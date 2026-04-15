import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { readSession } from "../src/cache/session.js";
import { createServer } from "../src/server.js";
import type { LensId } from "../src/lenses/prompts/index.js";
import {
  ReviewVerdictSchema,
  type LensFinding,
  type LensOutput,
  type Severity,
} from "../src/schema/index.js";
import { _resetForTests } from "../src/state/review-state.js";
import { handleLensReviewComplete } from "../src/tools/complete.js";
import { handleLensReviewStart } from "../src/tools/start.js";

// T-014: the tool boundary writes to the session cache on every
// complete. Pin `LENSES_SESSION_DIR` to a per-file temp dir so test
// runs don't pollute the real tmp/lenses-sessions directory and so
// two test files don't race against each other on the same sessionId.
let sessionDir: string;
beforeAll(() => {
  sessionDir = mkdtempSync(join(tmpdir(), "lenses-tools-complete-"));
  process.env.LENSES_SESSION_DIR = sessionDir;
});
afterAll(() => {
  delete process.env.LENSES_SESSION_DIR;
  rmSync(sessionDir, { recursive: true, force: true });
});

beforeEach(() => {
  _resetForTests();
});

function finding(
  severity: Severity,
  overrides: Partial<LensFinding> = {},
): LensFinding {
  return {
    id: overrides.id ?? `f-${severity}`,
    category: overrides.category ?? "generic",
    file: overrides.file ?? null,
    line: overrides.line ?? null,
    description: overrides.description ?? "",
    suggestion: overrides.suggestion ?? "",
    confidence: overrides.confidence ?? 0.8,
    ...overrides,
    severity,
  };
}

function ok(findings: LensFinding[] = []): LensOutput {
  return { status: "ok", findings, error: null, notes: null };
}

async function startPlanReview(overrides: {
  lensConfig?: { lenses?: string[] };
  sessionId?: string;
  reviewRound?: number;
} = {}): Promise<{ reviewId: string; lensIds: LensId[] }> {
  const result = await handleLensReviewStart({
    method: "tools/call",
    params: {
      name: "lens_review_start",
      arguments: {
        stage: "PLAN_REVIEW",
        artifact: "## Plan\n\nDo the thing.",
        ticketDescription: null,
        reviewRound: overrides.reviewRound ?? 1,
        ...(overrides.lensConfig !== undefined
          ? { lensConfig: overrides.lensConfig }
          : {}),
        ...(overrides.sessionId !== undefined
          ? { sessionId: overrides.sessionId }
          : {}),
      },
    },
  });
  const first = result.content[0];
  if (!first || first.type !== "text") {
    throw new Error("unexpected start result shape");
  }
  const parsed = JSON.parse(String(first.text)) as {
    reviewId: string;
    agents: Array<{ id: LensId }>;
  };
  return { reviewId: parsed.reviewId, lensIds: parsed.agents.map((a) => a.id) };
}

async function callComplete(
  args: Record<string, unknown>,
): Promise<{ isError: boolean; body: unknown; text: string }> {
  const result = await handleLensReviewComplete({
    method: "tools/call",
    params: { name: "lens_review_complete", arguments: args },
  });
  const first = result.content[0];
  if (!first || first.type !== "text") {
    throw new Error("unexpected complete result shape");
  }
  const text = String(first.text);
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* error messages are plain text; body stays null */
  }
  return { isError: Boolean(result.isError), body, text };
}

describe("handleLensReviewComplete -- argument validation", () => {
  it("empty args produce isError with the invalid-arguments prefix", async () => {
    const { isError, text } = await callComplete({});
    expect(isError).toBe(true);
    expect(text).toContain("lens_review_complete: invalid arguments");
  });

  it("a malformed output entry is converted to a synthetic error, not a hard rejection", async () => {
    const { reviewId, lensIds } = await startPlanReview({
      lensConfig: { lenses: ["security", "clean-code"] },
    });
    const results = lensIds.map((id, idx) =>
      idx === 0
        ? { lensId: id, output: { status: "ok" /* missing required fields */ } }
        : { lensId: id, output: ok([finding("minor")]) },
    );
    const { isError, body } = await callComplete({ reviewId, results });
    expect(isError).toBe(false);
    const verdict = ReviewVerdictSchema.parse(body);
    // The one real lens contributes one minor finding. The malformed
    // lens is coerced to status: "error" with no findings, so it adds
    // nothing to the counts.
    expect(verdict.verdict).toBe("approve");
    expect(verdict.minor).toBe(1);
    expect(verdict.findings).toHaveLength(1);
  });
});

