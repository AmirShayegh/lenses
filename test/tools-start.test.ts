import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { writeLensCache } from "../src/cache/lens-cache.js";
import type { LensId } from "../src/lenses/prompts/index.js";
import { createServer } from "../src/server.js";
import { _resetForTests, getReview } from "../src/state/review-state.js";
import {
  handleLensReviewStart,
  StartToolInputSchema,
  StartToolOutputSchema,
} from "../src/tools/start.js";

// T-015: the tool boundary probes the lens cache on every start. Pin
// `LENSES_LENS_CACHE_DIR` to a per-file temp dir so test runs don't
// pick up stale hits from the real tmp/lenses-lens-cache directory
// and so parallel test files don't race on the same (lensId,
// promptHash) keys. Per-test-file isolation — cross-test caching is
// exercised by the dedicated T-015 integration suite, not here.
//
// T-024: same isolation for the in-flight persistence directory.
// Without this, `_resetForTests`'s disk cleanup races with
// `registerReview`'s writes across test files on the default
// `tmpdir()/lenses-in-flight/` path, producing stderr noise and
// occasional ENOTEMPTY rmSync failures.
let lensCacheDir: string;
let inFlightDir: string;
beforeAll(() => {
  lensCacheDir = mkdtempSync(join(tmpdir(), "lenses-tools-start-lc-"));
  inFlightDir = mkdtempSync(join(tmpdir(), "lenses-tools-start-if-"));
  process.env.LENSES_LENS_CACHE_DIR = lensCacheDir;
  process.env.LENSES_IN_FLIGHT_DIR = inFlightDir;
});
afterAll(() => {
  delete process.env.LENSES_LENS_CACHE_DIR;
  delete process.env.LENSES_IN_FLIGHT_DIR;
  rmSync(lensCacheDir, { recursive: true, force: true });
  rmSync(inFlightDir, { recursive: true, force: true });
});

// Clear BOTH the in-memory state and the on-disk lens cache between
// every it() so each test starts from a true miss, regardless of
// ordering.
beforeEach(() => {
  _resetForTests();
  rmSync(lensCacheDir, { recursive: true, force: true });
});
afterEach(() => {
  rmSync(lensCacheDir, { recursive: true, force: true });
});

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * T-022: hop-1 response no longer carries prompt text — only promptHash +
 * expiresAt. Tests that assert on prompt content fetch the prompt from the
 * in-process state store (`getReview(...).prompts`). Equivalent to the
 * `lens_review_get_prompt` tool call but avoids the wire overhead in unit
 * tests. End-to-end coverage of `lens_review_get_prompt` lives in
 * `test/tools-get-prompt.test.ts`.
 */
