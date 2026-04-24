/**
 * In-memory + disk-backed state machine for the two-hop+ lens review
 * flow. The `sessions` Map is a bounded LRU READ-CACHE on top of the
 * in-flight disk store (`src/cache/in-flight.ts`). Disk is the source
 * of truth. Eviction from the Map is not data loss -- the next
 * `getReview` rehydrates from disk.
 *
 * Structural discipline (RULES.md §4): disk IO lives in best-effort
 * helpers that NEVER propagate errors out of the state module. A disk
 * failure is logged via `console.error` and swallowed so the caller's
 * review always produces a verdict.
 *
 * T-022 state machine contract preserved: `applyCompletion` remains
 * synchronous and in-memory only. Disk writeback is done by the
 * callsite (complete.ts) AFTER its outer try/catch closes, via the
 * peer helper `persistInFlightBestEffort`.
 */

import {
  rmSync,
} from "node:fs";

import {
  inFlightDir,
  readAllTasks,
  readIndex,
  readPrompt,
  taskId,
  writeIndex,
  writePrompt,
  writeTask,
  type IndexRecord,
  type TaskRecord,
  CURRENT_IN_FLIGHT_SCHEMA_VERSION,
} from "../cache/in-flight.js";
import type { LensId } from "../lenses/prompts/index.js";
import type {
  DeferralKey,
  LensErrorCode,
  LensFinding,
  LensOutput,
  Stage,
} from "../schema/index.js";

export interface CachedLensEntry {
  readonly findings: readonly LensFinding[];
  readonly notes: string | null;
}

export type ReviewStatus = "started" | "awaiting_retry" | "complete";

export interface ReviewSession {
  readonly reviewId: string;
  readonly sessionId: string;
  readonly stage: Stage;
  readonly expectedLensIds: readonly LensId[];
  readonly reviewRound: number;
  readonly priorDeferrals: readonly DeferralKey[];
  readonly startedAt: number;
  readonly status: ReviewStatus;
  readonly cachedResults: ReadonlyMap<LensId, CachedLensEntry>;
  readonly promptHashes: ReadonlyMap<LensId, string>;
  readonly prompts: ReadonlyMap<LensId, string>;
  readonly perLensExpiresAt: ReadonlyMap<LensId, number>;
  readonly perLensAttempts: ReadonlyMap<LensId, number>;
  readonly perLensLatestOutput: ReadonlyMap<LensId, LensOutput>;
}

export type ApplyCompletionResult =
  | { readonly ok: true; readonly session: ReviewSession }
  | {
      readonly ok: false;
      readonly code: "unknown";
      readonly message: string;
    }
  | {
      readonly ok: false;
      readonly code: "already_complete";
      readonly message: string;
    }
  | {
      readonly ok: false;
      readonly code: "missing_lenses";
      readonly message: string;
      readonly missing: readonly LensId[];
    }
  | {
      readonly ok: false;
      readonly code: "stale_attempt";
      readonly message: string;
      readonly lensId: LensId;
      readonly highestSeen: number;
      readonly submittedAttempt: number;
    }
  | {
      readonly ok: false;
      readonly code: "non_contiguous_attempt";
      readonly message: string;
      readonly lensId: LensId;
      readonly expected: number;
      readonly submittedAttempt: number;
    }
  | {
      readonly ok: false;
      readonly code: "review_expired";
      readonly message: string;
      readonly lensId: LensId;
      readonly expiresAt: number;
    };

/**
 * Bounded LRU cap for the in-process read-cache. Override via
 * `LENSES_INFLIGHT_LRU_CAP` env. Eviction is first-inserted-first-out
 * because `Map` iteration order in V8 is insertion order; re-inserting
 * on hit moves the entry to the back and approximates LRU cheaply.
 */
function lruCap(): number {
  const raw = process.env.LENSES_INFLIGHT_LRU_CAP;
  if (raw === undefined || raw.length === 0) return 100;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 100;
}

/**
 * Map each `ApplyCompletionResult` rejection code onto the closest
 * `LensErrorCode` enum value. Lets `complete.ts` surface the typed
 * code on the wire envelope (ISS-004) instead of dropping state-
 * machine rejections into plain-text isError responses with no way
 * for the caller to classify them programmatically.
 */
