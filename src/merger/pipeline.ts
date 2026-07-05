/**
 * T-009 merger pipeline baseline, extended in T-022.
 *
 * Pure transformation from per-lens outputs to a single `ReviewVerdict`.
 * No module-level state; no I/O. Callers hand in both the parsed per-lens
 * outputs AND the parseErrors / nextActions they collected at the per-lens
 * parse boundary in `complete.ts` (we can't re-run the safeParse here, so
 * the contract is "caller classifies what went wrong; merger shapes the
 * verdict").
 *
 * The shape is deliberate: `MergerInput` keeps `perLens` grouped so
 * T-010 (cross-lens dedup), T-011 (blocking policy + confidence filter),
 * T-012 (tension detection), and T-013 (verdict tightening) can drop in
 * as peer modules. The `ReviewVerdict` return stays flat because that is
 * the contract with the agent; internal grouping is the merger's business.
 */

import { CORE_LENS_IDS } from "../lenses/core-lens-ids.js";
import type { LensId } from "../lenses/prompts/index.js";
import {
  COVERED_STATUSES,
  DEFAULT_MERGER_CONFIG,
  type LensCoverageEntry,
  type LensErrorCode,
  type LensOutput,
  type MergedFinding,
  type MergerConfig,
  type NextAction,
  type ParseError,
  type ReviewIntegrityEntry,
  type ReviewVerdict,
} from "../schema/index.js";

import {
  verifyAnchors,
  type AnchoringInput,
} from "./anchor.js";
import { applyBlockingPolicy } from "./blocking-policy.js";

export type { AnchoringInput } from "./anchor.js";
import { dedupeFindings } from "./dedup.js";
import { detectTensions } from "./tension.js";
import { computeVerdict } from "./verdict.js";

export interface LensRunResult {
  readonly lensId: LensId;
  readonly output: LensOutput;
}

export interface MergerInput {
  readonly reviewId: string;
  /**
   * Cross-round series id (T-014). Distinct from `reviewId`: reviewId
   * is per-round, sessionId groups rounds of the same review.
   */
  readonly sessionId: string;
  readonly perLens: readonly LensRunResult[];
  /** Optional merger-time config (T-011). Absent → `DEFAULT_MERGER_CONFIG`. */
  readonly mergerConfig?: MergerConfig;
  /**
   * T-022: parse errors classified by `complete.ts` at the per-lens
   * parse boundary (envelope / finding / internal). Empty when nothing
   * failed validation. The merger surfaces these verbatim in the
   * verdict `parseErrors[]` field rather than constructing a
   * `syntheticError` shape that would later vanish via the dedup
   * `status !== "ok"` filter.
   */
  readonly parseErrors?: readonly ParseError[];
  /**
   * T-022: cooperative-retry instructions emitted by `complete.ts`
   * when a lens returned `status: "error"` with attempt budget
   * remaining, or a finding-shape parse failure is retryable. Empty
   * when nothing is retryable.
   */
  readonly nextActions?: readonly NextAction[];
  /**
   * T-027 R14(d): per-lens coverage disclosure built by
   * `buildLensCoverage` in review-state. When present, the merger
   * derives `coverage` + `errorCodes` from it and applies the
   * core-coverage cap. Absent (legacy callers / unit tests) -> the
   * verdict carries the defaulted empty disclosure and no cap fires.
   */
  readonly lensCoverage?: readonly LensCoverageEntry[];
  /**
   * T-027: false when this envelope is INTERIM (the review stays open:
   * retries pending or expected lenses still uncovered). Interim
   * envelopes can never carry `approve`.
   */
  readonly reviewComplete?: boolean;
  /**
   * T-026: complete-time anchoring context (stage + retained artifact +
   * changedFiles), supplied by `complete.ts` from the ReviewSession. Absent
   * (legacy callers / unit tests) -> the anchor pass runs normalize-only:
   * it strips server-owned finding fields and passes everything else
   * through, a provable no-op for any pre-T-026 input.
   */
  readonly anchoring?: AnchoringInput;
}

/**
 * T-026 (pen resolution 5): the focused integrity assertion. Runs after all
 * post-anchor pipeline stages and BEFORE the verdict schema parse in
 * complete.ts. Verifies every reviewIntegrity key has exactly one carrier in
 * `findings[]`; a violation names the offending key and the stage. This is a
 * server-side invariant break (dedup R-D4d + R6 make it unreachable on honest
 * input), surfaced loudly rather than shipped.
 */
function assertIntegrityCarriers(
  findings: readonly MergedFinding[],
  reviewIntegrity: readonly ReviewIntegrityEntry[],
): void {
  const counts = new Map<string, number>();
  for (const f of findings) {
    if (f.integrityKey !== undefined) {
      counts.set(f.integrityKey, (counts.get(f.integrityKey) ?? 0) + 1);
    }
  }
  for (const entry of reviewIntegrity) {
    const n = counts.get(entry.integrityKey) ?? 0;
    if (n !== 1) {
      throw new Error(
        `anchor integrity invariant [stage=verdict-assembly]: reviewIntegrity key '${entry.integrityKey}' must have exactly one findings[] carrier (found ${n})`,
      );
    }
  }
}

