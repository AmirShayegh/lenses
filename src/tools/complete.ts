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
import { sanitizeFindingForStorage } from "../merger/anchor.js";
import {
  runMergerPipeline,
  type AnchoringInput,
  type LensRunResult,
} from "../merger/pipeline.js";
import { LensOutputSchema } from "../schema/finding.js";
import {
  CompleteParamsSchema,
  DEFAULT_MAX_ATTEMPTS,
  ReviewVerdictSchema,
  type CompleteParams,
  type LensCoverageEntry,
  type LensErrorCode,
  type LensOutput,
  type NextAction,
  type ParseError,
  type ParseErrorPhase,
  type ReviewVerdict,
  type ZodIssueWire,
} from "../schema/index.js";
import { withReviewStateLock } from "../state/review-lock.js";
import {
  applyCompletion,
  buildLensCoverage,
  commitReviewCompletion,
  mintRetryDeadline,
  PersistenceFailedError,
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
    "Finish or advance a multi-lens review. Accepts the raw outputs from each " +
    "spawned agent, incrementally (partial batches and empty polls are fine); " +
    "returns the merged, confidence-filtered verdict envelope. The envelope " +
    "disclosures matter: reviewComplete=false marks an INTERIM envelope (the " +
    "review stays open; resubmit or poll again), lensCoverage[]/coverage/" +
    "errorCodes disclose per-lens outcomes including expired (timed-out) " +
    "lenses, and nextActions[] carries retry instructions with a FRESH " +
    "per-attempt deadline (each retry gets its full timeout budget from " +
    "emission time; a late result diverts that lens to expired coverage " +
    "instead of rejecting the call). Hop 2+ of N.",
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
 * T-027 (pen resolution 8): `extra` carries additive sibling fields
 * (e.g. `storedVerdict` on a DUPLICATE_COMPLETE replay). The message
 * string itself never changes shape for existing codes.
 *
 * Argument-validation errors (Zod parse failures on `CompleteParams`)
 * stay plain text -- those are "your request is malformed" and don't
 * need a code; the Zod message already describes the issue.
 */
function errorResultWithCode(
  code: LensErrorCode,
  message: string,
  extra: Record<string, unknown> = {},
): CallToolResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({ errorCode: code, message, ...extra }),
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
 * T-027 R-D3: paranoid tie between lensCoverage and expectedLensIds,
 * asserted immediately before verdict emission. The disclosure must be
 * EXACTLY the expected lens set: no duplicate, no missing, no extra
 * entry. A violation is a server-side invariant break (buildLensCoverage
 * ranges over expectedLensIds, so this should be unreachable) and
 * surfaces as an internal error rather than shipping an envelope whose
 * coverage story silently omits a lens.
 */
export function assertLensCoverageExactSet(
  expectedLensIds: readonly string[],
  lensCoverage: readonly LensCoverageEntry[],
): void {
  const seen = new Set<string>();
  for (const entry of lensCoverage) {
    if (seen.has(entry.lensId)) {
      throw new Error(
        `lens coverage invariant: duplicate lensCoverage entry for '${entry.lensId}'`,
      );
    }
    seen.add(entry.lensId);
  }
  const expected = new Set(expectedLensIds);
  const missing = expectedLensIds.filter((id) => !seen.has(id));
  const extra = [...seen].filter((id) => !expected.has(id));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `lens coverage invariant: lensCoverage must equal the expected lens set exactly` +
        (missing.length > 0 ? ` (missing: ${missing.join(", ")})` : "") +
        (extra.length > 0 ? ` (extra: ${extra.join(", ")})` : ""),
    );
  }
}

