import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  readTask,
  _failNextCompletionWriteForTests,
} from "../src/cache/in-flight.js";
import { readSession } from "../src/cache/session.js";
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

let sessionDir: string;
let lensCacheDir: string;
let inFlightDir: string;
let lockDir: string;
beforeAll(() => {
  sessionDir = mkdtempSync(join(tmpdir(), "lenses-t027-tools-sess-"));
  lensCacheDir = mkdtempSync(join(tmpdir(), "lenses-t027-tools-lc-"));
  inFlightDir = mkdtempSync(join(tmpdir(), "lenses-t027-tools-if-"));
  lockDir = mkdtempSync(join(tmpdir(), "lenses-t027-tools-lock-"));
  process.env.LENSES_SESSION_DIR = sessionDir;
  process.env.LENSES_LENS_CACHE_DIR = lensCacheDir;
  process.env.LENSES_IN_FLIGHT_DIR = inFlightDir;
  process.env.LENSES_LOCK_DIR = lockDir;
});
afterAll(() => {
  delete process.env.LENSES_SESSION_DIR;
  delete process.env.LENSES_LENS_CACHE_DIR;
  delete process.env.LENSES_IN_FLIGHT_DIR;
  delete process.env.LENSES_LOCK_DIR;
  rmSync(sessionDir, { recursive: true, force: true });
  rmSync(lensCacheDir, { recursive: true, force: true });
  rmSync(inFlightDir, { recursive: true, force: true });
  rmSync(lockDir, { recursive: true, force: true });
});

