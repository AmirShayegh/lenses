/**
 * T-010 cross-lens deduplication, rewritten in T-028.
 *
 * Severity-max, authority-clamped, corroboration-aware dedup. Pipeline order
 * (see pipeline.ts): anchor -> Pass A clamp -> dedup -> blocking policy ->
 * Pass B authority ceiling -> tension -> verdict. This module owns the middle
 * `dedup` box, in four phases:
 *
 *  Phase 0 -- within-lens normalization (pen resolution 2). Collapse each
 *    lens's own duplicate `(file, line, category)` reports to ONE source
 *    BEFORE cross-lens dedup (within-lens winner: highest severity rank, then
 *    highest confidence, then finding id asc). This keeps a single lens from
 *    appearing to corroborate itself: a same-lens severity increase has no
 *    cross-lens support and the confidence floor is evaluated against the
 *    severity-supplying finding itself.
 *  Phase 1 -- exact-key cross-lens dedup (severity-max). Merge across lenses at
 *    each exact `(file, line, category)` key. The representative (id/text/
 *    confidence/server-fields) is the R-C5 total-order winner; the merged
 *    SEVERITY is `max` over members (corroboration escalates, never demotes).
 *    Each representative carries `exactKeySupport` (distinct-lens count, R-D1)
 *    and an internal escalation lineage (pen resolution 1).
 *  Phase 2 -- anchor-window adjacency clustering (R-C4). Within a same-`(file,
 *    category)` group, cluster findings whose lines fall within a 2-line
 *    window of the cluster anchor; NO transitive chaining. `exactKeySupport`
 *    is `max` over members (nearby-line joiners never add corroboration).
 *
 * Composition with T-026 (integrity carriers): a finding carrying
 * `integrityKey` (survived-and-flagged) is NEVER bucketed, normalized, or
 * clustered -- it bypasses every phase as its own singleton, so its
 * integrityKey correlates 1:1 to the kept representative (the pipeline
 * assertion + verdict superRefine depend on this). `file === null` findings
 * likewise bypass (no locality).
 *
 * Pure function: no I/O, no module-level state, inputs never mutated. Merged
 * findings are constructed by SPREADING the winning representative (R14b) so
 * server-owned evidence fields (snippet / anchorRealignedFrom) survive.
 */

import type {
  ClampEvent,
  LensFinding,
  MergedFinding,
} from "../schema/index.js";
import type { EscalationEvent } from "../schema/review-protocol.js";
import { severityFromRank, severityRank, type SeverityRank } from "./clamp.js";
import type { LensRunResult } from "./pipeline.js";

/**
 * Internal shape change authorized by R-C6 (dedup is not on the public
 * surface). `findings` keeps today's insertion-order construction (R-C5 scope
 * fence). The three reference-keyed maps carry per-final-finding lineage to
 * the downstream stages, keyed by the returned `MergedFinding` reference (the
 * same seam as the R4 clamp-metadata carry).
 */
export interface DedupResult {
  readonly findings: MergedFinding[];
  /** R-D1: exact `(file, line, category)` corroboration count per finding. */
  readonly exactKeySupport: ReadonlyMap<MergedFinding, number>;
  /** R4: Pass A `lens_clamp` events reaching this final finding. */
  readonly clampLineage: ReadonlyMap<MergedFinding, ClampEvent[]>;
  /** Pen resolution 1: cross-lens severity-escalation source events. */
  readonly escalationLineage: ReadonlyMap<MergedFinding, EscalationEvent[]>;
}

interface Source {
  readonly lensId: string;
  readonly finding: LensFinding;
}

/** `\x00` separator so ("a", 12, "b") and ("a1", 2, "b") never alias. */
function keyOf(f: LensFinding): string {
  return `${f.file}\x00${f.line ?? ""}\x00${f.category}`;
}

/**
 * R-C5 total order for cross-lens winner/representative selection: confidence
 * desc, then (post-Pass-A) severity rank desc, then tiebreak lens id asc, then
 * finding id asc. Returns <0 when `a` should win.
 */
