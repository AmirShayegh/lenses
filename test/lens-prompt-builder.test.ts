import { describe, expect, it } from "vitest";

import {
  buildAgentPrompts,
  buildLensPrompt,
  PreambleConfigSchema,
  type PreambleConfig,
} from "../src/lenses/prompt-builder.js";
import { LENSES, type LensId } from "../src/lenses/prompts/index.js";
import type { LensActivation } from "../src/lenses/registry.js";
import type { StartParams } from "../src/schema/index.js";

const defaultPreamble: PreambleConfig = PreambleConfigSchema.parse({});

function codeReviewParams(overrides: Partial<StartParams> = {}): StartParams {
  return {
    stage: "CODE_REVIEW",
    artifact: "diff --git a/src/foo.ts b/src/foo.ts\n+console.log('hi')",
    ticketDescription: null,
    reviewRound: 1,
    priorDeferrals: [],
    changedFiles: ["src/foo.ts"],
    ...overrides,
  } as StartParams;
}

function planReviewParams(overrides: Partial<StartParams> = {}): StartParams {
  return {
    stage: "PLAN_REVIEW",
    artifact: "## Plan\n\nDo the thing.",
    ticketDescription: null,
    reviewRound: 1,
    priorDeferrals: [],
    ...overrides,
  } as StartParams;
}

function makeActivation(
  lensId: LensId,
  overrides: Partial<LensActivation> = {},
): LensActivation {
  return {
    lensId,
    model: LENSES[lensId].defaultModel,
    activationReason: "core lens",
    opts: {},
    ...overrides,
  };
}

describe("buildLensPrompt -- single-lens join structure", () => {
  const activation = makeActivation("security");
  const result = buildLensPrompt({
    activation,
    startParams: codeReviewParams(),
    preambleConfig: defaultPreamble,
  });

  it("returns { lensId, model, prompt } with model from activation", () => {
    expect(result.lensId).toBe("security");
    expect(result.model).toBe(LENSES.security.defaultModel);
    expect(typeof result.prompt).toBe("string");
  });

  it("prompt starts with the Safety preamble section", () => {
    expect(result.prompt.startsWith("## Safety")).toBe(true);
  });

  it("prompt contains Identity block with lens id / version / stage / round", () => {
    expect(result.prompt).toContain("## Identity");
    expect(result.prompt).toContain("Lens: security");
    expect(result.prompt).toContain(`Version: ${LENSES.security.version}`);
    expect(result.prompt).toContain("Stage: CODE_REVIEW");
    expect(result.prompt).toContain("Review round: 1");
  });

  it("prompt contains the lens body opening sentence", () => {
    expect(result.prompt).toContain("You are a Security reviewer");
  });

  it("no extra blank-line separator between preamble and body", () => {
    // Preamble ends with "\n\n", body starts with "You are a ..." (no blank).
    // Triple-newline would indicate an injected separator.
    expect(result.prompt.includes("\n\n\n")).toBe(false);
  });

  it("prompt ends with a single trailing newline", () => {
    expect(result.prompt.endsWith("\n")).toBe(true);
    expect(result.prompt.endsWith("\n\n")).toBe(false);
  });
});

describe("buildLensPrompt -- stage-specific rendering", () => {
  it("PLAN_REVIEW labels the artifact 'Plan:'", () => {
    const out = buildLensPrompt({
      activation: makeActivation("test-quality"),
      startParams: planReviewParams(),
      preambleConfig: defaultPreamble,
    });
    expect(out.prompt).toContain("Plan:");
    expect(out.prompt).not.toContain("Diff:");
  });

  it("CODE_REVIEW labels the artifact 'Diff:' and includes Changed files", () => {
    const out = buildLensPrompt({
      activation: makeActivation("performance"),
      startParams: codeReviewParams({ changedFiles: ["src/hot.ts"] }),
      preambleConfig: defaultPreamble,
    });
    expect(out.prompt).toContain("Diff:");
    expect(out.prompt).toContain("Changed files:");
    expect(out.prompt).not.toContain("Plan:");
  });

  it("PLAN_REVIEW preamble omits Changed files", () => {
    const out = buildLensPrompt({
      activation: makeActivation("test-quality"),
      startParams: planReviewParams(),
      preambleConfig: defaultPreamble,
    });
    expect(out.prompt).not.toContain("Changed files:");
  });

  it("PLAN_REVIEW for test-quality uses the plan-review body opening", () => {
    const out = buildLensPrompt({
      activation: makeActivation("test-quality"),
      startParams: planReviewParams(),
      preambleConfig: defaultPreamble,
    });
    expect(out.prompt).toContain(
      "You are a Test Quality reviewer evaluating an implementation plan",
    );
  });
});