beforeEach(() => {
  _resetForTests();
  rmSync(lensCacheDir, { recursive: true, force: true });
  rmSync(sessionDir, { recursive: true, force: true });
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

interface StartInfo {
  reviewId: string;
  agents: Array<{ id: LensId; expiresAt: string }>;
}

async function startReview(config: {
  lenses: string[];
  lensTimeout?: number | { default: number; opus: number };
}): Promise<StartInfo> {
  const result = await handleLensReviewStart({
    method: "tools/call",
    params: {
      name: "lens_review_start",
      arguments: {
        stage: "PLAN_REVIEW",
        artifact: "## Plan\n\nDo the thing.",
        ticketDescription: null,
        reviewRound: 1,
        lensConfig: {
          lenses: config.lenses,
          ...(config.lensTimeout !== undefined
            ? { lensTimeout: config.lensTimeout }
            : {}),
        },
      },
    },
  });
  const first = result.content[0];
  if (!first || first.type !== "text") throw new Error("bad start shape");
  return JSON.parse(String(first.text)) as StartInfo;
}

async function callComplete(
  args: Record<string, unknown>,
): Promise<{ isError: boolean; body: unknown; text: string }> {
  const result = await handleLensReviewComplete({
    method: "tools/call",
    params: { name: "lens_review_complete", arguments: args },
  });
  const first = result.content[0];
  if (!first || first.type !== "text") throw new Error("bad complete shape");
  const text = String(first.text);
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* plain text error */
  }
  return { isError: Boolean(result.isError), body, text };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("T-027 R3 terminal-only session round persistence", () => {
  it("(a) a two-step partial review leaves exactly ONE round record after the finalizing call", async () => {
    const { reviewId, agents } = await startReview({
      lenses: ["security", "clean-code"],
    });
    const [a, b] = agents.map((x) => x.id);
    if (!a || !b) throw new Error();

    const interim = await callComplete({
      reviewId,
      results: [{ lensId: a, output: ok() }],
    });
    expect(interim.isError).toBe(false);
    const interimVerdict = ReviewVerdictSchema.parse(interim.body);
    expect(interimVerdict.reviewComplete).toBe(false);
    // Interim envelopes persist ZERO round records.
    expect(readSession(interimVerdict.sessionId)).toBeUndefined();

    const fin = await callComplete({
      reviewId,
      results: [{ lensId: b, output: ok() }],
    });
    expect(fin.isError).toBe(false);
    const finVerdict = ReviewVerdictSchema.parse(fin.body);
    expect(finVerdict.reviewComplete).toBe(true);
    const stored = readSession(finVerdict.sessionId);
    expect(stored).toBeDefined();
    expect(stored!.rounds).toHaveLength(1);
  });

  it("(b) a sequence of empty interim polls appends zero round records", async () => {
    const { reviewId, agents } = await startReview({
      lenses: ["security", "clean-code"],
    });
    const poll1 = await callComplete({ reviewId, results: [] });
    expect(poll1.isError).toBe(false);
    const v1 = ReviewVerdictSchema.parse(poll1.body);
    expect(v1.reviewComplete).toBe(false);
    const poll2 = await callComplete({ reviewId, results: [] });
    expect(poll2.isError).toBe(false);
    expect(readSession(v1.sessionId)).toBeUndefined();

    const fin = await callComplete({
      reviewId,
      results: agents.map((x) => ({ lensId: x.id, output: ok() })),
    });
    expect(fin.isError).toBe(false);
    const finVerdict = ReviewVerdictSchema.parse(fin.body);
    expect(readSession(finVerdict.sessionId)!.rounds).toHaveLength(1);
  });
});

describe("T-027 rewritten started-gate behavior (interim envelopes)", () => {
  it("a partial first submission returns an interim envelope with skipped coverage, not an error", async () => {
    const { reviewId, agents } = await startReview({
      lenses: ["security", "clean-code"],
    });
    const [a, b] = agents.map((x) => x.id);
    if (!a || !b) throw new Error();
    const { isError, body } = await callComplete({
      reviewId,
      results: [{ lensId: a, output: ok() }],
    });
    expect(isError).toBe(false);
    const verdict = ReviewVerdictSchema.parse(body);
    expect(verdict.reviewComplete).toBe(false);
    expect(verdict.coverage).toBe("partial");
    expect(verdict.errorCodes).toEqual([]);
    expect(verdict.lensCoverage).toHaveLength(2);
    expect(verdict.lensCoverage.find((e) => e.lensId === a)?.status).toBe("ok");
    expect(verdict.lensCoverage.find((e) => e.lensId === b)?.status).toBe(
      "skipped",
    );
    // Interim envelopes can never carry approve.
    expect(verdict.verdict).toBe("revise");
  });
});

describe("T-027 R4 expired lens with malformed output", () => {
  it("yields coverage expired + PARTIAL_RESULTS, no retry NextAction, and no parseErrors entry for that lens", async () => {
    const { reviewId } = await startReview({
      lenses: ["security", "clean-code"],
      lensTimeout: { default: 600_000, opus: 250 },
    });
    await sleep(300); // security (opus) expires; clean-code does not

    const { isError, body } = await callComplete({
      reviewId,
      results: [
        { lensId: "security", output: { status: "ok" /* malformed */ } },
        { lensId: "clean-code", output: ok() },
      ],
    });
    expect(isError).toBe(false);
    const verdict = ReviewVerdictSchema.parse(body);
    expect(verdict.reviewComplete).toBe(true);
    expect(verdict.coverage).toBe("partial");
    expect(verdict.errorCodes).toEqual(["PARTIAL_RESULTS"]);
    expect(verdict.lensCoverage).toHaveLength(2);
    const sec = verdict.lensCoverage.find((e) => e.lensId === "security");
    expect(sec?.status).toBe("expired");
    expect(sec?.contributedFindings).toBe(0);
    expect(verdict.parseErrors).toEqual([]);
    expect(verdict.nextActions).toEqual([]);
    // Core lens expired: the false-approve is impossible.
    expect(verdict.verdict).toBe("revise");
  });
});

describe("T-027 R9 interim expiry disclosure", () => {
  it("an empty poll discloses a timed-out never-submitted lens as expired, not skipped", async () => {
    const { reviewId } = await startReview({
      lenses: ["security", "clean-code"],
      lensTimeout: { default: 600_000, opus: 250 },
    });
    await sleep(300);

    const poll = await callComplete({ reviewId, results: [] });
    expect(poll.isError).toBe(false);
    const verdict = ReviewVerdictSchema.parse(poll.body);
    expect(verdict.reviewComplete).toBe(false);
    const sec = verdict.lensCoverage.find((e) => e.lensId === "security");
    const cc = verdict.lensCoverage.find((e) => e.lensId === "clean-code");
    expect(sec?.status).toBe("expired");
    expect(cc?.status).toBe("skipped");
    expect(verdict.errorCodes).toEqual(["PARTIAL_RESULTS"]);
    expect(verdict.verdict).toBe("revise");

    // The sweep persisted an AGENT_TIMEOUT expired task record.
    const rec = readTask(reviewId, "security", 1);
    expect(rec?.status).toBe("expired");
    expect(rec?.errorCode).toBe("AGENT_TIMEOUT");
  });
});

describe("T-027 R12 acceptance test 3: partial coverage final verdict", () => {
  it("the finalizing submission itself returns revise/partial/PARTIAL_RESULTS naming the expired lens; a trailing poll is DUPLICATE_COMPLETE", async () => {
    const { reviewId } = await startReview({
      lenses: ["security", "clean-code"],
      lensTimeout: { default: 600_000, opus: 250 },
    });
    await sleep(300); // only the opus lens (security) expires

    const fin = await callComplete({
      reviewId,
      results: [{ lensId: "clean-code", output: ok() }],
    });
    expect(fin.isError).toBe(false);
    const verdict = ReviewVerdictSchema.parse(fin.body);
    expect(verdict.reviewComplete).toBe(true);
    expect(verdict.verdict).toBe("revise");
    expect(verdict.coverage).toBe("partial");
    expect(verdict.errorCodes).toEqual(["PARTIAL_RESULTS"]);
    expect(verdict.lensCoverage).toHaveLength(2);
    expect(
      verdict.lensCoverage.find((e) => e.lensId === "security")?.status,
    ).toBe("expired");
    expect(verdict.findings).toEqual([]);
    expect(verdict.hadAnyFindings).toBe(false);

    // A reader looking only at findings can no longer mistake this for
    // a clean pass: the envelope says partial + PARTIAL_RESULTS.
    const poll = await callComplete({ reviewId, results: [] });
    expect(poll.isError).toBe(true);
    const bodyErr = JSON.parse(poll.text) as {
      errorCode: string;
      message: string;
      storedVerdict?: { verdict: string };
    };
    expect(bodyErr.errorCode).toBe("DUPLICATE_COMPLETE");
    // Pen resolution 8: the replay envelope carries the stored verdict
    // as a sibling field.
    expect(bodyErr.storedVerdict?.verdict).toBe("revise");
  });
});

describe("T-027 R12 acceptance test 4: fresh retry deadline", () => {
  it("the minted retry expiresAt is strictly later than the hop-1 agents[].expiresAt", async () => {
    const start = await startReview({ lenses: ["security"] });
    const hop1 = start.agents[0]!.expiresAt;
    await sleep(10);

    const first = await callComplete({
      reviewId: start.reviewId,
      results: [
        { lensId: "security", output: { status: "ok" /* malformed */ } },
      ],
    });
    expect(first.isError).toBe(false);
    const verdict = ReviewVerdictSchema.parse(first.body);
    expect(verdict.nextActions).toHaveLength(1);
    const na = verdict.nextActions[0]!;
    expect(na.attempt).toBe(2);
    expect(Date.parse(na.expiresAt)).toBeGreaterThan(Date.parse(hop1));
  });
});

describe("T-027 R-D2 valid-but-unexpected lens via the tool", () => {
  it("affects nothing: dropped from findings, coverage, retries, and hadAnyFindings", async () => {
    const { reviewId, agents } = await startReview({
      lenses: ["security", "clean-code"],
    });
    const results = [
      ...agents.map((x) => ({ lensId: x.id, output: ok() })),
      {
        lensId: "performance", // valid lens id, NOT activated
        output: ok([finding("major", { id: "intruder" })]),
      },
    ];
    const { isError, body } = await callComplete({ reviewId, results });
    expect(isError).toBe(false);
    const verdict = ReviewVerdictSchema.parse(body);
    expect(verdict.findings).toEqual([]);
    expect(verdict.hadAnyFindings).toBe(false);
    expect(verdict.nextActions).toEqual([]);
    expect(verdict.lensCoverage).toHaveLength(2);
    expect(
      verdict.lensCoverage.find((e) => e.lensId === "performance"),
    ).toBeUndefined();
    expect(verdict.verdict).toBe("approve");
    expect(verdict.reviewComplete).toBe(true);
  });
});

describe("T-027 pen resolution 2: throw between apply and commit", () => {
  it("a failed completion write returns PERSISTENCE_FAILED and leaves the review re-completable with no DUPLICATE_COMPLETE", async () => {
    const { reviewId, agents } = await startReview({ lenses: ["security"] });
    _failNextCompletionWriteForTests({ reviewId });

    const first = await callComplete({
      reviewId,
      results: agents.map((x) => ({ lensId: x.id, output: ok() })),
    });
    expect(first.isError).toBe(true);
    const errBody = JSON.parse(first.text) as { errorCode: string };
    expect(errBody.errorCode).toBe("PERSISTENCE_FAILED");

    // The session stayed awaiting_retry: an empty poll now finalizes
    // from the retained outputs instead of rejecting DUPLICATE_COMPLETE.
    const second = await callComplete({ reviewId, results: [] });
    expect(second.isError).toBe(false);
    const verdict = ReviewVerdictSchema.parse(second.body);
    expect(verdict.reviewComplete).toBe(true);
    expect(verdict.verdict).toBe("approve");
    expect(verdict.coverage).toBe("full");
  });
});

describe("T-027 R1 at the tool boundary", () => {
  it("in-window ok submission survives a post-deadline duplicate: stale_attempt error, lens stays ok, findings intact", async () => {
    const { reviewId } = await startReview({
      lenses: ["security", "clean-code"],
      lensTimeout: { default: 600_000, opus: 400 },
    });
    const secFinding = finding("minor", {
      id: "sec-1",
      confidence: 0.9,
      file: "src/a.ts",
      line: 3,
    });
    const first = await callComplete({
      reviewId,
      results: [{ lensId: "security", output: ok([secFinding]) }],
    });
    expect(first.isError).toBe(false);

    await sleep(500); // security's deadline lapses; its ok output shields it

    const dup = await callComplete({
      reviewId,
      results: [{ lensId: "security", output: ok([secFinding]), attempt: 1 }],
    });
    expect(dup.isError).toBe(true);
    expect(dup.text).toContain("stale attempt");

    const fin = await callComplete({
      reviewId,
      results: [{ lensId: "clean-code", output: ok() }],
    });
    expect(fin.isError).toBe(false);
    const verdict = ReviewVerdictSchema.parse(fin.body);
    expect(verdict.reviewComplete).toBe(true);
    expect(
      verdict.lensCoverage.find((e) => e.lensId === "security")?.status,
    ).toBe("ok");
    expect(verdict.coverage).toBe("full");
    expect(verdict.findings.map((f) => f.id)).toEqual(["sec-1"]);
    expect(verdict.errorCodes).toEqual([]);
  });
});
