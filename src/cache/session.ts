/**
 * T-014 session cache. Disk-backed store for round-to-round continuity.
 * One JSON document per `sessionId`, validated on every read, written
 * atomically via tmp-and-rename. Pure module: the ONLY state is a
 * lazily-resolved cache directory path.
 *
 * Scope boundary: this module owns storage and schema. It does NOT
 * decide when a session exists, when to append a round, or how
 * findings are built -- those are T-014's caller (`complete.ts`) and
 * T-015's future start-time read path. Keeping storage decoupled from
 * orchestration means T-015 can add a read-on-start codepath without
 * touching this file.
 *
 * Failure mode policy:
 *  - `writeSessionRound` throws on real I/O failures. The caller in
 *    `complete.ts` wraps it in its own try/catch per RULES.md §4
 *    ("skip caching, don't fail") so a disk-full error cannot turn an
 *    otherwise-successful review into a tool-level error.
 *  - `readSession` swallows every recoverable failure (missing file,
 *    zero bytes, truncated JSON, schemaVersion mismatch) and returns
 *    `undefined`. Prior-round recovery is best-effort -- round 2
 *    treats "no prior record" and "prior record is unreadable"
 *    identically.
 *  - `cleanupStaleSessions` swallows per-file errors so one unreadable
 *    file cannot block the sweep. The return count reflects only what
 *    was actually deleted.
 *
 * Concurrency note: a single Claude Code process owns the MCP server,
 * and the agent drives rounds sequentially. No cross-process locking
 * is done here. The tmp-file nonce in §atomic-write defends against a
 * future ticket introducing concurrent writers without losing data.
 */

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import {
  DeferralKeySchema,
  MergedFindingSchema,
  StageSchema,
  VerdictSchema,
} from "../schema/index.js";

/**
 * Per-round record. Field shapes reuse the authoritative schemas
 * (`MergedFindingSchema`, `StageSchema`, `VerdictSchema`,
 * `DeferralKeySchema`) rather than redeclaring them, so a change to
 * any of those propagates into the cache format by construction.
 *
 * `counts` has all four `Severity` keys zero-filled on write -- the
 * producer in `complete.ts` sources them directly from the verdict, so
 * the schema just pins the shape.
 */
export const RoundRecordSchema = z
  .object({
    roundNumber: z.number().int().min(1),
    reviewId: z.string().min(1),
    stage: StageSchema,
    verdict: VerdictSchema,
    counts: z
      .object({
        blocking: z.number().int().min(0),
        major: z.number().int().min(0),
        minor: z.number().int().min(0),
        suggestion: z.number().int().min(0),
      })
      .strict(),
    findings: z.array(MergedFindingSchema),
    priorDeferrals: z.array(DeferralKeySchema),
    completedAt: z.number().int().min(0),
  })
  .strict();
export type RoundRecord = z.infer<typeof RoundRecordSchema>;

/**
 * Top-level session file shape. `schemaVersion: 1` is the migration
 * seam; any future extension bumps this literal, and older readers
 * treat bumped files as "no prior session" via the `safeParse` path
 * in `readSession`. The non-rolling-upgrade assumption is documented
 * in the plan (§3.1) -- a bump costs one series of continuity.
 */
export const SessionRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    sessionId: z.string().uuid(),
    createdAt: z.number().int().min(0),
    updatedAt: z.number().int().min(0),
    rounds: z.array(RoundRecordSchema).nonempty(),
  })
  .strict();
export type SessionRecord = z.infer<typeof SessionRecordSchema>;

/** Also exported for the bump-verifying test in `cache-session.test.ts`. */
export const CURRENT_SCHEMA_VERSION = 1 as const;

/** Default TTL. Override via `LENSES_SESSION_TTL_MS`. */
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Hard cap on a single session file. A larger file is treated as
 * "not a valid session" and skipped -- prevents a malformed or
 * attacker-planted multi-GB file from blowing up `readFileSync`
 * memory. 10 MB comfortably fits thousands of findings across
 * dozens of rounds.
 */
const MAX_SESSION_BYTES = 10 * 1024 * 1024;

/**
 * Resolve and create-if-missing the cache directory. Env override
 * exists primarily for tests (per-test temp dir) but is also usable
 * by operators who want to pin the location. Called on every write/
 * cleanup -- the mkdirSync is a no-op when the directory already
 * exists, and re-reading the env each call means a test can point the
 * module at a fresh dir per case without a module reload.
 */
export function cacheDir(): string {
  const override = process.env.LENSES_SESSION_DIR;
  const dir =
    override !== undefined && override.length > 0
      ? override
      : join(tmpdir(), "lenses-sessions");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // `mkdirSync` only applies `mode` when it actually creates the
  // directory; pre-existing dirs keep their prior permissions. Force
  // 0o700 on every call so a world-readable pre-existing dir cannot
  // silently leak session contents. Swallowed: chmod can fail on
  // non-owned paths (e.g., an operator-provided override), and a
  // permission warning is not worth failing the review over.
  try {
    chmodSync(dir, 0o700);
  } catch {
    // best-effort: see comment above.
  }
  return dir;
}

function sessionFilePath(sessionId: string): string {
  return join(cacheDir(), `${sessionId}.json`);
}

