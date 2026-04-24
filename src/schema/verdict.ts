import { z } from "zod";

import { MergedFindingSchema, type Severity } from "./finding.js";
import {
  DeferredFindingSchema,
  NextActionSchema,
  ParseErrorSchema,
} from "./review-protocol.js";

/** Top-level verdict returned by `lens_review_complete`. */
export const VerdictSchema = z.enum(["approve", "revise", "reject"]);
export type Verdict = z.infer<typeof VerdictSchema>;

/**
 * A cross-lens disagreement surfaced by the merger (see T-012). The schema
 * defines the shape; detection lives in the merger.
 *
 * `lenses` is fixed at length 2: a tension is by definition a pair of lenses.
 * Using `.length(2)` (rather than `.min(2)`) pins the contract so a future
 * caller cannot leak a 3-element "coalition" through the schema boundary --
 * that would require its own type, not a reuse of `Tension`.
 */
export const TensionSchema = z
  .object({
    category: z.string().min(1),
    lenses: z.array(z.string().min(1)).length(2),
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
 *
 * T-022 extensions:
 *  - `parseErrors[]` — lens payloads that failed validation at hop-2. Replaces
 *    the silent `syntheticError` swallow path.
 *  - `deferred[]` — findings dropped from `findings[]` (e.g., below the
 *    confidence floor) with the reason attached. `suppressedFindingCount`
 *    mirrors `deferred.length` for callers that only want the number.
 *  - `hadAnyFindings` — true iff any lens produced ≥1 finding at parse time,
 *    independent of deferral/suppression. Disambiguates `findings: []`
 *    between "no concerns" and "concerns suppressed" (L-003).
 *  - `nextActions[]` — cooperative retry instructions. When non-empty, the
 *    verdict MUST be `revise` (or `reject` if blocking > 0); the caller
 *    re-spawns the named lenses and resubmits with incremented `attempt`.
 */
export const ReviewVerdictSchema = z
  .object({
    verdict: VerdictSchema,
    findings: z.array(MergedFindingSchema),
    tensions: z.array(TensionSchema),
    blocking: z.number().int().min(0),
    major: z.number().int().min(0),
    minor: z.number().int().min(0),
    suggestion: z.number().int().min(0),
    sessionId: z.string().min(1),
    parseErrors: z.array(ParseErrorSchema).default([]),
    deferred: z.array(DeferredFindingSchema).default([]),
    suppressedFindingCount: z.number().int().min(0).default(0),
    hadAnyFindings: z.boolean(),
    nextActions: z.array(NextActionSchema).default([]),
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
    // Symmetric check: 'reject' requires at least one blocking finding.
    // Unreachable via `computeVerdict` (which derives verdict from the
    // counts) but a future merger bug or a wire-mutated payload would
    // otherwise pass through the schema with a misleading `verdict:
    // "reject", blocking: 0`.
    if (val.verdict === "reject" && val.blocking === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["verdict"],
        message: `verdict 'reject' requires blocking > 0 (got blocking=0)`,
      });
    }
    // T-022: suppressedFindingCount is a caller-friendly mirror of
    // deferred.length; inconsistency here is a merger bug.
    if (val.suppressedFindingCount !== val.deferred.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["suppressedFindingCount"],
        message: `suppressedFindingCount (${val.suppressedFindingCount}) must equal deferred.length (${val.deferred.length})`,
      });
    }
    // T-022 (L-003 disambiguation): `hadAnyFindings === false` means no
    // lens produced a finding at parse time. In that case no finding
    // content exists anywhere -- not in `findings[]`, not in `deferred[]`,
    // not in `parseErrors[]` (parseErrors are not findings).
    if (
      val.hadAnyFindings === false &&
      val.findings.length + val.deferred.length > 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["hadAnyFindings"],
        message: `hadAnyFindings=false but findings+deferred=${val.findings.length + val.deferred.length}`,
      });
    }
    // Symmetric check: `hadAnyFindings === true` means at least one
    // lens produced a finding at parse time. The pipeline routes every
    // parsed finding to `findings[]` (kept) or `deferred[]` (dropped by
    // confidence floor) -- `parseErrors[]` is orthogonal (findings that
    // failed .strict() never populate output.findings, so they never
    // contributed to `hadAnyFindings` in the first place). Therefore
    // `hadAnyFindings=true` with both `findings[]` and `deferred[]`
    // empty is structurally impossible. Enforced at the schema
    // boundary so a future merger regression that silently drops
    // findings cannot produce a misleading `hadAnyFindings: true,
    // findings: []` -- the caller would otherwise have no signal that
    // something went wrong.
    //
    // COUPLING NOTE for future maintainers: this rule assumes every
    // finding-suppression path writes to `deferred[]`. The three
    // forward-compat reasons on `DeferralReasonSchema`
    // (`below_confidence_floor`, `over_finding_budget`,
    // `non_blocking_suppressed`) are already defined, so a ticket that
    // adds server-side budget truncation or blocking-severity drops
    // MUST emit `deferred[]` entries to satisfy this invariant. If a
    // future suppression path ever drops findings WITHOUT recording
    // them in `deferred[]`, update this check to include the new sink
    // in the same commit.
    if (
      val.hadAnyFindings === true &&
      val.findings.length === 0 &&
      val.deferred.length === 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["hadAnyFindings"],
        message: `hadAnyFindings=true but findings and deferred are both empty (pipeline dropped all findings without deferring them)`,
      });
    }
    // T-022: when the server is asking for retries, the caller must
    // never see verdict='approve'. 'reject' is still permitted when
    // blocking > 0 (blocking findings can coexist with retryable
    // errors on other lenses). 'revise' is the canonical "retry
    // available" verdict.
    if (val.nextActions.length > 0 && val.verdict === "approve") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["verdict"],
        message: `verdict cannot be 'approve' while nextActions.length > 0 (retries pending)`,
      });
    }
  });
export type ReviewVerdict = z.infer<typeof ReviewVerdictSchema>;
