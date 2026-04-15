import { describe, it, expect } from "vitest";

import {
  CompleteParamsSchema,
  DEFAULT_ALWAYS_BLOCK,
  DEFAULT_MERGER_CONFIG,
  DeferralKeySchema,
  LensFindingSchema,
  LensOutputSchema,
  MergedFindingSchema,
  MergerConfigSchema,
  ReviewVerdictSchema,
  StartParamsSchema,
  TensionSchema,
  type LensFinding,
  type MergedFinding,
} from "../src/schema/index.js";

/** Minimal valid lens-reported finding for reuse across assertions. */
function finding(overrides: Partial<LensFinding> = {}): LensFinding {
  return {
    id: "f-1",
    severity: "minor",
    category: "naming",
    file: "src/x.ts",
    line: 10,
    description: "desc",
    suggestion: "fix",
    confidence: 0.9,
    ...overrides,
  };
}

/** Minimal valid post-merge finding (adds contributingLenses). */
function merged(overrides: Partial<MergedFinding> = {}): MergedFinding {
  return {
    id: "f-1",
    severity: "minor",
    category: "naming",
    file: "src/x.ts",
    line: 10,
    description: "desc",
    suggestion: "fix",
    confidence: 0.9,
    contributingLenses: ["clean-code"],
    ...overrides,
  };
}

describe("LensFindingSchema", () => {
  it("parses a well-formed finding", () => {
    expect(LensFindingSchema.safeParse(finding()).success).toBe(true);
  });

  it("rejects severity not in enum", () => {
    const result = LensFindingSchema.safeParse({
      ...finding(),
      severity: "critical",
    });
    expect(result.success).toBe(false);
  });

  it("rejects confidence above 1 or below 0", () => {
    expect(
      LensFindingSchema.safeParse({ ...finding(), confidence: 1.1 }).success,
    ).toBe(false);
    expect(
      LensFindingSchema.safeParse({ ...finding(), confidence: -0.1 }).success,
    ).toBe(false);
  });

  it("accepts file: null with line: null (artifact-level finding)", () => {
    expect(
      LensFindingSchema.safeParse({ ...finding(), file: null, line: null })
        .success,
    ).toBe(true);
  });

  it("rejects line non-null when file is null", () => {
    const result = LensFindingSchema.safeParse({
      ...finding(),
      file: null,
      line: 5,
    });
    expect(result.success).toBe(false);
  });

  it("rejects line: 0 and fractional line numbers", () => {
    expect(
      LensFindingSchema.safeParse({ ...finding(), line: 0 }).success,
    ).toBe(false);
    expect(
      LensFindingSchema.safeParse({ ...finding(), line: 1.5 }).success,
    ).toBe(false);
  });

  it("rejects empty id", () => {
    expect(LensFindingSchema.safeParse({ ...finding(), id: "" }).success).toBe(
      false,
    );
  });

  it("rejects empty category (would produce a malformed dedup key)", () => {
    expect(
      LensFindingSchema.safeParse({ ...finding(), category: "" }).success,
    ).toBe(false);
  });

  it("rejects empty file (would produce a malformed dedup key)", () => {
    expect(
      LensFindingSchema.safeParse({ ...finding(), file: "" }).success,
    ).toBe(false);
  });

  it("rejects unknown keys (strict)", () => {
    const result = LensFindingSchema.safeParse({
      ...finding(),
      foo: "bar",
    });
    expect(result.success).toBe(false);
  });
});

