import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  cleanupStaleSessions,
  CURRENT_SCHEMA_VERSION,
  readSession,
  writeSessionRound,
  type RoundRecord,
} from "../src/cache/session.js";

const SID_A = "11111111-1111-4111-8111-111111111111";
const SID_B = "22222222-2222-4222-8222-222222222222";

function makeRound(overrides: Partial<RoundRecord> = {}): RoundRecord {
  return {
    roundNumber: overrides.roundNumber ?? 1,
    reviewId: overrides.reviewId ?? "review-id-1",
    stage: overrides.stage ?? "PLAN_REVIEW",
    verdict: overrides.verdict ?? "approve",
    counts: overrides.counts ?? {
      blocking: 0,
      major: 0,
      minor: 0,
      suggestion: 0,
    },
    findings: overrides.findings ?? [],
    priorDeferrals: overrides.priorDeferrals ?? [],
    completedAt: overrides.completedAt ?? Date.now(),
  };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lenses-cache-session-"));
  process.env.LENSES_SESSION_DIR = dir;
  delete process.env.LENSES_SESSION_TTL_MS;
});

afterEach(() => {
  delete process.env.LENSES_SESSION_DIR;
  delete process.env.LENSES_SESSION_TTL_MS;
  rmSync(dir, { recursive: true, force: true });
});