export function rejectionToLensErrorCode(
  code: Exclude<ApplyCompletionResult, { ok: true }>["code"],
): LensErrorCode {
  switch (code) {
    case "review_expired":
      return "REVIEW_EXPIRED";
    case "already_complete":
    case "stale_attempt":
      return "DUPLICATE_COMPLETE";
    case "unknown":
    case "missing_lenses":
    case "non_contiguous_attempt":
    default:
      return "UNKNOWN_ERROR";
  }
}

const sessions = new Map<string, ReviewSession>();

function touchLru(reviewId: string, session: ReviewSession): void {
  sessions.delete(reviewId);
  sessions.set(reviewId, session);
  while (sessions.size > lruCap()) {
    const oldest = sessions.keys().next().value;
    if (oldest === undefined) break;
    sessions.delete(oldest);
  }
}

/**
 * Best-effort log for disk-IO failures. Kept as a small local helper
 * so the signature matches the other `persist*BestEffort` functions in
 * the codebase and future maintainers see the swallow-log pattern
 * uniformly applied.
 */
function logSwallow(op: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`review-state: ${op} failed: ${message}`);
}

/**
 * Register a new review. Writes the index + per-lens prompts + initial
 * pending task records atomically per file (best-effort: disk errors
 * are logged and swallowed so a broken cache cannot block hop-1).
 */
export function registerReview(params: {
  readonly reviewId: string;
  readonly sessionId: string;
  readonly stage: Stage;
  readonly expectedLensIds: readonly LensId[];
  readonly reviewRound: number;
  readonly priorDeferrals: readonly DeferralKey[];
  readonly cachedResults?: ReadonlyMap<LensId, CachedLensEntry>;
  readonly promptHashes?: ReadonlyMap<LensId, string>;
  readonly prompts?: ReadonlyMap<LensId, string>;
  readonly perLensExpiresAt?: ReadonlyMap<LensId, number>;
  readonly lensModels?: ReadonlyMap<LensId, "opus" | "sonnet">;
}): void {
  if (sessions.has(params.reviewId)) {
    throw new Error(
      `review state: reviewId already registered: ${params.reviewId}`,
    );
  }
  const session: ReviewSession = {
    reviewId: params.reviewId,
    sessionId: params.sessionId,
    stage: params.stage,
    expectedLensIds: params.expectedLensIds,
    reviewRound: params.reviewRound,
    priorDeferrals: params.priorDeferrals,
    startedAt: Date.now(),
    status: "started",
    cachedResults: params.cachedResults ?? new Map(),
    promptHashes: params.promptHashes ?? new Map(),
    prompts: params.prompts ?? new Map(),
    perLensExpiresAt: params.perLensExpiresAt ?? new Map(),
    perLensAttempts: new Map(),
    perLensLatestOutput: new Map(),
  };
  touchLru(params.reviewId, session);

  // Disk writeback. Each step its own try/catch so one file's failure
  // cannot cascade. The whole block is wrapped in an outer try/catch
  // so even an unexpected throw never escapes.
  try {
    persistRegistrationBestEffort(session, params.lensModels);
  } catch (err) {
    logSwallow("registerReview persist", err);
  }
}

