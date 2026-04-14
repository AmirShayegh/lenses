import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { beforeEach, describe, expect, it } from "vitest";

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
} = {}): Promise<{ reviewId: string; lensIds: LensId[] }> {
  const result = await handleLensReviewStart({
    method: "tools/call",
    params: {
      name: "lens_review_start",
      arguments: {
        stage: "PLAN_REVIEW",
        artifact: "## Plan\n\nDo the thing.",
        ticketDescription: null,
        reviewRound: 1,
        ...(overrides.lensConfig !== undefined
          ? { lensConfig: overrides.lensConfig }
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

describe("handleLensReviewComplete -- sessionId coupling (T-009 baseline)", () => {
  it("sessionId in the verdict equals the input reviewId", async () => {
    const { reviewId, lensIds } = await startPlanReview({
      lensConfig: { lenses: ["security"] },
    });
    const results = lensIds.map((id) => ({ lensId: id, output: ok() }));
    const { body } = await callComplete({ reviewId, results });
    const verdict = ReviewVerdictSchema.parse(body);
    expect(verdict.sessionId).toBe(reviewId);
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
      expect(verdict.sessionId).toBe(reviewId);
    } finally {
      await client.close().catch(() => {});
      await server.close().catch(() => {});
    }
  });
});
