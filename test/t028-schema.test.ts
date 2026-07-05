import { describe, expect, it } from "vitest";

import { renderSharedPreamble } from "../src/lenses/prompts/shared-preamble.js";
import {
  DeferredFindingSchema,
  ReviewVerdictSchema,
  toNextRoundDeferralKeys,
  type ClampEvent,
  type DeferredFinding,
  type MergedFinding,
} from "../src/schema/index.js";

function mf(over: Partial<MergedFinding> = {}): MergedFinding {
  return {
    id: over.id ?? "m1",
    severity: over.severity ?? "minor",
    category: over.category ?? "style",
    file: over.file ?? "src/x.ts",
    line: over.line ?? 1,
    description: over.description ?? "d",
    suggestion: over.suggestion ?? "s",
    confidence: over.confidence ?? 0.3,
    contributingLenses:
      over.contributingLenses ?? (["clean-code"] as MergedFinding["contributingLenses"]),
  };
}

const clampEvent: ClampEvent = {
  lensId: "accessibility",
  originalSeverity: "blocking",
  clampedSeverity: "major",
  stage: "lens_clamp",
};

describe("T-028 R-D2: DeferredFindingSchema clamp/escalation superRefine", () => {
  it("severity_clamped_to_lens_max REQUIRES clamps", () => {
    const base = { finding: mf(), reason: "severity_clamped_to_lens_max" as const };
    expect(DeferredFindingSchema.safeParse(base).success).toBe(false);
    expect(
      DeferredFindingSchema.safeParse({ ...base, clamps: [clampEvent] }).success,
    ).toBe(true);
  });

  it("a below_confidence_floor entry with clamps FAILS parse", () => {
    expect(
      DeferredFindingSchema.safeParse({
        finding: mf(),
        reason: "below_confidence_floor",
        clamps: [clampEvent],
      }).success,
    ).toBe(false);
  });

  it("severity_escalated_by_corroboration REQUIRES escalations and forbids clamps", () => {
    const escalations = [
      { lensId: "security", findingId: "s1", severity: "major" as const, confidence: 0.6 },
    ];
    expect(
      DeferredFindingSchema.safeParse({
        finding: mf({ severity: "major" }),
        reason: "severity_escalated_by_corroboration",
      }).success,
    ).toBe(false);
    expect(
      DeferredFindingSchema.safeParse({
        finding: mf({ severity: "major" }),
        reason: "severity_escalated_by_corroboration",
        escalations,
      }).success,
    ).toBe(true);
    expect(
      DeferredFindingSchema.safeParse({
        finding: mf({ severity: "major" }),
        reason: "severity_escalated_by_corroboration",
        escalations,
        clamps: [clampEvent],
      }).success,
    ).toBe(false);
  });

  it("alwaysblock_below_quorum never carries clamps", () => {
    expect(
      DeferredFindingSchema.safeParse({
        finding: mf({ severity: "major" }),
        reason: "alwaysblock_below_quorum",
        clamps: [clampEvent],
      }).success,
    ).toBe(false);
    expect(
      DeferredFindingSchema.safeParse({
        finding: mf({ severity: "major" }),
        reason: "alwaysblock_below_quorum",
      }).success,
    ).toBe(true);
  });
});

function verdict(
  findings: MergedFinding[],
  deferred: DeferredFinding[],
): Record<string, unknown> {
  return {
    verdict: "approve",
    findings,
    tensions: [],
    blocking: 0,
    major: findings.filter((x) => x.severity === "major").length,
    minor: findings.filter((x) => x.severity === "minor").length,
    suggestion: findings.filter((x) => x.severity === "suggestion").length,
    sessionId: "s",
    hadAnyFindings: findings.length > 0 || deferred.length > 0,
    deferred,
  };
}

