import { describe, expect, it } from "vitest";

import { applyBlockingPolicy } from "../src/merger/blocking-policy.js";
import type { DedupResult } from "../src/merger/dedup.js";
import {
  DEFAULT_MERGER_CONFIG,
  MergerConfigSchema,
  type ClampEvent,
  type MergedFinding,
  type MergerConfig,
  type Severity,
} from "../src/schema/index.js";

function mf(
  severity: Severity,
  overrides: Partial<MergedFinding> = {},
): MergedFinding {
  return {
    id: overrides.id ?? `f-${severity}`,
    severity,
    category: overrides.category ?? "generic",
    file: overrides.file ?? "src/x.ts",
    line: overrides.line ?? 1,
    description: overrides.description ?? "d",
    suggestion: overrides.suggestion ?? "s",
    confidence: overrides.confidence ?? 0.8,
    contributingLenses: overrides.contributingLenses ?? ["clean-code"],
  };
}

function dedupOf(
  findings: MergedFinding[],
  support?: Map<MergedFinding, number>,
  clamp?: Map<MergedFinding, ClampEvent[]>,
): DedupResult {
  return {
    findings,
    exactKeySupport: support ?? new Map(findings.map((f) => [f, 1])),
    clampLineage: clamp ?? new Map(),
    escalationLineage: new Map(),
  };
}

function withPolicy(
  overrides: Partial<{
    confidenceFloor: number;
    alwaysBlock: string[];
    neverBlock: string[];
    alwaysBlockQuorum: number;
  }>,
): MergerConfig {
  return MergerConfigSchema.parse({
    confidenceFloor: overrides.confidenceFloor,
    blockingPolicy: {
      alwaysBlock: overrides.alwaysBlock,
      neverBlock: overrides.neverBlock,
      alwaysBlockQuorum: overrides.alwaysBlockQuorum,
    },
  });
}

