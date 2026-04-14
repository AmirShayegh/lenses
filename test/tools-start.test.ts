import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { beforeEach, describe, expect, it } from "vitest";

import { createServer } from "../src/server.js";
import { _resetForTests, getReview } from "../src/state/review-state.js";
import {
  handleLensReviewStart,
  StartToolInputSchema,
  StartToolOutputSchema,
} from "../src/tools/start.js";

// Every lens_review_start call registers a session in the T-020 state
// store. Clearing the module-level Map between tests keeps this file
// isolated from neighbors AND prevents unbounded growth once T-009
// exercises completion paths against the same singleton.
beforeEach(() => {
  _resetForTests();
});

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function planReviewArgs(overrides: Record<string, unknown> = {}) {
  return {
    stage: "PLAN_REVIEW",
    artifact: "## Plan\n\nDo the thing.",
    ticketDescription: null,
    reviewRound: 1,
    ...overrides,
  };
}

function codeReviewArgs(overrides: Record<string, unknown> = {}) {
  return {
    stage: "CODE_REVIEW",
    artifact: "diff --git a/x b/x\n+x",
    ticketDescription: null,
    reviewRound: 1,
    changedFiles: ["docs/readme.md"],
    ...overrides,
  };
}

async function callStart(
  args: Record<string, unknown>,
): Promise<{ isError: boolean; body: unknown; text: string }> {
  const req = {
    method: "tools/call" as const,
    params: { name: "lens_review_start", arguments: args },
  };
  const result = await handleLensReviewStart(req);
  const first = result.content[0];
  if (!first || first.type !== "text") {
    throw new Error("unexpected content shape in tool result");
  }
  const text = String(first.text);
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* non-JSON error messages are fine */
  }
  return { isError: Boolean(result.isError), body, text };
}

describe("StartToolInputSchema", () => {
  it("accepts a minimal PLAN_REVIEW payload", () => {
    const parsed = StartToolInputSchema.parse(planReviewArgs());
    expect(parsed.stage).toBe("PLAN_REVIEW");
    expect(parsed.priorDeferrals).toEqual([]);
    expect(parsed.lensConfig).toEqual({});
    expect(parsed.preambleConfig).toEqual({
      findingBudget: 10,
      confidenceFloor: 0.6,
    });
  });

  it("accepts a minimal CODE_REVIEW payload", () => {
    const parsed = StartToolInputSchema.parse(codeReviewArgs());
    expect(parsed.stage).toBe("CODE_REVIEW");
    if (parsed.stage !== "CODE_REVIEW") throw new Error();
    expect(parsed.changedFiles).toEqual(["docs/readme.md"]);
  });

  it("rejects CODE_REVIEW missing changedFiles", () => {
    expect(() =>
      StartToolInputSchema.parse({
        stage: "CODE_REVIEW",
        artifact: "x",
        ticketDescription: null,
        reviewRound: 1,
      }),
    ).toThrow();
  });

  it("rejects CODE_REVIEW with empty changedFiles", () => {
    expect(() =>
      StartToolInputSchema.parse(codeReviewArgs({ changedFiles: [] })),
    ).toThrow();
  });

  it("rejects unknown top-level keys (strict)", () => {
    expect(() =>
      StartToolInputSchema.parse(planReviewArgs({ extra: "nope" })),
    ).toThrow();
  });

  it("rejects reviewRound: 0", () => {
    expect(() =>
      StartToolInputSchema.parse(planReviewArgs({ reviewRound: 0 })),
    ).toThrow();
  });

  it("rejects an unknown stage value", () => {
    expect(() =>
      StartToolInputSchema.parse({
        stage: "DEPLOY_REVIEW",
        artifact: "x",
        ticketDescription: null,
        reviewRound: 1,
      }),
    ).toThrow();
  });

  it("rejects lensConfig.hotPaths with invalid grammar (trust boundary)", () => {
    expect(() =>
      StartToolInputSchema.parse(
        codeReviewArgs({
          lensConfig: { hotPaths: ["has space"] },
        }),
      ),
    ).toThrow();
  });
});