describe("handleLensReviewComplete -- state machine integration", () => {
  it("unknown reviewId produces the 'review state: unknown reviewId' error", async () => {
    const { isError, text } = await callComplete({
      reviewId: "never-issued",
      results: [],
    });
    expect(isError).toBe(true);
    expect(text).toBe(
      "lens_review_complete: review state: unknown reviewId: never-issued",
    );
  });

  it("missing-lenses submission produces the 'missing expected lens result(s)' error", async () => {
    const { reviewId, lensIds } = await startPlanReview({
      lensConfig: { lenses: ["security", "clean-code"] },
    });
    const onlyFirst = lensIds.slice(0, 1);
    const { isError, text } = await callComplete({
      reviewId,
      results: onlyFirst.map((id) => ({ lensId: id, output: ok() })),
    });
    expect(isError).toBe(true);
    expect(text).toContain("lens_review_complete: review state: submission missing 1 expected lens result(s):");
    expect(text).toContain(lensIds[1]!);
  });

  it("double-complete returns already_complete on the second call", async () => {
    const { reviewId, lensIds } = await startPlanReview({
      lensConfig: { lenses: ["security"] },
    });
    const results = lensIds.map((id) => ({ lensId: id, output: ok() }));
    const first = await callComplete({ reviewId, results });
    expect(first.isError).toBe(false);
    const second = await callComplete({ reviewId, results });
    expect(second.isError).toBe(true);
    expect(second.text).toBe(
      `lens_review_complete: review state: reviewId already completed: ${reviewId}`,
    );
  });
});

describe("handleLensReviewComplete -- merger pipeline happy paths", () => {
  it("all lenses ok with zero findings → approve and all counts zero", async () => {
    const { reviewId, lensIds } = await startPlanReview({
      lensConfig: { lenses: ["security", "clean-code"] },
    });
    const results = lensIds.map((id) => ({ lensId: id, output: ok() }));
    const { isError, body } = await callComplete({ reviewId, results });
    expect(isError).toBe(false);
    const verdict = ReviewVerdictSchema.parse(body);
    expect(verdict.verdict).toBe("approve");
    expect(verdict.blocking).toBe(0);
    expect(verdict.major).toBe(0);
    expect(verdict.minor).toBe(0);
    expect(verdict.suggestion).toBe(0);
    expect(verdict.tensions).toEqual([]);
  });

  it("one major finding across the results → revise, major=1", async () => {
    const { reviewId, lensIds } = await startPlanReview({
      lensConfig: { lenses: ["clean-code"] },
    });
    const results = lensIds.map((id) => ({
      lensId: id,
      output: ok([finding("major")]),
    }));
    const { body } = await callComplete({ reviewId, results });
    const verdict = ReviewVerdictSchema.parse(body);
    expect(verdict.verdict).toBe("revise");
    expect(verdict.major).toBe(1);
    expect(verdict.findings).toHaveLength(1);
  });

  it("one blocking finding → reject, blocking=1 (and ReviewVerdictSchema's own invariant is respected)", async () => {
    const { reviewId, lensIds } = await startPlanReview({
      lensConfig: { lenses: ["security"] },
    });
    const results = lensIds.map((id) => ({
      lensId: id,
      output: ok([finding("blocking")]),
    }));
    const { body } = await callComplete({ reviewId, results });
    const verdict = ReviewVerdictSchema.parse(body);
    expect(verdict.verdict).toBe("reject");
    expect(verdict.blocking).toBe(1);
  });

  it("mixed severity counts across two lenses sum exactly", async () => {
    const { reviewId, lensIds } = await startPlanReview({
      lensConfig: { lenses: ["security", "clean-code"] },
    });
    const [first, second] = lensIds;
    if (!first || !second) throw new Error("need two lens ids");
    const results = [
      {
        lensId: first,
        output: ok([
          finding("blocking", { id: "b1" }),
          finding("minor", { id: "m1" }),
        ]),
      },
      {
        lensId: second,
        output: ok([
          finding("major", { id: "ma1" }),
          finding("suggestion", { id: "s1" }),
        ]),
      },
    ];
    const { body } = await callComplete({ reviewId, results });
    const verdict = ReviewVerdictSchema.parse(body);
    expect(verdict.verdict).toBe("reject");
    expect(verdict.blocking).toBe(1);
    expect(verdict.major).toBe(1);
    expect(verdict.minor).toBe(1);
    expect(verdict.suggestion).toBe(1);
    expect(verdict.findings).toHaveLength(4);
  });
});

