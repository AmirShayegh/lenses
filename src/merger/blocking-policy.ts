/**
 * T-011 post-dedup transform, rewritten in T-028 (R2 / R-D1 / R-D4).
 *
 * Applies the merger-time policies to deduplicated findings:
 *
 *  1. Gated alwaysBlock (R2 / R-D1). An `alwaysBlock`-category finding is
 *     evaluated BEFORE the confidence floor. It promotes to `blocking` iff
 *     `confidence >= confidenceFloor` OR the finding has exact-key corroboration
 *     from at least `alwaysBlockQuorum` lenses (`exactKeySupport`, NOT the
 *     adjacency-cluster contributor count -- R-D1). Below the gate the finding
 *     is RETAINED at `major` and tagged `alwaysblock_below_quorum` (surfaced by
 *     the pipeline's audit stage): never a silent reject, never a floor drop.
 *  2. Confidence floor. A non-alwaysBlock finding with `confidence < floor` is
 *     DROPPED into `deferred[]` with reason `below_confidence_floor`.
 *  3. neverBlock demotion. A `blocking` finding whose EVERY contributing lens is
 *     in `neverBlock` is demoted to `major`. One non-muted lens keeps it.
 *
 * Precedence: `alwaysBlock > confidenceFloor > neverBlock`.
 *
 * R-D4 purity: never mutates caller-passed collections. The returned
 * `clampedByPassA` / `escalationLineage` are FRESHLY constructed and re-keyed
 * (via the shared `rebaseInto` helper) for any finding re-allocated on a
 * severity change; `exactKeySupport` is read-only here (terminal consumer,
 * R-D1). No I/O, no module-level state, inputs never mutated.
 */

import type {
  ClampEvent,
  DeferredFinding,
  MergedFinding,
  MergerConfig,
  Severity,
} from "../schema/index.js";
import type { EscalationEvent } from "../schema/review-protocol.js";
import { rebaseInto } from "./clamp.js";
import type { DedupResult } from "./dedup.js";

export interface BlockingPolicyResult {
  readonly kept: MergedFinding[];
  /** DROP-class deferrals produced here (`below_confidence_floor`). */
  readonly deferred: DeferredFinding[];
  /** R-D4: freshly-constructed, rebased Pass A clamp lineage (keys subset of kept). */
  readonly clampedByPassA: Map<MergedFinding, ClampEvent[]>;
  /** Freshly-constructed, rebased escalation lineage carried to Pass B. */
  readonly escalationLineage: Map<MergedFinding, EscalationEvent[]>;
  /** Findings RETAINED at `major` under a failed alwaysBlock quorum gate. */
  readonly alwaysBlockBelowQuorum: Set<MergedFinding>;
}

export function applyBlockingPolicy(
  dedup: DedupResult,
  config: MergerConfig,
): BlockingPolicyResult {
  const alwaysBlockSet = new Set(config.blockingPolicy.alwaysBlock);
  const neverBlockSet = new Set(config.blockingPolicy.neverBlock);
  const quorum = config.blockingPolicy.alwaysBlockQuorum;
  const floor = config.confidenceFloor;

  const kept: MergedFinding[] = [];
  const deferred: DeferredFinding[] = [];
  const clampedByPassA = new Map<MergedFinding, ClampEvent[]>();
  const escalationLineage = new Map<MergedFinding, EscalationEvent[]>();
  const alwaysBlockBelowQuorum = new Set<MergedFinding>();

  const emit = (from: MergedFinding, out: MergedFinding, belowQuorum: boolean) => {
    rebaseInto(clampedByPassA, dedup.clampLineage, from, out);
    rebaseInto(escalationLineage, dedup.escalationLineage, from, out);
    if (belowQuorum) alwaysBlockBelowQuorum.add(out);
    kept.push(out);
  };

  for (const f of dedup.findings) {
    if (alwaysBlockSet.has(f.category)) {
      // R2: evaluate the quorum gate BEFORE the floor (never floor-dropped).
      const support = dedup.exactKeySupport.get(f) ?? 1;
      const gatePass = f.confidence >= floor || support >= quorum;
      const severity: Severity = gatePass ? "blocking" : "major";
      const out: MergedFinding =
        severity === f.severity ? f : { ...f, severity };
      emit(f, out, !gatePass);
      continue;
    }

    if (f.confidence < floor) {
      // DROP (R3): removed from findings[]; snapshot is final for a drop.
      deferred.push({ finding: f, reason: "below_confidence_floor" });
      continue;
    }

    let severity: Severity = f.severity;
    if (
      severity === "blocking" &&
      f.contributingLenses.every((id) => neverBlockSet.has(id))
    ) {
      severity = "major";
    }
    const out: MergedFinding =
      severity === f.severity ? f : { ...f, severity };
    emit(f, out, false);
  }

  return {
    kept,
    deferred,
    clampedByPassA,
    escalationLineage,
    alwaysBlockBelowQuorum,
  };
}
