import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
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
import {
  _clearMapOnlyForTests,
  _resetForTests,
} from "../src/state/review-state.js";
import { handleLensReviewComplete } from "../src/tools/complete.js";
import { handleLensReviewStart } from "../src/tools/start.js";

// T-014: the tool boundary writes to the session cache on every
// complete. Pin `LENSES_SESSION_DIR` to a per-file temp dir so test
// runs don't pollute the real tmp/lenses-sessions directory and so
// two test files don't race against each other on the same sessionId.
// T-015 applies the same isolation to the per-lens cache: without a
// per-file cache dir, hits from prior runs would make `agents` come
// back empty and `cachedResults` would smuggle extra lens coverage
// into state-machine assertions.
let sessionDir: string;
let lensCacheDir: string;
let inFlightDir: string;
beforeAll(() => {
  sessionDir = mkdtempSync(join(tmpdir(), "lenses-tools-complete-"));
  lensCacheDir = mkdtempSync(join(tmpdir(), "lenses-tools-complete-lc-"));
  inFlightDir = mkdtempSync(join(tmpdir(), "lenses-tools-complete-if-"));
  process.env.LENSES_SESSION_DIR = sessionDir;
  process.env.LENSES_LENS_CACHE_DIR = lensCacheDir;
  process.env.LENSES_IN_FLIGHT_DIR = inFlightDir;
});
afterAll(() => {
  delete process.env.LENSES_SESSION_DIR;
  delete process.env.LENSES_LENS_CACHE_DIR;
  delete process.env.LENSES_IN_FLIGHT_DIR;
  rmSync(sessionDir, { recursive: true, force: true });
  rmSync(lensCacheDir, { recursive: true, force: true });
  rmSync(inFlightDir, { recursive: true, force: true });
});

// Clear BOTH the in-memory state and the on-disk lens cache between
// every it() so each legacy test starts from a true miss regardless
// of ordering. The dedicated T-015 integration tests (below) manage
// their own fixtures explicitly when they need round-to-round
// continuity.
beforeEach(() => {
  _resetForTests();
  rmSync(lensCacheDir, { recursive: true, force: true });
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

  // T-022: a malformed output entry no longer silently becomes a
  // syntheticError — it surfaces via `parseErrors[]` AND, if attempts
  // remain, triggers a `nextActions[]` retry which downgrades the
  // verdict to `revise` so the caller knows there is unresolved state.
  it("a malformed output surfaces in parseErrors[] + nextActions[] and downgrades to revise", async () => {
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
    // The clean lens still contributes its minor finding. Verdict is
    // downgraded to `revise` because the malformed lens has a retry
    // queued.
    expect(verdict.verdict).toBe("revise");
    expect(verdict.minor).toBe(1);
    expect(verdict.findings).toHaveLength(1);
    // parseErrors[] surfaces the specific issues on the malformed lens.
    expect(verdict.parseErrors).toHaveLength(1);
    expect(verdict.parseErrors[0]?.lensId).toBe(lensIds[0]);
    // nextActions[] carries the retry instruction for that lens.
    expect(verdict.nextActions).toHaveLength(1);
    expect(verdict.nextActions[0]?.lensId).toBe(lensIds[0]);
    expect(verdict.nextActions[0]?.attempt).toBe(2);
  });
});

/**
 * T-022 contract regression pins.
 *
 * Live-test regression (2026-04-23): an orchestrator injected `lensId`
 * into the per-lens `output` envelope for its own tracking, which used
 * to trip `.strict()` on `LensOutputSchema`, produce a `syntheticError`,
 * and make all five real findings vanish via the `status !== "ok"`
 * dedup filter. The fix is envelope `.passthrough()` + envelope-vs-
 * finding parseError classification.
 */