describe("handleLensReviewStart -- end-to-end happy path", () => {
  it("PLAN_REVIEW with no config returns 8 agents and cached=[]", async () => {
    const { isError, body } = await callStart(planReviewArgs());
    expect(isError).toBe(false);
    const parsed = StartToolOutputSchema.parse(body);
    expect(parsed.agents).toHaveLength(8);
    expect(parsed.cached).toEqual([]);
  });

  it("CODE_REVIEW with only a markdown file returns exactly the 4 core lenses", async () => {
    const { isError, body } = await callStart(
      codeReviewArgs({ changedFiles: ["docs/readme.md"] }),
    );
    expect(isError).toBe(false);
    const parsed = StartToolOutputSchema.parse(body);
    expect(parsed.agents.map((a) => a.id)).toEqual([
      "security",
      "error-handling",
      "clean-code",
      "concurrency",
    ]);
  });

  it("CODE_REVIEW with src/foo.ts returns 6 agents (4 core + performance + test-quality)", async () => {
    const { isError, body } = await callStart(
      codeReviewArgs({ changedFiles: ["src/foo.ts"] }),
    );
    expect(isError).toBe(false);
    const parsed = StartToolOutputSchema.parse(body);
    expect(parsed.agents.map((a) => a.id)).toEqual([
      "security",
      "error-handling",
      "clean-code",
      "performance",
      "concurrency",
      "test-quality",
    ]);
  });

  it("every agent prompt starts with the shared preamble's ## Safety section", async () => {
    const { body } = await callStart(planReviewArgs());
    const parsed = StartToolOutputSchema.parse(body);
    for (const a of parsed.agents) {
      expect(a.prompt.startsWith("## Safety")).toBe(true);
    }
  });

  it("reviewId matches UUID v4 shape", async () => {
    const { body } = await callStart(planReviewArgs());
    const parsed = StartToolOutputSchema.parse(body);
    expect(parsed.reviewId).toMatch(UUID_V4_RE);
  });

  it("two back-to-back calls produce different reviewIds", async () => {
    const [a, b] = await Promise.all([
      callStart(planReviewArgs()),
      callStart(planReviewArgs()),
    ]);
    const parsedA = StartToolOutputSchema.parse(a.body);
    const parsedB = StartToolOutputSchema.parse(b.body);
    expect(parsedA.reviewId).not.toBe(parsedB.reviewId);
  });

  it("registers the review in the T-020 state store with matching stage and expectedLensIds", async () => {
    const { body } = await callStart(planReviewArgs());
    const parsed = StartToolOutputSchema.parse(body);
    const session = getReview(parsed.reviewId);
    expect(session).toBeDefined();
    if (!session) throw new Error();
    expect(session.status).toBe("started");
    expect(session.stage).toBe("PLAN_REVIEW");
    expect(session.expectedLensIds).toEqual(parsed.agents.map((a) => a.id));
  });
});

