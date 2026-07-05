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
  ReviewVerdictSchema,
  StageSchema,
} from "../schema/index.js";

export const CURRENT_IN_FLIGHT_SCHEMA_VERSION = 1 as const;

/**
 * T-027 R-D6: failure-injection hooks, scoped by OPERATION and by
 * target. A hook fires only when every scope field matches the
 * operation's arguments, is single-shot, and every pending hook is
 * cleared via the review-state `_resetForTests` seam (which calls
 * `_clearFailureHooksForTests` below). Unscoped global failure hooks
 * are forbidden.
 */
interface TaskWriteScope {
  readonly reviewId: string;
  readonly lensId: string;
  readonly attempt: number;
}
interface ReviewScope {
  readonly reviewId: string;
}
let failNextTaskWrite: TaskWriteScope | null = null;
let failNextIndexRmw: ReviewScope | null = null;
let failNextCompletionWrite: ReviewScope | null = null;

/** @internal Test-only: fail the next writeTask matching the scope. */
export function _failNextTaskWriteForTests(scope: TaskWriteScope): void {
  failNextTaskWrite = scope;
}

/** @internal Test-only: fail the next index read-modify-write for the review. */
export function _failNextIndexRmwForTests(scope: ReviewScope): void {
  failNextIndexRmw = scope;
}

/** @internal Test-only: fail the next completion write for the review. */
export function _failNextCompletionWriteForTests(scope: ReviewScope): void {
  failNextCompletionWrite = scope;
}

/** @internal Test-only: clear every pending failure hook. */
export function _clearFailureHooksForTests(): void {
  failNextTaskWrite = null;
  failNextIndexRmw = null;
  failNextCompletionWrite = null;
}

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
    // T-026 R11: the retained hop-1 artifact (diff or plan text) + its
    // changedFiles, persisted so the complete-time anchor pass can verify
    // snippets after a server restart. DEFAULTED (no schema-version bump)
    // so pre-T-026 index files still parse; the inferred OUTPUT type makes
    // them required, so every writer (registration, makeIndex fixture)
    // supplies them. The artifact is size-fitted by
    // `fitArtifactToIndexBudget` before write (R7); these field names/shapes
    // are a cross-ticket contract with T-032 -- do not rename or reshape.
    artifact: z.string().default(""),
    changedFiles: z.array(z.string()).default([]),
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
          // T-027 R14(h): the lens's timeout budget, persisted so
          // deadline re-anchoring survives a restart. Optional (no
          // schema-version bump); hydration of pre-T-027 index files
          // falls back to resolveLensTimeoutMs(model, undefined).
          timeoutMs: z.number().int().positive().optional(),
          // T-027 R-B1 (ratified alternative branch): set when a retry
          // NextAction is emitted. Hydration reconciles pendingAttempt
          // N with a missing terminal attempt N-1 so an in-window
          // retry is never rejected as non-contiguous after a restart.
          pendingAttempt: z.number().int().min(2).optional(),
          // T-027 codex round 2: the durable ONCE-GUARD for the
          // prompt-fetch anchor, written in the SAME index RMW as the
          // anchored expiresAt so guard and deadline are atomic. The
          // fetch path re-anchors ONLY when this is absent; hydration
          // reads it back, so a restart can never re-extend an already
          // anchored deadline (the task-record pending -> in_flight
          // flip is bookkeeping, not the guard).
          anchoredAttempt: z.number().int().min(1).optional(),
        })
        .strict(),
    ),
  })
  .strict();
export type IndexRecord = z.infer<typeof IndexRecordSchema>;

/**
 * T-026 R7: the serialized-byte budget for a persisted IndexRecord. The
 * read gates (`safeReadJson`, `readPrompt`) reject any in-flight file whose
 * on-disk size exceeds `MAX_FILE_BYTES`, so persisting an index right AT
 * that cap would make it unreadable and destroy T-024 restart rehydration.
 * A 4 KB headroom below the cap leaves room for the non-artifact fields plus
 * a slice-rounding margin.
 */
export const INDEX_BYTE_BUDGET = MAX_FILE_BYTES - 4096;

/**
 * JSON-string-escaped UTF-8 byte cost of a single code point, matching how
 * `JSON.stringify` encodes it inside a string. Control chars with short
 * escapes (\b \t \n \f \r), `"`, and `\` cost 2 bytes; other control chars
 * cost 6 (\u00XX); everything else is emitted verbatim at its UTF-8 length.
 */
