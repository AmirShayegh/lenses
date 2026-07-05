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

import { MergedFindingSchema, SeveritySchema, type DeferralKey } from "./finding.js";

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
  // T-028 R2 / R-D1: an alwaysBlock-category finding that failed the quorum
  // gate. RETAINED at `major` in findings[]; never a silent reject.
  "alwaysblock_below_quorum",
  // T-028 R-C1 / R3 / R4 / R-D2: a finding demoted to its (per-lens or
  // authority) severity ceiling. RETAINED at the clamped severity; carries
  // `clamps`.
  "severity_clamped_to_lens_max",
  // T-028 pen resolution 1-3: a finding whose severity was raised by
  // severity-max dedup because a DIFFERENT lens corroborated at a higher
  // severity. RETAINED at the escalated severity; carries `escalations`.
  "severity_escalated_by_corroboration",
]);
export type DeferralReason = z.infer<typeof DeferralReasonSchema>;

/**
 * T-028 R3: the deferral taxonomy has two disjoint classes with a single
 * machine-readable source of truth.
 *
 *  - DROP reasons: the finding is REMOVED from `findings[]`.
 *    `suppressedFindingCount` counts ONLY these; `toNextRoundDeferralKeys`
 *    forwards ONLY these into the next round's priorDeferrals (R12 / R-C2).
 *  - RETAINED reasons: the finding STAYS in `findings[]` at an adjusted
 *    severity; the deferred entry is an audit record. Forwarding a RETAINED
 *    entry as a priorDeferral would silently suppress a live finding next
 *    round, so it is fenced out of `toNextRoundDeferralKeys` (R-C2).
 */
export const DROP_DEFERRAL_REASONS = [
  "below_confidence_floor",
  "over_finding_budget",
  "non_blocking_suppressed",
  "evidence_unverified",
] as const satisfies readonly DeferralReason[];

export const RETAINED_DEFERRAL_REASONS = [
  "alwaysblock_below_quorum",
  "severity_clamped_to_lens_max",
  "severity_escalated_by_corroboration",
] as const satisfies readonly DeferralReason[];

const DROP_DEFERRAL_SET: ReadonlySet<DeferralReason> = new Set(
  DROP_DEFERRAL_REASONS,
);

/** True iff the reason removes the finding from `findings[]` (R3). */
export function isDropDeferral(reason: DeferralReason): boolean {
  return DROP_DEFERRAL_SET.has(reason);
}

/**
 * T-028 R-D2: the two clamp passes (R1 / R-C1). `lens_clamp` is Pass A
 * (`clampLensFindings`, per-lens ceiling before dedup); `authority_ceiling`
 * is Pass B (`enforceAuthorityCeiling`, the final authority clamp after all
 * policy transforms).
 */
export const ClampStageSchema = z.enum(["lens_clamp", "authority_ceiling"]);
export type ClampStage = z.infer<typeof ClampStageSchema>;

/**
 * T-028 R-D2: one clamp event in a `severity_clamped_to_lens_max` finding's
 * lineage. R-C1 coalesces at most ONE audit entry per final finding, so its
 * `clamps` array carries EVERY clamp event that fired across the finding's
 * lineage.
 */
export const ClampEventSchema = z
  .object({
    lensId: z.string().min(1),
    originalSeverity: SeveritySchema,
    clampedSeverity: SeveritySchema,
    stage: ClampStageSchema,
  })
  .strict();
export type ClampEvent = z.infer<typeof ClampEventSchema>;

/**
 * T-028 pen resolution 1-3: one severity-source event in a
 * `severity_escalated_by_corroboration` finding's escalation lineage. It
 * names the CROSS-lens source finding that supplied the escalated severity.
 *
 * INTERNAL schema by design (pen resolution 4 export fence): it is embedded
 * in `DeferredFindingSchema.escalations` but, unlike the R-D2 clamp names, is
 * NOT surfaced from any barrel. The public export set grows only by the R7 /
 * R-C2 / R-D2 ruled names.
 */
export const EscalationEventSchema = z
  .object({
    lensId: z.string().min(1),
    findingId: z.string().min(1),
    severity: SeveritySchema,
    confidence: z.number().min(0).max(1),
  })
  .strict();
export type EscalationEvent = z.infer<typeof EscalationEventSchema>;

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
    // T-028 R-D2: present iff reason is `severity_clamped_to_lens_max`.
    clamps: z.array(ClampEventSchema).min(1).optional(),
    // T-028 pen resolution 3: present iff reason is
    // `severity_escalated_by_corroboration`.
    escalations: z.array(EscalationEventSchema).min(1).optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    // R-D2: the clamp/escalation metadata is REQUIRED for its own reason and
    // FORBIDDEN for every other reason (in particular
    // `alwaysblock_below_quorum` never carries clamps -- its demotion is the
    // R2 gate surfacing, not an authority clamp).
    const wantsClamps = val.reason === "severity_clamped_to_lens_max";
    if (wantsClamps && val.clamps === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["clamps"],
        message: `reason '${val.reason}' requires clamps`,
      });
    }
    if (!wantsClamps && val.clamps !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["clamps"],
        message: `clamps is only valid with reason 'severity_clamped_to_lens_max' (got '${val.reason}')`,
      });
    }
    const wantsEscalations =
      val.reason === "severity_escalated_by_corroboration";
    if (wantsEscalations && val.escalations === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["escalations"],
        message: `reason '${val.reason}' requires escalations`,
      });
    }
    if (!wantsEscalations && val.escalations !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["escalations"],
        message: `escalations is only valid with reason 'severity_escalated_by_corroboration' (got '${val.reason}')`,
      });
    }
  });
export type DeferredFinding = z.infer<typeof DeferredFindingSchema>;

/**
 * T-028 R-C2: the ONLY sanctioned constructor of next-round priorDeferrals
 * from a verdict's `deferred[]`. Keeps only DROP-class entries (R3) then
 * expands each into one DeferralKey per contributing lens (the preamble
 * filters ownDeferrals by lensId). A RETAINED audit entry references a finding
 * still live in `findings[]`; forwarding it would silently suppress that live
 * finding next round, so it is fenced out here.
 */
export function toNextRoundDeferralKeys(
  deferred: readonly DeferredFinding[],
): DeferralKey[] {
  const keys: DeferralKey[] = [];
  for (const entry of deferred) {
    if (!isDropDeferral(entry.reason)) continue;
    for (const lensId of entry.finding.contributingLenses) {
      keys.push({
        lensId,
        file: entry.finding.file,
        line: entry.finding.line,
        category: entry.finding.category,
      });
    }
  }
  return keys;
}

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
