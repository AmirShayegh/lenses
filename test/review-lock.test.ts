import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  withReviewStateLock,
  _lockPathForTests,
} from "../src/state/review-lock.js";

/**
 * T-027 pen resolution 4: the review-state lock uses a bounded
 * wall-clock deadline (2000ms default) with small backoff plus jitter
 * between attempts, using a synchronous sleep (Atomics.wait). These
 * tests pin acquisition, release, contention, and stale-lock stealing.
 */
let lockDir: string;
beforeAll(() => {
  lockDir = mkdtempSync(join(tmpdir(), "lenses-review-lock-"));
  process.env.LENSES_LOCK_DIR = lockDir;
});
afterAll(() => {
  delete process.env.LENSES_LOCK_DIR;
  delete process.env.LENSES_LOCK_DEADLINE_MS;
  rmSync(lockDir, { recursive: true, force: true });
});

describe("withReviewStateLock", () => {
  it("runs the callback, returns its value, and releases the lock", () => {
    const rid = "lock-test-basic";
    const result = withReviewStateLock(rid, () => 42);
    expect(result).toBe(42);
    expect(existsSync(_lockPathForTests(rid))).toBe(false);
    // Immediately re-acquirable.
    expect(withReviewStateLock(rid, () => "again")).toBe("again");
  });

  it("releases the lock when the callback throws, and propagates the throw", () => {
    const rid = "lock-test-throw";
    expect(() =>
      withReviewStateLock(rid, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(existsSync(_lockPathForTests(rid))).toBe(false);
  });

  it("a held lock released after ~50ms is acquired by a waiting caller (pen resolution 4)", async () => {
    const rid = "lock-test-contended";
    const path = _lockPathForTests(rid);
    mkdirSync(path, { recursive: true });

    // A worker thread releases the lock after ~50ms. The main thread's
    // synchronous Atomics.wait sleep does not block worker threads.
    const worker = new Worker(
      `
      const { workerData, parentPort } = require("node:worker_threads");
      const { rmSync } = require("node:fs");
      setTimeout(() => {
        try { rmSync(workerData.path, { recursive: true, force: true }); } catch {}
        parentPort.postMessage("released");
      }, workerData.delayMs);
      `,
      { eval: true, workerData: { path, delayMs: 50 } },
    );

    try {
      const t0 = Date.now();
      const result = withReviewStateLock(rid, () => "acquired");
      const elapsed = Date.now() - t0;
      expect(result).toBe("acquired");
      // The caller genuinely waited for the release (not an immediate
      // steal): at least most of the 50ms hold must have elapsed.
      expect(elapsed).toBeGreaterThanOrEqual(40);
      expect(elapsed).toBeLessThan(2000);
      expect(existsSync(path)).toBe(false);
    } finally {
      await worker.terminate();
    }
  });

  it("times out with an error when the lock stays held past the deadline", () => {
    const rid = "lock-test-timeout";
    const path = _lockPathForTests(rid);
    mkdirSync(path, { recursive: true });
    process.env.LENSES_LOCK_DEADLINE_MS = "100";
    try {
      expect(() => withReviewStateLock(rid, () => "never")).toThrow(
        /lock timeout/,
      );
    } finally {
      delete process.env.LENSES_LOCK_DEADLINE_MS;
      rmSync(path, { recursive: true, force: true });
    }
  });

  it("steals a stale lock left behind by a crashed process", () => {
    const rid = "lock-test-stale";
    const path = _lockPathForTests(rid);
    mkdirSync(path, { recursive: true });
    // Backdate the lock far past the staleness threshold.
    const old = (Date.now() - 60_000) / 1000;
    utimesSync(path, old, old);
    const result = withReviewStateLock(rid, () => "stolen");
    expect(result).toBe("stolen");
    expect(existsSync(path)).toBe(false);
  });
});
