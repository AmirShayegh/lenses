import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  CURRENT_IN_FLIGHT_SCHEMA_VERSION,
  readCompletion,
  readTask,
  selectTaskRecord,
  taskId,
  writeIndex,
  writeTask,
  _failNextTaskWriteForTests,
  type TaskRecord,
} from "../src/cache/in-flight.js";
import { DEFAULT_LENS_TIMEOUT_MS } from "../src/lenses/registry.js";
import type { LensId } from "../src/lenses/prompts/index.js";
import { ReviewVerdictSchema, type LensOutput } from "../src/schema/index.js";
import {
  _clearMapOnlyForTests,
  _resetForTests,
  applyCompletion,
  buildLensCoverage,
  commitReviewCompletion,
  getReview,
  mintRetryDeadline,
  persistExpiredBestEffort,
  planCompletion,
  registerReview,
  type SubmittedResult,
} from "../src/state/review-state.js";
import { assertLensCoverageExactSet } from "../src/tools/complete.js";

let inFlightDir: string;
beforeAll(() => {
  inFlightDir = mkdtempSync(join(tmpdir(), "lenses-t027-state-if-"));
  process.env.LENSES_IN_FLIGHT_DIR = inFlightDir;
});
afterAll(() => {
  delete process.env.LENSES_IN_FLIGHT_DIR;
  rmSync(inFlightDir, { recursive: true, force: true });
});

const RID = "33333333-3333-4333-8333-333333333333";
const SID = "44444444-4444-4444-8444-444444444444";
const THREE: readonly LensId[] = ["security", "clean-code", "performance"];

function fullMaps(lensIds: readonly LensId[], expiresAt: ReadonlyMap<LensId, number>) {
  return {
    prompts: new Map<LensId, string>(lensIds.map((l) => [l, `prompt for ${l}`])),
    promptHashes: new Map<LensId, string>(lensIds.map((l) => [l, `hash-${l}`])),
    perLensExpiresAt: new Map(expiresAt),
    lensModels: new Map<LensId, "opus" | "sonnet">(
      lensIds.map((l) => [l, l === "security" ? "opus" : "sonnet"]),
    ),
  };
}

function register(
  overrides: Partial<Parameters<typeof registerReview>[0]> = {},
): void {
  registerReview({
    reviewId: RID,
    sessionId: SID,
    stage: "PLAN_REVIEW",
    expectedLensIds: THREE,
    reviewRound: 1,
    priorDeferrals: [],
    ...overrides,
  });
}

function ok(
  lensId: LensId,
  attempt = 1,
  overrides: Partial<LensOutput> = {},
): SubmittedResult {
  return {
    lensId,
    attempt,
    output: {
      status: "ok",
      findings: [],
      error: null,
      notes: null,
      ...overrides,
    } as LensOutput,
  };
}

function err(lensId: LensId, attempt = 1): SubmittedResult {
  return {
    lensId,
    attempt,
    output: {
      status: "error",
      findings: [],
      error: "lens reported error",
      notes: null,
    },
  };
}

beforeEach(() => {
  _resetForTests();
});

