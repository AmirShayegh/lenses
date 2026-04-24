import type {
  CallToolRequest,
  CallToolResult,
  ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  cleanupStaleLensCache,
  writeLensCache,
} from "../cache/lens-cache.js";
import {
  cleanupStaleSessions,
  writeSessionRound,
  type RoundRecord,
} from "../cache/session.js";
import { LENSES, type LensId } from "../lenses/prompts/index.js";
import { runMergerPipeline, type LensRunResult } from "../merger/pipeline.js";
import { LensOutputSchema } from "../schema/finding.js";
import {
  CompleteParamsSchema,
  DEFAULT_MAX_ATTEMPTS,
  ReviewVerdictSchema,
  type CompleteParams,
  type LensErrorCode,
  type LensOutput,
  type NextAction,
  type ParseError,
  type ParseErrorPhase,
  type ReviewVerdict,
  type ZodIssueWire,
} from "../schema/index.js";
import {
  applyCompletion,
  persistInFlightBestEffort,
  rejectionToLensErrorCode,
  type ReviewSession,
  type SubmittedResult,
} from "../state/review-state.js";

export const LENS_REVIEW_COMPLETE_NAME = "lens_review_complete";

/**
 * Tool definition returned via listTools. Hint schema only -- Zod at the
 * handler boundary is the enforcement layer. Mirrors T-008's approach in
 * `src/tools/start.ts` so both tools surface the same listTools shape and
 * the same wire-level error style.
 */
export const lensReviewCompleteDefinition = {
  name: LENS_REVIEW_COMPLETE_NAME,
  description:
    "Finish a multi-lens review. Accepts the raw outputs from each spawned agent; " +
    "returns the merged, confidence-filtered verdict. Hop 2 of 2 " +
    "(or hop 2+ of N if the prior call emitted nextActions[] for retry).",
  inputSchema: {
    type: "object" as const,
    properties: {
      reviewId: { type: "string", minLength: 1 },
      results: {
        type: "array",
        items: {
          type: "object",
          properties: {
            lensId: { type: "string", minLength: 1 },
            // `output` is `unknown` on the wire; each entry is parsed
            // per-lens so one malformed payload does not reject the call.
            output: {},
            // T-022: optional retry attempt counter; 1 on first call,
            // incremented on resubmission after a nextActions[] entry.
            attempt: { type: "integer", minimum: 1 },
          },
          required: ["lensId", "output"],
          additionalProperties: false,
        },
      },
      // T-011: optional merger-time config (confidence floor + blocking
      // policy + T-022 maxAttempts).
      mergerConfig: { type: "object" },
    },
    required: ["reviewId", "results"],
    additionalProperties: false,
  },
} satisfies ListToolsResult["tools"][number];

function errorResult(message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}

/**
 * Structured error response for state-machine rejections (ISS-004).
 * The text content is a JSON string carrying both `errorCode` (one
 * of the `LensErrorCode` enum values) and the original human-readable
 * `message`. Callers that want to branch on the code parse the JSON;
 * callers that just want to display the error see a structured
 * diagnostic string.
 *
 * Argument-validation errors (Zod parse failures on `CompleteParams`)
 * stay plain text -- those are "your request is malformed" and don't
 * need a code; the Zod message already describes the issue.
 */
function errorResultWithCode(
  code: LensErrorCode,
  message: string,
): CallToolResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({ errorCode: code, message }),
      },
    ],
  };
}

function summarizeZod(err: z.ZodError): string {
  return err.issues
    .map((i) => `${i.path.join(".")}: ${i.message}`)
    .join("; ");
}

function zodIssuesToWire(err: z.ZodError): ZodIssueWire[] {
  return err.issues.map((i) => ({
    path: i.path.join("."),
    message: i.message,
  }));
}

/**
 * T-022 phase classifier: given a failed `LensOutputSchema.safeParse`,
 * decide whether the caller should see the failure as an envelope
 * problem (typed field has wrong type) or a per-finding problem (a
 * finding failed `.strict()` / file-line correlation). Implementation
 * matches the plan's explicit algorithm:
 *   - any issue with path[0] === "findings" → "finding"
 *   - otherwise "envelope"
 * Ties (mixed issues) resolve to "finding" because that's the more
 * actionable classification -- the caller can re-prompt the LLM to fix
 * its finding shape, whereas envelope-shape problems are harder to
 * self-correct.
 */
function classifyPhase(err: z.ZodError): ParseErrorPhase {
  for (const issue of err.issues) {
    if (issue.path.length > 0 && issue.path[0] === "findings") return "finding";
  }
  return "envelope";
}

/**
 * Persist round summary to the disk session cache. Best-effort per
 * RULES.md §4: any error is logged but never propagated. Runs OUTSIDE
 * the outer try/catch in `handleLensReviewComplete` so a disk error
 * cannot flip `isError: true`.
 */