describe("handleLensReviewComplete -- T-022 contract fixes", () => {
  it("unknown ENVELOPE field does NOT swallow findings (live-test regression)", async () => {
    const { reviewId, lensIds } = await startPlanReview({
      lensConfig: { lenses: ["security", "clean-code"] },
    });
    // Replicate the orchestrator's bookkeeping injection: an extra
    // `lensId` field inside `output`. Before T-022 this caused the
    // whole lens's findings to vanish.
    const results = lensIds.map((id) => ({
      lensId: id,
      output: {
        ...ok([finding("minor", { id: `f-${id}`, confidence: 0.75 })]),
        lensId: id, // the contract-leak-triggering injection
      },
    }));
    const { isError, body } = await callComplete({ reviewId, results });
    expect(isError).toBe(false);
    const verdict = ReviewVerdictSchema.parse(body);
    // Both findings must surface. No parseErrors, no nextActions.
    expect(verdict.findings).toHaveLength(2);
    expect(verdict.minor).toBe(2);
    expect(verdict.parseErrors).toHaveLength(0);
    expect(verdict.nextActions).toHaveLength(0);
    expect(verdict.hadAnyFindings).toBe(true);
  });

  it("malformed FINDING surfaces in parseErrors[] but does not drop the sibling lens", async () => {
    const { reviewId, lensIds } = await startPlanReview({
      lensConfig: { lenses: ["security", "clean-code"] },
    });
    const results = lensIds.map((id, idx) =>
      idx === 0
        ? {
            lensId: id,
            // Malformed finding: missing required fields. Triggers
            // per-finding strict-mode rejection → phase "finding".
            output: {
              status: "ok",
              findings: [{ id: "f1", severity: "minor" }],
              error: null,
              notes: null,
            },
          }
        : { lensId: id, output: ok([finding("minor", { confidence: 0.75 })]) },
    );
    const { isError, body } = await callComplete({ reviewId, results });
    expect(isError).toBe(false);
    const verdict = ReviewVerdictSchema.parse(body);
    expect(verdict.findings).toHaveLength(1);
    expect(verdict.parseErrors).toHaveLength(1);
    expect(verdict.parseErrors[0]?.lensId).toBe(lensIds[0]);
    expect(verdict.parseErrors[0]?.phase).toBe("finding");
  });

  it("below-floor finding surfaces in deferred[] with reason below_confidence_floor", async () => {
    const { reviewId, lensIds } = await startPlanReview({
      lensConfig: { lenses: ["security", "clean-code"] },
    });
    const results = [
      {
        lensId: lensIds[0],
        output: ok([
          finding("minor", { id: "low", confidence: 0.1, file: "a.ts", line: 1 }),
        ]),
      },
      {
        lensId: lensIds[1],
        output: ok([
          finding("minor", { id: "ok", confidence: 0.8, file: "b.ts", line: 1 }),
        ]),
      },
    ];
    const { isError, body } = await callComplete({ reviewId, results });
    expect(isError).toBe(false);
    const verdict = ReviewVerdictSchema.parse(body);
    expect(verdict.findings).toHaveLength(1);
    expect(verdict.findings[0]?.id).toBe("ok");
    expect(verdict.deferred).toHaveLength(1);
    expect(verdict.deferred[0]?.finding.id).toBe("low");
    expect(verdict.deferred[0]?.reason).toBe("below_confidence_floor");
    expect(verdict.suppressedFindingCount).toBe(1);
    expect(verdict.hadAnyFindings).toBe(true);
  });

  it("hadAnyFindings is distinguishable from a clean approve", async () => {
    const { reviewId, lensIds } = await startPlanReview({
      lensConfig: { lenses: ["security", "clean-code"] },
    });
    // No findings from either lens → hadAnyFindings=false.
    const clean = lensIds.map((id) => ({ lensId: id, output: ok([]) }));
    const { body } = await callComplete({ reviewId, results: clean });
    const verdict = ReviewVerdictSchema.parse(body);
    expect(verdict.findings).toEqual([]);
    expect(verdict.deferred).toEqual([]);
    expect(verdict.hadAnyFindings).toBe(false);
    expect(verdict.verdict).toBe("approve");
  });

  it("retry flow: attempt=2 resolves the malformed lens and verdict returns to approve", async () => {
    const { reviewId, lensIds } = await startPlanReview({
      lensConfig: { lenses: ["security", "clean-code"] },
    });
    const malformed = {
      lensId: lensIds[0],
      output: { status: "ok" /* missing findings/error/notes */ },
      attempt: 1,
    };
    const clean = { lensId: lensIds[1], output: ok([]), attempt: 1 };
    const first = await callComplete({
      reviewId,
      results: [malformed, clean],
    });
    expect(first.isError).toBe(false);
    const firstVerdict = ReviewVerdictSchema.parse(first.body);
    expect(firstVerdict.verdict).toBe("revise");
    expect(firstVerdict.nextActions).toHaveLength(1);
    expect(firstVerdict.nextActions[0]?.attempt).toBe(2);

    // Resubmit attempt 2 with a clean payload for the same lens.
    const retry = await callComplete({
      reviewId,
      results: [{ lensId: lensIds[0], output: ok([]), attempt: 2 }],
    });
    expect(retry.isError).toBe(false);
    const retryVerdict = ReviewVerdictSchema.parse(retry.body);
    expect(retryVerdict.verdict).toBe("approve");
    expect(retryVerdict.nextActions).toEqual([]);
    expect(retryVerdict.parseErrors).toEqual([]);
    // L-003: after a clean retry with no findings, hadAnyFindings stays
    // false — distinguishable from the "concerns suppressed" case.
    expect(retryVerdict.hadAnyFindings).toBe(false);
  });

  it("retry exhaustion at max_attempts terminates with parseErrors[], no more nextActions", async () => {
    const { reviewId, lensIds } = await startPlanReview({
      lensConfig: { lenses: ["security", "clean-code"] },
    });
    // First call: malformed + clean. Default maxAttempts=2 → one retry.
    const firstRes = await callComplete({
      reviewId,
      results: [
        { lensId: lensIds[0], output: { status: "ok" }, attempt: 1 },
        { lensId: lensIds[1], output: ok([]), attempt: 1 },
      ],
    });
    expect(firstRes.isError).toBe(false);
    const firstVerdict = ReviewVerdictSchema.parse(firstRes.body);
    expect(firstVerdict.nextActions).toHaveLength(1);

    // Retry is also malformed; attempt=2 reaches maxAttempts, so no
    // further nextActions are emitted.
    const retryRes = await callComplete({
      reviewId,
      results: [
        { lensId: lensIds[0], output: { status: "ok" }, attempt: 2 },
      ],
    });
    expect(retryRes.isError).toBe(false);
    const retryVerdict = ReviewVerdictSchema.parse(retryRes.body);
    expect(retryVerdict.nextActions).toHaveLength(0);
    expect(retryVerdict.parseErrors).toHaveLength(1);
    expect(retryVerdict.parseErrors[0]?.attempt).toBe(2);
  });

  it("stale attempt (resubmit with same or earlier number) is rejected", async () => {
    const { reviewId, lensIds } = await startPlanReview({
      lensConfig: { lenses: ["security", "clean-code"] },
    });
    // First call covers both lenses at attempt 1. Session advances.
    await callComplete({
      reviewId,
      results: [
        {
          lensId: lensIds[0],
          output: { status: "ok" },
          attempt: 1,
        },
        { lensId: lensIds[1], output: ok([]), attempt: 1 },
      ],
    });
    // Resubmit attempt 1 for the malformed lens (should be rejected
    // as stale).
    const stale = await callComplete({
      reviewId,
      results: [
        {
          lensId: lensIds[0],
          output: { status: "ok" },
          attempt: 1,
        },
      ],
    });
    expect(stale.isError).toBe(true);
    expect(stale.text).toContain("stale attempt");
  });
});

