/**
 * T-028 authority clamps (R1 / R-C1 / R-C3 / R-D2 / R-D4).
 *
 * Two passes cap a finding's severity to the AUTHORITY of the lens(es) that
 * raised it, so no lens can launder an out-of-authority severity through the
 * merger:
 *
 *  - Pass A `clampLensFindings`: runs BEFORE severity-max dedup. Clamps each
 *    lens finding to its OWN `LENSES[lensId].maxSeverity`, so every severity
 *    entering dedup is within its supplier's authority. One-way (only demotes).
 *  - Pass B `enforceAuthorityCeiling`: the FINAL authority clamp (R-C1), run
 *    AFTER all policy transforms (confidence floor, alwaysBlock gate, neverBlock
 *    demotion). Caps ANY severity whose rank exceeds the max ceiling over the
 *    finding's `contributingLenses`. One-way. Every demotion is logged as a
 *    `severity_clamped_to_lens_max` RETAINED audit (R3/R4), coalesced to one
 *    entry per final finding (R-C1).
 *
 * Ceiling resolution fails CLOSED (R-C3): an unknown lens id resolves to the
 * LOWEST ceiling (`suggestion`), so a direct `runMergerPipeline` caller can
 * never manufacture verdict-driving severity from an unvalidated id. (Unknown
 * ids cannot reach here through the tool boundary; this is defense-in-depth.)
 *
 * Purity: no I/O, no module-level mutable state, inputs never mutated.
 */

import { LENSES, type LensDefinition } from "../lenses/prompts/index.js";
import type {
  ClampEvent,
  LensFinding,
  MergedFinding,
  Severity,
} from "../schema/index.js";
// EscalationEvent is deliberately NOT surfaced from the schema barrel (pen
// resolution 4 export fence); the internal merger modules import the type
// directly from the leaf module.
import type { EscalationEvent } from "../schema/review-protocol.js";
import type { LensRunResult } from "./pipeline.js";

/** R6: no raw numeric indexing into a severity-rank array. */
export type SeverityRank = 0 | 1 | 2 | 3;

const RANK_BY_SEVERITY: Readonly<Record<Severity, SeverityRank>> = {
  suggestion: 0,
  minor: 1,
  major: 2,
  blocking: 3,
};

export function severityRank(s: Severity): SeverityRank {
  return RANK_BY_SEVERITY[s];
}

/** R6: exhaustive rank -> severity mapping (typechecks under noUncheckedIndexedAccess). */
export function severityFromRank(rank: SeverityRank): Severity {
  switch (rank) {
    case 0:
      return "suggestion";
    case 1:
      return "minor";
    case 2:
      return "major";
    case 3:
      return "blocking";
  }
}

/** Injectable ceiling resolver (R-C1): lens id -> its severity ceiling. */
export type CeilingResolver = (lensId: string) => Severity;

/**
 * Default registry-backed resolver (R6 widened lookup + R-C3 fail-closed).
 * An unknown lens id resolves to `suggestion`, the lowest ceiling.
 */
export const registryCeilingFor: CeilingResolver = (lensId) =>
  (LENSES as Record<string, LensDefinition | undefined>)[lensId]?.maxSeverity ??
  "suggestion";

/** Max ceiling RANK over the given lenses (R-C1 `maxCeilingRank`). */
export function maxCeilingRank(
  lensIds: readonly string[],
  ceilingFor: CeilingResolver,
): SeverityRank {
  let max: SeverityRank = 0;
  for (const id of lensIds) {
    const r = severityRank(ceilingFor(id));
    if (r > max) max = r;
  }
  return max;
}

/**
 * The contributor that supplies the governing ceiling (R-D2 event lensId):
 * the lexicographically smallest lens whose ceiling rank equals `maxRank`.
 */
function governingCeilingLens(
  lensIds: readonly string[],
  ceilingFor: CeilingResolver,
  maxRank: SeverityRank,
): string {
  let best: string | undefined;
  for (const id of lensIds) {
    if (severityRank(ceilingFor(id)) !== maxRank) continue;
    if (best === undefined || id < best) best = id;
  }
  // `maxRank` is derived from `lensIds`, so at least one supporter exists;
  // fall back to the first id defensively (never reached on honest input).
  return best ?? lensIds[0] ?? "";
}

/**
 * R-D4 identity-rebase: the SINGLE seam every stage that re-allocates a
 * finding object shares. Copies `from`'s entry (if any) onto `to` in the
 * caller's FRESH `target` map so reference-keyed lineage (clamp events,
 * escalation events, exactKeySupport, retained tags) follows the new object.
 * Never mutates the read-only `source`. Exported from no barrel.
 */
