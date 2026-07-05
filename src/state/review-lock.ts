/**
 * T-027 (pen resolution 1 + 4): cross-process lock for the review
 * finalization transaction.
 *
 * `handleLensReviewComplete` acquires this lock exactly ONCE around the
 * section from disposition planning through completion commit.
 * `applyCompletion` / `commitReviewCompletion` do NOT acquire it
 * internally (their doc contracts require the caller to hold it), and
 * there is no reentrant locking anywhere.
 *
 * Acquisition (pen resolution 4): a bounded wall-clock deadline
 * (2000ms default) with small backoff plus jitter between attempts.
 * The sleep is synchronous via Atomics.wait on a SharedArrayBuffer:
 * within one Node process the critical section is synchronous anyway
 * (a second call cannot interleave), so the lock exists purely for
 * cross-process contention on a shared in-flight store, where blocking
 * this process's event loop while waiting is acceptable and correct.
 *
 * Deadline sizing: the guarded critical section is pure in-memory work
 * plus a handful of small file writes; 2000ms is orders of magnitude
 * above the longest observed section. A lock older than the staleness
 * threshold is treated as a crash leftover and stolen.
 *
 * Failure posture: if the lock DIRECTORY itself cannot be created
 * (broken tmp), the callback runs unlocked with a stderr warning; a
 * broken lock store must never brick an honest review (RULES.md
 * section 4 posture). A lock that stays genuinely held past the
 * deadline throws a "review lock timeout" error, surfaced by the tool
 * as a normal error envelope; the caller simply retries the call.
 */

import { mkdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_DEADLINE_MS = 2000;
const DEFAULT_STALE_MS = 5000;
const BACKOFF_START_MS = 5;
const BACKOFF_FACTOR = 1.5;
const BACKOFF_CAP_MS = 50;
const JITTER_MAX_MS = 5;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.length === 0) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function lockDir(): string {
  const override = process.env.LENSES_LOCK_DIR;
  const dir =
    override !== undefined && override.length > 0
      ? override
      : join(tmpdir(), "lenses-locks");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function lockPath(reviewId: string): string {
  // Sanitize so a hostile reviewId cannot traverse out of the lock dir.
  const safe = reviewId.replace(/[^A-Za-z0-9._-]/g, "_");
  return join(lockDir(), `${safe}.lock`);
}

/** @internal Test-only path resolver so tests can pre-hold a lock. */
export function _lockPathForTests(reviewId: string): string {
  return lockPath(reviewId);
}

/**
 * Synchronous sleep. Atomics.wait on a never-notified SharedArrayBuffer
 * is the clean sync primitive: it parks the thread without spinning.
 */
function sleepSync(ms: number): void {
  const sab = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sab, 0, 0, ms);
}

export function withReviewStateLock<T>(reviewId: string, fn: () => T): T {
  let path: string;
  try {
    path = lockPath(reviewId);
  } catch (err) {
    // Lock infrastructure unavailable: run unlocked rather than brick
    // the review. Cross-process safety is best-effort in this state.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`review-lock: lock dir unavailable, running unlocked: ${message}`);
    return fn();
  }

  const deadlineMs = envInt("LENSES_LOCK_DEADLINE_MS", DEFAULT_DEADLINE_MS);
  const staleMs = envInt("LENSES_LOCK_STALE_MS", DEFAULT_STALE_MS);
  const startedAt = Date.now();
  let backoff = BACKOFF_START_MS;

  for (;;) {
    try {
      mkdirSync(path); // non-recursive: throws EEXIST while held
      break; // acquired
    } catch {
      // Held (or unreadable). Steal only when demonstrably stale.
      try {
        const st = statSync(path);
        if (Date.now() - st.mtimeMs > staleMs) {
          rmSync(path, { recursive: true, force: true });
          continue; // retry immediately after stealing
        }
      } catch {
        // Lock vanished between mkdir and stat: retry immediately.
        continue;
      }
      if (Date.now() - startedAt >= deadlineMs) {
        throw new Error(
          `review-lock: lock timeout after ${deadlineMs}ms for review ${reviewId}`,
        );
      }
      const jitter = Math.floor(Math.random() * (JITTER_MAX_MS + 1));
      sleepSync(Math.min(backoff, BACKOFF_CAP_MS) + jitter);
      backoff = Math.min(backoff * BACKOFF_FACTOR, BACKOFF_CAP_MS);
    }
  }

  try {
    return fn();
  } finally {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`review-lock: release failed for ${reviewId}: ${message}`);
    }
  }
}