function persistRoundBestEffort(
  session: ReviewSession,
  verdict: ReviewVerdict,
): void {
  try {
    const round: RoundRecord = {
      roundNumber: session.reviewRound,
      reviewId: session.reviewId,
      stage: session.stage,
      verdict: verdict.verdict,
      counts: {
        blocking: verdict.blocking,
        major: verdict.major,
        minor: verdict.minor,
        suggestion: verdict.suggestion,
      },
      findings: verdict.findings,
      priorDeferrals: [...session.priorDeferrals],
      completedAt: Date.now(),
    };
    try {
      writeSessionRound({ sessionId: session.sessionId, round });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `lens_review_complete: session cache write failed: ${message}`,
      );
    }
    try {
      cleanupStaleSessions();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `lens_review_complete: session cache cleanup failed: ${message}`,
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`lens_review_complete: session cache skipped: ${message}`);
  }
}

/**
 * T-015 per-lens cache writeback. Same RULES.md §4 discipline as
 * `persistRoundBestEffort` — runs outside the outer try/catch.
 */
function persistLensCacheBestEffort(
  session: ReviewSession,
  perLens: readonly LensRunResult[],
  agentSubmittedLensIds: ReadonlySet<LensId>,
): void {
  try {
    for (const entry of perLens) {
      if (entry.output.status !== "ok") continue;
      if (!agentSubmittedLensIds.has(entry.lensId)) continue;
      const promptHash = session.promptHashes.get(entry.lensId);
      if (promptHash === undefined) continue;
      try {
        writeLensCache({
          lensId: entry.lensId,
          promptHash,
          findings: entry.output.findings,
          notes: entry.output.notes,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          `lens_review_complete: lens cache write failed (${entry.lensId}): ${message}`,
        );
      }
    }
    try {
      cleanupStaleLensCache();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `lens_review_complete: lens cache cleanup failed: ${message}`,
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`lens_review_complete: lens cache skipped: ${message}`);
  }
}

/**
 * T-022: decide whether a lens's current state warrants a retry. A retry
 * entry is emitted when the lens returned `status: "error"` OR the lens's
 * payload failed finding-level validation, AND the lens has budget
 * remaining (`latestAttempt < maxAttempts`).
 */
interface RetryCandidate {
  readonly lensId: LensId;
  readonly latestAttempt: number;
  readonly reason: string;
}

function buildNextActions(
  session: ReviewSession,
  candidates: readonly RetryCandidate[],
  maxAttempts: number,
): NextAction[] {
  const out: NextAction[] = [];
  for (const c of candidates) {
    if (c.latestAttempt >= maxAttempts) continue;
    const prompt = session.prompts.get(c.lensId);
    if (prompt === undefined) continue; // cached lens has no prompt; never retries
    // Any spawned lens has a matching expiresAt registered at hop-1
    // (see `start.ts`), so an undefined lookup here is a server-side
    // invariant break, not an expected path. Skip rather than silently
    // manufacture a synthetic deadline that has no relationship to the
    // caller's `lensTimeout` config.
    const expiresMs = session.perLensExpiresAt.get(c.lensId);
    if (expiresMs === undefined) continue;
    const expiresAt = new Date(expiresMs).toISOString();
    const retryPrompt = `${prompt}\n\n<retry-context>Prior attempt ${c.latestAttempt} failed validation: ${c.reason}. Return only valid JSON matching the lens output schema.</retry-context>\n`;
    out.push({
      lensId: c.lensId,
      retryPrompt,
      attempt: c.latestAttempt + 1,
      expiresAt,
    });
  }
  return out;
}

export async function handleLensReviewComplete(
  req: CallToolRequest,
): Promise<CallToolResult> {
  let parsed: CompleteParams;
  try {
    parsed = CompleteParamsSchema.parse(req.params.arguments);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return errorResult(
        `lens_review_complete: invalid arguments: ${summarizeZod(err)}`,
      );
    }
    if (err instanceof Error) {
      return errorResult(`lens_review_complete: ${err.message}`);
    }
    return errorResult(`lens_review_complete: unknown error`);
  }

  let session: ReviewSession;
  let safe: ReviewVerdict;
  let perLens: LensRunResult[];
  // Hoist `submissions` so `persistInFlightBestEffort` can read them
  // AFTER the outer try/catch closes -- mirrors the `persistRoundBestEffort`
  // / `persistLensCacheBestEffort` pattern. A disk-write failure inside
  // the helper cannot flip `isError: true` because the helper runs
  // outside the try/catch.
  const submissions: SubmittedResult[] = [];
  const agentSubmittedLensIds = new Set<LensId>();
  try {
    // First pass: classify each submitted result -- does it parse as a
    // clean LensOutput, or does it produce a parseError we should
    // surface? We do NOT advance the state machine until we know the
    // shape of each submission; applyCompletion needs the LensOutput
    // object (including syntheticError placeholders for hard-failed
    // lenses) to store the latest view.
    const parseErrors: ParseError[] = [];
    const retryCandidates: RetryCandidate[] = [];
    const maxAttempts =
      parsed.mergerConfig?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

    for (const r of parsed.results) {
      const attempt = r.attempt ?? 1;

      if (!(r.lensId in LENSES)) {
        // Unknown lens id: treat as internal parse failure. No retry
        // possible for an invented lens; surface as a terminal
        // parseError and do NOT update the state machine for it.
        parseErrors.push({
          lensId: r.lensId,
          attempt,
          phase: "internal",
          zodIssues: [
            { path: "lensId", message: `unknown lens id: ${r.lensId}` },
          ],
        });
        continue;
      }

      const res = LensOutputSchema.safeParse(r.output);
      if (res.success) {
        submissions.push({
          lensId: r.lensId as LensId,
          output: res.data as LensOutput,
          attempt,
        });
        agentSubmittedLensIds.add(r.lensId as LensId);
        // Lens may still be in a retryable `status: "error"` state.
        if (res.data.status === "error") {
          retryCandidates.push({
            lensId: r.lensId as LensId,
            latestAttempt: attempt,
            reason: res.data.error ?? "lens reported error",
          });
        }
      } else {
        const phase = classifyPhase(res.error);
        parseErrors.push({
          lensId: r.lensId,
          attempt,
          phase,
          zodIssues: zodIssuesToWire(res.error),
        });
        // For retryable parse failures (finding-shape or envelope-shape),
        // still advance the state machine so subsequent resubmissions
        // carry the correct `attempt` counter. The stored output is a
        // placeholder syntheticError — it does NOT contribute findings
        // to dedup/merger (status !== "ok"), but it pins the attempt.
        const placeholder: LensOutput = {
          status: "error",
          findings: [],
          error: `parse failure (${phase}): ${summarizeZod(res.error)}`,
          notes: null,
        };
        submissions.push({
          lensId: r.lensId as LensId,
          output: placeholder,
          attempt,
        });
        retryCandidates.push({
          lensId: r.lensId as LensId,
          latestAttempt: attempt,
          reason: summarizeZod(res.error),
        });
      }
    }

    // Decide finalize: true ONLY when no retry candidates have budget
    // remaining. If any lens can still retry, we keep the session open.
    const willEmitRetries = retryCandidates.some(
      (c) => c.latestAttempt < maxAttempts,
    );

    const applied = applyCompletion({
      reviewId: parsed.reviewId,
      results: submissions,
      finalize: !willEmitRetries,
    });
    if (!applied.ok) {
      // State-machine rejection: wrap the message with the structured
      // LensErrorCode so callers can programmatically distinguish
      // REVIEW_EXPIRED / DUPLICATE_COMPLETE from generic rejections.
      return errorResultWithCode(
        rejectionToLensErrorCode(applied.code),
        `lens_review_complete: ${applied.message}`,
      );
    }

    session = applied.session;

    // Build the full per-lens view the merger sees:
    //   - latest successfully-parsed outputs (from session.perLensLatestOutput).
    //   - cached outputs (from session.cachedResults, re-inflated as ok).
    perLens = [];
    for (const [lensId, out] of session.perLensLatestOutput) {
      perLens.push({ lensId, output: out });
    }
    for (const [lensId, cached] of session.cachedResults) {
      if (session.perLensLatestOutput.has(lensId)) continue; // fresh wins
      perLens.push({
        lensId,
        output: {
          status: "ok",
          findings: [...cached.findings],
          error: null,
          notes: cached.notes,
        },
      });
    }

    const nextActions = buildNextActions(session, retryCandidates, maxAttempts);

    const verdict = runMergerPipeline(
      parsed.mergerConfig === undefined
        ? {
            reviewId: parsed.reviewId,
            sessionId: session.sessionId,
            perLens,
            parseErrors,
            nextActions,
          }
        : {
            reviewId: parsed.reviewId,
            sessionId: session.sessionId,
            perLens,
            mergerConfig: parsed.mergerConfig,
            parseErrors,
            nextActions,
          },
    );

    safe = ReviewVerdictSchema.parse(verdict);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return errorResult(
        `lens_review_complete: internal error: ${summarizeZod(err)}`,
      );
    }
    if (err instanceof Error) {
      return errorResult(`lens_review_complete: ${err.message}`);
    }
    return errorResult(`lens_review_complete: unknown error`);
  }

  persistRoundBestEffort(session, safe);
  persistLensCacheBestEffort(session, perLens, agentSubmittedLensIds);
  // T-024: persist per-(reviewId, lensId, attempt) task records so a
  // server restart between hops can rebuild `perLensLatestOutput` from
  // disk on the next `getReview` call. Runs outside the outer try/catch
  // so a disk failure never flips `isError: true` (RULES.md §4).
  persistInFlightBestEffort(session, submissions);

  return { content: [{ type: "text", text: JSON.stringify(safe) }] };
}