describe("handleLensReviewComplete -- resilience", () => {
  it("a malformed output in one lens does not discard findings from the others", async () => {
    const { reviewId, lensIds } = await startPlanReview({
      lensConfig: { lenses: ["security", "clean-code"] },
    });
    const [first, second] = lensIds;
    if (!first || !second) throw new Error("need two lens ids");
    const results = [
      { lensId: first, output: { garbage: true } },
      { lensId: second, output: ok([finding("major")]) },
    ];
    const { body } = await callComplete({ reviewId, results });
    const verdict = ReviewVerdictSchema.parse(body);
    expect(verdict.verdict).toBe("revise");
    expect(verdict.major).toBe(1);
    expect(verdict.findings.map((f) => f.id)).toEqual(["f-major"]);
  });

  it("an unknown lens id (not in LENSES) is coerced to a synthetic error, not a throw", async () => {
    const { reviewId, lensIds } = await startPlanReview({
      lensConfig: { lenses: ["security"] },
    });
    const results = [
      ...lensIds.map((id) => ({ lensId: id, output: ok() })),
      { lensId: "invented-lens", output: ok() },
    ];
    const { isError, body } = await callComplete({ reviewId, results });
    expect(isError).toBe(false);
    const verdict = ReviewVerdictSchema.parse(body);
    expect(verdict.verdict).toBe("approve");
  });

  it("an unknown lens id alongside a real major finding still yields verdict=revise, major=1", async () => {
    const { reviewId, lensIds } = await startPlanReview({
      lensConfig: { lenses: ["clean-code"] },
    });
    const realLens = lensIds[0];
    if (!realLens) throw new Error("need a real lens id");
    const results = [
      { lensId: realLens, output: ok([finding("major")]) },
      { lensId: "invented-lens", output: ok() },
    ];
    const { body } = await callComplete({ reviewId, results });
    const verdict = ReviewVerdictSchema.parse(body);
    expect(verdict.verdict).toBe("revise");
    expect(verdict.major).toBe(1);
    expect(verdict.findings).toHaveLength(1);
  });
});

describe("handleLensReviewComplete -- cross-lens dedup (T-010)", () => {
  it("two lenses reporting (src/x.ts, 10, auth) merge into one finding with two contributing lenses", async () => {
    const { reviewId, lensIds } = await startPlanReview({
      lensConfig: { lenses: ["security", "clean-code"] },
    });
    const [first, second] = lensIds;
    if (!first || !second) throw new Error("need two lens ids");
    const results = [
      {
        lensId: first,
        output: ok([
          finding("major", {
            id: "first-1",
            file: "src/x.ts",
            line: 10,
            category: "auth",
            confidence: 0.7,
          }),
        ]),
      },
      {
        lensId: second,
        output: ok([
          finding("minor", {
            id: "second-1",
            file: "src/x.ts",
            line: 10,
            category: "auth",
            confidence: 0.95,
          }),
        ]),
      },
    ];
    const { body } = await callComplete({ reviewId, results });
    const verdict = ReviewVerdictSchema.parse(body);
    expect(verdict.findings).toHaveLength(1);
    const merged = verdict.findings[0]!;
    expect(merged.contributingLenses).toEqual([first, second]);
    // second won on confidence → surviving severity is minor.
    expect(merged.severity).toBe("minor");
    expect(verdict.verdict).toBe("approve");
    expect(verdict.minor).toBe(1);
    expect(verdict.major).toBe(0);
  });
});