/**
 * T-024: in-flight state survives an MCP server restart. We simulate
 * the restart by clearing ONLY the in-process Map (leaving the disk
 * state intact), then calling hop-2 with the reviewId issued before
 * the wipe. The handler must rehydrate the session from disk and emit
 * a verdict.
 */
describe("handleLensReviewComplete -- T-024 restart recovery", () => {
  it("reviewId survives a Map wipe; hop-2 still produces a verdict", async () => {
    const { reviewId, lensIds } = await startPlanReview({
      lensConfig: { lenses: ["security", "clean-code"] },
    });
    // Simulate restart: memory gone, disk intact.
    _clearMapOnlyForTests();

    const results = lensIds.map((id) => ({
      lensId: id,
      output: ok([finding("minor", { confidence: 0.8 })]),
    }));
    const { isError, body } = await callComplete({ reviewId, results });
    expect(isError).toBe(false);
    const verdict = ReviewVerdictSchema.parse(body);
    expect(verdict.findings).toHaveLength(2);
    expect(verdict.minor).toBe(2);
    // Two minor findings, no blockers → computeVerdict approves.
    expect(verdict.verdict).toBe("approve");
    expect(verdict.hadAnyFindings).toBe(true);
  });

  it("disk write failure during the submit cycle does not turn the review into isError", async () => {
    const { reviewId, lensIds } = await startPlanReview({
      lensConfig: { lenses: ["security", "clean-code"] },
    });
    // Point the in-flight dir at a non-directory path so the next
    // writeTask call throws. persistInFlightBestEffort runs outside
    // the outer try/catch, so the verdict still arrives.
    const original = process.env.LENSES_IN_FLIGHT_DIR;
    const badPath = join(sessionDir, "not-a-dir");
    // Create a FILE at that path so mkdirSync(badPath, recursive) fails.
    writeFileSync(badPath, "x");
    process.env.LENSES_IN_FLIGHT_DIR = badPath;
    try {
      const results = lensIds.map((id) => ({
        lensId: id,
        output: ok([]),
      }));
      const { isError, body } = await callComplete({ reviewId, results });
      expect(isError).toBe(false);
      const verdict = ReviewVerdictSchema.parse(body);
      expect(verdict.verdict).toBe("approve");
    } finally {
      if (original === undefined) {
        delete process.env.LENSES_IN_FLIGHT_DIR;
      } else {
        process.env.LENSES_IN_FLIGHT_DIR = original;
      }
    }
  });
});