/**
 * T-022: merger emits a richer verdict. Computes `hadAnyFindings` over
 * the RAW per-lens outputs (before dedup / confidence filter / deferral)
 * so the L-003 disambiguation is accurate — "did any lens produce a
 * finding at parse time, regardless of what survived later filtering".
 *
 * Verdict tightening:
 *  - If `nextActions[]` is non-empty AND `computeVerdict` would return
 *    `approve`, downgrade to `revise`. The caller always sees a
 *    "retries pending → try again" signal rather than a false-approve.
 *  - Blocking findings still force `reject` — matches
 *    `ReviewVerdictSchema.superRefine`.
 *
 * `recommendNextRound` from `computeVerdict` is intentionally dropped
 * here: the wire schema does not carry it, and the boolean is derivable
 * from `blocking`/`major` on the receiver side if ever needed.
 */
export function runMergerPipeline(input: MergerInput): ReviewVerdict {
  const config = input.mergerConfig ?? DEFAULT_MERGER_CONFIG;
  const parseErrors: readonly ParseError[] = input.parseErrors ?? [];
  const nextActions: readonly NextAction[] = input.nextActions ?? [];
  const lensCoverage: readonly LensCoverageEntry[] = input.lensCoverage ?? [];
  const reviewComplete = input.reviewComplete ?? true;

  // hadAnyFindings ranges over the RAW per-lens outputs (before the anchor
  // pass, dedup, confidence filter, and deferral) so the L-003
  // disambiguation stays accurate: "did any lens produce a finding at parse
  // time, regardless of what survived later filtering".
  let rawFindingCount = 0;
  for (const { output } of input.perLens) {
    if (output.status === "ok") rawFindingCount += output.findings.length;
  }
  const hadAnyFindings = rawFindingCount > 0;

  // T-026: the anchor pass is the FIRST stage (PRE-dedup). It realigns
  // drifted lines, routes unverifiable findings to survive+flag or
  // evidence_unverified deferral, strips server-owned finding fields, and
  // emits the verdict integrity surface. Normalize-only when `anchoring` is
  // absent.
  const anchor = verifyAnchors({
    perLens: input.perLens,
    ...(input.anchoring !== undefined ? { anchoring: input.anchoring } : {}),
    alwaysBlock: config.blockingPolicy.alwaysBlock,
    confidenceFloor: config.confidenceFloor,
  });

  const deduped = dedupeFindings(anchor.perLens);
  const { kept, deferred: floorDeferred } = applyBlockingPolicy(deduped, config);
  // evidence_unverified deferrals (never deduped) precede the confidence-floor
  // deferrals in the disclosure; suppressedFindingCount mirrors the union.
  const deferred = [...anchor.deferred, ...floorDeferred];
  const tensions = detectTensions(kept);
  const { verdict: baseVerdict, counts } = computeVerdict(kept);

  // Pen resolution 5: assert 1:1 integrity-key carriers before the schema
  // parse (which re-enforces the same tie via superRefine, R-D4f).
  assertIntegrityCarriers(kept, anchor.integrityEntries);

  // T-027 R14(c): coverage + errorCodes derive mechanically from the
  // disclosure so they can never disagree with lensCoverage (the
  // schema's superRefine rules (c)/(d) re-enforce the same tie).
  const anyUncovered = lensCoverage.some(
    (e) => !COVERED_STATUSES.has(e.status),
  );
  const coverage: "full" | "partial" = anyUncovered ? "partial" : "full";
  const anyExpired = lensCoverage.some((e) => e.status === "expired");
  const errorCodes: LensErrorCode[] = anyExpired ? ["PARTIAL_RESULTS"] : [];

  // Verdict caps. Each is a downgrade of `approve` to `revise`; a
  // `reject` (blocking > 0) is never softened.
  //  - retry cap (T-022): retries pending -> never approve.
  //  - core-coverage cap (T-027 DEFECT 2): a CORE lens without a real
  //    contribution (ok/cached) -> never approve. Closes the false
  //    approve when core lenses die.
  //  - interim cap (T-027): an interim envelope -> never approve.
  const coreUncovered = lensCoverage.some(
    (e) =>
      (CORE_LENS_IDS as readonly string[]).includes(e.lensId) &&
      !COVERED_STATUSES.has(e.status),
  );
  const capped =
    nextActions.length > 0 || coreUncovered || !reviewComplete;
  const verdict =
    capped && baseVerdict === "approve" ? "revise" : baseVerdict;

  return {
    verdict,
    findings: kept,
    tensions,
    blocking: counts.blocking,
    major: counts.major,
    minor: counts.minor,
    suggestion: counts.suggestion,
    sessionId: input.sessionId,
    parseErrors: [...parseErrors],
    deferred,
    suppressedFindingCount: deferred.length,
    hadAnyFindings,
    nextActions: [...nextActions],
    lensCoverage: [...lensCoverage],
    coverage,
    errorCodes,
    reviewComplete,
    anchorRealignedCount: anchor.realignedCount,
    evidenceUnverifiedCount: anchor.evidenceUnverifiedCount,
    reviewIntegrity: [...anchor.integrityEntries],
    anchorUnindexedFiles: [...anchor.anchorUnindexedFiles],
  };
}