function persistRegistrationBestEffort(
  session: ReviewSession,
  lensModels: ReadonlyMap<LensId, "opus" | "sonnet"> | undefined,
): void {
  // Build the index record from the session + lensModels map.
  try {
    const lensMeta: IndexRecord["lensMeta"] = {};
    for (const lensId of session.promptHashes.keys()) {
      const promptHash = session.promptHashes.get(lensId);
      const expiresMs = session.perLensExpiresAt.get(lensId);
      const model = lensModels?.get(lensId);
      if (promptHash === undefined || expiresMs === undefined || model === undefined) {
        continue; // cached-only lens or model not provided
      }
      lensMeta[lensId] = {
        model,
        promptHash,
        expiresAt: new Date(expiresMs).toISOString(),
      };
    }

    const cached: IndexRecord["cachedResults"] = {};
    for (const [lensId, entry] of session.cachedResults) {
      cached[lensId] = {
        findings: [...entry.findings],
        notes: entry.notes,
      };
    }

    const index: IndexRecord = {
      schemaVersion: CURRENT_IN_FLIGHT_SCHEMA_VERSION,
      reviewId: session.reviewId,
      sessionId: session.sessionId,
      stage: session.stage,
      expectedLensIds: [...session.expectedLensIds],
      reviewRound: session.reviewRound,
      priorDeferrals: [...session.priorDeferrals],
      createdAt: new Date(session.startedAt).toISOString(),
      cachedResults: cached,
      lensMeta,
    };
    writeIndex(index);
  } catch (err) {
    logSwallow("writeIndex", err);
  }

  for (const [lensId, prompt] of session.prompts) {
    try {
      writePrompt({ reviewId: session.reviewId, lensId, prompt });
    } catch (err) {
      logSwallow(`writePrompt(${lensId})`, err);
    }
    try {
      const promptHash = session.promptHashes.get(lensId);
      const expiresMs = session.perLensExpiresAt.get(lensId);
      if (promptHash === undefined || expiresMs === undefined) continue;
      const now = new Date().toISOString();
      const record: TaskRecord = {
        schemaVersion: CURRENT_IN_FLIGHT_SCHEMA_VERSION,
        taskId: taskId(session.reviewId, lensId, 1),
        reviewId: session.reviewId,
        lensId,
        attempt: 1,
        status: "pending",
        promptHash,
        chunkIndex: null,
        startedAt: now,
        completedAt: null,
        expiresAt: new Date(expiresMs).toISOString(),
        errorCode: null,
        lensOutput: null,
      };
      writeTask(record);
    } catch (err) {
      logSwallow(`writeTask pending(${lensId}, 1)`, err);
    }
  }
}

/**
 * Lookup with lazy disk rehydration. Map hit returns immediately;
 * Map miss reads index + tasks + prompts and reconstructs the
 * ReviewSession. Undefined only when the index file is missing.
 */
export function getReview(reviewId: string): ReviewSession | undefined {
  const fromMap = sessions.get(reviewId);
  if (fromMap !== undefined) {
    touchLru(reviewId, fromMap); // keep LRU ordering fresh on read
    return fromMap;
  }
  const hydrated = hydrateFromDisk(reviewId);
  if (hydrated !== undefined) touchLru(reviewId, hydrated);
  return hydrated;
}

function hydrateFromDisk(reviewId: string): ReviewSession | undefined {
  const index = readIndex(reviewId);
  if (index === undefined) return undefined;
  const tasks = readAllTasks(reviewId);

  const prompts = new Map<LensId, string>();
  const promptHashes = new Map<LensId, string>();
  const perLensExpiresAt = new Map<LensId, number>();
  for (const [lensId, meta] of Object.entries(index.lensMeta)) {
    const p = readPrompt(reviewId, lensId);
    if (p !== undefined) prompts.set(lensId as LensId, p);
    promptHashes.set(lensId as LensId, meta.promptHash);
    const expiresMs = Date.parse(meta.expiresAt);
    if (Number.isFinite(expiresMs)) {
      perLensExpiresAt.set(lensId as LensId, expiresMs);
    }
  }

  const cachedResults = new Map<LensId, CachedLensEntry>();
  for (const [lensId, entry] of Object.entries(index.cachedResults)) {
    cachedResults.set(lensId as LensId, {
      findings: entry.findings,
      notes: entry.notes,
    });
  }

  const perLensAttempts = new Map<LensId, number>();
  const perLensLatestOutput = new Map<LensId, LensOutput>();
  let anyTerminalTask = false;
  for (const [lensId, task] of tasks) {
    // Only count terminal attempts toward the highest-seen counter.
    // A `pending` record is the hop-1 seed (attempt 1 created before
    // any submission lands); including it would make `applyCompletion`
    // reject the matching first submission as stale.
    if (task.status === "pending" || task.status === "in_flight") {
      continue;
    }
    anyTerminalTask = true;
    perLensAttempts.set(lensId as LensId, task.attempt);
    if (task.lensOutput !== null) {
      perLensLatestOutput.set(lensId as LensId, task.lensOutput);
    }
  }

  // Status derivation: if no terminal tasks exist, we're still in
  // `started`. If terminal tasks exist but the review directory still
  // has pending tasks that outnumber the terminal set, we're in
  // `awaiting_retry`. If every expected lens has a terminal task at
  // max-attempts or is cached, we're `complete`. Conservative rule:
  // surface `awaiting_retry` whenever there is ANY terminal submission
  // so the caller cannot re-submit attempt 1 as if it were fresh. The
  // definitive `complete` transition is owned by `applyCompletion`
  // when the next submission lands and is finalized.
  const status: ReviewStatus = anyTerminalTask ? "awaiting_retry" : "started";

  const startedAtMs = Date.parse(index.createdAt);

  return {
    reviewId: index.reviewId,
    sessionId: index.sessionId,
    stage: index.stage,
    expectedLensIds: index.expectedLensIds as LensId[],
    reviewRound: index.reviewRound,
    priorDeferrals: index.priorDeferrals,
    startedAt: Number.isFinite(startedAtMs) ? startedAtMs : Date.now(),
    status,
    cachedResults,
    promptHashes,
    prompts,
    perLensExpiresAt,
    perLensAttempts,
    perLensLatestOutput,
  };
}