function jsonEscapedCodePointBytes(cp: string): number {
  const code = cp.codePointAt(0)!;
  if (
    code === 0x22 || // "
    code === 0x5c || // \
    code === 0x08 || // \b
    code === 0x09 || // \t
    code === 0x0a || // \n
    code === 0x0c || // \f
    code === 0x0d // \r
  ) {
    return 2;
  }
  if (code < 0x20) return 6;
  return Buffer.byteLength(cp, "utf8");
}

/**
 * T-026 R7 / pen resolution 4: fit a persisted IndexRecord under
 * `INDEX_BYTE_BUDGET` by slicing ONLY `record.artifact`. Under-budget records
 * return unchanged (reference identity). Over budget: compute the
 * non-artifact serialized overhead ONCE (with `artifact: ""`), derive an
 * exact escaped-byte budget for the artifact, walk the artifact's code
 * points accumulating their JSON-escaped byte cost, and cut at the last code
 * point that fits -- so a surrogate pair is never split and control/multibyte
 * escaping is accounted for exactly. Slice once, verify once. Accepted
 * documented degradation: for pathological artifacts the tail is dropped, so
 * post-restart verification of findings anchored beyond the cut degrades to
 * the R6 defer/flag paths; in-memory sessions keep the full artifact.
 */
export function fitArtifactToIndexBudget(record: IndexRecord): IndexRecord {
  const full = Buffer.byteLength(JSON.stringify(record), "utf8");
  if (full <= INDEX_BYTE_BUDGET) return record;
  const emptyOverhead = Buffer.byteLength(
    JSON.stringify({ ...record, artifact: "" }),
    "utf8",
  );
  const artifactBudget = INDEX_BYTE_BUDGET - emptyOverhead;
  if (artifactBudget <= 0) return { ...record, artifact: "" };
  let used = 0;
  let cut = 0; // number of UTF-16 code units to keep
  for (const cp of record.artifact) {
    const cost = jsonEscapedCodePointBytes(cp);
    if (used + cost > artifactBudget) break;
    used += cost;
    cut += cp.length; // 2 for an astral code point, 1 otherwise
  }
  const candidate = { ...record, artifact: record.artifact.slice(0, cut) };
  // Verify once; the walk is exact, so this holds by construction. The guard
  // falls back to an empty artifact only if an impossible miscount overshot.
  if (
    Buffer.byteLength(JSON.stringify(candidate), "utf8") <= INDEX_BYTE_BUDGET
  ) {
    return candidate;
  }
  return { ...record, artifact: "" };
}

/**
 * T-027 (pen resolution 2): the durable completion record. Written by
 * `commitReviewCompletion` BEFORE the in-memory status flips to
 * `complete`; its presence is what makes a replayed completion call a
 * DUPLICATE_COMPLETE across restarts, and its stored verdict feeds the
 * replay envelope's `storedVerdict` sibling field.
 */
export const CompletionRecordSchema = z
  .object({
    schemaVersion: z.literal(CURRENT_IN_FLIGHT_SCHEMA_VERSION),
    reviewId: z.string().uuid(),
    completedAt: z.string().datetime({ offset: true }),
    verdict: ReviewVerdictSchema,
  })
  .strict();
export type CompletionRecord = z.infer<typeof CompletionRecordSchema>;

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
  if (
    failNextTaskWrite !== null &&
    failNextTaskWrite.reviewId === record.reviewId &&
    failNextTaskWrite.lensId === record.lensId &&
    failNextTaskWrite.attempt === record.attempt
  ) {
    failNextTaskWrite = null; // single-shot
    throw new Error(
      `in-flight: injected task write failure (${record.lensId}@${record.attempt})`,
    );
  }
  TaskRecordSchema.parse(record);
  reviewDir(record.reviewId);
  atomicWriteFile(
    taskPath(record.reviewId, record.lensId, record.attempt),
    JSON.stringify(record),
  );
}

function completionPath(reviewId: string): string {
  return join(inFlightDir(), reviewId, "completion.json");
}

/**
 * Durable completion write. Unlike the best-effort task/index writers'
 * CALLERS, `commitReviewCompletion` treats a throw here as fatal for
 * the finalizing call (PERSISTENCE_FAILED envelope), so this function
 * intentionally propagates IO errors.
 */
