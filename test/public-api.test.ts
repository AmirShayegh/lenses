import { describe, it, expect } from "vitest";

import {
  main,
  // finding.ts
  DeferralKeySchema,
  LensFindingSchema,
  LensOutputSchema,
  LensStatusSchema,
  MergedFindingSchema,
  SeveritySchema,
  type DeferralKey,
  type LensFinding,
  type LensOutput,
  type LensStatus,
  type MergedFinding,
  type Severity,
  // verdict.ts
  ReviewVerdictSchema,
  TensionSchema,
  VerdictSchema,
  type ReviewVerdict,
  type Tension,
  type Verdict,
  // params.ts
  CompleteParamsSchema,
  StageSchema,
  StartParamsSchema,
  type CompleteParams,
  type Stage,
  type StartParams,
  // merger-config.ts
  BlockingPolicySchema,
  DEFAULT_ALWAYS_BLOCK,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_MERGER_CONFIG,
  MergerConfigSchema,
  type BlockingPolicy,
  type MergerConfig,
  // review-protocol.ts (T-022)
  DeferralReasonSchema,
  DeferredFindingSchema,
  NextActionSchema,
  ParseErrorPhaseSchema,
  ParseErrorSchema,
  ZodIssueWireSchema,
  type DeferralReason,
  type DeferredFinding,
  type NextAction,
  type ParseError,
  type ParseErrorPhase,
  type ZodIssueWire,
  // params.ts (T-022)
  GetPromptParamsSchema,
  type GetPromptParams,
  // error-code.ts (T-024)
  LENS_ERROR_MESSAGES,
  LensErrorCodeSchema,
  type LensErrorCode,
  // lenses/prompts (type-only)
  type LensId,
} from "../src/index.js";

/**
 * Bidirectional exhaustiveness check for LensId.
 *
 * `Record<LensId, true>` forces every member of the union to appear as a key
 * (catches additions) while `strict: true` + excess-property checks catch
 * removals. If a lens is added to LENSES without updating this map, tsc
 * fails with "missing property". If a lens is removed/renamed, tsc fails
 * with "excess property". This is the compile-time contract the plan's
 * Stage B1 describes; the test at runtime just confirms the 8 keys exist.
 */
const LENS_ID_COVERAGE: Record<LensId, true> = {
  security: true,
  "error-handling": true,
  "clean-code": true,
  performance: true,
  "api-design": true,
  concurrency: true,
  "test-quality": true,
  accessibility: true,
};

/** Tie the type-only imports to the value graph so tsc keeps them resolvable. */
type _TypeOnlyBindings = [
  DeferralKey,
  LensFinding,
  LensOutput,
  LensStatus,
  MergedFinding,
  Severity,
  ReviewVerdict,
  Tension,
  Verdict,
  CompleteParams,
  Stage,
  StartParams,
  BlockingPolicy,
  MergerConfig,
  // T-022 review protocol
  DeferralReason,
  DeferredFinding,
  NextAction,
  ParseError,
  ParseErrorPhase,
  ZodIssueWire,
  GetPromptParams,
  // T-024 error taxonomy
  LensErrorCode,
];

