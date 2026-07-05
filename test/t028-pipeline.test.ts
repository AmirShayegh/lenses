import { describe, expect, it } from "vitest";

import type { CeilingResolver } from "../src/merger/clamp.js";
import {
  runMergerPipeline,
  type LensRunResult,
} from "../src/merger/pipeline.js";
import type { LensId } from "../src/lenses/prompts/index.js";
import {
  ReviewVerdictSchema,
  type LensFinding,
  type LensOutput,
  type Severity,
} from "../src/schema/index.js";

const RID = "t028-review";
const SID = "t028-session";

function f(severity: Severity, o: Partial<LensFinding> = {}): LensFinding {
  return {
    id: o.id ?? "f",
    severity,
    category: o.category ?? "generic",
    file: o.file ?? "src/x.ts",
    line: o.line ?? 1,
    description: o.description ?? "concrete failure scenario",
    suggestion: o.suggestion ?? "fix it",
    confidence: o.confidence ?? 0.8,
    ...o,
  };
}
function ok(findings: LensFinding[]): LensOutput {
  return { status: "ok", findings, error: null, notes: null };
}
function L(lensId: string, output: LensOutput): LensRunResult {
  return { lensId: lensId as LensId, output };
}
function run(perLens: LensRunResult[], options?: { ceilingFor?: CeilingResolver }) {
  const v = runMergerPipeline({ reviewId: RID, sessionId: SID, perLens }, options);
  // Every assembled verdict must satisfy the public schema (R-D3 membership).
  expect(ReviewVerdictSchema.safeParse(v).success).toBe(true);
  return v;
}

describe("T-028 ACCEPTANCE criteria", () => {
  it("a single injection/suggestion/0.1 finding does NOT force reject; major + alwaysblock_below_quorum", () => {
    const v = run([
      L("security", ok([f("suggestion", { id: "s1", category: "injection", confidence: 0.1 })])),
    ]);
    expect(v.verdict).not.toBe("reject");
    expect(v.blocking).toBe(0);
    expect(v.findings[0]!.severity).toBe("major");
    const entry = v.deferred.find((d) => d.reason === "alwaysblock_below_quorum");
    expect(entry).toBeDefined();
    expect(entry!.finding.severity).toBe("major");
    // RETAINED: the finding is live, not suppressed.
    expect(v.suppressedFindingCount).toBe(0);
  });

  it("an accessibility finding emitted as blocking is clamped to major with a logged demotion", () => {
    const v = run([
      L("accessibility", ok([f("blocking", { id: "a1", category: "contrast", confidence: 0.9 })])),
    ]);
    expect(v.findings[0]!.severity).toBe("major");
    const clampEntry = v.deferred.find(
      (d) => d.reason === "severity_clamped_to_lens_max",
    );
    expect(clampEntry).toBeDefined();
    expect(clampEntry!.clamps).toEqual([
      {
        lensId: "accessibility",
        originalSeverity: "blocking",
        clampedSeverity: "major",
        stage: "lens_clamp",
      },
    ]);
    // The audit snapshot is the final live finding (not suppressed).
    expect(clampEntry!.finding.severity).toBe("major");
    expect(v.suppressedFindingCount).toBe(0);
  });
});

describe("T-028 R5(1): clamp-then-floor-drop yields only the drop entry", () => {
  it("accessibility blocking/0.3 -> Pass A major -> floor drop, no clamp audit", () => {
    const v = run([
      L("accessibility", ok([f("blocking", { id: "a1", category: "contrast", confidence: 0.3 })])),
    ]);
    expect(v.findings).toHaveLength(0);
    const reasons = v.deferred.map((d) => d.reason);
    expect(reasons).toEqual(["below_confidence_floor"]);
    expect(v.suppressedFindingCount).toBe(1);
  });
});

describe("T-028 R-D1: alwaysBlock quorum counts EXACT-key corroboration only", () => {
  it("(1) no false reject: two lenses lines 42/43 conf 0.2 adjacency-merge but exactKeySupport 1", () => {
    const v = run([
      L("security", ok([f("suggestion", { id: "s1", category: "injection", line: 42, confidence: 0.2 })])),
      L("concurrency", ok([f("suggestion", { id: "c1", category: "injection", line: 43, confidence: 0.2 })])),
    ]);
    expect(v.findings).toHaveLength(1);
    expect(v.findings[0]!.severity).toBe("major");
    expect(v.verdict).not.toBe("reject");
    expect(
      v.deferred.some((d) => d.reason === "alwaysblock_below_quorum"),
    ).toBe(true);
  });

  it("(2) exact corroboration: same (file,line,category) from two lenses conf 0.2 -> support 2 -> blocking", () => {
    const v = run([
      L("security", ok([f("suggestion", { id: "s1", category: "injection", line: 42, confidence: 0.2 })])),
      L("concurrency", ok([f("suggestion", { id: "c1", category: "injection", line: 42, confidence: 0.2 })])),
    ]);
    expect(v.findings).toHaveLength(1);
    expect(v.findings[0]!.severity).toBe("blocking");
    expect(v.verdict).toBe("reject");
  });

  it("(3) support survives clustering: exact pair at 42 + a third lens at 43 keeps support 2", () => {
    const v = run([
      L("security", ok([f("suggestion", { id: "s1", category: "injection", line: 42, confidence: 0.2 })])),
      L("concurrency", ok([f("suggestion", { id: "c1", category: "injection", line: 42, confidence: 0.2 })])),
      L("data-safety", ok([f("suggestion", { id: "d1", category: "injection", line: 43, confidence: 0.2 })])),
    ]);
    expect(v.findings).toHaveLength(1);
    expect(v.findings[0]!.severity).toBe("blocking");
    expect(v.verdict).toBe("reject");
  });
});