export function writeCompletion(record: CompletionRecord): void {
  if (
    failNextCompletionWrite !== null &&
    failNextCompletionWrite.reviewId === record.reviewId
  ) {
    failNextCompletionWrite = null; // single-shot
    throw new Error(
      `in-flight: injected completion write failure (${record.reviewId})`,
    );
  }
  CompletionRecordSchema.parse(record);
  reviewDir(record.reviewId);
  atomicWriteFile(completionPath(record.reviewId), JSON.stringify(record));
}

export function readCompletion(
  reviewId: string,
): CompletionRecord | undefined {
  return safeReadJson(completionPath(reviewId), CompletionRecordSchema);
}

/**
 * T-027 R7: deadline durability lives in the INDEX, never in task
 * records. Both the prompt-fetch anchor and the retry mint persist via
 * this lensMeta read-modify-write only. Throws on IO failure (callers
 * decide whether to swallow); a missing index (memory-only session) is
 * a silent no-op.
 */
export function updateIndexLensMeta(
  reviewId: string,
  lensId: string,
  patch: {
    readonly expiresAt?: string;
    readonly pendingAttempt?: number;
    readonly anchoredAttempt?: number;
  },
): void {
  if (failNextIndexRmw !== null && failNextIndexRmw.reviewId === reviewId) {
    failNextIndexRmw = null; // single-shot
    throw new Error(`in-flight: injected index RMW failure (${reviewId})`);
  }
  const index = readIndex(reviewId);
  if (index === undefined) return; // memory-only session: nothing durable to update
  const meta = index.lensMeta[lensId];
  if (meta === undefined) return; // lens unknown to the index (e.g. cached-only)
  const nextMeta = {
    ...meta,
    ...(patch.expiresAt !== undefined ? { expiresAt: patch.expiresAt } : {}),
    ...(patch.pendingAttempt !== undefined
      ? { pendingAttempt: patch.pendingAttempt }
      : {}),
    ...(patch.anchoredAttempt !== undefined
      ? { anchoredAttempt: patch.anchoredAttempt }
      : {}),
  };
  writeIndex({
    ...index,
    lensMeta: { ...index.lensMeta, [lensId]: nextMeta },
  });
}

/**
 * Whether the review has a durable index on disk. Distinguishes the
 * memory-only path ("no index file exists" -> completion proceeds in
 * memory) from an IO failure (a THROW here or in the completion write
 * feeds PERSISTENCE_FAILED on finalizing paths). Propagates throws
 * from `inFlightDir` resolution deliberately.
 */
export function hasIndexFile(reviewId: string): boolean {
  return existsSync(indexPath(reviewId));
}

export function readTask(
  reviewId: string,
  lensId: string,
  attempt: number,
): TaskRecord | undefined {
  return safeReadJson(taskPath(reviewId, lensId, attempt), TaskRecordSchema);
}

const TERMINAL_STATUSES: ReadonlySet<TaskRecord["status"]> = new Set([
  "completed",
  "failed",
  "expired",
]);

function isTerminal(r: TaskRecord): boolean {
  return TERMINAL_STATUSES.has(r.status);
}

function hasOkOutput(r: TaskRecord): boolean {
  return r.lensOutput !== null && r.lensOutput.status === "ok";
}

/** Equal-attempt status rank (R-D5 rule 4): higher rank is preferred. */
const STATUS_RANK: Record<TaskRecord["status"], number> = {
  completed: 4,
  failed: 3,
  expired: 2,
  in_flight: 1,
  pending: 0,
};