describe("LensOutputSchema", () => {
  it("parses status=ok with findings", () => {
    const result = LensOutputSchema.safeParse({
      status: "ok",
      findings: [finding()],
      error: null,
      notes: null,
    });
    expect(result.success).toBe(true);
  });

  it("parses status=error with error message and empty findings", () => {
    expect(
      LensOutputSchema.safeParse({
        status: "error",
        findings: [],
        error: "timeout",
        notes: null,
      }).success,
    ).toBe(true);
  });

  it("parses status=skipped with null error and empty findings", () => {
    expect(
      LensOutputSchema.safeParse({
        status: "skipped",
        findings: [],
        error: null,
        notes: "skipped by config",
      }).success,
    ).toBe(true);
  });

  it("rejects status=error with null error", () => {
    expect(
      LensOutputSchema.safeParse({
        status: "error",
        findings: [],
        error: null,
        notes: null,
      }).success,
    ).toBe(false);
  });

  it("rejects status=error with non-empty findings", () => {
    expect(
      LensOutputSchema.safeParse({
        status: "error",
        findings: [finding()],
        error: "timeout",
        notes: null,
      }).success,
    ).toBe(false);
  });

  it("rejects status=skipped with a non-null error", () => {
    expect(
      LensOutputSchema.safeParse({
        status: "skipped",
        findings: [],
        error: "something",
        notes: null,
      }).success,
    ).toBe(false);
  });

  it("rejects status=skipped with non-empty findings", () => {
    expect(
      LensOutputSchema.safeParse({
        status: "skipped",
        findings: [finding()],
        error: null,
        notes: null,
      }).success,
    ).toBe(false);
  });

  it("rejects status=ok with a non-null error", () => {
    expect(
      LensOutputSchema.safeParse({
        status: "ok",
        findings: [],
        error: "nope",
        notes: null,
      }).success,
    ).toBe(false);
  });

  it("rejects unknown keys (strict)", () => {
    const result = LensOutputSchema.safeParse({
      status: "ok",
      findings: [],
      error: null,
      notes: null,
      extra: 1,
    });
    expect(result.success).toBe(false);
  });
});

describe("MergedFindingSchema", () => {
  it("parses a well-formed merged finding", () => {
    expect(MergedFindingSchema.safeParse(merged()).success).toBe(true);
  });

  it("rejects empty contributingLenses (must be nonempty)", () => {
    expect(
      MergedFindingSchema.safeParse({
        ...merged(),
        contributingLenses: [],
      }).success,
    ).toBe(false);
  });

  it("rejects duplicate lens ids inside contributingLenses", () => {
    expect(
      MergedFindingSchema.safeParse({
        ...merged(),
        contributingLenses: ["security", "security"],
      }).success,
    ).toBe(false);
  });

  it("rejects empty lens id inside contributingLenses", () => {
    expect(
      MergedFindingSchema.safeParse({
        ...merged(),
        contributingLenses: ["security", ""],
      }).success,
    ).toBe(false);
  });

  it("rejects unknown keys (strict)", () => {
    expect(
      MergedFindingSchema.safeParse({ ...merged(), foo: "bar" }).success,
    ).toBe(false);
  });

  it("rejects line non-null when file is null (inherits correlation)", () => {
    expect(
      MergedFindingSchema.safeParse({
        ...merged(),
        file: null,
        line: 5,
      }).success,
    ).toBe(false);
  });

  it("accepts multiple distinct lens ids", () => {
    expect(
      MergedFindingSchema.safeParse({
        ...merged(),
        contributingLenses: ["security", "clean-code", "performance"],
      }).success,
    ).toBe(true);
  });
});