describe("T-027 R1 per-result disposition order", () => {
  // Codex round (resolution 3): the ok-covered shield fires BEFORE the
  // attempt-monotonicity rejections. A harmless late duplicate for an
  // already-ok lens must never reject the batch, regardless of its
  // attempt number.
  it("codex round: a late STALE duplicate for an ok-covered lens is ignored; the same batch finalizes", () => {
    const t0 = Date.now();
    register({
      perLensExpiresAt: new Map<LensId, number>([["security", t0 + 1000]]),
    });
    const first = applyCompletion({
      reviewId: RID,
      results: [ok("security")],
      finalize: false,
      now: t0 + 10,
    });
    expect(first.ok).toBe(true);

    // Duplicate attempt-1 resubmission AFTER the deadline lapsed, in
    // the SAME batch as the remaining fresh lenses: the duplicate is
    // diverted to pastDeadlineIgnoredLensIds and the batch finalizes.
    const fin = applyCompletion({
      reviewId: RID,
      results: [ok("security", 1), ok("clean-code"), ok("performance")],
      finalize: true,
      now: t0 + 2000,
    });
    expect(fin.ok).toBe(true);
    if (!fin.ok) throw new Error();
    expect(fin.disposition.pastDeadlineIgnoredLensIds).toEqual(["security"]);
    expect(fin.session.status).toBe("complete");
    expect(fin.session.perLensExpired.has("security")).toBe(false);
    expect(fin.session.perLensAttempts.get("security")).toBe(1);
    expect(fin.session.perLensLatestOutput.get("security")?.status).toBe("ok");
    const entry = buildLensCoverage(fin.session).find(
      (e) => e.lensId === "security",
    );
    expect(entry?.status).toBe("ok");
  });

  it("codex round: a late NON-CONTIGUOUS duplicate for an ok-covered lens is also ignored, not rejected", () => {
    const t0 = Date.now();
    register({
      perLensExpiresAt: new Map<LensId, number>([["security", t0 + 1000]]),
    });
    const first = applyCompletion({
      reviewId: RID,
      results: [ok("security")],
      finalize: false,
      now: t0 + 10,
    });
    expect(first.ok).toBe(true);

    const late = applyCompletion({
      reviewId: RID,
      results: [ok("security", 7)],
      finalize: false,
      now: t0 + 2000,
    });
    expect(late.ok).toBe(true);
    if (!late.ok) throw new Error();
    expect(late.disposition.pastDeadlineIgnoredLensIds).toEqual(["security"]);
    expect(late.session.perLensAttempts.get("security")).toBe(1);
  });

  it("an IN-WINDOW stale duplicate still rejects (the shield requires the deadline to have passed)", () => {
    const t0 = Date.now();
    register({
      perLensExpiresAt: new Map<LensId, number>([["security", t0 + 1000]]),
    });
    const first = applyCompletion({
      reviewId: RID,
      results: [ok("security")],
      finalize: false,
      now: t0 + 10,
    });
    expect(first.ok).toBe(true);

    const dup = applyCompletion({
      reviewId: RID,
      results: [ok("security", 1)],
      finalize: false,
      now: t0 + 500,
    });
    expect(dup.ok).toBe(false);
    if (dup.ok) throw new Error();
    expect(dup.code).toBe("stale_attempt");
  });

  it("R1 rule 4: a past-deadline result for an ok-covered lens is ignored and never flips coverage to expired", () => {
    const t0 = Date.now();
    register({
      perLensExpiresAt: new Map<LensId, number>([["security", t0 + 1000]]),
    });
    const withFinding = {
      id: "late-1",
      severity: "major" as const,
      category: "late",
      file: null,
      line: null,
      description: "late arrival",
      suggestion: "",
      confidence: 0.9,
    };
    const first = applyCompletion({
      reviewId: RID,
      results: [ok("security")],
      finalize: false,
      now: t0 + 10,
    });
    expect(first.ok).toBe(true);

    // Contiguous attempt-2, past deadline, lens already ok-covered.
    const late = applyCompletion({
      reviewId: RID,
      results: [ok("security", 2, { findings: [withFinding] })],
      finalize: false,
      now: t0 + 2000,
    });
    expect(late.ok).toBe(true);
    if (!late.ok) throw new Error();
    expect(late.disposition.pastDeadlineIgnoredLensIds).toEqual(["security"]);
    const s = late.session;
    expect(s.perLensExpired.has("security")).toBe(false);
    // Attempt counter untouched, stored output still the attempt-1 one.
    expect(s.perLensAttempts.get("security")).toBe(1);
    expect(s.perLensLatestOutput.get("security")?.findings).toHaveLength(0);
    expect(buildLensCoverage(s).find((e) => e.lensId === "security")?.status).toBe(
      "ok",
    );
  });

  it("R1 rules 1+3: a would-be-accepted result past deadline diverts to expired; later results for that lens are silently ignored", () => {
    const t0 = Date.now();
    register({
      perLensExpiresAt: new Map<LensId, number>([["security", t0 + 100]]),
    });
    // Rule 3: would-be-accepted, past deadline, no ok output -> diverted.
    const diverted = applyCompletion({
      reviewId: RID,
      results: [ok("security")],
      finalize: false,
      now: t0 + 200,
    });
    expect(diverted.ok).toBe(true);
    if (!diverted.ok) throw new Error();
    expect(diverted.disposition.newlyExpiredLensIds).toEqual(["security"]);
    expect(diverted.session.perLensExpired.has("security")).toBe(true);
    expect(diverted.session.perLensLatestOutput.has("security")).toBe(false);
    expect(diverted.session.perLensAttempts.get("security")).toBe(1);

    // Rule 1: lens already in perLensExpired -> silent divert, attempts
    // untouched, no output stored.
    const replay = applyCompletion({
      reviewId: RID,
      results: [ok("security", 2)],
      finalize: false,
      now: t0 + 300,
    });
    expect(replay.ok).toBe(true);
    if (!replay.ok) throw new Error();
    expect(replay.disposition.alreadyExpiredLensIds).toEqual(["security"]);
    expect(replay.session.perLensAttempts.get("security")).toBe(1);
    expect(replay.session.perLensLatestOutput.has("security")).toBe(false);
    expect(
      buildLensCoverage(replay.session).find((e) => e.lensId === "security")
        ?.status,
    ).toBe("expired");
  });

  it("lenses with no registered deadline never expire and are never swept (HEAD parity)", () => {
    const t0 = Date.now();
    register(); // no perLensExpiresAt at all
    const v = applyCompletion({
      reviewId: RID,
      results: [ok("security")],
      finalize: false,
      now: t0 + 10_000_000,
    });
    expect(v.ok).toBe(true);
    if (!v.ok) throw new Error();
    expect(v.disposition.newlyExpiredLensIds).toEqual([]);
    expect(v.session.perLensExpired.size).toBe(0);
  });
});