/**
 * Persist a single round. If this is the first round for `sessionId`,
 * create a new `SessionRecord` with `rounds: [round]`. Otherwise read
 * the prior record and append; if the prior record is unreadable, start
 * fresh -- treating a corrupted prior as "lost history" and preserving
 * at least the current round is strictly better than refusing to write.
 *
 * Atomic via tmp-file-then-rename. The tmp filename uses a per-write
 * nonce (`<sessionId>.<uuid>.tmp`) so two concurrent writers cannot
 * stomp each other's pre-rename buffer, and a crashed writer does not
 * leave a predictable stale file that looks like a valid target.
 */
export function writeSessionRound(input: {
  readonly sessionId: string;
  readonly round: RoundRecord;
}): void {
  // Resolve the cache directory ONCE per write. Three consequences:
  // (1) `tmp` and `final` are guaranteed to live under the same dir so
  //     `renameSync` cannot hit EXDEV if an environment mutation races
  //     between syscalls; (2) we pay the `mkdirSync` + `chmodSync`
  //     cost once instead of per sessionFilePath / readSession / tmp
  //     path lookup; (3) if a future caller points
  //     `LENSES_SESSION_DIR` at an unwritable path we get a single
  //     stderr line per write, not three.
  const dir = cacheDir();
  const final = join(dir, `${input.sessionId}.json`);
  const prior = readSession(input.sessionId);
  const now = input.round.completedAt;

  const record: SessionRecord = prior
    ? {
        ...prior,
        updatedAt: now,
        rounds: [...prior.rounds, input.round] as SessionRecord["rounds"],
      }
    : {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        sessionId: input.sessionId,
        createdAt: now,
        updatedAt: now,
        rounds: [input.round],
      };

  // Defense-in-depth: re-validate before writing so a caller-constructed
  // record with an invalid severity or a duplicate lens id on a finding
  // cannot pollute the cache. A throw here surfaces to `complete.ts`,
  // which swallows it per RULES.md §4.
  SessionRecordSchema.parse(record);

  const tmp = join(dir, `${input.sessionId}.${randomUUID()}.tmp`);
  writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
  try {
    renameSync(tmp, final);
  } catch (err) {
    // Rename failed (disk full, permissions changed, EXDEV). Unlink
    // the tmp file so a repeating failure does not accumulate garbage
    // -- `cleanupStaleSessions` only sweeps `*.json` by design, so
    // orphaned `.tmp` files have no other collection path. Swallow
    // the unlink error: it is best-effort cleanup, and the original
    // rename error is what the caller needs to see.
    try {
      unlinkSync(tmp);
    } catch {
      // best-effort: nothing to do if even unlink fails.
    }
    throw err;
  }
}

/**
 * Read a session by id. Returns `undefined` for every recoverable
 * failure -- missing file, zero-byte file, non-JSON content, or a
 * record that fails schema validation (including a future
 * `schemaVersion` bump). Callers treat "undefined" as "no prior
 * session" uniformly.
 */
export function readSession(sessionId: string): SessionRecord | undefined {
  const path = sessionFilePath(sessionId);
  if (!existsSync(path)) return undefined;
  // Stat-first to cap memory: a pathological multi-GB file would
  // otherwise be slurped whole by `readFileSync`. Treat "stat fails"
  // as "no prior session" -- consistent with the rest of readSession's
  // graceful-degrade posture. The size cap is checked against the
  // byte count on disk, not the UTF-8 string length; for the valid
  // ASCII JSON we write these are effectively equal, but sizing off
  // the stat means we never allocate the oversized buffer at all.
  try {
    const st = statSync(path);
    if (st.size > MAX_SESSION_BYTES) return undefined;
  } catch {
    return undefined;
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  if (raw.length === 0) return undefined;
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const result = SessionRecordSchema.safeParse(parsedJson);
  return result.success ? result.data : undefined;
}

/**
 * Sweep the cache directory, deleting any `*.json` whose `updatedAt`
 * (or failing that, the filesystem mtime) is older than `maxAgeMs`.
 * Per-file errors are swallowed so one unreadable file does not block
 * the rest. Returns the number of files actually deleted -- tests pin
 * this count.
 */
export function cleanupStaleSessions(
  maxAgeMs: number = resolveTtl(),
): { removed: number } {
  const dir = cacheDir();
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  let entries: readonly string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return { removed: 0 };
  }
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const full = join(dir, entry);
    try {
      const st = statSync(full);
      // Prefer the record's own `updatedAt` when available: it reflects
      // when the session was logically updated, not when the filesystem
      // last touched the inode. Fall back to mtime if the record is
      // unreadable -- a corrupt stale file should still be cleanable.
      const raw = readFileSync(full, "utf8");
      let updatedAt: number;
      try {
        const parsed = SessionRecordSchema.safeParse(JSON.parse(raw));
        updatedAt = parsed.success ? parsed.data.updatedAt : st.mtimeMs;
      } catch {
        updatedAt = st.mtimeMs;
      }
      if (updatedAt < cutoff) {
        unlinkSync(full);
        removed += 1;
      }
    } catch {
      // swallow per-file errors; next sweep will retry.
    }
  }
  return { removed };
}

function resolveTtl(): number {
  const raw = process.env.LENSES_SESSION_TTL_MS;
  if (raw === undefined || raw.length === 0) return DEFAULT_TTL_MS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TTL_MS;
}