describe("ReviewVerdictSchema", () => {
  it("parses a well-formed verdict with matching counts", () => {
    const result = ReviewVerdictSchema.safeParse({
      verdict: "revise",
      findings: [
        merged({ id: "a", severity: "major" }),
        merged({ id: "b", severity: "minor" }),
        merged({ id: "c", severity: "minor" }),
      ],
      tensions: [],
      blocking: 0,
      major: 1,
      minor: 2,
      suggestion: 0,
      sessionId: "review-1",
    });
    expect(result.success).toBe(true);
  });

  it("rejects verdict not in enum", () => {
    const result = ReviewVerdictSchema.safeParse({
      verdict: "revise!",
      findings: [],
      tensions: [],
      blocking: 0,
      major: 0,
      minor: 0,
      suggestion: 0,
      sessionId: "r1",
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative or non-integer counts", () => {
    expect(
      ReviewVerdictSchema.safeParse({
        verdict: "approve",
        findings: [],
        tensions: [],
        blocking: -1,
        major: 0,
        minor: 0,
        suggestion: 0,
        sessionId: "r1",
      }).success,
    ).toBe(false);

    expect(
      ReviewVerdictSchema.safeParse({
        verdict: "approve",
        findings: [],
        tensions: [],
        blocking: 1.5,
        major: 0,
        minor: 0,
        suggestion: 0,
        sessionId: "r1",
      }).success,
    ).toBe(false);
  });

  it("rejects counts that don't match findings (one major, major: 0)", () => {
    const result = ReviewVerdictSchema.safeParse({
      verdict: "revise",
      findings: [merged({ severity: "major" })],
      tensions: [],
      blocking: 0,
      major: 0,
      minor: 0,
      suggestion: 0,
      sessionId: "r1",
    });
    expect(result.success).toBe(false);
  });

  it("rejects verdict=approve when blocking > 0 (internally inconsistent)", () => {
    const result = ReviewVerdictSchema.safeParse({
      verdict: "approve",
      findings: [merged({ severity: "blocking" })],
      tensions: [],
      blocking: 1,
      major: 0,
      minor: 0,
      suggestion: 0,
      sessionId: "r1",
    });
    expect(result.success).toBe(false);
  });

  it("rejects verdict=revise when blocking > 0 (blocker must reject)", () => {
    const result = ReviewVerdictSchema.safeParse({
      verdict: "revise",
      findings: [merged({ severity: "blocking" })],
      tensions: [],
      blocking: 1,
      major: 0,
      minor: 0,
      suggestion: 0,
      sessionId: "r1",
    });
    expect(result.success).toBe(false);
  });

  it("accepts verdict=reject with a blocking finding", () => {
    const result = ReviewVerdictSchema.safeParse({
      verdict: "reject",
      findings: [merged({ severity: "blocking" })],
      tensions: [],
      blocking: 1,
      major: 0,
      minor: 0,
      suggestion: 0,
      sessionId: "r1",
    });
    expect(result.success).toBe(true);
  });

  it("rejects findings without contributingLenses (post-T-010 invariant)", () => {
    const result = ReviewVerdictSchema.safeParse({
      verdict: "revise",
      // Using LensFinding-shaped helper instead of merged() — no contributingLenses.
      findings: [finding({ severity: "major" })],
      tensions: [],
      blocking: 0,
      major: 1,
      minor: 0,
      suggestion: 0,
      sessionId: "r1",
    });
    expect(result.success).toBe(false);
  });
});

describe("TensionSchema", () => {
  it("parses a tension between two lenses", () => {
    expect(
      TensionSchema.safeParse({
        category: "auth",
        lenses: ["security", "performance"],
        summary: "security flags caching; performance requires it",
      }).success,
    ).toBe(true);
  });

  it("rejects empty lenses (a tension needs >=2 participants)", () => {
    expect(
      TensionSchema.safeParse({
        category: "auth",
        lenses: [],
        summary: "s",
      }).success,
    ).toBe(false);
  });

  it("rejects a single lens (a tension needs >=2 participants)", () => {
    expect(
      TensionSchema.safeParse({
        category: "auth",
        lenses: ["security"],
        summary: "s",
      }).success,
    ).toBe(false);
  });

  it("rejects empty lens id within lenses", () => {
    expect(
      TensionSchema.safeParse({
        category: "auth",
        lenses: ["security", ""],
        summary: "s",
      }).success,
    ).toBe(false);
  });

  it("rejects empty category (would produce a malformed grouping key)", () => {
    expect(
      TensionSchema.safeParse({
        category: "",
        lenses: ["security", "performance"],
        summary: "s",
      }).success,
    ).toBe(false);
  });

  it("rejects duplicate lens ids (a tension needs distinct lenses)", () => {
    expect(
      TensionSchema.safeParse({
        category: "auth",
        lenses: ["security", "security"],
        summary: "s",
      }).success,
    ).toBe(false);
  });
});

describe("DeferralKeySchema", () => {
  it("parses a file+line deferral", () => {
    expect(
      DeferralKeySchema.safeParse({
        lensId: "security",
        file: "src/x.ts",
        line: 10,
        category: "auth",
      }).success,
    ).toBe(true);
  });

  it("parses an artifact-level deferral (file: null, line: null)", () => {
    expect(
      DeferralKeySchema.safeParse({
        lensId: "clean-code",
        file: null,
        line: null,
        category: "naming",
      }).success,
    ).toBe(true);
  });

  it("rejects line non-null when file is null", () => {
    expect(
      DeferralKeySchema.safeParse({
        lensId: "x",
        file: null,
        line: 10,
        category: "y",
      }).success,
    ).toBe(false);
  });

  it("rejects empty category (would produce a malformed dedup key)", () => {
    expect(
      DeferralKeySchema.safeParse({
        lensId: "clean-code",
        file: null,
        line: null,
        category: "",
      }).success,
    ).toBe(false);
  });

  it("rejects empty file (would produce a malformed dedup key)", () => {
    expect(
      DeferralKeySchema.safeParse({
        lensId: "clean-code",
        file: "",
        line: 10,
        category: "naming",
      }).success,
    ).toBe(false);
  });

  it("rejects unknown keys (strict)", () => {
    const result = DeferralKeySchema.safeParse({
      lensId: "x",
      file: null,
      line: null,
      category: "y",
      extra: true,
    });
    expect(result.success).toBe(false);
  });
});

describe("StartParamsSchema", () => {
  it("parses a PLAN_REVIEW payload without changedFiles", () => {
    const result = StartParamsSchema.safeParse({
      stage: "PLAN_REVIEW",
      artifact: "plan text",
      ticketDescription: null,
      reviewRound: 1,
      priorDeferrals: [],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a PLAN_REVIEW payload that includes changedFiles (strict)", () => {
    const result = StartParamsSchema.safeParse({
      stage: "PLAN_REVIEW",
      artifact: "plan text",
      ticketDescription: null,
      reviewRound: 1,
      priorDeferrals: [],
      changedFiles: ["a.ts"],
    });
    expect(result.success).toBe(false);
  });

  it("parses a CODE_REVIEW payload with non-empty changedFiles", () => {
    expect(
      StartParamsSchema.safeParse({
        stage: "CODE_REVIEW",
        artifact: "diff text",
        ticketDescription: "ticket",
        reviewRound: 2,
        priorDeferrals: [],
        changedFiles: ["src/a.ts", "src/b.ts"],
      }).success,
    ).toBe(true);
  });

  it("rejects a CODE_REVIEW payload with empty changedFiles", () => {
    const result = StartParamsSchema.safeParse({
      stage: "CODE_REVIEW",
      artifact: "diff text",
      ticketDescription: null,
      reviewRound: 1,
      priorDeferrals: [],
      changedFiles: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects reviewRound: 0", () => {
    const result = StartParamsSchema.safeParse({
      stage: "PLAN_REVIEW",
      artifact: "plan",
      ticketDescription: null,
      reviewRound: 0,
      priorDeferrals: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects stage not in enum", () => {
    const result = StartParamsSchema.safeParse({
      stage: "REVIEW",
      artifact: "x",
      ticketDescription: null,
      reviewRound: 1,
      priorDeferrals: [],
    });
    expect(result.success).toBe(false);
  });

  it("defaults priorDeferrals to [] when omitted", () => {
    const result = StartParamsSchema.safeParse({
      stage: "PLAN_REVIEW",
      artifact: "plan",
      ticketDescription: null,
      reviewRound: 1,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.priorDeferrals).toEqual([]);
    }
  });
});

describe("CompleteParamsSchema", () => {
  it("parses with arbitrary output values (output is unknown)", () => {
    expect(
      CompleteParamsSchema.safeParse({
        reviewId: "r1",
        results: [
          { lensId: "security", output: { status: "ok", findings: [] } },
          { lensId: "clean-code", output: null },
          { lensId: "performance", output: "raw string" },
        ],
      }).success,
    ).toBe(true);
  });

  it("parses with empty results array", () => {
    expect(
      CompleteParamsSchema.safeParse({
        reviewId: "r1",
        results: [],
      }).success,
    ).toBe(true);
  });

  it("rejects missing reviewId", () => {
    const result = CompleteParamsSchema.safeParse({
      results: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty reviewId", () => {
    const result = CompleteParamsSchema.safeParse({
      reviewId: "",
      results: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown top-level keys (strict)", () => {
    const result = CompleteParamsSchema.safeParse({
      reviewId: "r1",
      results: [],
      extra: 1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects duplicate lensId in results", () => {
    const result = CompleteParamsSchema.safeParse({
      reviewId: "r1",
      results: [
        { lensId: "security", output: {} },
        { lensId: "security", output: {} },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("accepts an optional mergerConfig", () => {
    const result = CompleteParamsSchema.safeParse({
      reviewId: "r1",
      results: [],
      mergerConfig: { confidenceFloor: 0.9 },
    });
    expect(result.success).toBe(true);
  });

  it("accepts the absence of mergerConfig", () => {
    const result = CompleteParamsSchema.safeParse({
      reviewId: "r1",
      results: [],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a non-object mergerConfig", () => {
    const result = CompleteParamsSchema.safeParse({
      reviewId: "r1",
      results: [],
      mergerConfig: "nope",
    });
    expect(result.success).toBe(false);
  });
});

describe("MergerConfigSchema", () => {
  it("parses undefined to fully-defaulted values", () => {
    const parsed = MergerConfigSchema.parse(undefined);
    expect(parsed.confidenceFloor).toBe(0.6);
    expect(parsed.blockingPolicy.alwaysBlock).toEqual([...DEFAULT_ALWAYS_BLOCK]);
    expect(parsed.blockingPolicy.neverBlock).toEqual([]);
  });

  it("parses {} to fully-defaulted values", () => {
    const parsed = MergerConfigSchema.parse({});
    expect(parsed.confidenceFloor).toBe(0.6);
    expect(parsed.blockingPolicy.alwaysBlock).toEqual([...DEFAULT_ALWAYS_BLOCK]);
    expect(parsed.blockingPolicy.neverBlock).toEqual([]);
  });

  it("partial config with only confidenceFloor fills blockingPolicy with defaults", () => {
    // Canary for the `.optional().default(...)` cascade: the nested
    // `BlockingPolicySchema.default({})` alone would NOT fire here.
    const parsed = MergerConfigSchema.parse({ confidenceFloor: 0.5 });
    expect(parsed.confidenceFloor).toBe(0.5);
    expect(parsed.blockingPolicy.alwaysBlock).toEqual([...DEFAULT_ALWAYS_BLOCK]);
    expect(parsed.blockingPolicy.neverBlock).toEqual([]);
  });

  it("partial blockingPolicy with only alwaysBlock fills neverBlock default", () => {
    const parsed = MergerConfigSchema.parse({
      blockingPolicy: { alwaysBlock: ["auth"] },
    });
    expect(parsed.blockingPolicy.alwaysBlock).toEqual(["auth"]);
    expect(parsed.blockingPolicy.neverBlock).toEqual([]);
  });

  it("DEFAULT_MERGER_CONFIG matches the documented defaults", () => {
    expect(DEFAULT_MERGER_CONFIG.confidenceFloor).toBe(0.6);
    expect(DEFAULT_MERGER_CONFIG.blockingPolicy.alwaysBlock).toEqual([
      ...DEFAULT_ALWAYS_BLOCK,
    ]);
    expect(DEFAULT_MERGER_CONFIG.blockingPolicy.neverBlock).toEqual([]);
  });

  it("DEFAULT_MERGER_CONFIG is deeply frozen (accidental writes throw, not corrupt)", () => {
    expect(Object.isFrozen(DEFAULT_MERGER_CONFIG)).toBe(true);
    expect(Object.isFrozen(DEFAULT_MERGER_CONFIG.blockingPolicy)).toBe(true);
    expect(
      Object.isFrozen(DEFAULT_MERGER_CONFIG.blockingPolicy.alwaysBlock),
    ).toBe(true);
    expect(
      Object.isFrozen(DEFAULT_MERGER_CONFIG.blockingPolicy.neverBlock),
    ).toBe(true);
  });

  it("rejects unknown top-level keys (strict)", () => {
    expect(
      MergerConfigSchema.safeParse({ confidenceFloor: 0.5, foo: 1 }).success,
    ).toBe(false);
  });

  it("rejects unknown keys inside blockingPolicy (strict)", () => {
    expect(
      MergerConfigSchema.safeParse({
        blockingPolicy: { alwaysBlock: [], neverBlock: [], foo: 1 },
      }).success,
    ).toBe(false);
  });

  it("rejects confidenceFloor outside [0, 1]", () => {
    expect(MergerConfigSchema.safeParse({ confidenceFloor: -0.1 }).success).toBe(
      false,
    );
    expect(MergerConfigSchema.safeParse({ confidenceFloor: 1.1 }).success).toBe(
      false,
    );
  });

  it("accepts confidenceFloor at the boundaries (0 and 1)", () => {
    expect(MergerConfigSchema.safeParse({ confidenceFloor: 0 }).success).toBe(
      true,
    );
    expect(MergerConfigSchema.safeParse({ confidenceFloor: 1 }).success).toBe(
      true,
    );
  });

  it("rejects empty strings inside alwaysBlock / neverBlock", () => {
    expect(
      MergerConfigSchema.safeParse({
        blockingPolicy: { alwaysBlock: [""] },
      }).success,
    ).toBe(false);
    expect(
      MergerConfigSchema.safeParse({
        blockingPolicy: { neverBlock: ["security", ""] },
      }).success,
    ).toBe(false);
  });

  it("accepts an explicitly empty alwaysBlock (caller opts out of the default set)", () => {
    const parsed = MergerConfigSchema.parse({
      blockingPolicy: { alwaysBlock: [] },
    });
    expect(parsed.blockingPolicy.alwaysBlock).toEqual([]);
  });
});
