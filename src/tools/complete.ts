import type {
  CallToolRequest,
  CallToolResult,
  ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { LENSES, type LensId } from "../lenses/prompts/index.js";
import { runMergerPipeline, type LensRunResult } from "../merger/pipeline.js";
import { LensOutputSchema } from "../schema/finding.js";
import {
  CompleteParamsSchema,
  ReviewVerdictSchema,
  type CompleteParams,
  type LensOutput,
} from "../schema/index.js";
import { validateAndComplete } from "../state/review-state.js";

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

    const verdict = runMergerPipeline({
      reviewId: parsed.reviewId,
      perLens,
    });

    // Defense-in-depth: re-parse the computed verdict so a merger bug
    // (e.g., severity counts that don't match findings) cannot leak
    // through the tool boundary. A ZodError here is a SERVER-side
    // issue, not bad user input, so the catch below does NOT use the
    // "invalid arguments:" prefix.
    const safe = ReviewVerdictSchema.parse(verdict);
    return { content: [{ type: "text", text: JSON.stringify(safe) }] };
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
}