function promptFor(reviewId: string, lensId: string): string {
  const s = getReview(reviewId);
  if (!s) throw new Error(`no review for ${reviewId}`);
  const p = s.prompts.get(lensId as LensId);
  if (p === undefined) throw new Error(`no prompt for ${lensId}`);
  return p;
}

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
  it("PLAN_REVIEW with no config returns 9 agents and cached=[]", async () => {
    const { isError, body } = await callStart(planReviewArgs());
    expect(isError).toBe(false);
    const parsed = StartToolOutputSchema.parse(body);
    expect(parsed.agents).toHaveLength(9);
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
      expect(promptFor(parsed.reviewId, a.id).startsWith("## Safety")).toBe(
        true,
      );
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
    expect(promptFor(parsed.reviewId, "security")).toContain("Lens: security");
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
    expect(promptFor(parsed.reviewId, "security")).toContain(
      "at most 3 findings",
    );
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
      const prompt = promptFor(parsed.reviewId, a.id);
      expect(prompt).toContain('<untrusted-context name="projectRules">');
      expect(prompt).toContain("PR_X");
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
    if (!sec || !clean) throw new Error();
    const secPrompt = promptFor(parsed.reviewId, sec.id);
    const cleanPrompt = promptFor(parsed.reviewId, clean.id);
    expect(secPrompt).toContain("## Known prior deferrals");
    expect(secPrompt).toContain('category="injection"');
    expect(cleanPrompt).not.toContain("## Known prior deferrals");
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

/**
 * T-015 hop-1 cache resolution. These tests exercise the pipeline
 * end-to-end by pre-seeding the on-disk cache (via `writeLensCache`
 * directly) and then calling `lens_review_start` to see which lenses
 * are split off into `cached[]` vs `agents[]`. Pre-seeding is closer
 * to reality than mocking because `hashLensPrompt` actually hashes the
 * prompt the tool built, so any drift between the tool's prompt and
 * the cache key would show up here.
 *
 * Plan §8b enumerates the cases below; see `src/cache/lens-cache.ts`
 * for DISABLE / dir / TTL env-var semantics.
 */
describe("handleLensReviewStart -- T-015 cache resolution (§8b)", () => {
  /**
   * Run hop-1 once, hash each agent's prompt, and pre-populate the
   * cache with empty findings for the given subset. Returns the map of
   * `(lensId -> promptHash)` so downstream tests can cross-check that
   * the second call's `cached` array lines up with what was seeded.
   */
  async function seedCache(
    args: Record<string, unknown>,
    lensIdsToSeed: readonly LensId[],
  ): Promise<ReadonlyMap<LensId, string>> {
    const { body } = await callStart(args);
    const parsed = StartToolOutputSchema.parse(body);
    const hashes = new Map<LensId, string>();
    for (const agent of parsed.agents) {
      // T-022: hop-1 now ships promptHash directly. Use it as-is
      // instead of recomputing from `agent.prompt` (which no longer
      // exists on the wire).
      hashes.set(agent.id, agent.promptHash);
    }
    for (const lensId of lensIdsToSeed) {
      const promptHash = hashes.get(lensId);
      if (promptHash === undefined) {
        throw new Error(`seedCache: lens ${lensId} not in agents`);
      }
      writeLensCache({
        lensId,
        promptHash,
        findings: [],
        notes: null,
      });
    }
    _resetForTests();
    return hashes;
  }

  it("round 1 with a fresh cache returns cached=[] and agents covers expected", async () => {
    const { body } = await callStart(
      planReviewArgs({ lensConfig: { lenses: ["security", "clean-code"] } }),
    );
    const parsed = StartToolOutputSchema.parse(body);
    expect(parsed.cached).toEqual([]);
    expect(parsed.agents.map((a) => a.id).sort()).toEqual([
      "clean-code",
      "security",
    ]);
  });

  it("identical round-2 args hit the cache for every pre-seeded lens", async () => {
    const args = planReviewArgs({
      lensConfig: { lenses: ["security", "clean-code"] },
    });
    await seedCache(args, ["security", "clean-code"]);
    const { body } = await callStart(args);
    const parsed = StartToolOutputSchema.parse(body);
    expect(parsed.agents).toEqual([]);
    expect(parsed.cached.map((c) => c.id).sort()).toEqual([
      "clean-code",
      "security",
    ]);
    // Every cached entry must carry the findings array (empty in this
    // fixture); the tool should not drop or rename the field on its
    // way to the wire.
    for (const entry of parsed.cached) {
      expect(entry.findings).toEqual([]);
    }
  });

  it("cached + agents partitions the expected set (totals sum)", async () => {
    const args = planReviewArgs({
      lensConfig: { lenses: ["security", "clean-code", "performance"] },
    });
    await seedCache(args, ["security"]);
    const { body } = await callStart(args);
    const parsed = StartToolOutputSchema.parse(body);
    expect(parsed.cached.map((c) => c.id)).toEqual(["security"]);
    expect(parsed.agents.map((a) => a.id).sort()).toEqual([
      "clean-code",
      "performance",
    ]);
  });

  it("changing artifact invalidates the cache (different promptHash)", async () => {
    const base = planReviewArgs({
      lensConfig: { lenses: ["security"] },
      artifact: "## Plan\n\nOriginal.",
    });
    await seedCache(base, ["security"]);
    const changed = planReviewArgs({
      lensConfig: { lenses: ["security"] },
      artifact: "## Plan\n\nChanged text flows into a new hash.",
    });
    const { body } = await callStart(changed);
    const parsed = StartToolOutputSchema.parse(body);
    expect(parsed.cached).toEqual([]);
    expect(parsed.agents.map((a) => a.id)).toEqual(["security"]);
  });

  it("changing stage (PLAN→CODE) invalidates the cache", async () => {
    const planArgs = planReviewArgs({ lensConfig: { lenses: ["security"] } });
    await seedCache(planArgs, ["security"]);
    const codeArgs = codeReviewArgs({
      // security activates on CODE_REVIEW for any changed file -- use a
      // source file so the activation registry keeps it in the set.
      changedFiles: ["src/auth.ts"],
      lensConfig: { lenses: ["security"] },
    });
    const { body } = await callStart(codeArgs);
    const parsed = StartToolOutputSchema.parse(body);
    expect(parsed.cached).toEqual([]);
    expect(parsed.agents.map((a) => a.id)).toEqual(["security"]);
  });

  it("changing preambleConfig.findingBudget invalidates the cache", async () => {
    const base = planReviewArgs({
      lensConfig: { lenses: ["security"] },
      preambleConfig: { findingBudget: 10 },
    });
    await seedCache(base, ["security"]);
    const changed = planReviewArgs({
      lensConfig: { lenses: ["security"] },
      preambleConfig: { findingBudget: 25 },
    });
    const { body } = await callStart(changed);
    const parsed = StartToolOutputSchema.parse(body);
    expect(parsed.cached).toEqual([]);
    expect(parsed.agents.map((a) => a.id)).toEqual(["security"]);
  });

  it("LENSES_LENS_CACHE_DISABLE=1 disables reads even with cache populated", async () => {
    const args = planReviewArgs({
      lensConfig: { lenses: ["security", "clean-code"] },
    });
    // Seed cache with DISABLE unset so the file actually lands on disk.
    await seedCache(args, ["security", "clean-code"]);
    process.env.LENSES_LENS_CACHE_DISABLE = "1";
    try {
      const { body } = await callStart(args);
      const parsed = StartToolOutputSchema.parse(body);
      // Both lenses should be re-spawned despite the on-disk hits.
      expect(parsed.cached).toEqual([]);
      expect(parsed.agents.map((a) => a.id).sort()).toEqual([
        "clean-code",
        "security",
      ]);
    } finally {
      delete process.env.LENSES_LENS_CACHE_DISABLE;
    }
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