export function rebaseInto<V>(
  target: Map<MergedFinding, V>,
  source: ReadonlyMap<MergedFinding, V>,
  from: MergedFinding,
  to: MergedFinding,
): void {
  const v = source.get(from);
  if (v !== undefined) target.set(to, v);
}

export interface PassAResult {
  /** Clamped per-lens outputs feeding within-lens normalization + dedup. */
  readonly perLens: LensRunResult[];
  /**
   * One `lens_clamp` event per clamped source, keyed by the OUTPUT (clamped)
   * finding reference so dedup can consult it while buckets are built (R4).
   */
  readonly clampMeta: Map<LensFinding, ClampEvent>;
}

/**
 * Pass A (R1): clamp each lens finding to its own lens ceiling BEFORE dedup.
 * Reference identity is preserved on a no-op (R9 convention). Never mutates
 * the input.
 */
export function clampLensFindings(
  perLens: readonly LensRunResult[],
  ceilingFor: CeilingResolver = registryCeilingFor,
): PassAResult {
  const clampMeta = new Map<LensFinding, ClampEvent>();
  const out: LensRunResult[] = [];
  for (const { lensId, output } of perLens) {
    if (output.status !== "ok") {
      out.push({ lensId, output });
      continue;
    }
    const ceiling = ceilingFor(lensId);
    const ceilingR = severityRank(ceiling);
    const findings: LensFinding[] = [];
    for (const f of output.findings) {
      if (severityRank(f.severity) > ceilingR) {
        const clamped: LensFinding = { ...f, severity: ceiling };
        findings.push(clamped);
        clampMeta.set(clamped, {
          lensId,
          originalSeverity: f.severity,
          clampedSeverity: ceiling,
          stage: "lens_clamp",
        });
      } else {
        findings.push(f); // no-op: reference preserved
      }
    }
    out.push({ lensId, output: { ...output, findings } });
  }
  return { perLens: out, clampMeta };
}

export interface PassBResult {
  readonly kept: MergedFinding[];
  /** Fresh, rebased clamp lineage (Pass A events + any Pass B event). */
  readonly clampLineage: Map<MergedFinding, ClampEvent[]>;
  /** Fresh, rebased escalation lineage carried to the emit stage. */
  readonly escalationLineage: Map<MergedFinding, EscalationEvent[]>;
  /** Fresh, rebased set of findings tagged `alwaysblock_below_quorum` (R-C1 rebase). */
  readonly alwaysBlockBelowQuorum: Set<MergedFinding>;
}

/**
 * Pass B (R-C1): the FINAL authority clamp. Caps ANY severity whose rank
 * exceeds `maxCeilingRank(contributingLenses)`. One-way. On a demotion,
 * appends exactly one `authority_ceiling` event to the finding's carried
 * clamp lineage and re-keys all carried lineage/tags to the new object via
 * the shared rebase helper. Within-ceiling findings pass through BY REFERENCE
 * (R-C1(2) / R9). Never mutates its inputs (R-D4).
 */
export function enforceAuthorityCeiling(
  findings: readonly MergedFinding[],
  carriedClampLineage: ReadonlyMap<MergedFinding, ClampEvent[]>,
  carriedEscalationLineage: ReadonlyMap<MergedFinding, EscalationEvent[]>,
  carriedAlwaysBlock: ReadonlySet<MergedFinding>,
  ceilingFor: CeilingResolver = registryCeilingFor,
): PassBResult {
  const kept: MergedFinding[] = [];
  const clampLineage = new Map<MergedFinding, ClampEvent[]>();
  const escalationLineage = new Map<MergedFinding, EscalationEvent[]>();
  const alwaysBlockBelowQuorum = new Set<MergedFinding>();

  for (const f of findings) {
    const ceilingR = maxCeilingRank(f.contributingLenses, ceilingFor);
    let out = f;
    if (severityRank(f.severity) > ceilingR) {
      const ceiling = severityFromRank(ceilingR);
      out = { ...f, severity: ceiling };
      const event: ClampEvent = {
        lensId: governingCeilingLens(f.contributingLenses, ceilingFor, ceilingR),
        originalSeverity: f.severity,
        clampedSeverity: ceiling,
        stage: "authority_ceiling",
      };
      const prior = carriedClampLineage.get(f) ?? [];
      clampLineage.set(out, [...prior, event]);
    } else {
      const prior = carriedClampLineage.get(f);
      if (prior !== undefined) clampLineage.set(out, prior);
    }
    rebaseInto(escalationLineage, carriedEscalationLineage, f, out);
    if (carriedAlwaysBlock.has(f)) alwaysBlockBelowQuorum.add(out);
    kept.push(out);
  }

  return { kept, clampLineage, escalationLineage, alwaysBlockBelowQuorum };
}
