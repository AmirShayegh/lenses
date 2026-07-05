import { z } from "zod";

// T-027 R10/R-D1: import the core lens set from the LEAF module
// directly, never from lenses/registry.ts. The registry route would be
// a real ESM cycle (prompts/index.ts export-stars shared-preamble.ts,
// which value-imports schema/index.ts). The leaf has zero runtime
// imports, so this edge is cycle-free.
import { CORE_LENS_IDS } from "../lenses/core-lens-ids.js";
import { LensErrorCodeSchema } from "./error-code.js";
import { MergedFindingSchema, type Severity } from "./finding.js";
import {
  DeferredFindingSchema,
  NextActionSchema,
  ParseErrorSchema,
  ReviewIntegrityEntrySchema,
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
 * T-027: per-lens coverage disclosure. One entry per expected lens in
 * the verdict envelope so partial coverage can never masquerade as a
 * clean full pass.
 *
 * Status precedence (R14e), applied per lens by the builder:
 * expired -> ok (latest output ok) -> parse_failed (latest error starts
 * with "parse failure") -> error (other latest error) -> cached ->
 * skipped.
 */
export const LensCoverageStatusSchema = z.enum([
  "ok",
  "error",
  "skipped",
  "expired",
  "parse_failed",
  "cached",
]);
export type LensCoverageStatus = z.infer<typeof LensCoverageStatusSchema>;

export const LensCoverageEntrySchema = z
  .object({
    lensId: z.string().min(1),
    status: LensCoverageStatusSchema,
    attempts: z.number().int().min(0),
    contributedFindings: z.number().int().min(0),
  })
  .strict();
export type LensCoverageEntry = z.infer<typeof LensCoverageEntrySchema>;

/** Statuses that count as a real contribution (full coverage). */
export const COVERED_STATUSES: ReadonlySet<LensCoverageStatus> = new Set([
  "ok",
  "cached",
]);

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
 *
 * T-027 extensions (all four DEFAULTED so pre-T-027 consumers parse
 * unchanged, R14b):
 *  - `lensCoverage[]` -- one entry per expected lens; the exact-set tie
 *    to expectedLensIds is enforced in complete.ts (R-D3), not here.
 *  - `coverage` -- "partial" iff any lensCoverage entry is outside
 *    ok/cached.
 *  - `errorCodes` -- carries PARTIAL_RESULTS iff any entry is expired.
 *  - `reviewComplete` -- false for interim envelopes (incremental
 *    submission); interim envelopes can never carry approve.
 *
 * T-026 evidence-anchoring integrity surface (all DEFAULTED so pre-T-026
 * consumers parse unchanged). CODE_REVIEW-only in practice; PLAN_REVIEW and
 * normalize-only runs leave them at the empty/zero defaults.
 *
 * TRUST BOUNDARY (R-D1a): these fields attest PROMPT-CONSISTENCY anchoring
 * only -- the server verifies lens quotes against the SAME caller-supplied
 * artifact string that was embedded in every lens prompt and bound by
 * promptHash, so all lenses and the anchor pass provably saw one identical
 * artifact. They NEVER attest that the artifact faithfully reflects any
 * repository state; artifact authenticity remains the caller's
 * responsibility (the server has zero repo access and calls no API).
 *  - `anchorRealignedCount` -- PRE-dedup operational telemetry (R4a): the
 *    number of input findings the server realigned this round. The
 *    superRefine enforces only the sound direction (>= emitted carriers);
 *    dedup loss makes strict inequality legal.
 *  - `evidenceUnverifiedCount` -- exact count of `evidence_unverified`
 *    deferrals (never deduped, so equality is sound).
 *  - `reviewIntegrity` -- survived-and-flagged findings whose snippet
 *    failed verification; each `integrityKey` maps 1:1 to a `findings[]`
 *    member.
 *  - `anchorUnindexedFiles` -- changedFiles entries with no diff new-side
 *    index entry (R-D1b): a pure integrity disclosure, sorted + deduped.
 *    NO verdict/severity/blocking behavior changes when it is non-empty.
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
    lensCoverage: z.array(LensCoverageEntrySchema).default([]),
    coverage: z.enum(["full", "partial"]).default("full"),
    errorCodes: z.array(LensErrorCodeSchema).default([]),
    reviewComplete: z.boolean().default(true),
    anchorRealignedCount: z.number().int().min(0).default(0),
    evidenceUnverifiedCount: z.number().int().min(0).default(0),
    reviewIntegrity: z.array(ReviewIntegrityEntrySchema).default([]),
    anchorUnindexedFiles: z.array(z.string()).default([]),
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
    // T-027 R14(d) rules (a)-(f). These are ADDITIONAL to every rule
    // above; the nextActions approve rule stays untouched. All of them
    // range over the entries PRESENT in lensCoverage: the exact-set
    // guarantee (lensCoverage ids === expectedLensIds) lives in
    // complete.ts per R-D3, because the schema cannot see the session.
    // (a) distinct lensIds.
    const coverageIds = new Set<string>();
    for (const entry of val.lensCoverage) {
      if (coverageIds.has(entry.lensId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["lensCoverage"],
          message: `lensCoverage has duplicate entry for lens '${entry.lensId}'`,
        });
      }
      coverageIds.add(entry.lensId);
    }
    const uncovered = val.lensCoverage.filter(
      (e) => !COVERED_STATUSES.has(e.status),
    );
    // (b) core-coverage cap: approve is invalid when any CORE lens
    // entry is outside ok/cached. With R1's disposition order no
    // contributing lens can ever be reported "expired", so this rule
    // can never throw post-finalize on an honest envelope.
    if (val.verdict === "approve") {
      for (const entry of uncovered) {
        if ((CORE_LENS_IDS as readonly string[]).includes(entry.lensId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["verdict"],
            message: `verdict cannot be 'approve' while core lens '${entry.lensId}' has coverage '${entry.status}'`,
          });
        }
      }
    }
    // (c) coverage is 'partial' iff any entry is outside ok/cached.
    const expectPartial = uncovered.length > 0;
    if (expectPartial && val.coverage !== "partial") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["coverage"],
        message: `coverage must be 'partial' when a lensCoverage entry is outside ok/cached`,
      });
    }
    if (!expectPartial && val.coverage !== "full") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["coverage"],
        message: `coverage must be 'full' when every lensCoverage entry is ok/cached`,
      });
    }
    // (d) PARTIAL_RESULTS appears in errorCodes iff any entry expired
    // (timeouts only; merely-awaiting 'skipped' lenses do not fire it).
    const anyExpired = val.lensCoverage.some((e) => e.status === "expired");
    const hasPartialResults = val.errorCodes.includes("PARTIAL_RESULTS");
    if (anyExpired && !hasPartialResults) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["errorCodes"],
        message: `errorCodes must include PARTIAL_RESULTS when a lens expired`,
      });
    }
    if (!anyExpired && hasPartialResults) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["errorCodes"],
        message: `errorCodes must not include PARTIAL_RESULTS without an expired lens`,
      });
    }
    // (e) reality tie: expired/skipped entries contributed nothing.
    for (const entry of val.lensCoverage) {
      if (
        (entry.status === "expired" || entry.status === "skipped") &&
        entry.contributedFindings !== 0
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["lensCoverage"],
          message: `lens '${entry.lensId}' has status '${entry.status}' but contributedFindings=${entry.contributedFindings}`,
        });
      }
    }
    // (f) interim discipline: an interim envelope can never carry
    // approve and is by construction partial.
    if (val.reviewComplete === false) {
      if (val.verdict === "approve") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["verdict"],
          message: `verdict cannot be 'approve' while reviewComplete=false`,
        });
      }
      if (val.coverage !== "partial") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["coverage"],
          message: `coverage must be 'partial' while reviewComplete=false`,
        });
      }
    }
    // T-026 R4(a): anchorRealignedCount is PRE-dedup operational telemetry
    // (server-minted). Enforce only the sound direction: it must be at
    // least the number of EMITTED carriers of anchorRealignedFrom (across
    // both kept findings and deferrals). Strict inequality is legal --
    // dedup can drop a realigned finding that lost the confidence tiebreak.
    const realignedCarriers =
      val.findings.filter((f) => f.anchorRealignedFrom !== undefined).length +
      val.deferred.filter((d) => d.finding.anchorRealignedFrom !== undefined)
        .length;
    if (val.anchorRealignedCount < realignedCarriers) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["anchorRealignedCount"],
        message: `anchorRealignedCount (${val.anchorRealignedCount}) must be >= emitted findings/deferrals carrying anchorRealignedFrom (${realignedCarriers})`,
      });
    }
    // T-026 R4(a) / ACCEPTANCE 4 (amended): evidenceUnverifiedCount is an
    // EXACT mirror of the evidence_unverified deferrals -- those are never
    // deduped, so equality is sound.
    const evidenceUnverifiedDeferrals = val.deferred.filter(
      (d) => d.reason === "evidence_unverified",
    ).length;
    if (val.evidenceUnverifiedCount !== evidenceUnverifiedDeferrals) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evidenceUnverifiedCount"],
        message: `evidenceUnverifiedCount (${val.evidenceUnverifiedCount}) must equal evidence_unverified deferrals (${evidenceUnverifiedDeferrals})`,
      });
    }
    // T-026 R-D4(f): every reviewIntegrity entry's integrityKey matches
    // EXACTLY ONE findings[] member, and no two findings[] members share an
    // integrityKey. Sound because R6 guarantees an integrity-flagged
    // finding's dedup representative is never floor-deferred, and dedup
    // never collapses a finding carrying an integrityKey (R-D4d).
    const keyCounts = new Map<string, number>();
    for (const f of val.findings) {
      if (f.integrityKey !== undefined) {
        keyCounts.set(f.integrityKey, (keyCounts.get(f.integrityKey) ?? 0) + 1);
      }
    }
    for (const [key, count] of keyCounts) {
      if (count > 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["findings"],
          message: `integrityKey '${key}' is shared by ${count} findings (must be unique)`,
        });
      }
    }
    for (const entry of val.reviewIntegrity) {
      const carriers = keyCounts.get(entry.integrityKey) ?? 0;
      if (carriers !== 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["reviewIntegrity"],
          message: `reviewIntegrity key '${entry.integrityKey}' must match exactly one findings[] member (matched ${carriers})`,
        });
      }
    }
  });
export type ReviewVerdict = z.infer<typeof ReviewVerdictSchema>;
