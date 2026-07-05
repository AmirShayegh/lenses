/**
 * T-022 retry / rich-envelope protocol schemas.
 *
 * Separated from `verdict.ts` so `ReviewVerdictSchema` stays focused on
 * verdict-level invariants (severity counts, verdict vs blocking, etc.) while
 * the shapes embedded in it live here. Three enums, three object schemas:
 *
 *  - `ParseErrorPhase` — where in the per-lens payload the validation failed.
 *  - `DeferralReason` — why a finding was dropped from `findings[]`.
 *  - `ParseErrorSchema`, `DeferredFindingSchema`, `NextActionSchema`.
 */

import { z } from "zod";

import { MergedFindingSchema } from "./finding.js";

/**
 * Where the per-lens parse failed:
 *
 *  - `"envelope"` — typed envelope fields (`status`, `findings` as array,
 *    `error`, `notes`) had the wrong TYPE. Can still happen under
 *    `.passthrough()` — passthrough only forgives unknown keys, it does not
 *    coerce known fields.
 *  - `"finding"` — a finding object failed `.strict()` or a file/line
 *    correlation superRefine.
 *  - `"internal"` — server-side classification failure (e.g., unknown
 *    lensId submitted by the caller); surfaces as a syntheticError in
 *    `complete.ts` without ever reaching `safeParse`.
 */
export const ParseErrorPhaseSchema = z.enum(["envelope", "finding", "internal"]);
export type ParseErrorPhase = z.infer<typeof ParseErrorPhaseSchema>;

/**
 * Carbon-copy of the fields a caller needs off a Zod issue to understand
 * what broke. We don't ship the full `z.ZodIssue` (which has varying shape
 * per issue code) because the wire schema should not leak Zod internals.
 */
export const ZodIssueWireSchema = z
  .object({
    path: z.string(),
    message: z.string(),
  })
  .strict();
export type ZodIssueWire = z.infer<typeof ZodIssueWireSchema>;

export const ParseErrorSchema = z
  .object({
    lensId: z.string().min(1),
    attempt: z.number().int().min(1),
    phase: ParseErrorPhaseSchema,
    zodIssues: z.array(ZodIssueWireSchema),
  })
  .strict();
export type ParseError = z.infer<typeof ParseErrorSchema>;

/**
 * Why a finding was dropped from the verdict's `findings[]`. Forward-compat
 * enum: T-022 wires only `below_confidence_floor`; the other two legacy
 * values stay in the enum so future server-side truncation / demotion-to-drop
 * behavior can populate them without a schema break.
 *
 * T-026 `evidence_unverified` (CODE_REVIEW-only): the anchor pass could not
 * verify a localized finding's quoted snippet against the diff new-side.
 * The gate is FILE-LEVEL (R-C1 / R2): it fires for any localized finding
 * whose `file` has an entry in the diff-derived new-side index and whose
 * quote is not present in the new-side within the recovery window,
 * REGARDLESS of whether the claimed line itself falls inside a hunk -- an
 * out-of-hunk claimed line whose window search finds no match is
 * unverified by design (R-D2). Findings on files ABSENT from the index
 * pass through untouched (R2). This reason therefore covers unverified
 * minors/suggestions AND unverified blocking/major findings that are below
 * the confidence floor without an alwaysBlock category (R6); alwaysBlock
 * categories and above-floor blocking/major findings instead SURVIVE with
 * `line: null` and a reviewIntegrity entry. An `evidence_unverified`
 * deferral preserves the finding's claimed `line`; only the survive+flag
 * path nulls it.
 */
export const DeferralReasonSchema = z.enum([
  "below_confidence_floor",
  "over_finding_budget",
  "non_blocking_suppressed",
  "evidence_unverified",
]);
export type DeferralReason = z.infer<typeof DeferralReasonSchema>;

/**
 * T-026 R8 / R-D4: one entry per survived-and-flagged finding whose quoted
 * snippet failed anchor verification but whose severity/category kept it in
 * `findings[]` with `line: null`. Captured in `verifyAnchors` BEFORE dedup
 * and before the survive path nulls `line`, so `file`/`line` are the
 * ORIGINAL per-lens claim and are non-nullable (only localized findings are
 * flagged).
 *
 * Consumer contract: `integrityKey` is the PRIMARY correlation key -- it
 * matches exactly one `findings[]` member (dedup never collapses a finding
 * carrying an integrityKey, R-D4d). The R8 fallback for readers of
 * pre-upgrade cached verdicts stands: after dedup a `findings[]`
 * representative may carry a different `id`, so correlate on `(file,
 * category)` plus `contributingLenses` and use `lensId` for attribution.
 */
export const ReviewIntegrityEntrySchema = z
  .object({
    findingId: z.string().min(1),
    lensId: z.string().min(1),
    file: z.string().min(1),
    line: z.number().int().positive(),
    category: z.string().min(1),
    integrityKey: z.string().min(1),
  })
  .strict();
export type ReviewIntegrityEntry = z.infer<typeof ReviewIntegrityEntrySchema>;

export const DeferredFindingSchema = z
  .object({
    finding: MergedFindingSchema,
    reason: DeferralReasonSchema,
  })
  .strict();
export type DeferredFinding = z.infer<typeof DeferredFindingSchema>;

/**
 * A cooperative retry instruction the caller honors by spawning the named
 * lens again with `retryPrompt` and resubmitting via a fresh
 * `lens_review_complete` call with `attempt` incremented.
 *
 *  - `retryPrompt` is SELF-CONTAINED: original lens prompt + a
 *    `<retry-context>` suffix describing what broke. The caller does NOT
 *    fetch the prompt via `lens_review_get_prompt` for a retry; that tool
 *    is stateless and only returns the original prompt.
 *  - `expiresAt` is ISO 8601, minted FRESH at retry emission time
 *    (T-027 R8: now + the lens's timeout, re-anchored server-side so the
 *    wire value equals the enforced value; the hop-1 deadline is never
 *    reused). A resubmission past this deadline is not rejected: the
 *    lens is diverted to `expired` coverage and the review still
 *    finalizes with `coverage: "partial"` + PARTIAL_RESULTS.
 */
export const NextActionSchema = z
  .object({
    lensId: z.string().min(1),
    retryPrompt: z.string().min(1),
    attempt: z.number().int().min(2),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type NextAction = z.infer<typeof NextActionSchema>;