/**
 * Persist round summary to the disk session cache. Best-effort per
 * RULES.md §4: any error is logged but never propagated. Runs OUTSIDE
 * the outer try/catch in `handleLensReviewComplete` so a disk error
 * cannot flip `isError: true`.
 *
 * T-027 R3: called ONLY for TERMINAL envelopes (reviewComplete=true).
 * Interim envelopes persist zero round records, so a multi-step
 * incremental review leaves exactly one RoundRecord.
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
          // T-026 R-C4(b): the lens-cache WRITE choke point. Sanitize before
          // persisting so a server-owned field can never round-trip the
          // cache into a later round's `cached[]`. Ingestion already
          // sanitized perLensLatestOutput, so this is defense-in-depth --
          // mandated as the second of the two lens-cache choke points.
          findings: entry.output.findings.map(sanitizeFindingForStorage),
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
    // T-027 R8: mint a FRESH deadline at NextAction emission time. The
    // retry attempt gets the lens's full timeout budget from now,
    // replacing the pre-T-027 reuse of the hop-1 deadline (DEFECT 1:
    // a retry could otherwise inherit an already-lapsed window). The
    // mint re-anchors server-side and persists to index.lensMeta, so
    // the emitted expiresAt is exactly the enforced one. A lens with
    // no registered deadline is skipped, matching pre-T-027 behavior
    // (such a lens never expires; there is no deadline to refresh).
    const mintedMs = mintRetryDeadline(session.reviewId, c.lensId);
    if (mintedMs === undefined) continue;
    const expiresAt = new Date(mintedMs).toISOString();
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

/** Result of the locked finalization transaction. */
type LockedOutcome =
  | { readonly kind: "error"; readonly result: CallToolResult }
  | {
      readonly kind: "envelope";
      readonly session: ReviewSession;
      readonly safe: ReviewVerdict;
      readonly finalizing: boolean;
    };

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

  let outcome: LockedOutcome;
  const agentSubmittedLensIds = new Set<LensId>();
  try {
    // First pass: classify each submitted result -- does it parse as a
    // clean LensOutput, or does it produce a parseError we should
    // surface? Pure parsing; no state machine access, so it stays
    // outside the lock. T-027 R-D2: NO lens-id pre-filtering happens
    // here beyond the "is this a real lens at all" gate --
    // valid-but-unactivated lenses flow into applyCompletion and come
    // back in `disposition.ignoredLensIds`.
    const parseErrors: ParseError[] = [];
    const retryCandidates: RetryCandidate[] = [];
    const submissions: SubmittedResult[] = [];
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
        // T-026 R-C2: the SUBMISSION-CONSTRUCTION choke point, BEFORE
        // applyCompletion. Strip server-owned finding fields here so every
        // downstream store holds sanitized findings -- the in-memory
        // perLensLatestOutput (read by a same-process round 2), the
        // persisted TaskRecords written by persistInFlightBestEffort inside
        // applyCompletion, the restart rehydration that reads them back, and
        // the merge inputs. A lens can therefore never inject a value the
        // server alone mints (anchorRealignedFrom, integrityKey). The anchor
        // pass's own strip stays as defense-in-depth. Same canonical helper
        // as the two lens-cache choke points.
        const sanitizedOutput: LensOutput = {
          ...(res.data as LensOutput),
          findings: (res.data.findings as LensOutput["findings"]).map(
            sanitizeFindingForStorage,
          ),
        };
        submissions.push({
          lensId: r.lensId as LensId,
          output: sanitizedOutput,
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

    // T-027 (pen resolutions 1 + 3): EXACTLY ONE lock acquisition
    // around the whole finalization transaction -- disposition
    // planning, retry emission, every derived envelope decision, and
    // the completion commit. `applyCompletion` and
    // `commitReviewCompletion` do not lock internally (their doc
    // contracts require the caller to hold this lock); nothing inside
    // the callback re-enters the lock.
    outcome = withReviewStateLock(parsed.reviewId, (): LockedOutcome => {
      const applied = applyCompletion({
        reviewId: parsed.reviewId,
        results: submissions,
        finalize: false,
      });
      if (!applied.ok) {
        // State-machine rejection: wrap the message with the structured
        // LensErrorCode so callers can programmatically distinguish
        // DUPLICATE_COMPLETE from generic rejections. Pen resolution 8:
        // an already_complete replay additionally carries the stored
        // verdict as a SIBLING field; the message string is unchanged.
        const extra =
          applied.code === "already_complete" &&
          applied.storedVerdict !== undefined
            ? { storedVerdict: applied.storedVerdict }
            : {};
        return {
          kind: "error",
          result: errorResultWithCode(
            rejectionToLensErrorCode(applied.code),
            `lens_review_complete: ${applied.message}`,
            extra,
          ),
        };
      }

      const session = applied.session;
      const disposition = applied.disposition;

      // T-027 R4: expired lenses produce NO retry instructions and NO
      // parseErrors entries -- their disclosure is the expired coverage
      // status. R-B3 (codex round, resolution 5): BOTH lists are
      // additionally filtered to the review's expected lens set, so a
      // submission for a lens that was never part of the review (valid
      // id or invented, well-formed or malformed) cannot downgrade the
      // verdict, emit a retry, surface a parse error, or touch
      // coverage. The committed disposition + the session are the only
      // sources consulted (pen resolution 3).
      const expected = new Set<string>(session.expectedLensIds);
      const ignored = new Set<LensId>(disposition.ignoredLensIds);
      const effectiveCandidates = retryCandidates.filter(
        (c) =>
          expected.has(c.lensId) &&
          !session.perLensExpired.has(c.lensId) &&
          !ignored.has(c.lensId),
      );
      const effectiveParseErrors = parseErrors.filter(
        (p) =>
          expected.has(p.lensId) &&
          !session.perLensExpired.has(p.lensId as LensId),
      );

      // Mints fresh per-attempt deadlines (R8); mutates the in-memory
      // session's perLensExpiresAt, which is why it must stay inside
      // the lock.
      const nextActions = buildNextActions(
        session,
        effectiveCandidates,
        maxAttempts,
      );

      // Finalize iff nothing is retryable AND the union coverage
      // (accepted + prior outputs + cached + expired, R14a) spans every
      // expected lens. Otherwise this call returns an INTERIM envelope
      // and the review stays open.
      const finalizing =
        nextActions.length === 0 && disposition.unionCovered;

      // Build the full per-lens view the merger sees:
      //   - latest successfully-parsed outputs (from session.perLensLatestOutput).
      //   - cached outputs (from session.cachedResults, re-inflated as ok).
      const perLens: LensRunResult[] = [];
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

      // T-027 R14: the coverage disclosure, exact-set-checked against
      // expectedLensIds (R-D3) before the envelope ships.
      const lensCoverage = buildLensCoverage(session);
      assertLensCoverageExactSet(session.expectedLensIds, lensCoverage);

      // T-026 R11: the complete-time anchoring context from the retained
      // ReviewSession. The anchor pass verifies lens quotes against the SAME
      // artifact string the lenses reviewed (prompt-consistency anchoring,
      // R-D1a). CODE_REVIEW with a non-empty artifact enforces; PLAN_REVIEW
      // or an empty (pre-upgrade / truncation-lost) artifact is
      // normalize-only.
      const anchoring: AnchoringInput = {
        stage: session.stage,
        artifact: session.artifact,
        changedFiles: session.changedFiles,
      };

      const verdict = runMergerPipeline(
        parsed.mergerConfig === undefined
          ? {
              reviewId: parsed.reviewId,
              sessionId: session.sessionId,
              perLens,
              parseErrors: effectiveParseErrors,
              nextActions,
              lensCoverage,
              reviewComplete: finalizing,
              anchoring,
            }
          : {
              reviewId: parsed.reviewId,
              sessionId: session.sessionId,
              perLens,
              mergerConfig: parsed.mergerConfig,
              parseErrors: effectiveParseErrors,
              nextActions,
              lensCoverage,
              reviewComplete: finalizing,
              anchoring,
            },
      );

      const safe = ReviewVerdictSchema.parse(verdict);

      // T-027 (pen resolutions 2 + 5): the ONLY complete transition on
      // the tool path. Validates the final verdict and durably writes
      // completedAt + verdict BEFORE flipping the in-memory status. A
      // PersistenceFailedError propagates to the handler catch, which
      // returns the PERSISTENCE_FAILED envelope; the session stays
      // awaiting_retry and the finalizing call can simply be retried.
      if (finalizing) {
        commitReviewCompletion({ reviewId: parsed.reviewId, verdict: safe });
      }

      return { kind: "envelope", session, safe, finalizing };
    });
  } catch (err) {
    if (err instanceof PersistenceFailedError) {
      return errorResultWithCode(
        "PERSISTENCE_FAILED",
        `lens_review_complete: ${err.message}`,
      );
    }
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

  if (outcome.kind === "error") return outcome.result;

  // T-027 R3: round records are TERMINAL-only. Lens cache writes stay
  // per-call (they key on promptHash and only ever see ok outputs that
  // were actually accepted into perLensLatestOutput). Both run outside
  // the try/catch so a disk failure never flips `isError: true`
  // (RULES.md §4). Task-record persistence happens inside
  // `applyCompletion` now; the old post-hoc call site is gone.
  if (outcome.finalizing) {
    persistRoundBestEffort(outcome.session, outcome.safe);
  }
  persistLensCacheBestEffort(
    outcome.session,
    [...outcome.session.perLensLatestOutput].map(([lensId, output]) => ({
      lensId,
      output,
    })),
    agentSubmittedLensIds,
  );

  return { content: [{ type: "text", text: JSON.stringify(outcome.safe) }] };
}