describe("handleLensReviewComplete -- mergerConfig flow-through (T-011)", () => {
  it("custom confidenceFloor on the MCP args drops findings and yields approve", async () => {
    const { reviewId, lensIds } = await startPlanReview({
      lensConfig: { lenses: ["clean-code"] },
    });
    const results = lensIds.map((id) => ({
      lensId: id,
      output: ok([finding("major", { confidence: 0.8, category: "style" })]),
    }));
    const { isError, body } = await callComplete({
      reviewId,
      results,
      mergerConfig: { confidenceFloor: 0.95 },
    });
    expect(isError).toBe(false);
    const verdict = ReviewVerdictSchema.parse(body);
    // 0.8 confidence is below 0.95 floor, category 'style' is not
    // alwaysBlock, so the finding is dropped.
    expect(verdict.verdict).toBe("approve");
    expect(verdict.major).toBe(0);
    expect(verdict.findings).toEqual([]);
  });

  it("alwaysBlock category promotes a minor to blocking and flips to reject", async () => {
    const { reviewId, lensIds } = await startPlanReview({
      lensConfig: { lenses: ["security"] },
    });
    const results = lensIds.map((id) => ({
      lensId: id,
      output: ok([
        finding("minor", {
          id: "inj-1",
          file: "src/x.ts",
          line: 3,
          category: "injection",
          confidence: 0.9,
        }),
      ]),
    }));
    const { body } = await callComplete({ reviewId, results });
    const verdict = ReviewVerdictSchema.parse(body);
    // DEFAULT_MERGER_CONFIG.alwaysBlock includes "injection".
    expect(verdict.verdict).toBe("reject");
    expect(verdict.blocking).toBe(1);
  });

  it("a non-object mergerConfig is rejected at the Zod boundary", async () => {
    const { reviewId, lensIds } = await startPlanReview({
      lensConfig: { lenses: ["security"] },
    });
    const { isError, text } = await callComplete({
      reviewId,
      results: lensIds.map((id) => ({ lensId: id, output: ok() })),
      mergerConfig: "nope",
    });
    expect(isError).toBe(true);
    expect(text).toContain("lens_review_complete: invalid arguments");
  });
});

describe("handleLensReviewComplete -- tension detection (T-012)", () => {
  it("security + performance at the same file, different categories → verdict.tensions has one entry", async () => {
    const { reviewId, lensIds } = await startPlanReview({
      lensConfig: { lenses: ["security", "performance"] },
    });
    const [secId, perfId] = lensIds;
    if (!secId || !perfId) throw new Error("need security + performance");
    const results = [
      {
        lensId: secId,
        output: ok([
          finding("major", {
            id: "s1",
            file: "src/auth.ts",
            line: 10,
            category: "auth",
            confidence: 0.9,
          }),
        ]),
      },
      {
        lensId: perfId,
        output: ok([
          finding("major", {
            id: "p1",
            file: "src/auth.ts",
            line: 20,
            category: "hot-path",
            confidence: 0.9,
          }),
        ]),
      },
    ];
    const { body } = await callComplete({ reviewId, results });
    const verdict = ReviewVerdictSchema.parse(body);
    expect(verdict.tensions).toHaveLength(1);
    expect(verdict.tensions[0]!.category).toBe("security-vs-performance");
    expect(verdict.tensions[0]!.lenses).toEqual(["security", "performance"]);
  });
});