describe("handleLensReviewStart -- config propagation", () => {
  it("lensConfig.lenses narrows to exactly the listed lenses", async () => {
    const { body } = await callStart(
      planReviewArgs({ lensConfig: { lenses: ["security"] } }),
    );
    const parsed = StartToolOutputSchema.parse(body);
    expect(parsed.agents).toHaveLength(1);
    expect(parsed.agents[0]?.id).toBe("security");
    expect(parsed.agents[0]?.prompt).toContain("Lens: security");
  });

  it("lensConfig.lensModels overrides the default model for a lens", async () => {
    const { body } = await callStart(
      planReviewArgs({
        lensConfig: {
          lenses: ["security"],
          lensModels: { security: "sonnet" },
        },
      }),
    );
    const parsed = StartToolOutputSchema.parse(body);
    expect(parsed.agents[0]?.model).toBe("sonnet");
  });

  it("preambleConfig.findingBudget propagates into the preamble text", async () => {
    const { body } = await callStart(
      planReviewArgs({
        lensConfig: { lenses: ["security"] },
        preambleConfig: { findingBudget: 3 },
      }),
    );
    const parsed = StartToolOutputSchema.parse(body);
    expect(parsed.agents[0]?.prompt).toContain("at most 3 findings");
  });

  it("projectContext.projectRules appears in every prompt", async () => {
    const { body } = await callStart(
      codeReviewArgs({
        changedFiles: ["docs/readme.md"],
        projectContext: { projectRules: "PR_X" },
      }),
    );
    const parsed = StartToolOutputSchema.parse(body);
    for (const a of parsed.agents) {
      expect(a.prompt).toContain('<untrusted-context name="projectRules">');
      expect(a.prompt).toContain("PR_X");
    }
  });

  it("priorDeferrals entries surface in the matching lens's prompt only", async () => {
    const { body } = await callStart(
      planReviewArgs({
        lensConfig: { lenses: ["security", "clean-code"] },
        priorDeferrals: [
          {
            lensId: "security",
            file: "src/auth.ts",
            line: 10,
            category: "injection",
          },
        ],
      }),
    );
    const parsed = StartToolOutputSchema.parse(body);
    const sec = parsed.agents.find((a) => a.id === "security");
    const clean = parsed.agents.find((a) => a.id === "clean-code");
    expect(sec?.prompt).toContain("## Known prior deferrals");
    expect(sec?.prompt).toContain('category="injection"');
    expect(clean?.prompt).not.toContain("## Known prior deferrals");
  });

  it("lensConfig.maxLenses caps the agent count and drops the tail", async () => {
    const { body } = await callStart(
      planReviewArgs({ lensConfig: { maxLenses: 2 } }),
    );
    const parsed = StartToolOutputSchema.parse(body);
    expect(parsed.agents.map((a) => a.id)).toEqual([
      "security",
      "error-handling",
    ]);
  });
});

describe("handleLensReviewStart -- error surface", () => {
  it("malformed args return isError=true with a human-readable message", async () => {
    const { isError, text } = await callStart({
      stage: "PLAN_REVIEW",
      // missing required fields
    });
    expect(isError).toBe(true);
    expect(text).toContain("lens_review_start: invalid arguments");
  });

  it("error text does not leak a stack trace", async () => {
    const { isError, text } = await callStart({ stage: "nope" } as never);
    expect(isError).toBe(true);
    expect(text).not.toContain("at ");
    expect(text).not.toMatch(/\.ts:\d+:\d+/);
  });

  it("empty explicit lens list in lensConfig rejects at the boundary", async () => {
    const { isError, text } = await callStart(
      planReviewArgs({ lensConfig: { lenses: [] } }),
    );
    expect(isError).toBe(true);
    expect(text).toContain("lens_review_start: invalid arguments");
  });
});

describe("handleLensReviewStart -- MCP server round-trip", () => {
  async function connectedPair() {
    const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
    const server = createServer();
    await server.connect(serverTx);
    const client = new Client(
      { name: "lenses-test-client", version: "0.0.0" },
      { capabilities: {} },
    );
    await client.connect(clientTx);
    return { client, server };
  }

  it("returns a well-formed response over the MCP transport", async () => {
    const { client, server } = await connectedPair();
    try {
      const result = await client.request(
        {
          method: "tools/call",
          params: {
            name: "lens_review_start",
            arguments: planReviewArgs(),
          },
        },
        CallToolResultSchema,
      );
      expect(result.isError).not.toBe(true);
      const first = result.content[0];
      if (first?.type !== "text") throw new Error("expected text content");
      const parsed = StartToolOutputSchema.parse(JSON.parse(first.text));
      expect(parsed.agents.length).toBeGreaterThan(0);
      expect(parsed.cached).toEqual([]);
      expect(parsed.reviewId).toMatch(UUID_V4_RE);
    } finally {
      await client.close().catch(() => {});
      await server.close().catch(() => {});
    }
  });
});
