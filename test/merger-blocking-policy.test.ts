import { describe, expect, it } from "vitest";

import { applyBlockingPolicy } from "../src/merger/blocking-policy.js";
import {
  DEFAULT_MERGER_CONFIG,
  MergerConfigSchema,
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
    description: overrides.description ?? "",
    suggestion: overrides.suggestion ?? "",
    confidence: overrides.confidence ?? 0.8,
    contributingLenses: overrides.contributingLenses ?? ["clean-code"],
  };
}

function withPolicy(
  overrides: Partial<{
    confidenceFloor: number;
    alwaysBlock: string[];
    neverBlock: string[];
  }>,
): MergerConfig {
  return MergerConfigSchema.parse({
    confidenceFloor: overrides.confidenceFloor,
    blockingPolicy: {
      alwaysBlock: overrides.alwaysBlock,
      neverBlock: overrides.neverBlock,
    },
  });
}

describe("applyBlockingPolicy", () => {
  it("empty findings array returns empty regardless of config", () => {
    expect(applyBlockingPolicy([], DEFAULT_MERGER_CONFIG)).toEqual([]);
    expect(
      applyBlockingPolicy(
        [],
        withPolicy({
          confidenceFloor: 0.9,
          alwaysBlock: ["x"],
          neverBlock: ["y"],
        }),
      ),
    ).toEqual([]);
  });

  it("default config keeps findings >= 0.6 confidence and drops < 0.6 (non-alwaysBlock)", () => {
    const kept = mf("minor", { id: "k", category: "style", confidence: 0.6 });
    const dropped = mf("minor", {
      id: "d",
      category: "style",
      confidence: 0.59,
    });
    const out = applyBlockingPolicy([kept, dropped], DEFAULT_MERGER_CONFIG);
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("k");
  });

  it("confidence floor is strict-less-than (exactly 0.6 passes at default)", () => {
    const f = mf("minor", { confidence: 0.6, category: "style" });
    expect(applyBlockingPolicy([f], DEFAULT_MERGER_CONFIG)).toEqual([f]);
  });

  it("alwaysBlock category bypasses the confidence floor and is promoted to blocking", () => {
    // 0.1 confidence 'auth-bypass' would be dropped by the floor in any
    // other category; alwaysBlock saves it AND promotes to blocking.
    const f = mf("suggestion", {
      category: "auth-bypass",
      confidence: 0.1,
      contributingLenses: ["security"],
    });
    const out = applyBlockingPolicy([f], DEFAULT_MERGER_CONFIG);
    expect(out).toHaveLength(1);
    expect(out[0]!.severity).toBe("blocking");
    expect(out[0]!.confidence).toBe(0.1);
  });

  it("alwaysBlock promotes a minor category-matched finding to blocking", () => {
    const f = mf("minor", { category: "injection", confidence: 0.9 });
    const out = applyBlockingPolicy([f], DEFAULT_MERGER_CONFIG);
    expect(out[0]!.severity).toBe("blocking");
  });

  it("neverBlock demotes blocking -> major when ALL contributingLenses are in neverBlock", () => {
    const f = mf("blocking", {
      category: "style",
      confidence: 0.9,
      contributingLenses: ["clean-code", "performance"],
    });
    const out = applyBlockingPolicy(
      [f],
      withPolicy({ neverBlock: ["clean-code", "performance"] }),
    );
    expect(out[0]!.severity).toBe("major");
  });

  it("neverBlock does NOT demote when at least one contributingLens is outside neverBlock", () => {
    const f = mf("blocking", {
      category: "style",
      confidence: 0.9,
      contributingLenses: ["clean-code", "security"],
    });
    const out = applyBlockingPolicy(
      [f],
      withPolicy({ neverBlock: ["clean-code"] }),
    );
    expect(out[0]!.severity).toBe("blocking");
  });

  it("alwaysBlock beats neverBlock when category matches", () => {
    // An injection finding raised only by a neverBlock lens should
    // still end up blocking -- the category is the dominant rule.
    const f = mf("minor", {
      category: "injection",
      confidence: 0.9,
      contributingLenses: ["clean-code"],
    });
    const out = applyBlockingPolicy(
      [f],
      withPolicy({
        alwaysBlock: ["injection"],
        neverBlock: ["clean-code"],
      }),
    );
    expect(out[0]!.severity).toBe("blocking");
  });

  it("neverBlock leaves non-blocking severities alone (major from neverBlock stays major)", () => {
    const f = mf("major", {
      category: "style",
      confidence: 0.9,
      contributingLenses: ["clean-code"],
    });
    const out = applyBlockingPolicy(
      [f],
      withPolicy({ neverBlock: ["clean-code"] }),
    );
    expect(out[0]!.severity).toBe("major");
  });

  it("preserves reference identity when severity is unchanged", () => {
    const f = mf("minor", { category: "style", confidence: 0.9 });
    const out = applyBlockingPolicy([f], DEFAULT_MERGER_CONFIG);
    expect(out[0]).toBe(f);
  });

  it("already-blocking alwaysBlock finding below the floor is kept AND returns the same reference (no-op severity path)", () => {
    // Exercises the interaction between (1) alwaysBlock bypassing the
    // confidence floor and (2) the reference-identity optimization when
    // severity is already blocking and alwaysBlock promotion is a no-op.
    // A refactor that accidentally emits `{ ...f, severity }` in the
    // no-op case would break this assertion.
    const f = mf("blocking", {
      category: "injection",
      confidence: 0.1,
      contributingLenses: ["security"],
    });
    const out = applyBlockingPolicy([f], DEFAULT_MERGER_CONFIG);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(f);
    expect(out[0]!.severity).toBe("blocking");
  });

  it("produces a fresh object when severity changes (does not mutate input)", () => {
    const f = mf("minor", { category: "injection", confidence: 0.9 });
    const inputSeverity = f.severity;
    const out = applyBlockingPolicy([f], DEFAULT_MERGER_CONFIG);
    expect(out[0]).not.toBe(f);
    expect(out[0]!.severity).toBe("blocking");
    expect(f.severity).toBe(inputSeverity); // input untouched
  });

  it("empty alwaysBlock: confidence floor applies to everything, no promotion", () => {
    const keep = mf("minor", { category: "injection", confidence: 0.9 });
    const drop = mf("minor", { category: "injection", confidence: 0.1 });
    const out = applyBlockingPolicy(
      [keep, drop],
      withPolicy({ alwaysBlock: [] }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe(keep.id);
    expect(out[0]!.severity).toBe("minor"); // no promotion
  });

  it("custom confidenceFloor=0.9 drops findings at 0.85", () => {
    const f = mf("major", { category: "style", confidence: 0.85 });
    const out = applyBlockingPolicy([f], withPolicy({ confidenceFloor: 0.9 }));
    expect(out).toHaveLength(0);
  });

  it("contributingLenses content is preserved unchanged by the policy", () => {
    const f = mf("blocking", {
      category: "style",
      confidence: 0.9,
      contributingLenses: ["security", "performance"],
    });
    const out = applyBlockingPolicy(
      [f],
      withPolicy({ neverBlock: ["security", "performance"] }),
    );
    // Demoted, but contributingLenses is verbatim and not a new array ref.
    expect(out[0]!.contributingLenses).toBe(f.contributingLenses);
  });

  it("does not mutate the input array or finding objects", () => {
    const a = mf("minor", { id: "a", category: "injection", confidence: 0.9 });
    const b = mf("major", { id: "b", category: "style", confidence: 0.3 });
    const input: readonly MergedFinding[] = [a, b];
    const snapshot = { aSev: a.severity, bSev: b.severity };
    const out = applyBlockingPolicy(input, DEFAULT_MERGER_CONFIG);
    expect(input).toHaveLength(2); // not mutated
    expect(a.severity).toBe(snapshot.aSev);
    expect(b.severity).toBe(snapshot.bSev);
    // a is promoted to blocking; b is dropped by floor.
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("a");
    expect(out[0]!.severity).toBe("blocking");
  });
});
