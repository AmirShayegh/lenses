import { z } from "zod";

/** Severity tiers used across findings, blocking policy, and verdict counts. */
export const SeveritySchema = z.enum([
  "blocking",
  "major",
  "minor",
  "suggestion",
]);
export type Severity = z.infer<typeof SeveritySchema>;

/** Lifecycle state reported by one lens for a single run. */
export const LensStatusSchema = z.enum(["ok", "error", "skipped"]);
export type LensStatus = z.infer<typeof LensStatusSchema>;

/**
 * Shared field shape for lens-reported findings and merger-produced merged
 * findings. Factored out so `LensFindingSchema` and `MergedFindingSchema` stay
 * in lockstep -- adding or renaming a field happens here exactly once.
 */
const findingObjectShape = {
  id: z.string().min(1),
  severity: SeveritySchema,
  category: z.string().min(1),
  file: z.string().min(1).nullable(),
  line: z.number().int().positive().nullable(),
  description: z.string(),
  suggestion: z.string(),
  confidence: z.number().min(0).max(1),
};

/**
 * Shared cross-field refinement: a positional line number without a file
 * coordinate is meaningless. Enforced on both LensFinding and MergedFinding so
 * the dedup key `(file, line, category)` is always well-formed.
 */
function fileLineCorrelation(
  val: { file: string | null; line: number | null },
  ctx: z.RefinementCtx,
): void {
  if (val.line !== null && val.file === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["line"],
      message: "line cannot be set when file is null",
    });
  }
}

/**
 * A single issue reported by one lens.
 *
 * Dedup key (see RULES.md §5 and T-010) is (file, line, category); all three
 * fields are present on every valid finding. `line` is positive-int-or-null and
 * may only be non-null when `file` is non-null, so the key is always well-formed.
 */
export const LensFindingSchema = z
  .object(findingObjectShape)
  .strict()
  .superRefine(fileLineCorrelation);
export type LensFinding = z.infer<typeof LensFindingSchema>;

/**
 * Post-merger shape (T-010). Carries `contributingLenses` so the agent can see
 * which lenses independently raised the same (file, line, category) concern.
 * Lens identity is attached here (not on LensFinding) because the merger is
 * the first layer where cross-lens attribution makes sense -- a single lens
 * has no use for the field.
 *
 * Invariants:
 *  - contributingLenses is nonempty (every merged finding comes from ≥1 lens).
 *  - contributingLenses contains distinct lens ids (duplicates would mislead
 *    downstream tension/policy layers).
 *  - Same line/file correlation as LensFinding.
 */
export const MergedFindingSchema = z
  .object({
    ...findingObjectShape,
    contributingLenses: z.array(z.string().min(1)).nonempty(),
  })
  .strict()
  .superRefine((val, ctx) => {
    fileLineCorrelation(val, ctx);
    if (new Set(val.contributingLenses).size !== val.contributingLenses.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["contributingLenses"],
        message: "contributingLenses must be distinct",
      });
    }
  });
export type MergedFinding = z.infer<typeof MergedFindingSchema>;

/**
 * One lens run's payload. The lens's identity is carried on the envelope
 * (`CompleteParams.results[].lensId`), not here -- a single source of truth
 * avoids reconciliation logic in T-009.
 */
export const LensOutputSchema = z
  .object({
    status: LensStatusSchema,
    findings: z.array(LensFindingSchema),
    error: z.string().nullable(),
    notes: z.string().nullable(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.status === "error") {
      if (val.error === null || val.error.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["error"],
          message: "error must be a non-empty string when status is 'error'",
        });
      }
      if (val.findings.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["findings"],
          message: "findings must be empty when status is 'error'",
        });
      }
    } else {
      // "ok" or "skipped": error must be null
      if (val.error !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["error"],
          message: `error must be null when status is '${val.status}'`,
        });
      }
      if (val.status === "skipped" && val.findings.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["findings"],
          message: "findings must be empty when status is 'skipped'",
        });
      }
    }
  });
export type LensOutput = z.infer<typeof LensOutputSchema>;

/**
 * Cross-round / cross-lens deferral key. Uses the same (file, line, category)
 * tuple as the merger dedup key, plus `lensId` so the agent can carry a
 * "don't re-raise these" list into the next review round.
 */
export const DeferralKeySchema = z
  .object({
    lensId: z.string().min(1),
    file: z.string().min(1).nullable(),
    line: z.number().int().positive().nullable(),
    category: z.string().min(1),
  })
  .strict()
  .superRefine(fileLineCorrelation);
export type DeferralKey = z.infer<typeof DeferralKeySchema>;