/**
 * T-027 R-D5: the named pure comparator for per-lens record selection.
 * Returns a positive number when `a` is preferred over `b`, negative
 * for the reverse, never 0 for distinct on-disk records (the writer
 * cannot produce two records at one (lensId, attempt)). Rules 2-4 of
 * the documented total order live here; rule 1 (expired never erases a
 * prior terminal ok) is a pre-filter in `selectTaskRecord` because it
 * ranges over the whole record SET, not a pair.
 *
 * REAL-FAILURE SEMANTICS (codex round, resolution 1, audited): a
 * `failed` record beating an ok record at a lower attempt is
 * INTENTIONAL, because every `failed` record on disk corresponds to a
 * genuinely ACCEPTED submission at a monotonically advanced attempt --
 * it mirrors `perLensLatestOutput` in memory exactly. Writer inventory
 * guaranteeing this: (a) registration writes `pending` seeds only;
 * (b) `persistInFlightBestEffort` runs over the disposition's ACCEPTED
 * submissions only (the T-027 round removed the post-handler call that
 * could persist diverted/ignored placeholders); (c)
 * `persistExpiredBestEffort` writes `expired` records only, guarded
 * against ok-covered lenses; (d) the prompt-fetch anchor flips
 * `pending` to `in_flight` only. No path can synthesize a `failed`
 * record that bypassed the state machine. If a future writer breaks
 * that inventory, extend the rule-1 pre-filter rather than this
 * comparator.
 */
export function compareTaskRecords(a: TaskRecord, b: TaskRecord): number {
  // Rule 3: non-terminal records are used only when the lens has no
  // terminal record at all, regardless of attempt numbers.
  const at = isTerminal(a);
  const bt = isTerminal(b);
  if (at !== bt) return at ? 1 : -1;
  // Rule 2: within a class, the highest attempt wins (failed@2 beats
  // ok@1: a later failed attempt is the latest lens state).
  if (a.attempt !== b.attempt) return a.attempt - b.attempt;
  // Rule 4 (defensive tiebreak to keep the order total): at equal
  // attempt prefer completed/failed over expired over non-terminal,
  // and completed over failed.
  return STATUS_RANK[a.status] - STATUS_RANK[b.status];
}

/**
 * T-027 R-D5: per-lens record selection. Documented total order:
 *  (1) discard any "expired" record whose attempt is higher than a
 *      terminal record carrying an ok lensOutput for the same lens (a
 *      corrupt or late expired record never erases a prior ok; the
 *      reader-side mirror of the R2 writer invariant);
 *  (2) among the remaining records the highest-attempt TERMINAL record
 *      (completed/failed/expired) wins;
 *  (3) non-terminal records are used only when the lens has no
 *      terminal record at all;
 *  (4) at equal attempt prefer completed/failed over expired over
 *      non-terminal, and defensively completed over failed.
 */
export function selectTaskRecord(
  records: readonly TaskRecord[],
): TaskRecord | undefined {
  if (records.length === 0) return undefined;
  let maxOkAttempt = -1;
  for (const r of records) {
    if (isTerminal(r) && hasOkOutput(r) && r.attempt > maxOkAttempt) {
      maxOkAttempt = r.attempt;
    }
  }
  // Rule 1 pre-filter.
  const eligible = records.filter(
    (r) => !(r.status === "expired" && r.attempt > maxOkAttempt && maxOkAttempt >= 0),
  );
  const pool = eligible.length > 0 ? eligible : records;
  let best: TaskRecord | undefined;
  for (const r of pool) {
    if (best === undefined || compareTaskRecords(r, best) > 0) best = r;
  }
  return best;
}

/**
 * Read every task record for a review and return a Map keyed by
 * `lensId` containing the record selected by the R-D5 total order
 * above (terminal-preferred selection). `hydrateFromDisk`'s
 * anyTerminalTask derivation keeps working because a lens with any
 * terminal record always surfaces a terminal record here.
 */
export function readAllTasks(reviewId: string): Map<string, TaskRecord> {
  const byLens = new Map<string, TaskRecord[]>();
  const dir = join(inFlightDir(), reviewId, "tasks");
  let entries: readonly string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return new Map();
  }
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const full = join(dir, entry);
    const parsed = safeReadJson(full, TaskRecordSchema);
    if (parsed === undefined) continue;
    const list = byLens.get(parsed.lensId);
    if (list === undefined) {
      byLens.set(parsed.lensId, [parsed]);
    } else {
      list.push(parsed);
    }
  }
  const out = new Map<string, TaskRecord>();
  for (const [lensId, records] of byLens) {
    const selected = selectTaskRecord(records);
    if (selected !== undefined) out.set(lensId, selected);
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
  // Input type left free (`z.ZodType<T, z.ZodTypeDef, unknown>`) so
  // schemas whose Input differs from Output (e.g. `.default()`ed
  // fields inside CompletionRecordSchema's nested ReviewVerdictSchema)
  // still satisfy the constraint; we only ever consume the OUTPUT.
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
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