describe("applyBlockingPolicy", () => {
  it("empty findings returns empty kept/deferred/tags", () => {
    const out = applyBlockingPolicy(dedupOf([]), DEFAULT_MERGER_CONFIG);
    expect(out.kept).toEqual([]);
    expect(out.deferred).toEqual([]);
    expect(out.alwaysBlockBelowQuorum.size).toBe(0);
  });

  it("default config keeps findings >= 0.6 confidence and defers < 0.6", () => {
    const keep = mf("minor", { id: "k", category: "style", confidence: 0.6 });
    const dropped = mf("minor", { id: "d", category: "style", confidence: 0.59 });
    const { kept, deferred } = applyBlockingPolicy(
      dedupOf([keep, dropped]),
      DEFAULT_MERGER_CONFIG,
    );
    expect(kept).toHaveLength(1);
    expect(kept[0]!.id).toBe("k");
    expect(deferred).toHaveLength(1);
    expect(deferred[0]!.finding.id).toBe("d");
    expect(deferred[0]!.reason).toBe("below_confidence_floor");
  });

  it("confidence floor is strict-less-than (exactly 0.6 passes)", () => {
    const f = mf("minor", { confidence: 0.6, category: "style" });
    const { kept, deferred } = applyBlockingPolicy(dedupOf([f]), DEFAULT_MERGER_CONFIG);
    expect(kept).toEqual([f]);
    expect(deferred).toEqual([]);
  });

  it("R2: below-quorum alwaysBlock finding surfaces as major + tag, never blocking", () => {
    const f = mf("suggestion", {
      category: "auth-bypass",
      confidence: 0.1,
      contributingLenses: ["security"],
    });
    const { kept, deferred, alwaysBlockBelowQuorum } = applyBlockingPolicy(
      dedupOf([f]),
      DEFAULT_MERGER_CONFIG,
    );
    expect(kept).toHaveLength(1);
    expect(kept[0]!.severity).toBe("major");
    expect(alwaysBlockBelowQuorum.has(kept[0]!)).toBe(true);
    // The tag is surfaced by the pipeline's audit stage, not blocking-policy's
    // deferred[] (which carries DROP entries only).
    expect(deferred).toEqual([]);
  });

  it("alwaysBlock gate passes via confidence >= floor -> blocking", () => {
    const f = mf("minor", { category: "injection", confidence: 0.9 });
    const { kept, alwaysBlockBelowQuorum } = applyBlockingPolicy(
      dedupOf([f]),
      DEFAULT_MERGER_CONFIG,
    );
    expect(kept[0]!.severity).toBe("blocking");
    expect(alwaysBlockBelowQuorum.size).toBe(0);
  });

  it("R-D1: alwaysBlock gate passes via exactKeySupport quorum even below floor", () => {
    const f = mf("suggestion", {
      category: "injection",
      confidence: 0.2,
      contributingLenses: ["security", "concurrency"],
    });
    const support = new Map([[f, 2]]);
    const { kept, alwaysBlockBelowQuorum } = applyBlockingPolicy(
      dedupOf([f], support),
      DEFAULT_MERGER_CONFIG,
    );
    expect(kept[0]!.severity).toBe("blocking");
    expect(alwaysBlockBelowQuorum.size).toBe(0);
  });

  it("neverBlock demotes blocking -> major when ALL contributingLenses are muted", () => {
    const f = mf("blocking", {
      category: "style",
      confidence: 0.9,
      contributingLenses: ["clean-code", "performance"],
    });
    const { kept } = applyBlockingPolicy(
      dedupOf([f]),
      withPolicy({ neverBlock: ["clean-code", "performance"] }),
    );
    expect(kept[0]!.severity).toBe("major");
  });

  it("neverBlock does NOT demote when one contributingLens is outside", () => {
    const f = mf("blocking", {
      category: "style",
      confidence: 0.9,
      contributingLenses: ["clean-code", "security"],
    });
    const { kept } = applyBlockingPolicy(
      dedupOf([f]),
      withPolicy({ neverBlock: ["clean-code"] }),
    );
    expect(kept[0]!.severity).toBe("blocking");
  });

  it("alwaysBlock beats neverBlock when category matches (gate passes)", () => {
    const f = mf("minor", {
      category: "injection",
      confidence: 0.9,
      contributingLenses: ["clean-code"],
    });
    const { kept } = applyBlockingPolicy(
      dedupOf([f]),
      withPolicy({ alwaysBlock: ["injection"], neverBlock: ["clean-code"] }),
    );
    expect(kept[0]!.severity).toBe("blocking");
  });

  it("R9: below-quorum alwaysBlock finding already at major keeps same reference", () => {
    const f = mf("major", {
      category: "injection",
      confidence: 0.1,
      contributingLenses: ["security"],
    });
    const { kept, alwaysBlockBelowQuorum } = applyBlockingPolicy(
      dedupOf([f]),
      DEFAULT_MERGER_CONFIG,
    );
    expect(kept[0]).toBe(f);
    expect(kept[0]!.severity).toBe("major");
    expect(alwaysBlockBelowQuorum.has(f)).toBe(true);
  });

  it("preserves reference identity when severity is unchanged", () => {
    const f = mf("minor", { category: "style", confidence: 0.9 });
    const { kept } = applyBlockingPolicy(dedupOf([f]), DEFAULT_MERGER_CONFIG);
    expect(kept[0]).toBe(f);
  });

  it("produces a fresh object when severity changes (does not mutate input)", () => {
    const f = mf("minor", { category: "injection", confidence: 0.9 });
    const inputSeverity = f.severity;
    const { kept } = applyBlockingPolicy(dedupOf([f]), DEFAULT_MERGER_CONFIG);
    expect(kept[0]).not.toBe(f);
    expect(kept[0]!.severity).toBe("blocking");
    expect(f.severity).toBe(inputSeverity);
  });

  it("empty alwaysBlock: confidence floor applies to everything, no promotion", () => {
    const keep = mf("minor", { category: "injection", confidence: 0.9 });
    const drop = mf("minor", { category: "injection", confidence: 0.1 });
    const { kept, deferred } = applyBlockingPolicy(
      dedupOf([keep, drop]),
      withPolicy({ alwaysBlock: [] }),
    );
    expect(kept).toHaveLength(1);
    expect(kept[0]!.id).toBe(keep.id);
    expect(kept[0]!.severity).toBe("minor");
    expect(deferred).toHaveLength(1);
    expect(deferred[0]!.finding.id).toBe(drop.id);
    expect(deferred[0]!.reason).toBe("below_confidence_floor");
  });

  it("custom confidenceFloor=0.9 defers findings at 0.85", () => {
    const f = mf("major", { category: "style", confidence: 0.85 });
    const { kept, deferred } = applyBlockingPolicy(
      dedupOf([f]),
      withPolicy({ confidenceFloor: 0.9 }),
    );
    expect(kept).toHaveLength(0);
    expect(deferred).toHaveLength(1);
    expect(deferred[0]!.finding).toBe(f);
    expect(deferred[0]!.reason).toBe("below_confidence_floor");
  });

  it("contributingLenses content is preserved unchanged by the policy", () => {
    const f = mf("blocking", {
      category: "style",
      confidence: 0.9,
      contributingLenses: ["security", "performance"],
    });
    const { kept } = applyBlockingPolicy(
      dedupOf([f]),
      withPolicy({ neverBlock: ["security", "performance"] }),
    );
    expect(kept[0]!.contributingLenses).toBe(f.contributingLenses);
  });

  it("R-D4: does not mutate caller-passed clampLineage; returned map keys subset of kept", () => {
    const f = mf("minor", { category: "injection", confidence: 0.9 });
    const clampEvent: ClampEvent = {
      lensId: "clean-code",
      originalSeverity: "blocking",
      clampedSeverity: "major",
      stage: "lens_clamp",
    };
    const caller = new Map<MergedFinding, ClampEvent[]>([[f, [clampEvent]]]);
    const callerSize = caller.size;
    const { kept, clampedByPassA } = applyBlockingPolicy(
      dedupOf([f], undefined, caller),
      DEFAULT_MERGER_CONFIG,
    );
    // Caller map untouched.
    expect(caller.size).toBe(callerSize);
    expect(caller.has(f)).toBe(true);
    // f is re-allocated (minor injection -> blocking); returned map is rebased
    // to the new object, and every key is a member of kept.
    for (const key of clampedByPassA.keys()) {
      expect(kept).toContain(key);
    }
    expect(clampedByPassA.get(kept[0]!)).toEqual([clampEvent]);
  });
});