export interface SubmittedResult {
  readonly lensId: LensId;
  readonly output: LensOutput;
  readonly attempt: number;
}

export function applyCompletion(params: {
  readonly reviewId: string;
  readonly results: readonly SubmittedResult[];
  readonly finalize: boolean;
  readonly now?: number;
}): ApplyCompletionResult {
  const session = getReview(params.reviewId);
  if (!session) {
    return {
      ok: false,
      code: "unknown",
      message: `review state: unknown reviewId: ${params.reviewId}`,
    };
  }
  if (session.status === "complete") {
    return {
      ok: false,
      code: "already_complete",
      message: `review state: reviewId already completed: ${params.reviewId}`,
    };
  }

  const now = params.now ?? Date.now();

  const nextAttempts = new Map(session.perLensAttempts);
  for (const r of params.results) {
    const highestSeen = session.perLensAttempts.get(r.lensId) ?? 0;
    if (r.attempt <= highestSeen) {
      return {
        ok: false,
        code: "stale_attempt",
        message: `review state: stale attempt ${r.attempt} for lens '${r.lensId}' (highest seen: ${highestSeen})`,
        lensId: r.lensId,
        highestSeen,
        submittedAttempt: r.attempt,
      };
    }
    if (r.attempt !== highestSeen + 1) {
      return {
        ok: false,
        code: "non_contiguous_attempt",
        message: `review state: non-contiguous attempt for lens '${r.lensId}' (expected ${highestSeen + 1}, got ${r.attempt})`,
        lensId: r.lensId,
        expected: highestSeen + 1,
        submittedAttempt: r.attempt,
      };
    }
    const expires = session.perLensExpiresAt.get(r.lensId);
    if (expires !== undefined && now > expires) {
      return {
        ok: false,
        code: "review_expired",
        message: `review state: REVIEW_EXPIRED for lens '${r.lensId}' (expired at ${new Date(expires).toISOString()})`,
        lensId: r.lensId,
        expiresAt: expires,
      };
    }
    nextAttempts.set(r.lensId, r.attempt);
  }

  if (session.status === "started") {
    const provided = new Set<string>(params.results.map((r) => r.lensId));
    for (const lensId of session.cachedResults.keys()) provided.add(lensId);
    const missing = session.expectedLensIds.filter(
      (id) => !provided.has(id),
    );
    if (missing.length > 0) {
      return {
        ok: false,
        code: "missing_lenses",
        message: `review state: submission missing ${missing.length} expected lens result(s): ${missing.join(", ")}`,
        missing,
      };
    }
  }

  // Finalize-time union coverage (ISS-006). Once we are about to mark
  // the session `complete`, every expected lens must have a contribution
  // somewhere: in the current submission, in a prior submission
  // (`perLensLatestOutput`), or cached. Without this guard a post-
  // restart session rehydrated as `awaiting_retry` with partial disk
  // state could ship a verdict on an incomplete lens set.
  if (params.finalize) {
    const covered = new Set<string>();
    for (const r of params.results) covered.add(r.lensId);
    for (const lensId of session.perLensLatestOutput.keys()) {
      covered.add(lensId);
    }
    for (const lensId of session.cachedResults.keys()) covered.add(lensId);
    const missing = session.expectedLensIds.filter(
      (id) => !covered.has(id),
    );
    if (missing.length > 0) {
      return {
        ok: false,
        code: "missing_lenses",
        message: `review state: finalize missing ${missing.length} expected lens result(s) across submission + prior outputs + cache: ${missing.join(", ")}`,
        missing,
      };
    }
  }

  const nextOutputs = new Map(session.perLensLatestOutput);
  for (const r of params.results) nextOutputs.set(r.lensId, r.output);

  const nextStatus: ReviewStatus = params.finalize ? "complete" : "awaiting_retry";
  const next: ReviewSession = {
    ...session,
    status: nextStatus,
    perLensAttempts: nextAttempts,
    perLensLatestOutput: nextOutputs,
  };
  touchLru(session.reviewId, next);
  return { ok: true, session: next };
}