describe("buildLensPrompt -- opts and activationReason passthrough", () => {
  it("performance activation with hotPaths renders Hot paths block", () => {
    const out = buildLensPrompt({
      activation: makeActivation("performance", {
        opts: { hotPaths: ["src/hot/**"] },
      }),
      startParams: codeReviewParams(),
      preambleConfig: defaultPreamble,
    });
    expect(out.prompt).toContain("Hot paths:");
    expect(out.prompt).toContain("src/hot/**");
    expect(out.prompt).toContain('<untrusted-context name="hotPaths">');
  });

  it("security activation with scannerFindings renders wrapped block", () => {
    const out = buildLensPrompt({
      activation: makeActivation("security", {
        opts: { scannerFindings: "CVE-2024-00001" },
      }),
      startParams: codeReviewParams(),
      preambleConfig: defaultPreamble,
    });
    expect(out.prompt).toContain('<untrusted-context name="scannerFindings">');
    expect(out.prompt).toContain("CVE-2024-00001");
  });

  it("test-quality with focusMissingCoverage emits missing-test-coverage category", () => {
    const out = buildLensPrompt({
      activation: makeActivation("test-quality", {
        opts: { focusMissingCoverage: true },
      }),
      startParams: codeReviewParams(),
      preambleConfig: defaultPreamble,
    });
    expect(out.prompt).toContain("missing-test-coverage");
  });

  it("test-quality without focusMissingCoverage omits the missing-test-coverage category", () => {
    const out = buildLensPrompt({
      activation: makeActivation("test-quality", { opts: {} }),
      startParams: codeReviewParams(),
      preambleConfig: defaultPreamble,
    });
    expect(out.prompt).not.toContain('"missing-test-coverage"');
  });

  it("activationReason is wrapped in <untrusted-context name=\"activationReason\">", () => {
    const out = buildLensPrompt({
      activation: makeActivation("security", {
        activationReason: "core lens",
      }),
      startParams: codeReviewParams(),
      preambleConfig: defaultPreamble,
    });
    expect(out.prompt).toContain(
      '<untrusted-context name="activationReason">',
    );
    expect(out.prompt).toContain("core lens");
  });

  it("empty activationReason omits the Activation reason line", () => {
    const out = buildLensPrompt({
      activation: makeActivation("security", { activationReason: "" }),
      startParams: codeReviewParams(),
      preambleConfig: defaultPreamble,
    });
    expect(out.prompt).not.toContain("Activation reason:");
  });
});

