import { describe, expect, it } from "vitest";

import {
  LensCoverageEntrySchema,
  LensCoverageStatusSchema,
  ReviewVerdictSchema,
} from "../src/schema/index.js";

/**
 * T-027 R14(b)/(d): ReviewVerdictSchema gains four DEFAULTED fields
 * (lensCoverage, coverage, errorCodes, reviewComplete) plus superRefine
 * rules (a)-(f). Legacy payloads without the new fields must keep
 * parsing unchanged.
 */

function v(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    verdict: "approve",
    findings: [],
    tensions: [],
    blocking: 0,
    major: 0,
    minor: 0,
    suggestion: 0,
    sessionId: "s1",
    hadAnyFindings: false,
    ...overrides,
  };
}

function cov(
  lensId: string,
  status: string,
  over: Partial<{ attempts: number; contributedFindings: number }> = {},
): Record<string, unknown> {
  return {
    lensId,
    status,
    attempts: over.attempts ?? 1,
    contributedFindings: over.contributedFindings ?? 0,
  };
}

describe("ReviewVerdictSchema T-027 defaulted fields", () => {
  it("a legacy payload parses with the four defaults applied", () => {
    const parsed = ReviewVerdictSchema.parse(v());
    expect(parsed.lensCoverage).toEqual([]);
    expect(parsed.coverage).toBe("full");
    expect(parsed.errorCodes).toEqual([]);
    expect(parsed.reviewComplete).toBe(true);
  });
});

describe("LensCoverageEntrySchema", () => {
  it("accepts every documented status", () => {
    for (const s of ["ok", "error", "skipped", "expired", "parse_failed", "cached"]) {
      expect(LensCoverageStatusSchema.safeParse(s).success).toBe(true);
      expect(
        LensCoverageEntrySchema.safeParse(cov("security", s)).success,
      ).toBe(true);
    }
  });

  it("rejects unknown status, negative counts, and unknown keys (strict)", () => {
    expect(LensCoverageStatusSchema.safeParse("late").success).toBe(false);
    expect(
      LensCoverageEntrySchema.safeParse(cov("security", "ok", { attempts: -1 }))
        .success,
    ).toBe(false);
    expect(
      LensCoverageEntrySchema.safeParse({
        ...cov("security", "ok"),
        extra: 1,
      }).success,
    ).toBe(false);
  });
});

describe("ReviewVerdictSchema superRefine rules (a)-(f)", () => {
  it("(a) rejects duplicate lensIds in lensCoverage", () => {
    const result = ReviewVerdictSchema.safeParse(
      v({
        lensCoverage: [cov("security", "ok"), cov("security", "ok")],
        coverage: "full",
      }),
    );
    expect(result.success).toBe(false);
  });

  it("(b) rejects approve when a CORE lens entry is outside ok/cached", () => {
    const result = ReviewVerdictSchema.safeParse(
      v({
        verdict: "approve",
        lensCoverage: [cov("security", "expired")],
        coverage: "partial",
        errorCodes: ["PARTIAL_RESULTS"],
      }),
    );
    expect(result.success).toBe(false);
  });

  it("(b) accepts revise with a CORE lens expired (the cap verdict)", () => {
    const result = ReviewVerdictSchema.safeParse(
      v({
        verdict: "revise",
        lensCoverage: [cov("security", "expired")],
        coverage: "partial",
        errorCodes: ["PARTIAL_RESULTS"],
      }),
    );
    expect(result.success).toBe(true);
  });

  it("(b) accepts approve when core lenses are ok/cached (non-core rules untouched)", () => {
    const result = ReviewVerdictSchema.safeParse(
      v({
        verdict: "approve",
        lensCoverage: [cov("security", "ok"), cov("clean-code", "cached")],
        coverage: "full",
      }),
    );
    expect(result.success).toBe(true);
  });

  it("(b) approve with a NON-core entry outside ok/cached is not blocked by the core cap", () => {
    const result = ReviewVerdictSchema.safeParse(
      v({
        verdict: "approve",
        lensCoverage: [cov("security", "ok"), cov("performance", "skipped")],
        coverage: "partial",
      }),
    );
    expect(result.success).toBe(true);
  });

  it("(c) rejects coverage 'full' when an entry is outside ok/cached", () => {
    const result = ReviewVerdictSchema.safeParse(
      v({
        verdict: "revise",
        lensCoverage: [cov("security", "error")],
        coverage: "full",
      }),
    );
    expect(result.success).toBe(false);
  });

  it("(c) rejects coverage 'partial' when every entry is ok/cached", () => {
    const result = ReviewVerdictSchema.safeParse(
      v({
        verdict: "approve",
        lensCoverage: [cov("security", "ok"), cov("clean-code", "cached")],
        coverage: "partial",
      }),
    );
    expect(result.success).toBe(false);
  });

  it("(d) rejects an expired entry without PARTIAL_RESULTS in errorCodes", () => {
    const result = ReviewVerdictSchema.safeParse(
      v({
        verdict: "revise",
        lensCoverage: [cov("security", "expired")],
        coverage: "partial",
        errorCodes: [],
      }),
    );
    expect(result.success).toBe(false);
  });

  it("(d) rejects PARTIAL_RESULTS in errorCodes without any expired entry", () => {
    const result = ReviewVerdictSchema.safeParse(
      v({
        verdict: "revise",
        lensCoverage: [cov("security", "error")],
        coverage: "partial",
        errorCodes: ["PARTIAL_RESULTS"],
      }),
    );
    expect(result.success).toBe(false);
  });

  it("(e) rejects an expired entry with contributedFindings > 0", () => {
    const result = ReviewVerdictSchema.safeParse(
      v({
        verdict: "revise",
        lensCoverage: [cov("security", "expired", { contributedFindings: 1 })],
        coverage: "partial",
        errorCodes: ["PARTIAL_RESULTS"],
      }),
    );
    expect(result.success).toBe(false);
  });

  it("(e) rejects a skipped entry with contributedFindings > 0", () => {
    const result = ReviewVerdictSchema.safeParse(
      v({
        verdict: "revise",
        lensCoverage: [cov("performance", "skipped", { contributedFindings: 2 })],
        coverage: "partial",
        reviewComplete: false,
      }),
    );
    expect(result.success).toBe(false);
  });

  it("(f) rejects reviewComplete=false with verdict approve", () => {
    const result = ReviewVerdictSchema.safeParse(
      v({
        verdict: "approve",
        lensCoverage: [cov("performance", "skipped")],
        coverage: "partial",
        reviewComplete: false,
      }),
    );
    expect(result.success).toBe(false);
  });

  it("(f) rejects reviewComplete=false with coverage full", () => {
    const result = ReviewVerdictSchema.safeParse(
      v({
        verdict: "revise",
        lensCoverage: [cov("security", "ok")],
        coverage: "full",
        reviewComplete: false,
      }),
    );
    expect(result.success).toBe(false);
  });

  it("(f) accepts a well-formed interim envelope (revise, partial, reviewComplete=false)", () => {
    const result = ReviewVerdictSchema.safeParse(
      v({
        verdict: "revise",
        lensCoverage: [cov("security", "ok"), cov("clean-code", "skipped")],
        coverage: "partial",
        reviewComplete: false,
      }),
    );
    expect(result.success).toBe(true);
  });
});
