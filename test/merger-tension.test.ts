import { describe, expect, it } from "vitest";

import { LENSES, type LensId } from "../src/lenses/prompts/index.js";
import {
  TENSION_PAIRS,
  detectTensions,
  type TensionPair,
} from "../src/merger/tension.js";
import type { MergedFinding } from "../src/schema/index.js";

function mf(overrides: Partial<MergedFinding> = {}): MergedFinding {
  return {
    id: overrides.id ?? "f",
    severity: overrides.severity ?? "minor",
    category: overrides.category ?? "generic",
    file: overrides.file === undefined ? "src/x.ts" : overrides.file,
    line: overrides.line === undefined ? 1 : overrides.line,
    description: overrides.description ?? "d",
    suggestion: overrides.suggestion ?? "s",
    confidence: overrides.confidence ?? 0.8,
    contributingLenses: overrides.contributingLenses ?? ["clean-code"],
  };
}

describe("detectTensions", () => {
  it("returns [] for empty findings", () => {
    expect(detectTensions([])).toEqual([]);
  });

  it("returns [] when only a single lens's findings are present (no pair partner)", () => {
    const out = detectTensions([
      mf({ id: "s1", category: "c1", contributingLenses: ["security"] }),
      mf({ id: "s2", category: "c2", contributingLenses: ["security"] }),
    ]);
    expect(out).toEqual([]);
  });

  it("returns [] when lens pair is not in TENSION_PAIRS (e.g. security + api-design)", () => {
    const out = detectTensions([
      mf({ id: "a", category: "c1", contributingLenses: ["security"] }),
      mf({ id: "b", category: "c2", contributingLenses: ["api-design"] }),
    ]);
    expect(out).toEqual([]);
  });

  it("emits one security-vs-performance tension when both lenses raise different categories at the same file", () => {
    const out = detectTensions([
      mf({
        id: "s",
        category: "auth",
        file: "src/auth.ts",
        contributingLenses: ["security"],
      }),
      mf({
        id: "p",
        category: "hot-path",
        file: "src/auth.ts",
        contributingLenses: ["performance"],
      }),
    ]);
    expect(out).toHaveLength(1);
    const [t] = out;
    expect(t!.category).toBe("security-vs-performance");
    expect(t!.lenses).toEqual(["security", "performance"]);
    expect(t!.summary).toContain("src/auth.ts");
  });

  it("returns [] when security and performance findings are at DIFFERENT files", () => {
    const out = detectTensions([
      mf({
        id: "s",
        file: "src/a.ts",
        category: "auth",
        contributingLenses: ["security"],
      }),
      mf({
        id: "p",
        file: "src/b.ts",
        category: "hot-path",
        contributingLenses: ["performance"],
      }),
    ]);
    expect(out).toEqual([]);
  });

  it("emits two tensions in pair-table order when security + performance + error-handling co-locate", () => {
    // At the same file: security-vs-performance must come BEFORE
    // error-handling-vs-performance per TENSION_PAIRS order.
    const out = detectTensions([
      mf({
        id: "s",
        file: "src/x.ts",
        category: "auth",
        contributingLenses: ["security"],
      }),
      mf({
        id: "p",
        file: "src/x.ts",
        category: "hot-path",
        contributingLenses: ["performance"],
      }),
      mf({
        id: "e",
        file: "src/x.ts",
        category: "retry",
        contributingLenses: ["error-handling"],
      }),
    ]);
    expect(out.map((t) => t.category)).toEqual([
      "security-vs-performance",
      "error-handling-vs-performance",
    ]);
  });

  it("returns [] when only one lens of a pair is present (two security findings, no performance)", () => {
    const out = detectTensions([
      mf({
        id: "s1",
        file: "src/x.ts",
        category: "auth",
        contributingLenses: ["security"],
      }),
      mf({
        id: "s2",
        file: "src/x.ts",
        category: "crypto",
        contributingLenses: ["security"],
      }),
    ]);
    expect(out).toEqual([]);
  });

  it("returns [] for pure agreement: single finding with both lenses attributed (no dissent)", () => {
    const out = detectTensions([
      mf({
        id: "agree",
        file: "src/x.ts",
        category: "auth",
        contributingLenses: ["security", "performance"],
      }),
    ]);
    expect(out).toEqual([]);
  });

  it("emits a tension when agreement coexists with solo dissent on both sides", () => {
    const out = detectTensions([
      mf({
        id: "agree",
        file: "src/x.ts",
        category: "auth",
        contributingLenses: ["security", "performance"],
      }),
      mf({
        id: "s-solo",
        file: "src/x.ts",
        category: "crypto",
        contributingLenses: ["security"],
      }),
      mf({
        id: "p-solo",
        file: "src/x.ts",
        category: "hot-path",
        contributingLenses: ["performance"],
      }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.category).toBe("security-vs-performance");
  });

  it("returns [] when only one side dissents (agreement + security-solo, no performance-solo)", () => {
    // Locks in the negative path for the strict cross-attribution rule.
    // Protects against a refactor that collapses the two `.some()` calls.
    const out = detectTensions([
      mf({
        id: "agree",
        file: "src/x.ts",
        category: "auth",
        contributingLenses: ["security", "performance"],
      }),
      mf({
        id: "s-solo",
        file: "src/x.ts",
        category: "crypto",
        contributingLenses: ["security"],
      }),
    ]);
    expect(out).toEqual([]);
  });

  it("emits an artifact-level tension when both lenses raise null-file findings", () => {
    const out = detectTensions([
      mf({
        id: "s",
        file: null,
        line: null,
        category: "broad-security",
        contributingLenses: ["security"],
      }),
      mf({
        id: "p",
        file: null,
        line: null,
        category: "broad-perf",
        contributingLenses: ["performance"],
      }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.category).toBe("security-vs-performance");
    expect(out[0]!.summary).toContain("artifact-level");
  });

  it("sorts tensions across multiple files lexicographically", () => {
    const out = detectTensions([
      mf({
        id: "sB",
        file: "src/b.ts",
        category: "auth",
        contributingLenses: ["security"],
      }),
      mf({
        id: "pB",
        file: "src/b.ts",
        category: "hot",
        contributingLenses: ["performance"],
      }),
      mf({
        id: "sA",
        file: "src/a.ts",
        category: "auth",
        contributingLenses: ["security"],
      }),
      mf({
        id: "pA",
        file: "src/a.ts",
        category: "hot",
        contributingLenses: ["performance"],
      }),
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]!.summary).toContain("src/a.ts");
    expect(out[1]!.summary).toContain("src/b.ts");
  });

  it("places concrete-file tensions before artifact-level tensions", () => {
    const out = detectTensions([
      // artifact-level pair
      mf({
        id: "sNull",
        file: null,
        line: null,
        category: "x",
        contributingLenses: ["security"],
      }),
      mf({
        id: "pNull",
        file: null,
        line: null,
        category: "y",
        contributingLenses: ["performance"],
      }),
      // concrete pair
      mf({
        id: "sFile",
        file: "src/a.ts",
        category: "auth",
        contributingLenses: ["security"],
      }),
      mf({
        id: "pFile",
        file: "src/a.ts",
        category: "hot",
        contributingLenses: ["performance"],
      }),
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]!.summary).toContain("src/a.ts");
    expect(out[1]!.summary).toContain("artifact-level");
  });

  it("is deterministic across repeated runs on the same input", () => {
    const input: MergedFinding[] = [
      mf({
        id: "s",
        file: "src/x.ts",
        category: "auth",
        contributingLenses: ["security"],
      }),
      mf({
        id: "p",
        file: "src/x.ts",
        category: "hot",
        contributingLenses: ["performance"],
      }),
    ];
    const a = detectTensions(input);
    const b = detectTensions(input);
    expect(a).toEqual(b);
  });

  it("does not mutate the input array or its findings", () => {
    const s = mf({
      id: "s",
      file: "src/x.ts",
      category: "auth",
      contributingLenses: ["security"],
    });
    const p = mf({
      id: "p",
      file: "src/x.ts",
      category: "hot",
      contributingLenses: ["performance"],
    });
    const snapshot = JSON.stringify([s, p]);
    const input: readonly MergedFinding[] = [s, p];
    detectTensions(input);
    expect(input).toHaveLength(2);
    expect(JSON.stringify([s, p])).toBe(snapshot);
  });
});

describe("TENSION_PAIRS structural invariants", () => {
  it("each pair has distinct lensA and lensB", () => {
    for (const p of TENSION_PAIRS) {
      expect(p.lensA).not.toBe(p.lensB);
    }
  });

  it("every lens id in the table exists in LENSES", () => {
    const known = new Set<string>(Object.keys(LENSES));
    for (const p of TENSION_PAIRS) {
      expect(known.has(p.lensA)).toBe(true);
      expect(known.has(p.lensB)).toBe(true);
    }
  });

  it("labels are distinct across the table", () => {
    const labels = TENSION_PAIRS.map((p) => p.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("emitted tension.lenses is exactly [lensA, lensB] (length 2, order preserved)", () => {
    // Drive one tension per pair to lock in emission shape.
    const findings: MergedFinding[] = [];
    TENSION_PAIRS.forEach((pair: TensionPair, i: number) => {
      const file = `src/p${i}.ts`;
      findings.push(
        mf({
          id: `a-${i}`,
          file,
          category: `cat-a-${i}`,
          contributingLenses: [pair.lensA as LensId],
        }),
      );
      findings.push(
        mf({
          id: `b-${i}`,
          file,
          category: `cat-b-${i}`,
          contributingLenses: [pair.lensB as LensId],
        }),
      );
    });
    const out = detectTensions(findings);
    expect(out).toHaveLength(TENSION_PAIRS.length);
    for (const t of out) {
      expect(t.lenses).toHaveLength(2);
      const pair = TENSION_PAIRS.find((p) => p.label === t.category);
      expect(pair).toBeDefined();
      expect(t.lenses).toEqual([pair!.lensA, pair!.lensB]);
    }
  });
});
