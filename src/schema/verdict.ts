import { z } from "zod";

import { LensFindingSchema, type Severity } from "./finding.js";

/** Top-level verdict returned by `lens_review_complete`. */
export const VerdictSchema = z.enum(["approve", "revise", "reject"]);
export type Verdict = z.infer<typeof VerdictSchema>;

/**
 * A cross-lens disagreement surfaced by the merger (see T-012). The schema
 * defines the shape; detection lives in the merger.
 */
export const TensionSchema = z
  .object({
    category: z.string().min(1),
    lenses: z.array(z.string().min(1)).min(2),
    summary: z.string(),
  })
  .strict()
  .superRefine((val, ctx) => {
    // A cross-lens disagreement by definition involves distinct lenses;
    // ['security', 'security'] is a degenerate shape that would mislead T-013.
    if (new Set(val.lenses).size !== val.lenses.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["lenses"],
        message: "lenses must contain distinct ids",
      });
    }
  });
export type Tension = z.infer<typeof TensionSchema>;

const SEVERITY_COUNT_FIELDS: readonly Severity[] = [
  "blocking",
  "major",
  "minor",
  "suggestion",
] as const;

/**
 * Structured verdict returned to the agent. Shape is flat to match
 * the CLAUDE.md architecture contract. A `superRefine` enforces that the
 * top-level severity counts equal the number of findings with that severity,
 * so a bug in T-013 cannot emit internally inconsistent payloads.
 */
export const ReviewVerdictSchema = z
  .object({
    verdict: VerdictSchema,
    findings: z.array(LensFindingSchema),
    tensions: z.array(TensionSchema),
    blocking: z.number().int().min(0),
    major: z.number().int().min(0),
    minor: z.number().int().min(0),
    suggestion: z.number().int().min(0),
    sessionId: z.string().min(1),
  })
  .strict()
  .superRefine((val, ctx) => {
    for (const sev of SEVERITY_COUNT_FIELDS) {
      const actual = val.findings.filter((f) => f.severity === sev).length;
      if (val[sev] !== actual) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [sev],
          message: `${sev} count (${val[sev]}) does not match findings with severity '${sev}' (${actual})`,
        });
      }
    }
    // Any non-'reject' verdict with a blocking finding is internally
    // inconsistent: a single blocking finding is sufficient to reject.
    // 'revise' with a blocker would tell the agent "please revise" when the
    // policy is actually "stop". Enforced at the schema boundary so a bug in
    // T-013 cannot emit such a payload.
    if (val.blocking > 0 && val.verdict !== "reject") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["verdict"],
        message: `verdict must be 'reject' when blocking > 0 (got '${val.verdict}')`,
      });
    }
  });
export type ReviewVerdict = z.infer<typeof ReviewVerdictSchema>;
