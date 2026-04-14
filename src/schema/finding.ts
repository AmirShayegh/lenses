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
 * A single issue reported by one lens.
 *
 * Dedup key (see RULES.md §5 and T-010) is (file, line, category); all three
 * fields are present on every valid finding. `line` is positive-int-or-null and
 * may only be non-null when `file` is non-null, so the key is always well-formed.
 */
export const LensFindingSchema = z
  .object({
    id: z.string().min(1),
    severity: SeveritySchema,
    category: z.string().min(1),
    file: z.string().min(1).nullable(),
    line: z.number().int().positive().nullable(),
    description: z.string(),
    suggestion: z.string(),
    confidence: z.number().min(0).max(1),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.line !== null && val.file === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["line"],
        message: "line cannot be set when file is null",
      });
    }
  });
export type LensFinding = z.infer<typeof LensFindingSchema>;

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
  .superRefine((val, ctx) => {
    if (val.line !== null && val.file === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["line"],
        message: "line cannot be set when file is null",
      });
    }
  });
export type DeferralKey = z.infer<typeof DeferralKeySchema>;