describe("handleLensReviewComplete -- sessionId decoupling (T-014)", () => {
  const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  it("round-1 with no supplied sessionId mints a UUID distinct from reviewId", async () => {
    const { reviewId, lensIds } = await startPlanReview({
      lensConfig: { lenses: ["security"] },
    });
    const results = lensIds.map((id) => ({ lensId: id, output: ok() }));
    const { body } = await callComplete({ reviewId, results });
    const verdict = ReviewVerdictSchema.parse(body);
    expect(verdict.sessionId).not.toBe(reviewId);
    expect(verdict.sessionId).toMatch(UUID_RE);
  });

  it("round-1 passes a user-supplied sessionId through unchanged", async () => {
    const explicitSessionId = "11111111-1111-4111-8111-111111111111";
    const { reviewId, lensIds } = await startPlanReview({
      lensConfig: { lenses: ["security"] },
      sessionId: explicitSessionId,
    });
    const results = lensIds.map((id) => ({ lensId: id, output: ok() }));
    const { body } = await callComplete({ reviewId, results });
    const verdict = ReviewVerdictSchema.parse(body);
    expect(verdict.sessionId).toBe(explicitSessionId);
    expect(verdict.sessionId).not.toBe(reviewId);
  });

  it("round-2 with the prior sessionId yields a distinct reviewId but the same sessionId, and appends a round on disk", async () => {
    const r1 = await startPlanReview({
      lensConfig: { lenses: ["security"] },
    });
    const r1results = r1.lensIds.map((id) => ({ lensId: id, output: ok() }));
    const r1out = await callComplete({
      reviewId: r1.reviewId,
      results: r1results,
    });
    const r1verdict = ReviewVerdictSchema.parse(r1out.body);

    const r2 = await startPlanReview({
      lensConfig: { lenses: ["security"] },
      sessionId: r1verdict.sessionId,
      reviewRound: 2,
    });
    const r2results = r2.lensIds.map((id) => ({ lensId: id, output: ok() }));
    const r2out = await callComplete({
      reviewId: r2.reviewId,
      results: r2results,
    });
    const r2verdict = ReviewVerdictSchema.parse(r2out.body);

    expect(r2.reviewId).not.toBe(r1.reviewId);
    expect(r2verdict.sessionId).toBe(r1verdict.sessionId);

    const stored = readSession(r1verdict.sessionId);
    expect(stored).toBeDefined();
    expect(stored!.rounds).toHaveLength(2);
    expect(stored!.rounds[0]!.roundNumber).toBe(1);
    expect(stored!.rounds[1]!.roundNumber).toBe(2);
    expect(stored!.rounds[0]!.reviewId).toBe(r1.reviewId);
    expect(stored!.rounds[1]!.reviewId).toBe(r2.reviewId);
  });

  it("RULES.md §4: a cache write failure does not turn a successful review into a tool error", async () => {
    // Pin the structural guarantee: when persistRoundBestEffort throws
    // underneath (here because cacheDir() can't mkdir on top of a
    // regular file and `mkdirSync({recursive: true})` raises ENOTDIR),
    // the tool MUST still return the verdict with isError=false. This
    // is the integration-level counterpart to cache-session.test.ts's
    // unit coverage -- a regression that let a cache throw escape the
    // helper (e.g., a future refactor moving the call back inside the
    // outer try without its inner guards) would fail THIS test, not a
    // unit test, so the system-level §4 contract stays defended.
    const { reviewId, lensIds } = await startPlanReview({
      lensConfig: { lenses: ["security"] },
    });
    const results = lensIds.map((id) => ({ lensId: id, output: ok() }));

    const originalDir = process.env.LENSES_SESSION_DIR;
    const brokenPath = join(sessionDir, "not-a-dir");
    writeFileSync(brokenPath, "i am a file, not a directory");
    process.env.LENSES_SESSION_DIR = brokenPath;
    try {
      const { isError, body } = await callComplete({ reviewId, results });
      expect(isError).toBe(false);
      const verdict = ReviewVerdictSchema.parse(body);
      expect(verdict.verdict).toBe("approve");
      // sessionId is still well-formed on the wire even though the
      // write under the hood failed -- the wire contract does not
      // depend on disk success.
      expect(typeof verdict.sessionId).toBe("string");
      expect(verdict.sessionId.length).toBeGreaterThan(0);
    } finally {
      process.env.LENSES_SESSION_DIR = originalDir;
    }
  });

  it("orphaned sessionId (no on-disk record) is accepted and creates a new file", async () => {
    // Documents the T-014 behavior for round-2+ with a sessionId the
    // cache has never seen: the server threads it through and writes
    // a fresh record. T-015 will read at start-time; this test pins
    // the stable contract so an accidental "reject unknown session"
    // regression is caught.
    const orphanSessionId = "22222222-2222-4222-8222-222222222222";
    const { reviewId, lensIds } = await startPlanReview({
      lensConfig: { lenses: ["security"] },
      sessionId: orphanSessionId,
    });
    const results = lensIds.map((id) => ({ lensId: id, output: ok() }));
    const { isError, body } = await callComplete({ reviewId, results });
    expect(isError).toBe(false);
    const verdict = ReviewVerdictSchema.parse(body);
    expect(verdict.sessionId).toBe(orphanSessionId);
    const stored = readSession(orphanSessionId);
    expect(stored).toBeDefined();
    expect(stored!.rounds).toHaveLength(1);
  });
});

describe("handleLensReviewComplete -- MCP server round-trip", () => {
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

  it("returns a well-formed verdict over the MCP transport", async () => {
    const { reviewId, lensIds } = await startPlanReview({
      lensConfig: { lenses: ["security"] },
    });
    const { client, server } = await connectedPair();
    try {
      const result = await client.request(
        {
          method: "tools/call",
          params: {
            name: "lens_review_complete",
            arguments: {
              reviewId,
              results: lensIds.map((id) => ({ lensId: id, output: ok() })),
            },
          },
        },
        CallToolResultSchema,
      );
      expect(result.isError).not.toBe(true);
      const first = result.content[0];
      if (first?.type !== "text") throw new Error("expected text content");
      const verdict = ReviewVerdictSchema.parse(JSON.parse(first.text));
      expect(verdict.verdict).toBe("approve");
      // T-014: sessionId diverges from reviewId at the MCP boundary.
      // Pinned here so a regression that re-coupled them (e.g., a
      // start-tool refactor losing the `parsed.sessionId ?? uuid()`
      // fallback) fails over the actual transport, not just a unit
      // path.
      expect(verdict.sessionId).not.toBe(reviewId);
      expect(verdict.sessionId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
    } finally {
      await client.close().catch(() => {});
      await server.close().catch(() => {});
    }
  });
});
