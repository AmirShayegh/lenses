/**
 * T-024 in-flight review persistence. Disk-backed store for
 * `lens_review_start` → `lens_review_complete` continuity across an
 * MCP server restart. Mirrors the primitives in `cache/session.ts`
 * (atomic tmp+rename, 0o600, schema-versioned, TTL sweep) but keys
 * by `reviewId` rather than `sessionId` and supports per-(lensId, attempt)
 * task records plus separate prompt files.
 *
 * Storage layout:
 *
 *   tmpdir()/lenses-in-flight/
 *     <reviewId>/
 *       index.json                      -- per-review meta
 *       prompts/<lensId>.txt            -- full lens prompt (UTF-8)
 *       tasks/<lensId>.<attempt>.json   -- per-attempt state
 *
 * Failure mode policy: same as `cache/session.ts`. Writes throw on real
 * I/O failure; callers wrap in RULES.md §4 best-effort guards. Reads
 * swallow recoverable failures and return `undefined`.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { z } from "zod";

import { LensErrorCodeSchema } from "../schema/error-code.js";
import {
  DeferralKeySchema,
  LensFindingSchema,
  LensOutputSchema,
  StageSchema,
} from "../schema/index.js";

export const CURRENT_IN_FLIGHT_SCHEMA_VERSION = 1 as const;

/** Default TTL for in-flight records. Override via LENSES_IN_FLIGHT_TTL_MS. */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Hard cap on any single in-flight file. 10 MB is comfortable for a
 * multi-attempt task record carrying full findings + error messages,
 * while shielding against a pathological file from blowing up
 * `readFileSync` memory.
 */
const MAX_FILE_BYTES = 10 * 1024 * 1024;

/**
 * Per-attempt task record. Written once at `status: "pending"` during
 * hop-1, then rewritten on each submission with the terminal status
 * and (on success/failure) the `lensOutput` payload that allows a
 * disk-hydrated session to rebuild `perLensLatestOutput` — without
 * which the merger would rerun over an empty view after a restart
 * mid-retry.
 */
export const TaskRecordSchema = z
  .object({
    schemaVersion: z.literal(CURRENT_IN_FLIGHT_SCHEMA_VERSION),
    taskId: z.string().min(1),
    reviewId: z.string().uuid(),
    lensId: z.string().min(1),
    attempt: z.number().int().min(1),
    status: z.enum([
      "pending",
      "in_flight",
      "completed",
      "failed",
      "expired",
    ]),
    promptHash: z.string().min(1),
    chunkIndex: z.number().int().min(0).nullable(),
    startedAt: z.string().datetime({ offset: true }),
    completedAt: z.string().datetime({ offset: true }).nullable(),
    expiresAt: z.string().datetime({ offset: true }),
    errorCode: LensErrorCodeSchema.nullable(),
    lensOutput: LensOutputSchema.nullable(),
  })
  .strict();
export type TaskRecord = z.infer<typeof TaskRecordSchema>;

/**
 * Per-review meta. Everything needed to rebuild a `ReviewSession`
 * except the per-lens mutable state (which lives in task records)
 * and the per-lens prompt text (which lives in prompt files).
 */
export const IndexRecordSchema = z
  .object({
    schemaVersion: z.literal(CURRENT_IN_FLIGHT_SCHEMA_VERSION),
    reviewId: z.string().uuid(),
    sessionId: z.string().uuid(),
    stage: StageSchema,
    expectedLensIds: z.array(z.string().min(1)),
    reviewRound: z.number().int().min(1),
    priorDeferrals: z.array(DeferralKeySchema),
    createdAt: z.string().datetime({ offset: true }),
    cachedResults: z.record(
      z.string(),
      z
        .object({
          findings: z.array(LensFindingSchema),
          notes: z.string().nullable(),
        })
        .strict(),
    ),
    lensMeta: z.record(
      z.string(),
      z
        .object({
          model: z.enum(["opus", "sonnet"]),
          promptHash: z.string().min(1),
          expiresAt: z.string().datetime({ offset: true }),
        })
        .strict(),
    ),
  })
  .strict();
export type IndexRecord = z.infer<typeof IndexRecordSchema>;

/**
 * `taskId` formula. sha256 over the three-tuple that uniquely
 * identifies a single lens attempt within a review. The key is
 * stable across processes, so a restart yields the same taskId for
 * the same (reviewId, lensId, attempt).
 */
export function taskId(
  reviewId: string,
  lensId: string,
  attempt: number,
): string {
  return createHash("sha256")
    .update(`${reviewId}:${lensId}:${attempt}`)
    .digest("hex");
}

export function inFlightDir(): string {
  const override = process.env.LENSES_IN_FLIGHT_DIR;
  const dir =
    override !== undefined && override.length > 0
      ? override
      : join(tmpdir(), "lenses-in-flight");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // best-effort: see cache/session.ts for rationale.
  }
  return dir;
}