describe("writeSessionRound / readSession", () => {
  it("first write creates a SessionRecord with rounds.length === 1 and roundtrips equal on read", () => {
    const round = makeRound({ roundNumber: 1 });
    writeSessionRound({ sessionId: SID_A, round });
    const back = readSession(SID_A);
    expect(back).toBeDefined();
    expect(back!.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(back!.sessionId).toBe(SID_A);
    expect(back!.rounds).toHaveLength(1);
    expect(back!.rounds[0]).toEqual(round);
    expect(back!.createdAt).toBe(round.completedAt);
    expect(back!.updatedAt).toBe(round.completedAt);
  });

  it("second write appends and refreshes updatedAt (createdAt stays put)", () => {
    const r1 = makeRound({ roundNumber: 1, completedAt: 1000 });
    const r2 = makeRound({
      roundNumber: 2,
      reviewId: "review-id-2",
      completedAt: 5000,
    });
    writeSessionRound({ sessionId: SID_A, round: r1 });
    writeSessionRound({ sessionId: SID_A, round: r2 });
    const back = readSession(SID_A);
    expect(back).toBeDefined();
    expect(back!.rounds).toHaveLength(2);
    expect(back!.rounds[0]!.roundNumber).toBe(1);
    expect(back!.rounds[1]!.roundNumber).toBe(2);
    expect(back!.createdAt).toBe(1000);
    expect(back!.updatedAt).toBe(5000);
  });

  it("two different sessionIds do not bleed into each other", () => {
    writeSessionRound({
      sessionId: SID_A,
      round: makeRound({ reviewId: "a-1" }),
    });
    writeSessionRound({
      sessionId: SID_B,
      round: makeRound({ reviewId: "b-1" }),
    });
    expect(readSession(SID_A)!.rounds[0]!.reviewId).toBe("a-1");
    expect(readSession(SID_B)!.rounds[0]!.reviewId).toBe("b-1");
  });

  it("file is written with mode 0o600 (owner-only read/write)", () => {
    writeSessionRound({ sessionId: SID_A, round: makeRound() });
    const st = statSync(join(dir, `${SID_A}.json`));
    expect(st.mode & 0o777).toBe(0o600);
  });

  it("leaves no `.tmp` leftover after a normal write", () => {
    writeSessionRound({ sessionId: SID_A, round: makeRound() });
    const entries = readdirSync(dir);
    expect(entries.filter((e) => e.endsWith(".tmp"))).toHaveLength(0);
    expect(entries.filter((e) => e.endsWith(".json"))).toHaveLength(1);
  });
});

describe("readSession failure modes", () => {
  it("returns undefined for a missing file", () => {
    expect(readSession(SID_A)).toBeUndefined();
  });

  it("returns undefined for a zero-byte file", () => {
    writeFileSync(join(dir, `${SID_A}.json`), "");
    expect(readSession(SID_A)).toBeUndefined();
  });

  it("returns undefined for a truncated JSON file", () => {
    writeFileSync(join(dir, `${SID_A}.json`), '{"schemaVersion": 1, "sess');
    expect(readSession(SID_A)).toBeUndefined();
  });

  it("returns undefined for a record with a mismatched schemaVersion", () => {
    const future = {
      schemaVersion: 99,
      sessionId: SID_A,
      createdAt: 1,
      updatedAt: 1,
      rounds: [makeRound()],
    };
    writeFileSync(join(dir, `${SID_A}.json`), JSON.stringify(future));
    expect(readSession(SID_A)).toBeUndefined();
  });
});

describe("cleanupStaleSessions", () => {
  it("removes files older than maxAgeMs and leaves fresher ones", () => {
    writeSessionRound({
      sessionId: SID_A,
      round: makeRound({ completedAt: Date.now() - 60_000 }),
    });
    writeSessionRound({ sessionId: SID_B, round: makeRound() });

    // Spoof A's updatedAt on-disk AND its mtime so both the record
    // path and the mtime-fallback path agree it's stale.
    const pathA = join(dir, `${SID_A}.json`);
    const raw = JSON.parse(readFileSync(pathA, "utf8"));
    raw.updatedAt = Date.now() - 60_000;
    writeFileSync(pathA, JSON.stringify(raw));
    const stalePast = new Date(Date.now() - 60_000);
    utimesSync(pathA, stalePast, stalePast);

    const { removed } = cleanupStaleSessions(30_000);
    expect(removed).toBe(1);
    expect(readSession(SID_A)).toBeUndefined();
    expect(readSession(SID_B)).toBeDefined();
  });

  it("a corrupt file older than the TTL is still cleaned (mtime fallback)", () => {
    const corrupt = join(dir, `${SID_A}.json`);
    writeFileSync(corrupt, "{broken");
    const stalePast = new Date(Date.now() - 60_000);
    utimesSync(corrupt, stalePast, stalePast);
    const { removed } = cleanupStaleSessions(30_000);
    expect(removed).toBe(1);
  });

  it("non-.json entries are left alone", () => {
    writeFileSync(join(dir, "unrelated.txt"), "leave me");
    writeSessionRound({ sessionId: SID_A, round: makeRound() });
    cleanupStaleSessions(1);
    const entries = readdirSync(dir);
    expect(entries).toContain("unrelated.txt");
  });

  it("returns {removed: 0} when the cache directory is empty", () => {
    expect(cleanupStaleSessions()).toEqual({ removed: 0 });
  });

  it("LENSES_SESSION_TTL_MS env override is honored by the default arg", () => {
    const pathA = join(dir, `${SID_A}.json`);
    writeSessionRound({ sessionId: SID_A, round: makeRound() });
    // Spoof both record updatedAt and mtime to ~2 seconds old.
    const raw = JSON.parse(readFileSync(pathA, "utf8"));
    raw.updatedAt = Date.now() - 2000;
    writeFileSync(pathA, JSON.stringify(raw));
    const past = new Date(Date.now() - 2000);
    utimesSync(pathA, past, past);

    process.env.LENSES_SESSION_TTL_MS = "1000";
    const { removed } = cleanupStaleSessions();
    expect(removed).toBe(1);
  });
});

describe("env and schema invariants", () => {
  it("LENSES_SESSION_DIR override directs all I/O to the chosen dir", () => {
    writeSessionRound({ sessionId: SID_A, round: makeRound() });
    expect(readdirSync(dir)).toContain(`${SID_A}.json`);
  });

  it("writeSessionRound throws on an invalid round (defense-in-depth parse)", () => {
    // Negative roundNumber fails RoundRecordSchema.min(1). Casting is
    // intentional: the runtime check in writeSessionRound is the
    // subject under test, and the test bypasses the caller-side type
    // guarantee exactly once.
    const bad = makeRound({
      roundNumber: 0 as unknown as 1,
    });
    expect(() =>
      writeSessionRound({ sessionId: SID_A, round: bad }),
    ).toThrow();
    // No partial file should have been left behind.
    expect(readdirSync(dir)).toHaveLength(0);
  });

  it("atomicity: a failing second write leaves the first round's file intact", () => {
    // Write a good round 1, then attempt a round 2 that fails
    // SessionRecordSchema.parse (negative roundNumber). The atomic
    // tmp->rename path must guarantee the on-disk record for round 1
    // is unchanged. This pins the key property the atomic write
    // exists for -- without it, an interrupted second write could
    // corrupt the prior record.
    const r1 = makeRound({ roundNumber: 1, reviewId: "review-id-1" });
    writeSessionRound({ sessionId: SID_A, round: r1 });
    const bad = makeRound({ roundNumber: 0 as unknown as 1 });
    expect(() =>
      writeSessionRound({ sessionId: SID_A, round: bad }),
    ).toThrow();
    const back = readSession(SID_A);
    expect(back).toBeDefined();
    expect(back!.rounds).toHaveLength(1);
    expect(back!.rounds[0]).toEqual(r1);
    // And no `.tmp` leftover from the failed attempt.
    expect(readdirSync(dir).filter((e) => e.endsWith(".tmp"))).toHaveLength(0);
  });

  it("CURRENT_SCHEMA_VERSION is 1 (breaking changes require a bump)", () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(1);
  });
});
