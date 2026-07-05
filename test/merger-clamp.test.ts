import { describe, expect, it } from "vitest";

import {
  clampLensFindings,
  enforceAuthorityCeiling,
  maxCeilingRank,
  rebaseInto,
  registryCeilingFor,
  severityFromRank,
  severityRank,
  type CeilingResolver,
} from "../src/merger/clamp.js";
import type { LensRunResult } from "../src/merger/pipeline.js";
import type {
  ClampEvent,
  LensFinding,
  LensOutput,
  MergedFinding,
  Severity,
} from "../src/schema/index.js";

function finding(
  severity: Severity,
  overrides: Partial<LensFinding> = {},
): LensFinding {
  return {
    id: overrides.id ?? "f",
    severity,
    category: overrides.category ?? "generic",
    file: overrides.file ?? "src/x.ts",
    line: overrides.line ?? 1,
    description: overrides.description ?? "d",
    suggestion: overrides.suggestion ?? "s",
    confidence: overrides.confidence ?? 0.8,
    ...overrides,
  };
}
function ok(findings: LensFinding[]): LensOutput {
  return { status: "ok", findings, error: null, notes: null };
}
function mf(severity: Severity, contributingLenses: string[]): MergedFinding {
  return {
    id: "m",
    severity,
    category: "injection",
    file: "src/x.ts",
    line: 1,
    description: "d",
    suggestion: "s",
    confidence: 0.9,
    contributingLenses: contributingLenses as MergedFinding["contributingLenses"],
  };
}

describe("severity rank helpers (R6)", () => {
  it("round-trips severity <-> rank", () => {
    for (const s of ["suggestion", "minor", "major", "blocking"] as const) {
      expect(severityFromRank(severityRank(s))).toBe(s);
    }
  });
  it("orders suggestion < minor < major < blocking", () => {
    expect(severityRank("suggestion")).toBeLessThan(severityRank("minor"));
    expect(severityRank("minor")).toBeLessThan(severityRank("major"));
    expect(severityRank("major")).toBeLessThan(severityRank("blocking"));
  });
});

describe("registryCeilingFor (R-C3 fail-closed)", () => {
  it("resolves real lens ceilings", () => {
    expect(registryCeilingFor("security")).toBe("blocking");
    expect(registryCeilingFor("accessibility")).toBe("major");
    expect(registryCeilingFor("clean-code")).toBe("major");
    expect(registryCeilingFor("data-safety")).toBe("blocking");
  });
  it("R-C3: an unknown lens id fails closed to the lowest ceiling (suggestion)", () => {
    expect(registryCeilingFor("made-up-lens")).toBe("suggestion");
  });
});

describe("clampLensFindings (Pass A, R1)", () => {
  it("clamps an accessibility blocking finding to major and logs a lens_clamp event", () => {
    const f = finding("blocking", { category: "contrast" });
    const input: LensRunResult[] = [{ lensId: "accessibility", output: ok([f]) }];
    const { perLens, clampMeta } = clampLensFindings(input);
    const out = perLens[0]!.output.findings[0]!;
    expect(out.severity).toBe("major");
    const event = clampMeta.get(out);
    expect(event).toEqual({
      lensId: "accessibility",
      originalSeverity: "blocking",
      clampedSeverity: "major",
      stage: "lens_clamp",
    });
  });

  it("within-ceiling finding is a no-op: reference preserved, no event", () => {
    const f = finding("major", { category: "contrast" });
    const input: LensRunResult[] = [{ lensId: "accessibility", output: ok([f]) }];
    const { perLens, clampMeta } = clampLensFindings(input);
    expect(perLens[0]!.output.findings[0]!).toBe(f);
    expect(clampMeta.size).toBe(0);
  });
});

describe("enforceAuthorityCeiling (Pass B, R-C1)", () => {
  const empty = new Map();
  const emptySet = new Set<MergedFinding>();

  it("R-C1(1): a minor-ceiling lens's major finding is capped to minor with an authority_ceiling event", () => {
    const f = mf("major", ["synthetic"]);
    const resolver: CeilingResolver = (id) =>
      id === "synthetic" ? "minor" : "suggestion";
    const { kept, clampLineage } = enforceAuthorityCeiling(
      [f],
      empty,
      empty,
      emptySet,
      resolver,
    );
    expect(kept[0]!.severity).toBe("minor");
    expect(clampLineage.get(kept[0]!)).toEqual([
      {
        lensId: "synthetic",
        originalSeverity: "major",
        clampedSeverity: "minor",
        stage: "authority_ceiling",
      },
    ]);
  });

  it("R-C1(2): a within-ceiling finding passes through by reference", () => {
    const f = mf("blocking", ["security"]); // security ceiling = blocking
    const { kept, clampLineage } = enforceAuthorityCeiling(
      [f],
      empty,
      empty,
      emptySet,
    );
    expect(kept[0]).toBe(f);
    expect(clampLineage.size).toBe(0);
  });

  it("R-C3: a finding attributed to an unknown lens id resolves to suggestion ceiling", () => {
    const f = mf("blocking", ["made-up-lens"]);
    const { kept, clampLineage } = enforceAuthorityCeiling(
      [f],
      empty,
      empty,
      emptySet,
    );
    expect(kept[0]!.severity).toBe("suggestion");
    expect(clampLineage.get(kept[0]!)).toHaveLength(1);
    expect(clampLineage.get(kept[0]!)![0]!.clampedSeverity).toBe("suggestion");
  });

  it("governing ceiling = max over contributors; a blocking co-signer legitimizes", () => {
    const f = mf("blocking", ["accessibility", "security"]); // max(major, blocking)
    const { kept } = enforceAuthorityCeiling([f], empty, empty, emptySet);
    expect(kept[0]).toBe(f); // blocking is within the max ceiling
  });
});

describe("maxCeilingRank + rebaseInto", () => {
  it("maxCeilingRank is the max over lens ceilings", () => {
    expect(maxCeilingRank(["accessibility"], registryCeilingFor)).toBe(
      severityRank("major"),
    );
    expect(
      maxCeilingRank(["accessibility", "security"], registryCeilingFor),
    ).toBe(severityRank("blocking"));
  });

  it("rebaseInto copies a source entry onto a new key without mutating source", () => {
    const oldF = mf("major", ["a"]);
    const newF = mf("minor", ["a"]);
    const events: ClampEvent[] = [
      {
        lensId: "a",
        originalSeverity: "major",
        clampedSeverity: "minor",
        stage: "authority_ceiling",
      },
    ];
    const source = new Map<MergedFinding, ClampEvent[]>([[oldF, events]]);
    const target = new Map<MergedFinding, ClampEvent[]>();
    rebaseInto(target, source, oldF, newF);
    expect(target.get(newF)).toBe(events);
    expect(source.has(oldF)).toBe(true);
    expect(source.size).toBe(1);
  });
});