describe("T-028 R-D3: retained-deferral membership in ReviewVerdictSchema", () => {
  it("(1) a retained snapshot differing from every findings[] member fails at ['deferred',0]", () => {
    const live = mf({ id: "m1", severity: "minor" });
    const stale = mf({ id: "m1", severity: "major" }); // off by one tier
    const res = ReviewVerdictSchema.safeParse(
      verdict([live], [
        { finding: stale, reason: "severity_clamped_to_lens_max", clamps: [clampEvent] },
      ]),
    );
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((i) => i.path.join(".") === "deferred.0")).toBe(
        true,
      );
    }
  });

  it("(2) the same payload with a deep-equal snapshot parses", () => {
    const live = mf({ id: "m1", severity: "major" });
    const res = ReviewVerdictSchema.safeParse(
      verdict([live], [
        { finding: mf({ id: "m1", severity: "major" }), reason: "severity_clamped_to_lens_max", clamps: [clampEvent] },
      ]),
    );
    expect(res.success).toBe(true);
  });

  it("(3) a drop-reason entry whose finding is absent stays exempt (parses)", () => {
    const live = mf({ id: "m1", severity: "minor" });
    const dropped = mf({ id: "gone", severity: "minor", confidence: 0.1 });
    const payload = {
      ...verdict([live], [{ finding: dropped, reason: "below_confidence_floor" }]),
      suppressedFindingCount: 1,
    };
    expect(ReviewVerdictSchema.safeParse(payload).success).toBe(true);
  });

  it("(4) an alwaysblock_below_quorum entry is subject to the membership check", () => {
    const live = mf({ id: "m1", severity: "major" });
    const stale = mf({ id: "m1", severity: "minor" });
    const res = ReviewVerdictSchema.safeParse(
      verdict([live], [{ finding: stale, reason: "alwaysblock_below_quorum" }]),
    );
    expect(res.success).toBe(false);
  });
});

describe("T-028 R3: suppressedFindingCount counts DROP-class only", () => {
  it("a retained entry does not increment suppressedFindingCount", () => {
    const live = mf({ id: "m1", severity: "major" });
    const payload = {
      ...verdict([live], [
        { finding: mf({ id: "m1", severity: "major" }), reason: "severity_clamped_to_lens_max", clamps: [clampEvent] },
      ]),
      suppressedFindingCount: 0,
    };
    expect(ReviewVerdictSchema.safeParse(payload).success).toBe(true);
  });

  it("a drop entry must be counted", () => {
    const dropped = mf({ id: "gone", severity: "minor", confidence: 0.1 });
    const payload = {
      ...verdict([], [{ finding: dropped, reason: "below_confidence_floor" }]),
      suppressedFindingCount: 1,
    };
    expect(ReviewVerdictSchema.safeParse(payload).success).toBe(true);
  });
});

describe("T-028 R-C2: toNextRoundDeferralKeys forwards DROP entries only", () => {
  const dropFinding = mf({
    id: "d1",
    file: "src/drop.ts",
    line: 7,
    category: "style",
    contributingLenses: ["clean-code", "performance"] as MergedFinding["contributingLenses"],
  });
  const retainedFinding = mf({
    id: "r1",
    file: "src/retained.ts",
    line: 9,
    category: "auth",
    severity: "major",
    contributingLenses: ["security"] as MergedFinding["contributingLenses"],
  });
  const deferred: DeferredFinding[] = [
    { finding: dropFinding, reason: "below_confidence_floor" },
    { finding: retainedFinding, reason: "severity_clamped_to_lens_max", clamps: [clampEvent] },
  ];

  it("(1) keeps only the drop entry, one key per contributing lens", () => {
    const keys = toNextRoundDeferralKeys(deferred);
    expect(keys).toEqual([
      { lensId: "clean-code", file: "src/drop.ts", line: 7, category: "style" },
      { lensId: "performance", file: "src/drop.ts", line: 7, category: "style" },
    ]);
  });

  it("(2) preamble integration: the retained finding's tuple is not in the deferrals block", () => {
    const keys = toNextRoundDeferralKeys(deferred);
    const out = renderSharedPreamble({
      stage: "PLAN_REVIEW",
      artifact: "plan",
      ticketDescription: null,
      reviewRound: 2,
      priorDeferrals: keys,
      lensId: "clean-code",
      lensVersion: "v1",
      findingBudget: 10,
      confidenceFloor: 0.6,
    } as never);
    expect(out).toContain("src/drop.ts");
    expect(out).not.toContain("src/retained.ts");
  });
});