/**
 * T-022/T-024 ISS-004: past-`expiresAt` rejection carries the
 * REVIEW_EXPIRED LensErrorCode and fires at the tool boundary (not
 * just the unit-tested state-machine layer).
 */
describe("handleLensReviewComplete -- T-022 expiresAt rejection", () => {
  it("submission past expiresAt returns isError with errorCode=REVIEW_EXPIRED", async () => {
    // lensTimeout: 1 ms -> expiresAt is in the past by the time we
    // call hop-2. Submission is rejected by the state machine with
    // `review_expired`, which maps to REVIEW_EXPIRED on the wire.
    const startResult = await handleLensReviewStart({
      method: "tools/call",
      params: {
        name: "lens_review_start",
        arguments: {
          stage: "PLAN_REVIEW",
          artifact: "## Plan\n\nDo the thing.",
          ticketDescription: null,
          reviewRound: 1,
          lensConfig: { lenses: ["security"], lensTimeout: 1 },
        },
      },
    });
    const startFirst = startResult.content[0];
    if (!startFirst || startFirst.type !== "text") throw new Error();
    const parsed = JSON.parse(String(startFirst.text)) as {
      reviewId: string;
      agents: Array<{ id: LensId }>;
    };
    // Ensure the 1 ms deadline has elapsed.
    await new Promise((r) => setTimeout(r, 5));

    const { isError, text } = await callComplete({
      reviewId: parsed.reviewId,
      results: [{ lensId: parsed.agents[0]!.id, output: ok() }],
    });
    expect(isError).toBe(true);
    const body = JSON.parse(text) as {
      errorCode: string;
      message: string;
    };
    expect(body.errorCode).toBe("REVIEW_EXPIRED");
    expect(body.message).toContain("REVIEW_EXPIRED");
  });
});