describe("T-027 R9 eager expiry sweep", () => {
  it("an empty poll sweeps past-deadline uncovered lenses into expired and persists AGENT_TIMEOUT records", () => {
    const t0 = Date.now();
    register({
      ...fullMaps(THREE, new Map<LensId, number>([
        ["security", t0 - 10],
        ["clean-code", t0 + 600_000],
        ["performance", t0 + 600_000],
      ])),
    });
    const v = applyCompletion({
      reviewId: RID,
      results: [],
      finalize: false,
      now: t0,
    });
    expect(v.ok).toBe(true);
    if (!v.ok) throw new Error();
    expect(v.disposition.newlyExpiredLensIds).toEqual(["security"]);
    expect(v.session.perLensExpired.has("security")).toBe(true);
    expect(v.session.perLensAttempts.get("security")).toBe(1);

    // The two dead identifiers now have a live producer: the expired
    // task record carries status "expired" + errorCode AGENT_TIMEOUT.
    const rec = readTask(RID, "security", 1);
    expect(rec?.status).toBe("expired");
    expect(rec?.errorCode).toBe("AGENT_TIMEOUT");
  });

  it("two sequential partial submissions finalize without fabricated error placeholders", () => {
    const t0 = Date.now();
    register({
      ...fullMaps(THREE, new Map<LensId, number>(
        THREE.map((l) => [l, t0 + 600_000] as const),
      )),
    });
    const first = applyCompletion({
      reviewId: RID,
      results: [ok("security")],
      finalize: false,
      now: t0 + 10,
    });
    expect(first.ok).toBe(true);
    const second = applyCompletion({
      reviewId: RID,
      results: [ok("clean-code"), ok("performance")],
      finalize: true,
      now: t0 + 20,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error();
    expect(second.session.status).toBe("complete");
    expect(second.session.perLensExpired.size).toBe(0);
  });
});

describe("T-027 R2 expired-shadows-completed durability", () => {
  it("reader rule: a later expired record never erases a prior ok output on rehydration", () => {
    const t0 = Date.now();
    register({
      ...fullMaps(THREE, new Map<LensId, number>(
        THREE.map((l) => [l, t0 + 600_000] as const),
      )),
    });
    const applied = applyCompletion({
      reviewId: RID,
      results: THREE.map((l) => ok(l)),
      finalize: false,
      now: t0 + 10,
    });
    expect(applied.ok).toBe(true);

    // Simulate a corrupt/late expired record at a higher attempt.
    writeTask({
      schemaVersion: CURRENT_IN_FLIGHT_SCHEMA_VERSION,
      taskId: taskId(RID, "security", 2),
      reviewId: RID,
      lensId: "security",
      attempt: 2,
      status: "expired",
      promptHash: "hash-security",
      chunkIndex: null,
      startedAt: new Date(t0).toISOString(),
      completedAt: new Date(t0).toISOString(),
      expiresAt: new Date(t0 + 600_000).toISOString(),
      errorCode: "AGENT_TIMEOUT",
      lensOutput: null,
    });

    _clearMapOnlyForTests();
    const s = getReview(RID);
    if (!s) throw new Error();
    expect(s.perLensLatestOutput.get("security")?.status).toBe("ok");
    expect(s.perLensExpired.has("security")).toBe(false);
    expect(s.perLensAttempts.get("security")).toBe(1);
  });

  it("writer guard: persistExpiredBestEffort skips a lens whose latest accepted output is ok", () => {
    const t0 = Date.now();
    register({
      ...fullMaps(THREE, new Map<LensId, number>(
        THREE.map((l) => [l, t0 + 600_000] as const),
      )),
    });
    const applied = applyCompletion({
      reviewId: RID,
      results: [ok("security")],
      finalize: false,
      now: t0 + 10,
    });
    if (!applied.ok) throw new Error();

    persistExpiredBestEffort(applied.session, ["security"], t0 + 20);
    // No expired record was written at any attempt; the completed
    // record from the accepted submission is untouched.
    expect(readTask(RID, "security", 1)?.status).toBe("completed");
    expect(readTask(RID, "security", 2)).toBeUndefined();
  });
});

describe("T-027 R-D5 task record selection", () => {
  function rec(
    lensId: string,
    attempt: number,
    status: TaskRecord["status"],
    okOutput = false,
  ): TaskRecord {
    const now = new Date().toISOString();
    return {
      schemaVersion: CURRENT_IN_FLIGHT_SCHEMA_VERSION,
      taskId: taskId(RID, lensId, attempt),
      reviewId: RID,
      lensId,
      attempt,
      status,
      promptHash: "h",
      chunkIndex: null,
      startedAt: now,
      completedAt: status === "pending" || status === "in_flight" ? null : now,
      expiresAt: now,
      errorCode: status === "expired" ? "AGENT_TIMEOUT" : null,
      lensOutput: okOutput
        ? { status: "ok", findings: [], error: null, notes: null }
        : status === "failed"
          ? { status: "error", findings: [], error: "x", notes: null }
          : null,
    };
  }

  it("failed@2 wins over completed-ok@1 (higher terminal attempt)", () => {
    const picked = selectTaskRecord([
      rec("security", 1, "completed", true),
      rec("security", 2, "failed"),
    ]);
    expect(picked?.status).toBe("failed");
    expect(picked?.attempt).toBe(2);
  });

  it("completed-ok@2 wins over expired@3 (rule 1: expired never erases a prior ok)", () => {
    const picked = selectTaskRecord([
      rec("security", 2, "completed", true),
      rec("security", 3, "expired"),
    ]);
    expect(picked?.status).toBe("completed");
    expect(picked?.attempt).toBe(2);
  });

  it("expired@2 wins over failed@1 (higher terminal attempt, no ok shield)", () => {
    const picked = selectTaskRecord([
      rec("security", 1, "failed"),
      rec("security", 2, "expired"),
    ]);
    expect(picked?.status).toBe("expired");
  });

  it("completed@1 wins over pending@2 (terminal preferred over non-terminal)", () => {
    const picked = selectTaskRecord([
      rec("security", 1, "completed", true),
      rec("security", 2, "pending"),
    ]);
    expect(picked?.status).toBe("completed");
  });

  it("pending@1 is selected when no terminal record exists", () => {
    const picked = selectTaskRecord([rec("security", 1, "pending")]);
    expect(picked?.status).toBe("pending");
  });

  it("at equal attempt, completed wins over expired", () => {
    const picked = selectTaskRecord([
      rec("security", 1, "expired"),
      rec("security", 1, "completed", true),
    ]);
    expect(picked?.status).toBe("completed");
  });
});

describe("codex round: comparator real-failure semantics (resolution 1)", () => {
  // Writer inventory (audited): task records are written ONLY by
  // (a) registration pending seeds, (b) persistInFlightBestEffort over
  // ACCEPTED submissions, (c) persistExpiredBestEffort (ok-guarded),
  // (d) the anchor's pending -> in_flight flip. No path can write a
  // failed record that was not a genuinely accepted submission at a
  // monotonically advanced attempt, so failed@N beating ok@N-1 is the
  // intended latest-real-terminal-attempt-wins semantics (it mirrors
  // perLensLatestOutput in memory exactly).
  it("a REAL failed@2 supersedes ok@1 across a restart (disk mirrors memory)", () => {
    const t0 = Date.now();
    const ONE: readonly LensId[] = ["security"];
    register({
      expectedLensIds: ONE,
      ...fullMaps(ONE, new Map<LensId, number>([["security", t0 + 600_000]])),
    });
    const first = applyCompletion({
      reviewId: RID,
      results: [ok("security")],
      finalize: false,
      now: t0 + 10,
    });
    expect(first.ok).toBe(true);
    // A REAL attempt-2 failure (the lens itself reported an error).
    const second = applyCompletion({
      reviewId: RID,
      results: [err("security", 2)],
      finalize: false,
      now: t0 + 20,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error();
    expect(second.session.perLensLatestOutput.get("security")?.status).toBe(
      "error",
    );

    _clearMapOnlyForTests();
    const s = getReview(RID);
    if (!s) throw new Error();
    expect(s.perLensAttempts.get("security")).toBe(2);
    expect(s.perLensLatestOutput.get("security")?.status).toBe("error");
    expect(s.perLensExpired.has("security")).toBe(false);
    expect(buildLensCoverage(s).find((e) => e.lensId === "security")?.status).toBe(
      "error",
    );
  });
});

describe("T-027 R7/R-B1 retry durability across restart", () => {
  const ONE: readonly LensId[] = ["security"];

  function registerOne(t0: number): void {
    register({
      expectedLensIds: ONE,
      ...fullMaps(ONE, new Map<LensId, number>([["security", t0 + 1000]])),
      perLensTimeoutMs: new Map<LensId, number>([["security", 1000]]),
    });
  }

  it("R7: restart after a retry deadline is minted preserves attempts + outputs; attempt-2 accepted in the fresh window", () => {
    const t0 = Date.now();
    registerOne(t0);
    const first = applyCompletion({
      reviewId: RID,
      results: [err("security")],
      finalize: false,
      now: t0 + 10,
    });
    expect(first.ok).toBe(true);

    const minted = mintRetryDeadline(RID, "security", t0 + 500);
    expect(minted).toBe(t0 + 1500);
    expect(minted).toBeGreaterThan(t0 + 1000);

    _clearMapOnlyForTests();
    const s = getReview(RID);
    if (!s) throw new Error();
    expect(s.perLensAttempts.get("security")).toBe(1);
    expect(s.perLensLatestOutput.get("security")?.status).toBe("error");
    expect(s.perLensExpiresAt.get("security")).toBe(t0 + 1500);

    // Past the ORIGINAL hop-1 deadline but inside the minted window.
    const retry = applyCompletion({
      reviewId: RID,
      results: [ok("security", 2)],
      finalize: true,
      now: t0 + 1200,
    });
    expect(retry.ok).toBe(true);
    if (!retry.ok) throw new Error();
    expect(retry.session.status).toBe("complete");
  });

  it("R-B1: index update succeeds, task write fails, restart; attempt-2 is still accepted (pendingAttempt reconcile)", () => {
    const t0 = Date.now();
    registerOne(t0);
    _failNextTaskWriteForTests({ reviewId: RID, lensId: "security", attempt: 1 });
    const first = applyCompletion({
      reviewId: RID,
      results: [err("security")],
      finalize: false,
      now: t0 + 10,
    });
    expect(first.ok).toBe(true); // persistence failure is swallowed

    const minted = mintRetryDeadline(RID, "security", t0 + 500);
    expect(minted).toBe(t0 + 1500);

    _clearMapOnlyForTests();
    const s = getReview(RID);
    if (!s) throw new Error();
    // No terminal record landed on disk, but the pendingAttempt marker
    // reconciles the attempt counter so the retry is contiguous.
    expect(s.perLensAttempts.get("security")).toBe(1);

    const retry = applyCompletion({
      reviewId: RID,
      results: [ok("security", 2)],
      finalize: true,
      now: t0 + 1200,
    });
    expect(retry.ok).toBe(true);
    if (!retry.ok) throw new Error();
    expect(retry.session.status).toBe("complete");
  });
});

describe("T-027 R14(h)/R-D7 timeout derivation and hydration fallback", () => {
  it("registerReview without perLensTimeoutMs derives timeouts from lensModels", () => {
    const t0 = Date.now();
    register({
      ...fullMaps(THREE, new Map<LensId, number>(
        THREE.map((l) => [l, t0 + 600_000] as const),
      )),
    });
    const s = getReview(RID);
    if (!s) throw new Error();
    expect(s.perLensTimeoutMs.get("security")).toBe(DEFAULT_LENS_TIMEOUT_MS.opus);
    expect(s.perLensTimeoutMs.get("clean-code")).toBe(
      DEFAULT_LENS_TIMEOUT_MS.default,
    );
  });

  it("hydrating an old index file without timeoutMs falls back to resolveLensTimeoutMs(model, undefined)", () => {
    const rid = "55555555-5555-4555-8555-555555555555";
    writeIndex({
      schemaVersion: CURRENT_IN_FLIGHT_SCHEMA_VERSION,
      reviewId: rid,
      sessionId: SID,
      stage: "PLAN_REVIEW",
      expectedLensIds: ["security"],
      reviewRound: 1,
      priorDeferrals: [],
      createdAt: new Date().toISOString(),
      artifact: "",
      changedFiles: [],
      cachedResults: {},
      lensMeta: {
        security: {
          model: "opus",
          promptHash: "h-sec",
          expiresAt: new Date(Date.now() + 1000).toISOString(),
          // no timeoutMs: simulates a pre-T-027 index file
        },
      },
    });
    const s = getReview(rid);
    if (!s) throw new Error();
    expect(s.perLensTimeoutMs.get("security")).toBe(DEFAULT_LENS_TIMEOUT_MS.opus);
  });
});

describe("T-027 R-B3/R-D2 unexpected-lens drop in planCompletion", () => {
  it("a valid-but-unactivated lens is dropped: named in ignoredLensIds, no attempt advance, no coverage entry, no influence", () => {
    const t0 = Date.now();
    const TWO: readonly LensId[] = ["security", "clean-code"];
    register({
      expectedLensIds: TWO,
      ...fullMaps(TWO, new Map<LensId, number>(
        TWO.map((l) => [l, t0 + 600_000] as const),
      )),
    });
    const s = getReview(RID);
    if (!s) throw new Error();
    const intruderFinding = {
      id: "x-1",
      severity: "major" as const,
      category: "perf",
      file: null,
      line: null,
      description: "intruder",
      suggestion: "",
      confidence: 0.9,
    };
    const plan = planCompletion(
      s,
      [ok("security"), ok("performance", 1, { findings: [intruderFinding] })],
      t0 + 10,
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) throw new Error();
    expect(plan.ignoredLensIds).toEqual(["performance"]);
    expect(plan.accepted.map((r) => r.lensId)).toEqual(["security"]);
    expect(plan.nextAttempts.has("performance")).toBe(false);
    expect(plan.unionCovered).toBe(false); // clean-code still missing

    const applied = applyCompletion({
      reviewId: RID,
      results: [ok("security"), ok("performance", 1, { findings: [intruderFinding] })],
      finalize: false,
      now: t0 + 10,
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) throw new Error();
    expect(applied.disposition.ignoredLensIds).toEqual(["performance"]);
    expect(applied.session.perLensLatestOutput.has("performance")).toBe(false);
    const coverage = buildLensCoverage(applied.session);
    expect(coverage.map((e) => e.lensId).sort()).toEqual([
      "clean-code",
      "security",
    ]);
  });
});

describe("T-027 R-D3 lensCoverage exact-set assertion", () => {
  const entry = (lensId: string, status = "ok") => ({
    lensId,
    status: status as "ok",
    attempts: 1,
    contributedFindings: 0,
  });

  it("passes on an exact set", () => {
    expect(() =>
      assertLensCoverageExactSet(
        ["security", "clean-code"],
        [entry("security"), entry("clean-code")],
      ),
    ).not.toThrow();
  });

  it("a synthetically omitted entry for an expired core lens trips the assertion instead of parsing as full/approve", () => {
    expect(() =>
      assertLensCoverageExactSet(
        ["security", "clean-code"],
        [entry("clean-code")],
      ),
    ).toThrow(/security/);
  });

  it("an extra entry trips the assertion naming the extra id", () => {
    expect(() =>
      assertLensCoverageExactSet(
        ["security"],
        [entry("security"), entry("performance")],
      ),
    ).toThrow(/performance/);
  });

  it("a duplicate entry trips the assertion", () => {
    expect(() =>
      assertLensCoverageExactSet(
        ["security", "clean-code"],
        [entry("security"), entry("security")],
      ),
    ).toThrow(/duplicate|security/);
  });
});

describe("T-027 commitReviewCompletion", () => {
  it("durably writes the completion, flips memory, and survives a restart; replays reject with already_complete + storedVerdict", () => {
    const t0 = Date.now();
    const ONE: readonly LensId[] = ["security"];
    register({
      expectedLensIds: ONE,
      ...fullMaps(ONE, new Map<LensId, number>([["security", t0 + 600_000]])),
    });
    const applied = applyCompletion({
      reviewId: RID,
      results: [ok("security")],
      finalize: false,
      now: t0 + 10,
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) throw new Error();
    expect(applied.session.status).toBe("awaiting_retry");

    const verdict = ReviewVerdictSchema.parse({
      verdict: "approve",
      findings: [],
      tensions: [],
      blocking: 0,
      major: 0,
      minor: 0,
      suggestion: 0,
      sessionId: SID,
      hadAnyFindings: false,
      lensCoverage: [
        { lensId: "security", status: "ok", attempts: 1, contributedFindings: 0 },
      ],
      coverage: "full",
      reviewComplete: true,
    });
    commitReviewCompletion({ reviewId: RID, verdict, now: t0 + 20 });

    expect(getReview(RID)?.status).toBe("complete");
    expect(readCompletion(RID)?.verdict.verdict).toBe("approve");

    const dup = applyCompletion({
      reviewId: RID,
      results: [ok("security", 2)],
      finalize: true,
      now: t0 + 30,
    });
    expect(dup.ok).toBe(false);
    if (dup.ok) throw new Error();
    expect(dup.code).toBe("already_complete");
    if (dup.code !== "already_complete") throw new Error();
    expect(dup.storedVerdict?.verdict).toBe("approve");

    // Restart: completion is durable, status hydrates as complete.
    _clearMapOnlyForTests();
    expect(getReview(RID)?.status).toBe("complete");
  });
});
