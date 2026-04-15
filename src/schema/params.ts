import { z } from "zod";

import { DeferralKeySchema } from "./finding.js";
import { MergerConfigSchema } from "./merger-config.js";

/** Which stage of the autonomous loop a review corresponds to. */
export const StageSchema = z.enum(["PLAN_REVIEW", "CODE_REVIEW"]);
export type Stage = z.infer<typeof StageSchema>;

/**
 * Fields shared by every StartParams stage. Spread into each discriminated
 * branch because Zod 3's discriminatedUnion requires each arm to be a plain
 * ZodObject (no intersections).
 *
 * Exported so T-008's `StartToolInputSchema` can reuse the exact same shape
 * without structural duplication -- a single source of truth keeps the MCP
 * tool input and the preamble's expected review envelope in lockstep.
 */
export const sharedStartShape = {
  artifact: z.string(),
  ticketDescription: z.string().nullable(),
  reviewRound: z.number().int().min(1),
  priorDeferrals: z.array(DeferralKeySchema).default([]),
  // T-014: optional series identifier. Absent on round 1 (the server
  // generates one); present on round 2+ so the agent can link rounds
  // into a single series. UUID-gated so the agent cannot pass a
  // free-form string that collides with a future reviewId. Optional
  // rather than `.default(() => randomUUID())` because the default
  // belongs on the tool-handler side, where state-machine
  // registration happens -- pushing it into Zod would mint a fresh id
  // on every parse call and break the tool-boundary test roundtrip.
  sessionId: z.string().uuid().optional(),
} as const;

/**
 * Input to `lens_review_start`.
 *
 * Stage-discriminated so that the schema itself enforces stage invariants:
 * PLAN_REVIEW has no `changedFiles`; CODE_REVIEW requires non-empty
 * `changedFiles`. T-008 gets those constraints for free.
 */
export const StartParamsSchema = z.discriminatedUnion("stage", [
  z
    .object({
      stage: z.literal("PLAN_REVIEW"),
      ...sharedStartShape,
    })
    .strict(),
  z
    .object({
      stage: z.literal("CODE_REVIEW"),
      changedFiles: z.array(z.string().min(1)).nonempty(),
      ...sharedStartShape,
    })
    .strict(),
]);
export type StartParams = z.infer<typeof StartParamsSchema>;

/**
 * Input to `lens_review_complete`.
 *
 * `output` is `unknown` by design: one malformed lens payload must not reject
 * the entire call. T-009 validates each `output` with `LensOutputSchema`
 * individually so per-lens errors can be recorded without losing the others.
 *
 * A superRefine catches duplicate lens submissions at the contract boundary
 * rather than leaving T-009 to pick a winner.
 */
export const CompleteParamsSchema = z
  .object({
    reviewId: z.string().min(1),
    results: z.array(
      z
        .object({
          lensId: z.string().min(1),
          output: z.unknown(),
        })
        .strict(),
    ),
    // T-011: optional merger-time config (confidence floor + blocking
    // policy). Undefined cascades to `DEFAULT_MERGER_CONFIG` at pipeline
    // time. Left `.optional()` (no `.default(...)`) so the parsed
    // `CompleteParams` surface reflects whether the caller sent the
    // field -- the pipeline decides the default, not the schema.
    mergerConfig: MergerConfigSchema.optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    const seen = new Set<string>();
    val.results.forEach((r, idx) => {
      if (seen.has(r.lensId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["results", idx, "lensId"],
          message: `duplicate lensId '${r.lensId}' in results`,
        });
      }
      seen.add(r.lensId);
    });
  });
export type CompleteParams = z.infer<typeof CompleteParamsSchema>;