describe("T-028 R-D2: clamp audit richness", () => {
  it("(1) Pass A clamps one source, a higher-authority lens supplies the surviving severity", () => {
    const v = run([
      L("accessibility", ok([f("blocking", { id: "a1", category: "auth", line: 10, confidence: 0.9 })])),
      L("security", ok([f("blocking", { id: "s1", category: "auth", line: 10, confidence: 0.95 })])),
    ]);
    expect(v.findings).toHaveLength(1);
    // security wins id/text (0.95) and supplies blocking; the finding survives
    // at blocking though accessibility's own contribution was clamped to major.
    expect(v.findings[0]!.severity).toBe("blocking");
    const clampEntry = v.deferred.find(
      (d) => d.reason === "severity_clamped_to_lens_max",
    );
    expect(clampEntry).toBeDefined();
    expect(clampEntry!.clamps).toEqual([
      {
        lensId: "accessibility",
        originalSeverity: "blocking",
        clampedSeverity: "major",
        stage: "lens_clamp",
      },
    ]);
    // The audit snapshot deep-equals the final (blocking) finding.
    expect(clampEntry!.finding).toEqual(v.findings[0]);
  });
});

describe("T-028 R-C1(1): coalesced clamp + gate-fail on a synthetic minor-ceiling lens", () => {
  it("gate-fails to major, then authority-ceiling caps to minor; both audits reference the final finding", () => {
    const ceilingFor: CeilingResolver = (id) =>
      id === "synthetic" ? "minor" : "suggestion";
    const v = run(
      [L("synthetic", ok([f("suggestion", { id: "x1", category: "injection", confidence: 0.1 })]))],
      { ceilingFor },
    );
    expect(v.findings).toHaveLength(1);
    expect(v.findings[0]!.severity).toBe("minor");
    const clampEntry = v.deferred.find(
      (d) => d.reason === "severity_clamped_to_lens_max",
    );
    const quorumEntry = v.deferred.find(
      (d) => d.reason === "alwaysblock_below_quorum",
    );
    expect(clampEntry).toBeDefined();
    expect(quorumEntry).toBeDefined();
    expect(clampEntry!.clamps).toEqual([
      {
        lensId: "synthetic",
        originalSeverity: "major",
        clampedSeverity: "minor",
        stage: "authority_ceiling",
      },
    ]);
    // Both retained snapshots deep-equal the final minor finding (R-C1 rebase).
    expect(clampEntry!.finding).toEqual(v.findings[0]);
    expect(quorumEntry!.finding).toEqual(v.findings[0]);
  });
});

describe("T-028 pen resolution 1: escalation lineage survives Phase-2 clustering", () => {
  it("a Phase-1-escalated rep in a multi-member cluster emits one escalation naming the original lens", () => {
    const v = run([
      // Phase-1 exact key (x,10,pagination): perf minor/0.9 wins id, api-design
      // major/0.6 escalates severity to major -> lineage names api-design.
      L("performance", ok([f("minor", { id: "p1", category: "pagination", line: 10, confidence: 0.9 })])),
      L("api-design", ok([f("major", { id: "ad1", category: "pagination", line: 10, confidence: 0.6 })])),
      // Adjacent line 11 (same file+category): a third major finding, cluster
      // max equals the escalated severity (major). repRank == maxRank branch.
      L("security", ok([f("major", { id: "s1", category: "pagination", line: 11, confidence: 0.5 })])),
    ]);
    expect(v.findings).toHaveLength(1);
    const escalations = v.deferred.filter(
      (d) => d.reason === "severity_escalated_by_corroboration",
    );
    expect(escalations).toHaveLength(1);
    expect(escalations[0]!.escalations!.map((e) => e.lensId)).toEqual([
      "api-design",
    ]);
  });
});

describe("T-028 pen resolution 2: same-lens duplicates are not self-corroboration", () => {
  it("one lens submits minor/0.9 + blocking/0.1 at a key: no corroboration label; floor sees the severity supplier", () => {
    // security has a blocking ceiling, so Pass A does not pre-clamp the
    // blocking finding; this isolates the within-lens normalization behavior.
    const v = run([
      L(
        "security",
        ok([
          f("minor", { id: "hi", category: "generic", line: 5, confidence: 0.9 }),
          f("blocking", { id: "lo", category: "generic", line: 5, confidence: 0.1 }),
        ]),
      ),
    ]);
    // Within-lens winner = blocking/0.1 (severity rank first). Not alwaysBlock,
    // below floor -> dropped. No corroboration record; the high confidence is
    // never paired with the escalated severity under a corroboration label.
    expect(
      v.deferred.some((d) => d.reason === "severity_escalated_by_corroboration"),
    ).toBe(false);
    const drop = v.deferred.find((d) => d.reason === "below_confidence_floor");
    expect(drop).toBeDefined();
    expect(drop!.finding.severity).toBe("blocking");
    expect(drop!.finding.confidence).toBeCloseTo(0.1);
  });
});
