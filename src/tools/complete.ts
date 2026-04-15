import type {
  CallToolRequest,
  CallToolResult,
  ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

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
  ReviewVerdictSchema,
  type CompleteParams,
  type LensOutput,
  type ReviewVerdict,
} from "../schema/index.js";
import {
  validateAndComplete,
  type ReviewSession,
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
    "returns the merged, confidence-filtered verdict. Hop 2 of 2.",
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
          },
          required: ["lensId", "output"],
          additionalProperties: false,
        },
      },
      // T-011: optional merger-time config (confidence floor + blocking
      // policy). Full validation happens at the Zod boundary, so the
      // listTools hint is kept deliberately loose.
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
 * Build a LensOutput with `status: "error"`. Guards the message so an
 * empty summary from `summarizeZod` cannot produce a payload that
 * itself fails `LensOutputSchema.superRefine` -- which would later
 * cause `ReviewVerdictSchema.parse` to throw and turn graceful
 * degradation into a hard 500.
 */
function syntheticError(message: string): LensOutput {
  return {
    status: "error",
    error: message.length > 0 ? message : "lens output parse error",
    findings: [],
    notes: null,
  };
}

function summarizeZod(err: z.ZodError): string {
  return err.issues
    .map((i) => `${i.path.join(".")}: ${i.message}`)
    .join("; ");
}

/**
 * Append this round to the disk session cache, then sweep stale
 * sessions. Every step is best-effort per RULES.md §4: any error is
 * logged to stderr but never propagated, so the agent still receives
 * its verdict even if the disk is full or permissions are wrong. The
 * documented cost is that the agent may later present a sessionId
 * that does not resolve to a file; T-015's read-at-start path treats
 * that identically to "round 1."
 *
 * The entire body sits inside one outer try/catch (in addition to the
 * per-call guards) so that a throw from `round` construction itself
 * -- however unlikely -- cannot escape into the caller's tool-error
 * path. The caller in `handleLensReviewComplete` relies on this
 * guarantee by invoking `persistRoundBestEffort` outside its own
 * outer try/catch: any cache trouble must be logged and swallowed
 * here, never become `isError: true`.
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

export async function handleLensReviewComplete(
  req: CallToolRequest,
): Promise<CallToolResult> {
  // Top-level envelope parse gets its OWN catch so that a ZodError
  // from `CompleteParamsSchema` produces the "invalid arguments:"
  // prefix -- and the defense-in-depth `ReviewVerdictSchema.parse`
  // below (post state transition) does NOT accidentally reuse that
  // label. Plan section 5 distinguishes the two error surfaces
  // explicitly.
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

  // `session` and `safe` are declared OUTSIDE the outer try/catch so
  // the cache write (persistRoundBestEffort) can run strictly after
  // the try/catch completes successfully. Structurally this is what
  // makes RULES.md §4 ("if cache is unavailable, skip caching, don't
  // fail") watertight: even if some future edit accidentally threw
  // from the cache call or removed persistRoundBestEffort's own
  // outer guard, the throw could not reach the outer catch and
  // couldn't turn a successful verdict into `isError: true`.
  let session: ReviewSession;
  let safe: ReviewVerdict;
  try {
    // State machine check BEFORE per-lens Zod work. No point paying
    // the Zod cost for a reviewId that was never issued or has
    // already been completed. `validateAndComplete` atomically
    // transitions the session to `complete` on success -- if anything
    // below throws, the session is already marked complete and the
    // outer catch returns an isError response (see plan section 11
    // "No completion rollback").
    const stateResult = validateAndComplete({
      reviewId: parsed.reviewId,
      // The state machine reads these as string Set keys; unknown-id
      // enforcement happens per-lens below. The state machine accepts
      // supersets by design, so an invented id here is not an error
      // at this layer -- it becomes a synthetic-error entry
      // downstream.
      providedLensIds: parsed.results.map((r) => r.lensId as LensId),
    });
    if (!stateResult.ok) {
      return errorResult(`lens_review_complete: ${stateResult.message}`);
    }

    const perLens: LensRunResult[] = [];
    for (const r of parsed.results) {
      if (!(r.lensId in LENSES)) {
        perLens.push({
          lensId: r.lensId as LensId,
          output: syntheticError(`unknown lens id: ${r.lensId}`),
        });
        continue;
      }
      const res = LensOutputSchema.safeParse(r.output);
      perLens.push({
        lensId: r.lensId as LensId,
        output: res.success ? res.data : syntheticError(summarizeZod(res.error)),
      });
    }

    // T-014: the cross-round sessionId lives on the stored
    // ReviewSession (seeded at start-time). The pipeline now takes it
    // as a distinct field -- reviewId is per-round, sessionId is
    // cross-round. Only attach `mergerConfig` when the caller actually
    // sent one -- `exactOptionalPropertyTypes` treats
    // `{ mergerConfig: undefined }` differently from an absent key.
    session = stateResult.session;
    const verdict = runMergerPipeline(
      parsed.mergerConfig === undefined
        ? {
            reviewId: parsed.reviewId,
            sessionId: session.sessionId,
            perLens,
          }
        : {
            reviewId: parsed.reviewId,
            sessionId: session.sessionId,
            perLens,
            mergerConfig: parsed.mergerConfig,
          },
    );

    // Defense-in-depth: re-parse the computed verdict so a merger bug
    // (e.g., severity counts that don't match findings) cannot leak
    // through the tool boundary. A ZodError here is a SERVER-side
    // issue, not bad user input, so the catch below does NOT use the
    // "invalid arguments:" prefix.
    safe = ReviewVerdictSchema.parse(verdict);
  } catch (err) {
    // ZodError extends Error; check it FIRST so a merger-regression
    // verdict parse failure surfaces the flattened issue summary
    // instead of ZodError.message's raw JSON blob. Uses "internal
    // error:" (not "invalid arguments:") because a throw from this
    // block means the merger emitted an inconsistent verdict -- a
    // server bug, not bad user input.
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

  // T-014 session cache: persist this round's record and sweep stale
  // sessions. This runs AFTER the try/catch closes -- combined with
  // persistRoundBestEffort's own internal guards, cache trouble can
  // never become `isError: true`. The `safe`-reparsed verdict is the
  // ONLY source used for the record: it is the same payload the agent
  // will see, so on-disk state cannot drift from the wire.
  persistRoundBestEffort(session, safe);

  return { content: [{ type: "text", text: JSON.stringify(safe) }] };
}