function compareRep(
  a: { confidence: number; rank: SeverityRank; lensId: string; id: string },
  b: { confidence: number; rank: SeverityRank; lensId: string; id: string },
): number {
  if (a.confidence !== b.confidence) return b.confidence - a.confidence;
  if (a.rank !== b.rank) return b.rank - a.rank;
  if (a.lensId !== b.lensId) return a.lensId < b.lensId ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

/** Lexicographically smallest contributing lens id (cluster-phase tiebreak). */
function smallestLens(lensIds: readonly string[]): string {
  let best: string | undefined;
  for (const id of lensIds) if (best === undefined || id < best) best = id;
  return best ?? "";
}

/**
 * Phase 0: within-lens winner among same-`(lensId, key)` findings -- highest
 * severity rank, then highest confidence, then finding id asc. The severity
 * increase from collapsing here is NOT cross-lens corroboration.
 */
function withinLensNormalize(sources: readonly Source[]): Source[] {
  const byLensKey = new Map<string, Source>();
  const order: string[] = [];
  for (const s of sources) {
    const composite = `${s.lensId}\x00${keyOf(s.finding)}`;
    const existing = byLensKey.get(composite);
    if (existing === undefined) {
      byLensKey.set(composite, s);
      order.push(composite);
      continue;
    }
    // Within-lens: severity rank first, then confidence, then id asc.
    const er = severityRank(existing.finding.severity);
    const sr = severityRank(s.finding.severity);
    let winner = existing;
    if (
      sr > er ||
      (sr === er && s.finding.confidence > existing.finding.confidence) ||
      (sr === er &&
        s.finding.confidence === existing.finding.confidence &&
        s.finding.id < existing.finding.id)
    ) {
      winner = s;
    }
    byLensKey.set(composite, winner);
  }
  return order.map((k) => byLensKey.get(k)!);
}

export function dedupeFindings(
  perLens: readonly LensRunResult[],
  passAClampMeta: ReadonlyMap<LensFinding, ClampEvent> = new Map(),
): DedupResult {
  const findings: MergedFinding[] = [];
  const exactKeySupport = new Map<MergedFinding, number>();
  const clampLineage = new Map<MergedFinding, ClampEvent[]>();
  const escalationLineage = new Map<MergedFinding, EscalationEvent[]>();
  // Representative lens per final finding (Phase-2 escalation attribution).
  const repLensId = new Map<MergedFinding, string>();

  const clampFor = (f: LensFinding): ClampEvent[] => {
    const e = passAClampMeta.get(f);
    return e === undefined ? [] : [e];
  };

  // Ungrouped: null-file + integrity-flagged findings bypass every phase.
  const keyedSources: Source[] = [];
  for (const { lensId, output } of perLens) {
    if (output.status !== "ok") continue;
    for (const f of output.findings) {
      if (f.file === null || f.integrityKey !== undefined) {
        const merged = spreadRep(f, [lensId], f.severity);
        findings.push(merged);
        exactKeySupport.set(merged, 1);
        if (passAClampMeta.get(f) !== undefined)
          clampLineage.set(merged, clampFor(f));
        repLensId.set(merged, lensId);
        continue;
      }
      keyedSources.push({ lensId, finding: f });
    }
  }

  // Phase 0 -> Phase 1: within-lens normalize, then bucket by exact key.
  const normalized = withinLensNormalize(keyedSources);
  const buckets = new Map<string, Source[]>();
  const bucketOrder: string[] = [];
  for (const s of normalized) {
    const key = keyOf(s.finding);
    const bucket = buckets.get(key);
    if (bucket === undefined) {
      buckets.set(key, [s]);
      bucketOrder.push(key);
    } else {
      bucket.push(s);
    }
  }

  interface Phase1 {
    readonly merged: MergedFinding;
    readonly support: number;
    readonly clamp: ClampEvent[];
    readonly escal: EscalationEvent[];
    readonly repLens: string;
    readonly order: number;
  }
  const phase1: Phase1[] = [];
  for (const key of bucketOrder) {
    const members = buckets.get(key)!;
    // Representative (id/text/confidence/server-fields) = R-C5 winner.
    let winner = members[0]!;
    for (const m of members.slice(1)) {
      if (
        compareRep(
          {
            confidence: m.finding.confidence,
            rank: severityRank(m.finding.severity),
            lensId: m.lensId,
            id: m.finding.id,
          },
          {
            confidence: winner.finding.confidence,
            rank: severityRank(winner.finding.severity),
            lensId: winner.lensId,
            id: winner.finding.id,
          },
        ) < 0
      ) {
        winner = m;
      }
    }
    // Severity = max over members; contributingLenses first-seen distinct.
    let maxRank: SeverityRank = severityRank(winner.finding.severity);
    const contributingLenses: string[] = [];
    for (const m of members) {
      const r = severityRank(m.finding.severity);
      if (r > maxRank) maxRank = r;
      if (!contributingLenses.includes(m.lensId))
        contributingLenses.push(m.lensId);
    }
    const merged = spreadRep(
      winner.finding,
      contributingLenses,
      severityFromRank(maxRank),
    );
    // Escalation lineage (pen resolution 1, reading: max-supplying members
    // that RAISED the representative -- empty when the winner already held
    // the max, so a never-escalated winner emits no corroboration record).
    const escal: EscalationEvent[] = [];
    if (maxRank > severityRank(winner.finding.severity)) {
      for (const m of members) {
        if (severityRank(m.finding.severity) !== maxRank) continue;
        escal.push({
          lensId: m.lensId,
          findingId: m.finding.id,
          severity: m.finding.severity,
          confidence: m.finding.confidence,
        });
      }
    }
    // Clamp lineage = union of every member's Pass A lens_clamp event (log
    // every clamp, even when another lens supplies the surviving severity).
    const clamp: ClampEvent[] = [];
    for (const m of members) clamp.push(...clampFor(m.finding));
    phase1.push({
      merged,
      support: contributingLenses.length,
      clamp,
      escal,
      repLens: winner.lensId,
      order: phase1.length,
    });
  }

  // Phase 2: anchor-window adjacency clustering within same (file, category).
  // pen resolution 5: a single-member cluster is returned as its Phase-1
  // representative BY REFERENCE, so its lineage keys are never orphaned.
  const groups = new Map<string, Phase1[]>();
  const groupOrder: string[] = [];
  for (const p of phase1) {
    const f = p.merged;
    // Only findings with a concrete line participate in adjacency.
    const groupKey =
      f.file !== null && f.line !== null
        ? `${f.file}\x00${f.category}`
        : `__solo__\x00${p.order}`;
    const g = groups.get(groupKey);
    if (g === undefined) {
      groups.set(groupKey, [p]);
      groupOrder.push(groupKey);
    } else {
      g.push(p);
    }
  }

  const finalReps: Array<{ rep: Phase1; order: number }> = [];
  for (const groupKey of groupOrder) {
    const g = groups.get(groupKey)!;
    if (g.length === 1) {
      finalReps.push({ rep: g[0]!, order: g[0]!.order });
      continue;
    }
    // Sort by line asc (each line appears once after Phase 1); anchor-window
    // clustering, no transitive chaining -- a new cluster opens at the first
    // finding beyond anchorLine + 2.
    const sorted = [...g].sort((a, b) => (a.merged.line ?? 0) - (b.merged.line ?? 0));
    let cluster: Phase1[] = [];
    let anchorLine = 0;
    const flush = () => {
      if (cluster.length === 0) return;
      finalReps.push({
        rep: mergeCluster(cluster),
        order: Math.min(...cluster.map((c) => c.order)),
      });
      cluster = [];
    };
    for (const p of sorted) {
      const line = p.merged.line ?? 0;
      if (cluster.length === 0) {
        cluster = [p];
        anchorLine = line;
      } else if (line - anchorLine <= 2) {
        cluster.push(p);
      } else {
        flush();
        cluster = [p];
        anchorLine = line;
      }
    }
    flush();
  }

  // Emit final findings in Phase-1 insertion order (R-C5 output-order fence).
  finalReps.sort((a, b) => a.order - b.order);
  for (const { rep } of finalReps) {
    findings.push(rep.merged);
    exactKeySupport.set(rep.merged, rep.support);
    if (rep.clamp.length > 0) clampLineage.set(rep.merged, rep.clamp);
    if (rep.escal.length > 0) escalationLineage.set(rep.merged, rep.escal);
    repLensId.set(rep.merged, rep.repLens);
  }

  return { findings, exactKeySupport, clampLineage, escalationLineage };

  /** Merge an adjacency cluster of Phase-1 representatives into one. */
  function mergeCluster(members: Phase1[]): Phase1 {
    // Cluster representative = R-C5 winner (cluster tiebreak = smallest
    // contributing lens id).
    let winner = members[0]!;
    for (const m of members.slice(1)) {
      if (
        compareRep(
          {
            confidence: m.merged.confidence,
            rank: severityRank(m.merged.severity),
            lensId: smallestLens(m.merged.contributingLenses),
            id: m.merged.id,
          },
          {
            confidence: winner.merged.confidence,
            rank: severityRank(winner.merged.severity),
            lensId: smallestLens(winner.merged.contributingLenses),
            id: winner.merged.id,
          },
        ) < 0
      ) {
        winner = m;
      }
    }
    let maxRank: SeverityRank = severityRank(winner.merged.severity);
    const contributingLenses: string[] = [];
    let support = 0;
    const clamp: ClampEvent[] = [];
    for (const m of members) {
      const r = severityRank(m.merged.severity);
      if (r > maxRank) maxRank = r;
      if (m.support > support) support = m.support; // R-D1: max, not sum
      for (const lens of m.merged.contributingLenses)
        if (!contributingLenses.includes(lens)) contributingLenses.push(lens);
      clamp.push(...m.clamp);
    }
    const merged = spreadRep(
      winner.merged,
      contributingLenses,
      severityFromRank(maxRank),
    );
    // Escalation lineage (pen resolution 1): carried members' lineages
    // re-filtered to max-rank suppliers (never discarded on the else branch),
    // plus NEW cluster-level events when the cluster raised the winner.
    const seen = new Set<string>();
    const escal: EscalationEvent[] = [];
    const add = (e: EscalationEvent) => {
      const k = `${e.lensId}\x00${e.findingId}`;
      if (!seen.has(k)) {
        seen.add(k);
        escal.push(e);
      }
    };
    for (const m of members)
      for (const e of m.escal)
        if (severityRank(e.severity) === maxRank) add(e);
    if (maxRank > severityRank(winner.merged.severity)) {
      for (const m of members) {
        if (severityRank(m.merged.severity) !== maxRank) continue;
        if (m === winner) continue;
        add({
          lensId: m.repLens,
          findingId: m.merged.id,
          severity: m.merged.severity,
          confidence: m.merged.confidence,
        });
      }
    }
    return {
      merged,
      support,
      clamp,
      escal,
      repLens: winner.repLens,
      order: Math.min(...members.map((m) => m.order)),
    };
  }
}

/**
 * Build a merged finding by SPREADING the winning representative (R14b) so
 * fields added by other wave items (e.g. T-026 snippet / anchorRealignedFrom)
 * survive without per-field enumeration. The winner's `id` identifies the
 * surviving representative, not a new entity.
 */
function spreadRep(
  base: LensFinding | MergedFinding,
  contributingLenses: readonly string[],
  severity: MergedFinding["severity"],
): MergedFinding {
  // Drop any pre-existing contributingLenses on the base before re-attaching.
  const { contributingLenses: _drop, ...rest } = base as MergedFinding;
  return {
    ...rest,
    severity,
    contributingLenses: contributingLenses as MergedFinding["contributingLenses"],
  };
}
