/**
 * T-009 merger pipeline baseline. Pure transformation from per-lens
 * outputs to a single `ReviewVerdict`. No module-level state; no I/O.
 *
 * The shape is deliberate: `MergerInput` keeps `perLens` grouped so
 * T-010 (cross-lens dedup), T-011 (blocking policy + confidence
 * filter), T-012 (tension detection), and T-013 (verdict tightening)
 * can drop in as peer modules without reshaping this interface. The
 * `ReviewVerdict` return stays flat because that is the contract with
 * the agent; internal grouping is the merger's business.
 */

import type { LensId } from "../lenses/prompts/index.js";
import {
  DEFAULT_MERGER_CONFIG,
  type LensOutput,
  type MergerConfig,
  type ReviewVerdict,
} from "../schema/index.js";

import { applyBlockingPolicy } from "./blocking-policy.js";
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
   * is per-round, sessionId groups rounds of the same review. Callers
   * that don't care about rounds (baseline tests, one-shot flows) can
   * pass the same UUID for both, but the two values are otherwise
   * independent.
   */
  readonly sessionId: string;
  readonly perLens: readonly LensRunResult[];
  /** Optional merger-time config (T-011). Absent → `DEFAULT_MERGER_CONFIG`. */
  readonly mergerConfig?: MergerConfig;
}

/**
 * Deduplicates cross-lens findings by `(file, line, category)` (T-010),
 * applies the blocking policy (T-011), detects cross-lens tensions
 * (T-012), and delegates severity counting + verdict derivation to
 * `computeVerdict` (T-013). `recommendNextRound` from the computation
 * is intentionally dropped here: the wire schema does not carry it,
 * and the boolean is derivable from `blocking`/`major` on the receiver
 * side if ever needed.
 *
 * `sessionId` passes straight through from `MergerInput.sessionId` to
 * the verdict (T-014). The caller (`complete.ts`) reads it off the
 * stored `ReviewSession`, which was seeded at start-time from the
 * agent's optional `sessionId` input or a fresh UUID.
 */
export function runMergerPipeline(input: MergerInput): ReviewVerdict {
  const config = input.mergerConfig ?? DEFAULT_MERGER_CONFIG;

  const deduped = dedupeFindings(input.perLens);
  const findings = applyBlockingPolicy(deduped, config);
  const tensions = detectTensions(findings);
  const { verdict, counts } = computeVerdict(findings);

  return {
    verdict,
    findings,
    tensions,
    blocking: counts.blocking,
    major: counts.major,
    minor: counts.minor,
    suggestion: counts.suggestion,
    sessionId: input.sessionId,
  };
}