describe("handleLensReviewComplete -- state machine integration", () => {
  it("unknown reviewId produces the 'review state: unknown reviewId' error", async () => {
    const { isError, text } = await callComplete({
      reviewId: "never-issued",
      results: [],
    });
    expect(isError).toBe(true);
    // T-024 ISS-004: state-machine rejections now carry a structured
    // LensErrorCode in the text payload. `text` is JSON-encoded
    // `{errorCode, message}`.
    const body = JSON.parse(text) as {
      errorCode: string;
      message: string;
    };
    expect(body.errorCode).toBe("UNKNOWN_ERROR");
    expect(body.message).toBe(
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
    // Second call with a DIFFERENT attempt number so the state-machine
    // rejection is `already_complete` (not `stale_attempt`).
    const retryResults = lensIds.map((id) => ({
      lensId: id,
      output: ok(),
      attempt: 2,
    }));
    const second = await callComplete({ reviewId, results: retryResults });
    expect(second.isError).toBe(true);
    const body = JSON.parse(second.text) as {
      errorCode: string;
      message: string;
    };
    // T-024 ISS-004: already_complete maps to DUPLICATE_COMPLETE.
    expect(body.errorCode).toBe("DUPLICATE_COMPLETE");
    expect(body.message).toBe(
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

/**
 * T-015 per-lens cache. These tests drive the full two-hop flow
 * (start → complete → start) and make assertions about what lands on
 * disk vs what gets re-injected as `cached[...]` on the next round.
 * Plan §8c is the source of truth for what each case pins.
 *
 * Why drive start twice rather than pre-seed via `writeLensCache`:
 * these tests are about the WRITE path in `complete.ts` and the
 * round-trip semantics (errors don't cache, cached entries participate
 * in the merger, etc). Pre-seeding skips the code under test.
 */
describe("handleLensReviewComplete -- T-015 per-lens cache (§8c)", () => {
  /**
   * Glob the current lens cache dir for JSON files with a given
   * lensId prefix. `writeLensCache` names files
   * `<lensId>-<promptHash>.json`, so a prefix match uniquely
   * identifies a lens's cache entry without needing to recompute the
   * hash in the test.
   */
  function cacheFilesFor(lensId: LensId): string[] {
    return readdirSync(lensCacheDir).filter(
      (f) => f.startsWith(`${lensId}-`) && f.endsWith(".json"),
    );
  }

  it("§8c-1: round 1 with ok results writes one cache file per lens", async () => {
    const { reviewId, lensIds } = await startPlanReview({
      lensConfig: { lenses: ["security", "clean-code"] },
    });
    expect(lensIds.sort()).toEqual(["clean-code", "security"]);
    const results = lensIds.map((id) => ({ lensId: id, output: ok() }));
    const { isError } = await callComplete({ reviewId, results });
    expect(isError).toBe(false);
    expect(cacheFilesFor("security")).toHaveLength(1);
    expect(cacheFilesFor("clean-code")).toHaveLength(1);
  });

  it("§8c-2: round-2 hop-1 returns cached findings and hop-2 accepts partial results", async () => {
    const args = {
      lensConfig: { lenses: ["security", "clean-code"] as string[] },
    };
    // Round 1: security emits a major finding, clean-code empty. Both
    // get cached. Category is deliberately NOT in
    // `DEFAULT_ALWAYS_BLOCK` ("injection" etc.) so the blocking
    // policy does not promote the severity -- this test pins the
    // round-trip of a plain major finding through the cache, not
    // the policy-promotion behavior.
    const securityFinding = finding("major", {
      id: "s-1",
      category: "token-leak",
      file: "src/auth.ts",
      line: 12,
      description: "unchecked input",
      suggestion: "validate",
      confidence: 0.9,
    });
    {
      const { reviewId, lensIds } = await startPlanReview(args);
      const results = lensIds.map((id) => ({
        lensId: id,
        output: id === "security" ? ok([securityFinding]) : ok(),
      }));
      const r1 = await callComplete({ reviewId, results });
      expect(r1.isError).toBe(false);
    }

    // Round 2: identical inputs INCLUDING reviewRound -- the prompt
    // embeds the round number, so a different round would legitimately
    // miss the cache (different hash). "Immediate identical" per
    // plan §11 acceptance means every field equal.
    const r2Start = await handleLensReviewStart({
      method: "tools/call",
      params: {
        name: "lens_review_start",
        arguments: {
          stage: "PLAN_REVIEW",
          artifact: "## Plan\n\nDo the thing.",
          ticketDescription: null,
          reviewRound: 1,
          ...args,
        },
      },
    });
    const r2First = r2Start.content[0];
    if (!r2First || r2First.type !== "text") throw new Error();
    const r2Body = JSON.parse(String(r2First.text)) as {
      reviewId: string;
      agents: Array<{ id: LensId }>;
      cached: Array<{ id: LensId; findings: LensFinding[] }>;
    };
    expect(r2Body.agents).toEqual([]);
    expect(r2Body.cached.map((c) => c.id).sort()).toEqual([
      "clean-code",
      "security",
    ]);

    // Hop-2 with empty results still succeeds because the state
    // machine treats cached lenses as covered, and the merger
    // re-injects the cached findings.
    const { isError, body } = await callComplete({
      reviewId: r2Body.reviewId,
      results: [],
    });
    expect(isError).toBe(false);
    const verdict = ReviewVerdictSchema.parse(body);
    expect(verdict.major).toBe(1);
    expect(verdict.findings).toHaveLength(1);
    expect(verdict.findings[0]?.category).toBe("token-leak");
    expect(verdict.findings[0]?.contributingLenses).toContain("security");
  });

  it("§8c-3: cached findings participate in the confidence floor", async () => {
    // Round 1: cache a finding whose confidence is below a strict
    // floor we'll set at round 2. Uses a minor severity so it doesn't
    // hit blocking-policy promotion.
    const args = { lensConfig: { lenses: ["clean-code"] as string[] } };
    const lowConfFinding = finding("minor", {
      id: "c-1",
      category: "naming",
      confidence: 0.5,
    });
    {
      const { reviewId, lensIds } = await startPlanReview(args);
      const results = lensIds.map((id) => ({
        lensId: id,
        output: ok([lowConfFinding]),
      }));
      expect((await callComplete({ reviewId, results })).isError).toBe(false);
    }

    // Round 2: identical inputs. The cache hit depends on the prompt
    // being byte-equal, which means reviewRound must match (the
    // preamble embeds it). Merger receives the cached finding and
    // drops it against the strict confidenceFloor the same way it
    // would have for a fresh finding.
    const r2Start = await handleLensReviewStart({
      method: "tools/call",
      params: {
        name: "lens_review_start",
        arguments: {
          stage: "PLAN_REVIEW",
          artifact: "## Plan\n\nDo the thing.",
          ticketDescription: null,
          reviewRound: 1,
          ...args,
        },
      },
    });
    const r2First = r2Start.content[0];
    if (!r2First || r2First.type !== "text") throw new Error();
    const r2Body = JSON.parse(String(r2First.text)) as {
      reviewId: string;
    };
    const { body } = await callComplete({
      reviewId: r2Body.reviewId,
      results: [],
      mergerConfig: { confidenceFloor: 0.8 },
    });
    const verdict = ReviewVerdictSchema.parse(body);
    expect(verdict.minor).toBe(0);
    expect(verdict.findings).toHaveLength(0);
  });

  it("§8c-4: a cached finding dedups against a fresh finding from another lens at the same key", async () => {
    // Round 1: both lenses return ok, but only security has a
    // finding at (src/x.ts, 10, taint). Both get cached; clean-code's
    // cache is empty. Category chosen to avoid alwaysBlock promotion.
    const args = {
      lensConfig: { lenses: ["security", "clean-code"] as string[] },
    };
    const sharedKey = finding("minor", {
      id: "s-1",
      category: "taint",
      file: "src/x.ts",
      line: 10,
      confidence: 0.9,
    });
    {
      const { reviewId, lensIds } = await startPlanReview(args);
      const results = lensIds.map((id) => ({
        lensId: id,
        output: id === "security" ? ok([sharedKey]) : ok(),
      }));
      await callComplete({ reviewId, results });
    }

    // Second start with identical inputs. Security hits the cache
    // with its one finding. Clean-code ALSO hits cache (empty). But
    // the agent re-submits clean-code with a finding at the SAME
    // (file, line, category) key as security's cached one, simulating
    // a round where clean-code independently flagged the same issue.
    // Fresh wins over cached for clean-code; the merger then
    // deduplicates the (security cached) + (clean-code fresh) pair
    // into one merged finding with two contributing lenses.
    const r2 = await handleLensReviewStart({
      method: "tools/call",
      params: {
        name: "lens_review_start",
        arguments: {
          stage: "PLAN_REVIEW",
          artifact: "## Plan\n\nDo the thing.",
          ticketDescription: null,
          reviewRound: 1,
          ...args,
        },
      },
    });
    const first = r2.content[0];
    if (!first || first.type !== "text") throw new Error();
    const r2Body = JSON.parse(String(first.text)) as {
      reviewId: string;
      cached: Array<{ id: LensId }>;
    };
    expect(r2Body.cached.map((c) => c.id).sort()).toEqual([
      "clean-code",
      "security",
    ]);
    const freshSameKey = finding("minor", {
      id: "cc-1",
      category: "taint",
      file: "src/x.ts",
      line: 10,
      confidence: 0.7,
    });
    const { isError, body } = await callComplete({
      reviewId: r2Body.reviewId,
      results: [{ lensId: "clean-code", output: ok([freshSameKey]) }],
    });
    expect(isError).toBe(false);
    const verdict = ReviewVerdictSchema.parse(body);
    expect(verdict.findings).toHaveLength(1);
    expect(verdict.findings[0]?.contributingLenses.sort()).toEqual([
      "clean-code",
      "security",
    ]);
    // Higher-confidence (security's 0.9) wins the confidence tiebreak.
    expect(verdict.findings[0]?.id).toBe("s-1");
    expect(verdict.findings[0]?.confidence).toBe(0.9);
  });

  it("§8c-5: status:error outputs are NOT cached (round 2 re-spawns)", async () => {
    const args = { lensConfig: { lenses: ["security"] as string[] } };
    const { reviewId, lensIds } = await startPlanReview(args);
    const results = lensIds.map((id) => ({
      lensId: id,
      output: {
        status: "error" as const,
        error: "transient failure",
        findings: [] as LensFinding[],
        notes: null,
      },
    }));
    expect((await callComplete({ reviewId, results })).isError).toBe(false);
    expect(cacheFilesFor("security")).toHaveLength(0);

    // Re-open with the SAME reviewRound so the prompt hash is
    // identical to round 1. With reviewRound: 2 the preamble embeds a
    // different round number, the hash changes, and the re-spawn
    // assertion would be vacuous (ANY new round misses). Keeping
    // round 1 ensures this test exercises the error-skip-write guard,
    // not the round-number hash differential.
    const r2 = await handleLensReviewStart({
      method: "tools/call",
      params: {
        name: "lens_review_start",
        arguments: {
          stage: "PLAN_REVIEW",
          artifact: "## Plan\n\nDo the thing.",
          ticketDescription: null,
          reviewRound: 1,
          ...args,
        },
      },
    });
    const first = r2.content[0];
    if (!first || first.type !== "text") throw new Error();
    const body = JSON.parse(String(first.text)) as {
      agents: Array<{ id: LensId }>;
      cached: Array<{ id: LensId }>;
    };
    expect(body.cached).toEqual([]);
    expect(body.agents.map((a) => a.id)).toEqual(["security"]);
  });

  it("§8c-6: synthetic-error results (unknown lens id) are NOT cached", async () => {
    const { reviewId, lensIds } = await startPlanReview({
      lensConfig: { lenses: ["security"] },
    });
    // Submit the real lens ok, PLUS an unknown lens id which the
    // handler coerces to synthetic error. The real lens IS cached;
    // the unknown one must not produce any file.
    const results = [
      ...lensIds.map((id) => ({ lensId: id, output: ok() })),
      { lensId: "not-a-real-lens", output: ok() },
    ];
    expect((await callComplete({ reviewId, results })).isError).toBe(false);
    expect(cacheFilesFor("security")).toHaveLength(1);
    // Nothing resembling the fake id should be on disk.
    const allFiles = readdirSync(lensCacheDir);
    for (const f of allFiles) {
      expect(f.startsWith("not-a-real-lens-")).toBe(false);
    }
  });

  it("§8c-7: a previously-errored lens gets cached once it eventually succeeds", async () => {
    const args = { lensConfig: { lenses: ["security"] as string[] } };
    // Round 1: error → no cache.
    {
      const { reviewId, lensIds } = await startPlanReview(args);
      const results = lensIds.map((id) => ({
        lensId: id,
        output: {
          status: "error" as const,
          error: "timeout",
          findings: [] as LensFinding[],
          notes: null,
        },
      }));
      await callComplete({ reviewId, results });
    }
    expect(cacheFilesFor("security")).toHaveLength(0);

    // Round 2: ok → cache written.
    {
      const { reviewId, lensIds } = await startPlanReview({
        ...args,
        reviewRound: 2,
      });
      const results = lensIds.map((id) => ({ lensId: id, output: ok() }));
      expect((await callComplete({ reviewId, results })).isError).toBe(false);
    }
    expect(cacheFilesFor("security")).toHaveLength(1);
  });

  it("§8c-8: RULES §4 -- a lens-cache write failure does NOT turn a successful review into isError", async () => {
    const { reviewId, lensIds } = await startPlanReview({
      lensConfig: { lenses: ["security"] },
    });
    const results = lensIds.map((id) => ({ lensId: id, output: ok() }));

    // Break the lens-cache dir the same way the session-cache test
    // does: point at a regular file so mkdirSync({recursive: true})
    // raises ENOTDIR. Session cache stays valid (different env var)
    // so this test isolates the lens-cache failure path.
    const originalDir = process.env.LENSES_LENS_CACHE_DIR;
    const brokenPath = join(lensCacheDir, "not-a-dir");
    writeFileSync(brokenPath, "i am a file, not a directory");
    process.env.LENSES_LENS_CACHE_DIR = brokenPath;
    try {
      const { isError, body } = await callComplete({ reviewId, results });
      expect(isError).toBe(false);
      const verdict = ReviewVerdictSchema.parse(body);
      expect(verdict.verdict).toBe("approve");
    } finally {
      process.env.LENSES_LENS_CACHE_DIR = originalDir;
    }
  });

  it("§8c-9: a round-2 submission omitting a cached lens is accepted", async () => {
    const args = {
      lensConfig: { lenses: ["security", "clean-code"] as string[] },
    };
    // Round 1: populate both lenses.
    {
      const { reviewId, lensIds } = await startPlanReview(args);
      const results = lensIds.map((id) => ({ lensId: id, output: ok() }));
      await callComplete({ reviewId, results });
    }

    // Second start with identical inputs -- both must hit the
    // cache. Agent sends [] → still covered.
    const r2 = await handleLensReviewStart({
      method: "tools/call",
      params: {
        name: "lens_review_start",
        arguments: {
          stage: "PLAN_REVIEW",
          artifact: "## Plan\n\nDo the thing.",
          ticketDescription: null,
          reviewRound: 1,
          ...args,
        },
      },
    });
    const first = r2.content[0];
    if (!first || first.type !== "text") throw new Error();
    const r2Body = JSON.parse(String(first.text)) as { reviewId: string };
    const { isError } = await callComplete({
      reviewId: r2Body.reviewId,
      results: [],
    });
    expect(isError).toBe(false);
  });

  it("§8c-10: omitting a non-cached lens still returns missing_lenses", async () => {
    const args = {
      lensConfig: { lenses: ["security", "clean-code"] as string[] },
    };
    // Round 1: only cache security (ok); clean-code errors so no cache.
    {
      const { reviewId, lensIds } = await startPlanReview(args);
      const results = lensIds.map((id) => ({
        lensId: id,
        output:
          id === "security"
            ? ok()
            : {
                status: "error" as const,
                error: "boom",
                findings: [] as LensFinding[],
                notes: null,
              },
      }));
      await callComplete({ reviewId, results });
    }
    expect(cacheFilesFor("security")).toHaveLength(1);
    expect(cacheFilesFor("clean-code")).toHaveLength(0);

    // Second start with identical inputs → hop-1 returns security
    // cached + clean-code agent. Agent sends [] → state machine
    // rejects (clean-code not covered).
    const r2 = await handleLensReviewStart({
      method: "tools/call",
      params: {
        name: "lens_review_start",
        arguments: {
          stage: "PLAN_REVIEW",
          artifact: "## Plan\n\nDo the thing.",
          ticketDescription: null,
          reviewRound: 1,
          ...args,
        },
      },
    });
    const first = r2.content[0];
    if (!first || first.type !== "text") throw new Error();
    const r2Body = JSON.parse(String(first.text)) as {
      reviewId: string;
      cached: Array<{ id: LensId }>;
      agents: Array<{ id: LensId }>;
    };
    expect(r2Body.cached.map((c) => c.id)).toEqual(["security"]);
    expect(r2Body.agents.map((a) => a.id)).toEqual(["clean-code"]);
    const { isError, text } = await callComplete({
      reviewId: r2Body.reviewId,
      results: [],
    });
    expect(isError).toBe(true);
    expect(text).toContain("missing 1 expected lens result(s)");
    expect(text).toContain("clean-code");
  });

  it("§8c-11: hop-2 does NOT re-write the cache file of a lens returned as cached in hop-1 (mtime unchanged)", async () => {
    const args = { lensConfig: { lenses: ["security"] as string[] } };
    // Round 1: populate cache for security.
    {
      const { reviewId, lensIds } = await startPlanReview(args);
      const results = lensIds.map((id) => ({ lensId: id, output: ok() }));
      await callComplete({ reviewId, results });
    }
    const files = cacheFilesFor("security");
    expect(files).toHaveLength(1);
    const cachePath = join(lensCacheDir, files[0]!);
    const beforeMtime = statSync(cachePath).mtimeMs;

    // Small delay so a hypothetical rewrite would register a newer
    // mtime. Node's mtime resolution is 1ms on most filesystems.
    await new Promise((r) => setTimeout(r, 20));

    // Second start with identical inputs → hop-1 returns cached,
    // agent submits []. The skip guard in persistLensCacheBestEffort
    // must prevent any rewrite.
    const r2 = await handleLensReviewStart({
      method: "tools/call",
      params: {
        name: "lens_review_start",
        arguments: {
          stage: "PLAN_REVIEW",
          artifact: "## Plan\n\nDo the thing.",
          ticketDescription: null,
          reviewRound: 1,
          ...args,
        },
      },
    });
    const first = r2.content[0];
    if (!first || first.type !== "text") throw new Error();
    const r2Body = JSON.parse(String(first.text)) as { reviewId: string };
    await callComplete({ reviewId: r2Body.reviewId, results: [] });

    expect(existsSync(cachePath)).toBe(true);
    const afterMtime = statSync(cachePath).mtimeMs;
    expect(afterMtime).toBe(beforeMtime);
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