describe("buildAgentPrompts -- multi-lens map", () => {
  it("empty activations list returns []", () => {
    const out = buildAgentPrompts({
      activations: [],
      startParams: codeReviewParams(),
      preambleConfig: defaultPreamble,
    });
    expect(out).toEqual([]);
  });

  it("preserves activation input order", () => {
    const out = buildAgentPrompts({
      activations: [
        makeActivation("security"),
        makeActivation("clean-code"),
        makeActivation("performance"),
      ],
      startParams: codeReviewParams(),
      preambleConfig: defaultPreamble,
    });
    expect(out.map((p) => p.lensId)).toEqual([
      "security",
      "clean-code",
      "performance",
    ]);
  });

  it("each prompt uses its own activation's model, not a shared value", () => {
    const out = buildAgentPrompts({
      activations: [
        makeActivation("security", { model: "sonnet" }),
        makeActivation("clean-code", { model: "opus" }),
      ],
      startParams: codeReviewParams(),
      preambleConfig: defaultPreamble,
    });
    expect(out[0]?.model).toBe("sonnet");
    expect(out[1]?.model).toBe("opus");
  });

  it("priorDeferrals are filtered per lens via the shared preamble", () => {
    const out = buildAgentPrompts({
      activations: [
        makeActivation("security"),
        makeActivation("clean-code"),
      ],
      startParams: codeReviewParams({
        priorDeferrals: [
          {
            lensId: "security",
            file: "src/auth.ts",
            line: 10,
            category: "injection",
          },
          {
            lensId: "clean-code",
            file: "src/foo.ts",
            line: 5,
            category: "dead-code",
          },
        ],
      }),
      preambleConfig: defaultPreamble,
    });
    const securityPrompt = out[0]?.prompt ?? "";
    const cleanCodePrompt = out[1]?.prompt ?? "";
    // Assert on the deferral-line category format so we don't collide with the
    // Safety section's "prompt injection" prose or the clean-code body's
    // mention of "dead code".
    expect(securityPrompt).toContain('category="injection"');
    expect(securityPrompt).not.toContain('category="dead-code"');
    expect(cleanCodePrompt).toContain('category="dead-code"');
    expect(cleanCodePrompt).not.toContain('category="injection"');
  });

  it("projectContext.projectRules appears in every prompt", () => {
    const out = buildAgentPrompts({
      activations: [
        makeActivation("security"),
        makeActivation("clean-code"),
      ],
      startParams: codeReviewParams(),
      preambleConfig: defaultPreamble,
      projectContext: { projectRules: "RULE_X" },
    });
    for (const p of out) {
      expect(p.prompt).toContain('<untrusted-context name="projectRules">');
      expect(p.prompt).toContain("RULE_X");
    }
  });

  it("projectContext.knownFalsePositives appears in every prompt", () => {
    const out = buildAgentPrompts({
      activations: [
        makeActivation("security"),
        makeActivation("clean-code"),
      ],
      startParams: codeReviewParams(),
      preambleConfig: defaultPreamble,
      projectContext: { knownFalsePositives: "FP_Y" },
    });
    for (const p of out) {
      expect(p.prompt).toContain("## Known false positives");
      expect(p.prompt).toContain("FP_Y");
    }
  });

  it("projectContext undefined -> no projectRules or knownFalsePositives sections", () => {
    const out = buildAgentPrompts({
      activations: [makeActivation("security")],
      startParams: codeReviewParams(),
      preambleConfig: defaultPreamble,
    });
    expect(out[0]?.prompt).not.toContain("Project rules:");
    expect(out[0]?.prompt).not.toContain("## Known false positives");
  });
});

describe("PreambleConfigSchema and error surface", () => {
  it("parses {} to { findingBudget: 10, confidenceFloor: 0.6 }", () => {
    expect(PreambleConfigSchema.parse({})).toEqual({
      findingBudget: 10,
      confidenceFloor: 0.6,
    });
  });

  it("round-trips a fully-specified config", () => {
    expect(
      PreambleConfigSchema.parse({ findingBudget: 5, confidenceFloor: 0.8 }),
    ).toEqual({ findingBudget: 5, confidenceFloor: 0.8 });
  });

  it("rejects unknown keys (strict)", () => {
    expect(() =>
      PreambleConfigSchema.parse({ findingBudget: 5, mystery: 1 }),
    ).toThrow();
  });

  it("rejects findingBudget: 0", () => {
    expect(() => PreambleConfigSchema.parse({ findingBudget: 0 })).toThrow();
  });

  it("rejects findingBudget: 51", () => {
    expect(() => PreambleConfigSchema.parse({ findingBudget: 51 })).toThrow();
  });

  it("rejects non-integer findingBudget", () => {
    expect(() =>
      PreambleConfigSchema.parse({ findingBudget: 2.5 }),
    ).toThrow();
  });

  it("rejects confidenceFloor < 0", () => {
    expect(() =>
      PreambleConfigSchema.parse({ confidenceFloor: -0.1 }),
    ).toThrow();
  });

  it("rejects confidenceFloor > 1", () => {
    expect(() =>
      PreambleConfigSchema.parse({ confidenceFloor: 1.01 }),
    ).toThrow();
  });

  it("invalid activation opts surface as a Zod error from renderLensBody", () => {
    expect(() =>
      buildLensPrompt({
        activation: makeActivation("performance", {
          opts: { hotPaths: ["has space"] },
        }),
        startParams: codeReviewParams(),
        preambleConfig: defaultPreamble,
      }),
    ).toThrow();
  });

  it("reviewRound < 1 throws via renderSharedPreamble", () => {
    expect(() =>
      buildLensPrompt({
        activation: makeActivation("security"),
        startParams: codeReviewParams({ reviewRound: 0 }),
        preambleConfig: defaultPreamble,
      }),
    ).toThrow();
  });
});