/**
 * RULES.md §4 peer to `persistRoundBestEffort` and
 * `persistLensCacheBestEffort`: write the updated task records for each
 * accepted submission. Runs AFTER the outer try/catch in
 * `handleLensReviewComplete` closes, so a disk-write error here can
 * never flip `isError: true`.
 */
export function persistInFlightBestEffort(
  session: ReviewSession,
  submissions: readonly SubmittedResult[],
): void {
  try {
    for (const s of submissions) {
      try {
        const promptHash = session.promptHashes.get(s.lensId);
        const expiresMs = session.perLensExpiresAt.get(s.lensId);
        if (promptHash === undefined || expiresMs === undefined) continue;
        const status: TaskRecord["status"] =
          s.output.status === "ok" ? "completed" : "failed";
        // Distinguish parse-failure placeholders (synthesized by
        // `complete.ts` when `LensOutputSchema.safeParse` rejects the
        // envelope / a finding) from legitimate agent-reported
        // `status: "error"` payloads. The placeholder path always
        // prefixes `error` with "parse failure"; anything else is
        // classified as `UNKNOWN_ERROR` until a future ticket wires a
        // richer control-plane code through the submission path.
        const errorCode: LensErrorCode | null =
          s.output.status === "ok"
            ? null
            : s.output.error !== null && s.output.error.startsWith("parse failure")
              ? "PARSE_FAILURE"
              : "UNKNOWN_ERROR";
        const nowIso = new Date().toISOString();
        const record: TaskRecord = {
          schemaVersion: CURRENT_IN_FLIGHT_SCHEMA_VERSION,
          taskId: taskId(session.reviewId, s.lensId, s.attempt),
          reviewId: session.reviewId,
          lensId: s.lensId,
          attempt: s.attempt,
          status,
          promptHash,
          chunkIndex: null,
          startedAt: nowIso,
          completedAt: nowIso,
          expiresAt: new Date(expiresMs).toISOString(),
          errorCode,
          lensOutput: s.output,
        };
        writeTask(record);
      } catch (err) {
        logSwallow(`writeTask(${s.lensId}, ${s.attempt})`, err);
      }
    }
  } catch (err) {
    logSwallow("persistInFlightBestEffort", err);
  }
}

/**
 * @internal Test-only reset. Clears the in-process Map AND the
 * on-disk in-flight directory so per-test `LENSES_IN_FLIGHT_DIR`
 * isolation actually holds between cases.
 */
export function _resetForTests(): void {
  sessions.clear();
  try {
    rmSync(inFlightDir(), { recursive: true, force: true });
  } catch (err) {
    // Test-only: log so a pollutted test environment produces a warning
    // trail rather than silent cross-case contamination. Matches the
    // "log then swallow" pattern used by the other best-effort helpers.
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`review-state: _resetForTests rmSync failed: ${message}`);
  }
}

/**
 * @internal Test-only: clear ONLY the in-memory Map, preserving the
 * on-disk in-flight directory. Used by T-024 rehydration tests that
 * simulate a server restart (memory gone, disk intact).
 */
export function _clearMapOnlyForTests(): void {
  sessions.clear();
}