describe("public API re-exports (src/index.ts)", () => {
  it("exposes `main` as a callable function reference", () => {
    expect(typeof main).toBe("function");
  });

  it("ReviewVerdictSchema parses a minimal valid verdict", () => {
    const minimal = {
      verdict: "approve" as const,
      findings: [],
      tensions: [],
      blocking: 0,
      major: 0,
      minor: 0,
      suggestion: 0,
      sessionId: "smoke",
      // T-022: hadAnyFindings is required (L-003 disambiguation).
      // parseErrors/deferred/suppressedFindingCount/nextActions default
      // to [] / 0 via Zod so they don't need to appear in `minimal`.
      hadAnyFindings: false,
    };
    const parsed = ReviewVerdictSchema.parse(minimal);
    // Defaults materialize post-parse, so check the provided fields
    // round-trip and the defaults are present.
    expect(parsed.verdict).toBe("approve");
    expect(parsed.hadAnyFindings).toBe(false);
    expect(parsed.parseErrors).toEqual([]);
    expect(parsed.deferred).toEqual([]);
    expect(parsed.suppressedFindingCount).toBe(0);
    expect(parsed.nextActions).toEqual([]);
  });

  it("DeferralKeySchema parses and enforces file/line correlation", () => {
    const ok = DeferralKeySchema.parse({
      lensId: "security",
      file: "src/foo.ts",
      line: 10,
      category: "auth",
    });
    expect(ok.lensId).toBe("security");

    expect(() =>
      DeferralKeySchema.parse({
        lensId: "security",
        file: null,
        line: 10,
        category: "auth",
      }),
    ).toThrow();
  });

  it("merger-config defaults parse under MergerConfigSchema", () => {
    expect(Array.isArray(DEFAULT_ALWAYS_BLOCK)).toBe(true);
    expect(MergerConfigSchema.safeParse(DEFAULT_MERGER_CONFIG).success).toBe(true);
    expect(DEFAULT_MAX_ATTEMPTS).toBe(2);
  });

  it("T-022 review-protocol schemas parse canonical shapes", () => {
    expect(
      ParseErrorPhaseSchema.safeParse("envelope").success,
    ).toBe(true);
    expect(DeferralReasonSchema.safeParse("below_confidence_floor").success).toBe(true);
    expect(
      ZodIssueWireSchema.safeParse({ path: "findings.0.id", message: "too short" })
        .success,
    ).toBe(true);
    expect(
      ParseErrorSchema.safeParse({
        lensId: "security",
        attempt: 1,
        phase: "finding",
        zodIssues: [{ path: "findings.0", message: "bad" }],
      }).success,
    ).toBe(true);
    expect(
      DeferredFindingSchema.safeParse({
        finding: {
          id: "f",
          severity: "minor",
          category: "style",
          file: "a.ts",
          line: 1,
          description: "d",
          suggestion: "s",
          confidence: 0.3,
          contributingLenses: ["clean-code"],
        },
        reason: "below_confidence_floor",
      }).success,
    ).toBe(true);
    expect(
      NextActionSchema.safeParse({
        lensId: "security",
        retryPrompt: "retry",
        attempt: 2,
        expiresAt: "2026-04-24T00:00:00.000Z",
      }).success,
    ).toBe(true);
    expect(
      GetPromptParamsSchema.safeParse({ reviewId: "r", lensId: "security" })
        .success,
    ).toBe(true);
  });

  it("T-024 LensErrorCode is exhaustively mapped to non-empty messages", () => {
    // Sanity: the exported map covers the enum values 1:1 (compile-
    // time exhaustiveness lives in test/error-code.test.ts).
    for (const code of Object.keys(LENS_ERROR_MESSAGES) as LensErrorCode[]) {
      expect(LensErrorCodeSchema.safeParse(code).success).toBe(true);
      expect(LENS_ERROR_MESSAGES[code].length).toBeGreaterThan(0);
    }
  });

  it("LensId covers exactly the 8 lens ids bidirectionally", () => {
    const keys = Object.keys(LENS_ID_COVERAGE).sort();
    expect(keys).toEqual([
      "accessibility",
      "api-design",
      "clean-code",
      "concurrency",
      "error-handling",
      "performance",
      "security",
      "test-quality",
    ]);
  });

  it("StartParamsSchema parses a minimal PLAN_REVIEW payload", () => {
    const start = StartParamsSchema.parse({
      stage: "PLAN_REVIEW",
      artifact: "plan body",
      ticketDescription: null,
      reviewRound: 1,
    });
    expect(start.stage).toBe("PLAN_REVIEW");
  });

  it("CompleteParamsSchema parses a minimal empty-results payload", () => {
    const complete = CompleteParamsSchema.parse({
      reviewId: "r1",
      results: [],
    });
    expect(complete.reviewId).toBe("r1");
  });

  it("every re-exported schema exposes a .parse function", () => {
    const schemas = [
      LensFindingSchema,
      LensOutputSchema,
      LensStatusSchema,
      MergedFindingSchema,
      SeveritySchema,
      TensionSchema,
      VerdictSchema,
      StageSchema,
      BlockingPolicySchema,
    ];
    for (const schema of schemas) {
      expect(typeof schema.parse).toBe("function");
    }
  });
});
