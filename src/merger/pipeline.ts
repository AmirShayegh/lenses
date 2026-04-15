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
  type Severity,
  type Verdict,
} from "../schema/index.js";

import { applyBlockingPolicy } from "./blocking-policy.js";
import { dedupeFindings } from "./dedup.js";

export interface LensRunResult {
  readonly lensId: LensId;
  readonly output: LensOutput;
}

export interface MergerInput {
  readonly reviewId: string;
  readonly perLens: readonly LensRunResult[];
  /** Optional merger-time config (T-011). Absent → `DEFAULT_MERGER_CONFIG`. */
  readonly mergerConfig?: MergerConfig;
}

/**
 * Baseline merger. Deduplicates cross-lens findings by `(file, line,
 * category)` (T-010), counts severities over the post-dedup array, and
 * derives the verdict from severity presence alone. Tensions are always
 * `[]` until T-012 wires in detection.
 *
 * `sessionId` is set to `reviewId` for T-009. T-014 will introduce a
 * distinct session cache where sessionId diverges from reviewId; the
 * tools-complete test pins the current equality so that change is
 * loud, not silent.
 */
export function runMergerPipeline(input: MergerInput): ReviewVerdict {
  const config = input.mergerConfig ?? DEFAULT_MERGER_CONFIG;

  // T-010: collapse findings that share (file, line, category) across
  // lenses. T-011: drop below-floor findings and apply blocking policy.
  // Severity counts drive off the post-policy array because the verdict
  // schema's count invariant must match the emitted findings.
  const deduped = dedupeFindings(input.perLens);
  const findings = applyBlockingPolicy(deduped, config);

  const counts: Record<Severity, number> = {
    blocking: 0,
    major: 0,
    minor: 0,
    suggestion: 0,
  };
  for (const f of findings) {
    counts[f.severity] += 1;
  }

  // Verdict rule (baseline). ReviewVerdictSchema's superRefine
  // enforces `blocking > 0 → verdict === "reject"`; breaking this rule
  // would produce a schema error, not a merger bug. T-011 and T-013
  // will tighten the approve/revise boundary with a blocking policy
  // and category-aware rules respectively.
  const verdict: Verdict =
    counts.blocking > 0
      ? "reject"
      : counts.major > 0
        ? "revise"
        : "approve";

  return {
    verdict,
    findings,
    tensions: [],
    blocking: counts.blocking,
    major: counts.major,
    minor: counts.minor,
    suggestion: counts.suggestion,
    sessionId: input.reviewId,
  };
}