function reviewDir(reviewId: string): string {
  const dir = join(inFlightDir(), reviewId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  mkdirSync(join(dir, "prompts"), { recursive: true, mode: 0o700 });
  mkdirSync(join(dir, "tasks"), { recursive: true, mode: 0o700 });
  return dir;
}

function indexPath(reviewId: string): string {
  return join(inFlightDir(), reviewId, "index.json");
}

function promptPath(reviewId: string, lensId: string): string {
  return join(inFlightDir(), reviewId, "prompts", `${lensId}.txt`);
}

function taskPath(
  reviewId: string,
  lensId: string,
  attempt: number,
): string {
  return join(
    inFlightDir(),
    reviewId,
    "tasks",
    `${lensId}.${attempt}.json`,
  );
}

/**
 * Atomic write helper: tmp filename is base + uuid-suffixed, renamed
 * into place. Same defense as `cache/session.ts` against concurrent
 * writers and post-crash predictable-name collisions.
 */
function atomicWriteFile(
  final: string,
  content: string | Uint8Array,
): void {
  // `path.dirname` handles both `/` and `\\` separators + trailing-slash
  // edge cases. Prior impl used `final.lastIndexOf("/")` which returned
  // -1 on Windows paths, producing an empty dir and landing the tmp
  // file in cwd.
  const dir = dirname(final);
  const tmp = join(dir, `.tmp-${randomUUID()}`);
  writeFileSync(tmp, content, { mode: 0o600 });
  try {
    renameSync(tmp, final);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // best-effort cleanup; original rename error is what matters.
    }
    throw err;
  }
}

export function writeIndex(record: IndexRecord): void {
  IndexRecordSchema.parse(record);
  reviewDir(record.reviewId);
  atomicWriteFile(indexPath(record.reviewId), JSON.stringify(record));
}

export function readIndex(reviewId: string): IndexRecord | undefined {
  return safeReadJson(indexPath(reviewId), IndexRecordSchema);
}

export function writePrompt(params: {
  readonly reviewId: string;
  readonly lensId: string;
  readonly prompt: string;
}): void {
  reviewDir(params.reviewId);
  atomicWriteFile(promptPath(params.reviewId, params.lensId), params.prompt);
}

export function readPrompt(
  reviewId: string,
  lensId: string,
): string | undefined {
  const path = promptPath(reviewId, lensId);
  if (!existsSync(path)) return undefined;
  try {
    const st = statSync(path);
    if (st.size > MAX_FILE_BYTES) return undefined;
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

export function writeTask(record: TaskRecord): void {
  TaskRecordSchema.parse(record);
  reviewDir(record.reviewId);
  atomicWriteFile(
    taskPath(record.reviewId, record.lensId, record.attempt),
    JSON.stringify(record),
  );
}

export function readTask(
  reviewId: string,
  lensId: string,
  attempt: number,
): TaskRecord | undefined {
  return safeReadJson(taskPath(reviewId, lensId, attempt), TaskRecordSchema);
}

/**
 * Read every task record for a review and return a Map keyed by
 * `lensId` containing the HIGHEST-attempt record per lens.
 *
 * Assumption: `registerReview` writes attempt-1 pending seeds. No code
 * path in this ticket writes attempt-N pending seeds for N > 1. If a
 * future retry-seed write path is added, `hydrateFromDisk`'s
 * non-terminal-skip logic must be revisited: if the max-attempt record
 * is non-terminal, the prior-attempt terminal record would be
 * permanently invisible here. File a follow-up ticket before adding
 * that path.
 */
export function readAllTasks(reviewId: string): Map<string, TaskRecord> {
  const out = new Map<string, TaskRecord>();
  const dir = join(inFlightDir(), reviewId, "tasks");
  let entries: readonly string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const full = join(dir, entry);
    const parsed = safeReadJson(full, TaskRecordSchema);
    if (parsed === undefined) continue;
    const current = out.get(parsed.lensId);
    if (current === undefined || parsed.attempt > current.attempt) {
      out.set(parsed.lensId, parsed);
    }
  }
  return out;
}

/**
 * Sweep the top-level in-flight dir, removing review dirs whose
 * `index.json.createdAt` is older than `maxAgeMs`. Per-review errors
 * are swallowed so one unreadable dir does not block the rest.
 */
export function cleanupStaleInFlight(
  maxAgeMs: number = resolveTtl(),
): { removed: number } {
  const dir = inFlightDir();
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  let entries: readonly string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return { removed: 0 };
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    try {
      const st = statSync(full);
      if (!st.isDirectory()) continue;
      const idx = safeReadJson(join(full, "index.json"), IndexRecordSchema);
      const createdAtMs =
        idx !== undefined
          ? Date.parse(idx.createdAt)
          : st.mtimeMs;
      if (Number.isFinite(createdAtMs) && createdAtMs < cutoff) {
        rmSync(full, { recursive: true, force: true });
        removed += 1;
      }
    } catch {
      // swallow per-dir errors.
    }
  }
  return { removed };
}

function safeReadJson<T>(
  path: string,
  schema: z.ZodType<T>,
): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const st = statSync(path);
    if (st.size > MAX_FILE_BYTES) return undefined;
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
  const result = schema.safeParse(parsedJson);
  return result.success ? result.data : undefined;
}

function resolveTtl(): number {
  const raw = process.env.LENSES_IN_FLIGHT_TTL_MS;
  if (raw === undefined || raw.length === 0) return DEFAULT_TTL_MS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TTL_MS;
}
