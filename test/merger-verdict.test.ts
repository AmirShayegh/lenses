import { describe, expect, it } from "vitest";

import { computeVerdict } from "../src/merger/verdict.js";
import type { MergedFinding, Severity } from "../src/schema/index.js";

function mf(
  severity: Severity,
  overrides: Partial<MergedFinding> = {},
): MergedFinding {
  return {
    id: overrides.id ?? `f-${severity}`,
    severity,
    category: overrides.category ?? "generic",
    file: overrides.file === undefined ? "src/x.ts" : overrides.file,
    line: overrides.line === undefined ? 1 : overrides.line,
    description: overrides.description ?? "d",
    suggestion: overrides.suggestion ?? "s",
    confidence: overrides.confidence ?? 0.8,
    contributingLenses: overrides.contributingLenses ?? ["clean-code"],
  };
}

describe("computeVerdict", () => {
  it("empty findings → approve, all counts zero, recommendNextRound=false", () => {
    const out = computeVerdict([]);
    expect(out.verdict).toBe("approve");
    expect(out.counts).toEqual({
      blocking: 0,
      major: 0,
      minor: 0,
      suggestion: 0,
    });
    expect(out.recommendNextRound).toBe(false);
  });

  it("a single suggestion → approve, suggestion=1, no next round", () => {
    const out = computeVerdict([mf("suggestion")]);
    expect(out.verdict).toBe("approve");
    expect(out.counts.suggestion).toBe(1);
    expect(out.recommendNextRound).toBe(false);
  });

  it("a single minor → approve, minor=1, no next round", () => {
    const out = computeVerdict([mf("minor")]);
    expect(out.verdict).toBe("approve");
    expect(out.counts.minor).toBe(1);
    expect(out.recommendNextRound).toBe(false);
  });

  it("a single major → revise, major=1, recommendNextRound=true", () => {
    const out = computeVerdict([mf("major")]);
    expect(out.verdict).toBe("revise");
    expect(out.counts.major).toBe(1);
    expect(out.recommendNextRound).toBe(true);
  });

  it("a single blocking → reject, blocking=1, recommendNextRound=true", () => {
    const out = computeVerdict([mf("blocking")]);
    expect(out.verdict).toBe("reject");
    expect(out.counts.blocking).toBe(1);
    expect(out.recommendNextRound).toBe(true);
  });

  it("mixed: 1 blocking + 1 major + 1 minor + 1 suggestion → reject, all counts 1, recommendNextRound=true", () => {
    const out = computeVerdict([
      mf("blocking", { id: "b" }),
      mf("major", { id: "ma" }),
      mf("minor", { id: "mi" }),
      mf("suggestion", { id: "s" }),
    ]);
    expect(out.verdict).toBe("reject");
    expect(out.counts).toEqual({
      blocking: 1,
      major: 1,
      minor: 1,
      suggestion: 1,
    });
    expect(out.recommendNextRound).toBe(true);
  });

  it("10 minors + 10 suggestions → approve, recommendNextRound=false (volume of non-blocking does NOT trigger another round)", () => {
    const input: MergedFinding[] = [];
    for (let i = 0; i < 10; i++) input.push(mf("minor", { id: `mi-${i}` }));
    for (let i = 0; i < 10; i++)
      input.push(mf("suggestion", { id: `s-${i}` }));
    const out = computeVerdict(input);
    expect(out.verdict).toBe("approve");
    expect(out.counts).toEqual({
      blocking: 0,
      major: 0,
      minor: 10,
      suggestion: 10,
    });
    expect(out.recommendNextRound).toBe(false);
  });

  it("majors only, no blocking → revise, recommendNextRound=true", () => {
    const out = computeVerdict([
      mf("major", { id: "ma-1" }),
      mf("major", { id: "ma-2" }),
    ]);
    expect(out.verdict).toBe("revise");
    expect(out.counts.major).toBe(2);
    expect(out.counts.blocking).toBe(0);
    expect(out.recommendNextRound).toBe(true);
  });

  it("blocking + suggestion → reject (blocking dominates)", () => {
    const out = computeVerdict([
      mf("blocking", { id: "b" }),
      mf("suggestion", { id: "s" }),
    ]);
    expect(out.verdict).toBe("reject");
    expect(out.counts.blocking).toBe(1);
    expect(out.counts.suggestion).toBe(1);
    expect(out.recommendNextRound).toBe(true);
  });

  it("determinism: repeated calls on the same input return deep-equal outputs", () => {
    const input = [mf("major"), mf("minor"), mf("suggestion")];
    const a = computeVerdict(input);
    const b = computeVerdict(input);
    expect(a).toEqual(b);
  });

  it("order-independence: shuffling the input yields the same output", () => {
    const a = computeVerdict([
      mf("blocking", { id: "b" }),
      mf("minor", { id: "mi" }),
      mf("major", { id: "ma" }),
      mf("suggestion", { id: "s" }),
    ]);
    const b = computeVerdict([
      mf("suggestion", { id: "s" }),
      mf("blocking", { id: "b" }),
      mf("major", { id: "ma" }),
      mf("minor", { id: "mi" }),
    ]);
    expect(a).toEqual(b);
  });

  it("does not mutate the input array or its findings", () => {
    const input: readonly MergedFinding[] = [
      mf("major", { id: "ma-1" }),
      mf("minor", { id: "mi-1" }),
    ];
    const snapshot = JSON.stringify(input);
    computeVerdict(input);
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(input).toHaveLength(2);
  });

  it("counts has exactly the four severity keys with number values", () => {
    const { counts } = computeVerdict([mf("minor")]);
    expect(Object.keys(counts).sort()).toEqual([
      "blocking",
      "major",
      "minor",
      "suggestion",
    ]);
    for (const v of Object.values(counts)) expect(typeof v).toBe("number");
  });

  it("counts is a fresh object per call (not.toBe but toEqual)", () => {
    const a = computeVerdict([mf("minor")]);
    const b = computeVerdict([mf("minor")]);
    expect(a.counts).not.toBe(b.counts);
    expect(a.counts).toEqual(b.counts);
  });
});
