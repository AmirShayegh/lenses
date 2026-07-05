/**
 * In-memory + disk-backed state machine for the two-hop+ lens review
 * flow. The `sessions` Map is a bounded LRU READ-CACHE on top of the
 * in-flight disk store (`src/cache/in-flight.ts`). Disk is the source
 * of truth. Eviction from the Map is not data loss -- the next
 * `getReview` rehydrates from disk.
 *
 * Structural discipline (RULES.md §4): disk IO lives in best-effort
 * helpers that NEVER propagate errors out of the state module, with
 * ONE deliberate T-027 exception: `commitReviewCompletion`'s durable
 * completion write throws `PersistenceFailedError` on IO failure so a
 * finalizing call can honestly report PERSISTENCE_FAILED instead of
 * flipping to `complete` on state that never landed.
 *
 * T-027 concurrency contract (pen resolution 1): `applyCompletion` and
 * `commitReviewCompletion` do NOT acquire the review-state lock
 * internally. The tool layer (`complete.ts`) acquires
 * `withReviewStateLock` exactly once around the whole finalization
 * transaction (disposition planning through completion commit). Direct
 * API callers running concurrent processes against a shared in-flight
 * store must do the same.
 */

import {
  rmSync,
} from "node:fs";

import {
  hasIndexFile,
  inFlightDir,
  readAllTasks,
  readCompletion,
  readIndex,
  readPrompt,
  readTask,
  taskId,
  updateIndexLensMeta,
  writeCompletion,
  writeIndex,
  writePrompt,
  writeTask,
  _clearFailureHooksForTests,
  type IndexRecord,
  type TaskRecord,
  CURRENT_IN_FLIGHT_SCHEMA_VERSION,
} from "../cache/in-flight.js";
import { resolveLensTimeoutMs } from "../lenses/registry.js";
import type { LensId } from "../lenses/prompts/index.js";
import { ReviewVerdictSchema } from "../schema/index.js";
import type {
  DeferralKey,
  LensCoverageEntry,
  LensErrorCode,
  LensFinding,
  LensOutput,
  ReviewVerdict,
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
  /** T-027: per-lens timeout budget (drives anchor + retry minting). */
  readonly perLensTimeoutMs: ReadonlyMap<LensId, number>;
  /** T-027: lenses terminally expired (AGENT_TIMEOUT). */
  readonly perLensExpired: ReadonlySet<LensId>;
  /** T-027: the durably committed verdict, when status is complete. */
  readonly completedVerdict: ReviewVerdict | null;
  readonly completedAtMs: number | null;
}

/**
 * T-027 R-D2: the per-call disposition computed by `planCompletion`
 * and committed by `applyCompletion`. The tool layer derives
 * parseErrors[], retry-candidate filtering, and ignoredLensIds
 * exclusively from this object.
 */
export interface CompletionDisposition {
  /** Results accepted this call (stored into perLensLatestOutput). */
  readonly accepted: readonly SubmittedResult[];
  /** R-B3: submitted lens ids not in expectedLensIds (dropped). */
  readonly ignoredLensIds: readonly LensId[];
  /** Lenses newly diverted/swept to expired this call (R1 rule 3 + R9). */
  readonly newlyExpiredLensIds: readonly LensId[];
  /** Submissions for lenses ALREADY expired (R1 rule 1: silent divert). */
  readonly alreadyExpiredLensIds: readonly LensId[];
  /** R1 rule 4: past-deadline results for ok-covered lenses (ignored). */
  readonly pastDeadlineIgnoredLensIds: readonly LensId[];
  /** The attempt counters as they will be committed. */
  readonly nextAttempts: ReadonlyMap<LensId, number>;
  /** The expired set as it will be committed. */
  readonly expiredLensIds: ReadonlySet<LensId>;
  /** R14(a): union coverage over accepted + prior + cached + expired. */
  readonly unionCovered: boolean;
  /** Expected lenses still uncovered by the union above. */
  readonly missing: readonly LensId[];
}

export type ApplyCompletionResult =
  | {
      readonly ok: true;
      readonly session: ReviewSession;
      readonly disposition: CompletionDisposition;
    }
  | {
      readonly ok: false;
      readonly code: "unknown";
      readonly message: string;
    }
  | {
      readonly ok: false;
      readonly code: "already_complete";
      readonly message: string;
      readonly storedVerdict?: ReviewVerdict;
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
    };

export type CompletionPlan =
  | ({ readonly ok: true } & CompletionDisposition)
  | Extract<
      ApplyCompletionResult,
      { code: "stale_attempt" } | { code: "non_contiguous_attempt" }
    >;

/**
 * T-027 (pen resolution 6): thrown by `commitReviewCompletion` when the
 * durable completion write fails. The tool layer maps this onto the
 * PERSISTENCE_FAILED error envelope; the session stays awaiting_retry
 * and the finalizing call can simply be retried.
 */
export class PersistenceFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersistenceFailedError";
  }
}

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
 *
 * T-027 R14(g): the internal `review_expired` variant is gone (expiry
 * is a per-lens disposition now, not a call rejection); the wire
 * REVIEW_EXPIRED enum value itself stays (backward-compatible schemas
 * rule; T-032 re-produces it for the in-flight TTL path).
 */
export function rejectionToLensErrorCode(
  code: Exclude<ApplyCompletionResult, { ok: true }>["code"],
): LensErrorCode {
  switch (code) {
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

/**
 * T-027 R5: in-memory per-process anchored set, keyed by
 * `reviewId:lensId`. Repeated get_prompt calls never re-anchor within
 * the process even if disk reads misbehave. Cleared by both test
 * resets: a real restart clears process memory too.
 */
const anchoredLenses = new Set<string>();

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
 *
 * T-027 R-D7: `perLensTimeoutMs` is OPTIONAL. When omitted, each
 * lens's timeout derives via `resolveLensTimeoutMs(model, undefined)`
 * from `lensModels`, the same fallback hydration applies to pre-T-027
 * index files.
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
  readonly perLensTimeoutMs?: ReadonlyMap<LensId, number>;
}): void {
  if (sessions.has(params.reviewId)) {
    throw new Error(
      `review state: reviewId already registered: ${params.reviewId}`,
    );
  }
  const perLensTimeoutMs = new Map<LensId, number>();
  if (params.perLensTimeoutMs !== undefined) {
    for (const [lensId, ms] of params.perLensTimeoutMs) {
      perLensTimeoutMs.set(lensId, ms);
    }
  } else if (params.lensModels !== undefined) {
    for (const [lensId, model] of params.lensModels) {
      perLensTimeoutMs.set(lensId, resolveLensTimeoutMs(model, undefined));
    }
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
    perLensTimeoutMs,
    perLensExpired: new Set(),
    completedVerdict: null,
    completedAtMs: null,
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
      const timeoutMs = session.perLensTimeoutMs.get(lensId);
      lensMeta[lensId] = {
        model,
        promptHash,
        expiresAt: new Date(expiresMs).toISOString(),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
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
  const completion = readCompletion(reviewId);

  const prompts = new Map<LensId, string>();
  const promptHashes = new Map<LensId, string>();
  const perLensExpiresAt = new Map<LensId, number>();
  const perLensTimeoutMs = new Map<LensId, number>();
  for (const [lensId, meta] of Object.entries(index.lensMeta)) {
    const p = readPrompt(reviewId, lensId);
    if (p !== undefined) prompts.set(lensId as LensId, p);
    promptHashes.set(lensId as LensId, meta.promptHash);
    const expiresMs = Date.parse(meta.expiresAt);
    if (Number.isFinite(expiresMs)) {
      perLensExpiresAt.set(lensId as LensId, expiresMs);
    }
    // T-027 R14(h): pre-T-027 index files have no timeoutMs; fall back
    // to the model default.
    perLensTimeoutMs.set(
      lensId as LensId,
      meta.timeoutMs ?? resolveLensTimeoutMs(meta.model, undefined),
    );
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
  const perLensExpired = new Set<LensId>();
  let anyTerminalTask = false;
  for (const [lensId, task] of tasks) {
    // Only count terminal attempts toward the highest-seen counter.
    // A `pending` record is the hop-1 seed (attempt 1 created before
    // any submission lands); an `in_flight` record is the prompt-fetch
    // anchor marker (T-027 R5). Including either would make
    // `applyCompletion` reject the matching first submission as stale.
    if (task.status === "pending" || task.status === "in_flight") {
      continue;
    }
    anyTerminalTask = true;
    perLensAttempts.set(lensId as LensId, task.attempt);
    if (task.status === "expired") {
      perLensExpired.add(lensId as LensId);
    } else if (task.lensOutput !== null) {
      perLensLatestOutput.set(lensId as LensId, task.lensOutput);
    }
  }

  // T-027 R-B1 (ratified alternative branch): reconcile a persisted
  // pendingAttempt N with a missing terminal attempt N-1, so an
  // in-window retry submission after a restart is never rejected as
  // non-contiguous just because the terminal task write was lost.
  for (const [lensId, meta] of Object.entries(index.lensMeta)) {
    if (meta.pendingAttempt === undefined) continue;
    const current = perLensAttempts.get(lensId as LensId) ?? 0;
    const reconciled = Math.max(current, meta.pendingAttempt - 1);
    if (reconciled > 0) perLensAttempts.set(lensId as LensId, reconciled);
  }

  // Status derivation: a durable completion record wins outright
  // (T-027: `commitReviewCompletion` owns the complete transition).
  // Otherwise: no terminal tasks -> `started`; any terminal submission
  // -> `awaiting_retry` (conservative: the caller cannot re-submit
  // attempt 1 as if it were fresh).
  const status: ReviewStatus =
    completion !== undefined
      ? "complete"
      : anyTerminalTask
        ? "awaiting_retry"
        : "started";

  const startedAtMs = Date.parse(index.createdAt);
  const completedAtMs =
    completion !== undefined ? Date.parse(completion.completedAt) : Number.NaN;

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
    perLensTimeoutMs,
    perLensExpired,
    completedVerdict: completion !== undefined ? completion.verdict : null,
    completedAtMs: Number.isFinite(completedAtMs) ? completedAtMs : null,
  };
}

export interface SubmittedResult {
  readonly lensId: LensId;
  readonly output: LensOutput;
  readonly attempt: number;
}

/**
 * T-027 R-D2: the SINGLE source for raw-result disposition. Pure with
 * respect to the session (no mutation); `applyCompletion` commits the
 * returned plan. Direct API callers observe behavior identical to the
 * wire path for valid-but-unactivated lenses.
 *
 * Per-result disposition order (R1, binding):
 *  (0) R-B3: a lensId outside session.expectedLensIds is DROPPED into
 *      `ignoredLensIds` before any attempt/deadline handling, so an
 *      unactivated lens can never influence findings, hadAnyFindings,
 *      retries, or coverage. (Duplicate lensIds within one call are
 *      rejected at the wire boundary by CompleteParamsSchema; direct
 *      callers must not pass duplicates.)
 *  (1) a result for a lens already in perLensExpired is silently
 *      diverted: output dropped, attempts untouched, coverage stays
 *      "expired", no parse error (R4).
 *  (2) a result failing the acceptance test (attempt === highestSeen+1)
 *      falls through to the stale_attempt / non_contiguous_attempt
 *      whole-batch rejection exactly as before T-027, and is NEVER
 *      diverted to expired (stale-over-expiry tiebreaker).
 *  (3) a would-be-accepted result past its lens deadline is diverted
 *      to newly-expired (attempt = highestSeen + 1, output NOT stored).
 *  (4) a past-deadline result for a lens already covered by an ok
 *      latest output must NEVER transition that lens to expired,
 *      regardless of attempt number: it is ignored (not stored) and
 *      the lens's coverage stays "ok".
 *
 * A lens with NO registered deadline never expires and is never swept
 * (HEAD parity, pen resolution 9).
 *
 * R9: an eager expiry sweep runs on EVERY call (including empty polls)
 * BEFORE the finalize union check: every expected lens that is not
 * cached, not already expired, has no latest output, no accepted
 * submission in this call, and whose deadline has passed joins the
 * expired set.
 */
export function planCompletion(
  session: ReviewSession,
  results: readonly SubmittedResult[],
  now: number,
): CompletionPlan {
  const nextAttempts = new Map(session.perLensAttempts);
  const expired = new Set(session.perLensExpired);
  const accepted: SubmittedResult[] = [];
  const ignoredLensIds: LensId[] = [];
  const newlyExpiredLensIds: LensId[] = [];
  const alreadyExpiredLensIds: LensId[] = [];
  const pastDeadlineIgnoredLensIds: LensId[] = [];

  for (const r of results) {
    // (0) R-B3 unexpected-lens drop.
    if (!session.expectedLensIds.includes(r.lensId)) {
      ignoredLensIds.push(r.lensId);
      continue;
    }
    // (1) already expired: silent divert.
    if (expired.has(r.lensId)) {
      alreadyExpiredLensIds.push(r.lensId);
      continue;
    }
    // (2) attempt monotonicity, exactly as at HEAD; fires BEFORE any
    // expiry diversion.
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
    // (3)/(4) deadline handling. An undefined deadline never expires
    // (pen resolution 9, HEAD parity).
    const deadline = session.perLensExpiresAt.get(r.lensId);
    if (deadline !== undefined && now > deadline) {
      const hasOk =
        session.perLensLatestOutput.get(r.lensId)?.status === "ok";
      if (hasOk) {
        // (4) ok-covered lens: ignore, coverage stays "ok".
        pastDeadlineIgnoredLensIds.push(r.lensId);
        continue;
      }
      // (3) divert to newly-expired.
      expired.add(r.lensId);
      newlyExpiredLensIds.push(r.lensId);
      nextAttempts.set(r.lensId, highestSeen + 1);
      continue;
    }
    accepted.push(r);
    nextAttempts.set(r.lensId, r.attempt);
  }

  // R9 eager sweep. NOTE: a lens with no entry in perLensExpiresAt has
  // no registered deadline, never expires, and is never swept -- HEAD
  // parity per pen resolution 9.
  const acceptedIds = new Set(accepted.map((r) => r.lensId));
  for (const lensId of session.expectedLensIds) {
    if (session.cachedResults.has(lensId)) continue;
    if (expired.has(lensId)) continue;
    if (session.perLensLatestOutput.has(lensId)) continue;
    if (acceptedIds.has(lensId)) continue;
    const deadline = session.perLensExpiresAt.get(lensId);
    if (deadline === undefined) continue; // no deadline: never swept
    if (now > deadline) {
      expired.add(lensId);
      newlyExpiredLensIds.push(lensId);
      nextAttempts.set(lensId, (session.perLensAttempts.get(lensId) ?? 0) + 1);
    }
  }

  // R14(a) union coverage: accepted + prior outputs + cached + expired.
  const covered = new Set<string>(acceptedIds);
  for (const lensId of session.perLensLatestOutput.keys()) covered.add(lensId);
  for (const lensId of session.cachedResults.keys()) covered.add(lensId);
  for (const lensId of expired) covered.add(lensId);
  const missing = session.expectedLensIds.filter((id) => !covered.has(id));

  return {
    ok: true,
    accepted,
    ignoredLensIds,
    newlyExpiredLensIds,
    alreadyExpiredLensIds,
    pastDeadlineIgnoredLensIds,
    nextAttempts,
    expiredLensIds: expired,
    unionCovered: missing.length === 0,
    missing,
  };
}

/**
 * Commit a completion call's disposition to the in-memory session.
 *
 * LOCKING CONTRACT (T-027 pen resolution 1): does NOT acquire the
 * review-state lock; the caller (the tool layer, or a direct API
 * driver) must hold `withReviewStateLock(reviewId, ...)` around the
 * whole transaction when concurrent processes share the store.
 *
 * STATUS CONTRACT (T-027 pen resolution 2): the TOOL path always calls
 * this with `finalize: false` and flips to `complete` exclusively via
 * `commitReviewCompletion` AFTER the durable completion write
 * succeeds, so a throw between apply and commit leaves the session
 * awaiting_retry and re-completable. `finalize: true` is retained for
 * direct API callers as the pre-T-027 memory-only completion: it runs
 * the finalize-time union check and flips in memory WITHOUT a durable
 * completion record.
 *
 * Persistence: accepted submissions and newly expired lenses are
 * persisted internally, best-effort (RULES.md §4). The separate
 * `persistInFlightBestEffort` export stays; calling it again with the
 * same submissions is an idempotent same-content overwrite.
 */
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
      ...(session.completedVerdict !== null
        ? { storedVerdict: session.completedVerdict }
        : {}),
    };
  }

  const now = params.now ?? Date.now();
  const plan = planCompletion(session, params.results, now);
  if (!plan.ok) return plan;

  // Finalize-time union coverage (ISS-006, retained per R14a as the
  // ONLY completeness guard; the started-state gate is deleted).
  // Expired lenses count as covered; a finalize missing a non-expired
  // lens is still rejected.
  if (params.finalize && !plan.unionCovered) {
    return {
      ok: false,
      code: "missing_lenses",
      message: `review state: finalize missing ${plan.missing.length} expected lens result(s) across submission + prior outputs + cache: ${plan.missing.join(", ")}`,
      missing: plan.missing,
    };
  }

  const nextOutputs = new Map(session.perLensLatestOutput);
  for (const r of plan.accepted) nextOutputs.set(r.lensId, r.output);

  const nextStatus: ReviewStatus = params.finalize ? "complete" : "awaiting_retry";
  const next: ReviewSession = {
    ...session,
    status: nextStatus,
    perLensAttempts: new Map(plan.nextAttempts),
    perLensLatestOutput: nextOutputs,
    perLensExpired: new Set(plan.expiredLensIds),
  };
  touchLru(session.reviewId, next);

  // Internal best-effort persistence (T-027): task records for the
  // accepted submissions plus AGENT_TIMEOUT expired records for the
  // newly expired lenses. Disk failures are logged and swallowed; the
  // strict durability boundary is commitReviewCompletion, not here.
  persistInFlightBestEffort(next, plan.accepted);
  persistExpiredBestEffort(next, plan.newlyExpiredLensIds, now);

  const { ok: _ok, ...disposition } = plan;
  return { ok: true, session: next, disposition };
}

/**
 * T-027 (pen resolutions 2 + 5 + 6): the durable completion commit.
 *
 * LOCKING CONTRACT: does NOT acquire the review-state lock; the caller
 * must hold `withReviewStateLock` for the whole finalization
 * transaction.
 *
 * Validates the verdict with `ReviewVerdictSchema` immediately before
 * writing, durably writes `completedAt` plus the validated verdict,
 * and ONLY THEN flips the in-memory status to `complete`, atomically.
 * Any throw leaves the session awaiting_retry and recoverable.
 *
 * IO classification (pen resolution 6): a THROW from inFlightDir
 * resolution or the completion write is an IO failure and raises
 * `PersistenceFailedError`; "no index file exists" is the memory-only
 * path and proceeds (nothing was ever persisted for this review, so
 * there is nothing durable to extend).
 */
export function commitReviewCompletion(params: {
  readonly reviewId: string;
  readonly verdict: ReviewVerdict;
  readonly now?: number;
}): ReviewSession {
  const validated = ReviewVerdictSchema.parse(params.verdict);
  const session = getReview(params.reviewId);
  if (!session) {
    throw new Error(
      `review state: commit for unknown reviewId: ${params.reviewId}`,
    );
  }
  const nowMs = params.now ?? Date.now();

  let indexExists: boolean;
  try {
    indexExists = hasIndexFile(params.reviewId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new PersistenceFailedError(
      `review state: completion persistence failed (in-flight dir unavailable): ${message}`,
    );
  }
  if (indexExists) {
    try {
      writeCompletion({
        schemaVersion: CURRENT_IN_FLIGHT_SCHEMA_VERSION,
        reviewId: params.reviewId,
        completedAt: new Date(nowMs).toISOString(),
        verdict: validated,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new PersistenceFailedError(
        `review state: completion persistence failed: ${message}`,
      );
    }
  }

  const next: ReviewSession = {
    ...session,
    status: "complete",
    completedVerdict: validated,
    completedAtMs: nowMs,
  };
  touchLru(params.reviewId, next);
  return next;
}

/**
 * T-027 R5/R8: the prompt-fetch deadline anchor. Called by
 * `lens_review_get_prompt`; returns the AUTHORITATIVE deadline for the
 * lens (R-B2 Option A puts it on the wire).
 *
 * Anchoring is once-per-attempt and never resurrects: re-anchor only
 * when (a) the lens has no terminal attempt and its attempt-1 task
 * record is still "pending" (the pending -> in_flight flip is the
 * durable once-marker), and (b) now <= the current deadline. A fetch
 * after the deadline returns the old deadline intact (the lens is then
 * expired by the R9 sweep). Retry attempts never anchor here; the
 * retry deadline is minted exactly once in `mintRetryDeadline`.
 *
 * R5 failure order: the task-record flip is written FIRST; only if it
 * succeeds is index.lensMeta.expiresAt updated (hydration reads
 * deadlines exclusively from index.lensMeta, so a flipped record
 * without a deadline update is harmless: no durable extension
 * happened, and the flip still blocks re-anchoring). The in-memory
 * anchored set guards repeated calls within the process even when
 * disk reads misbehave.
 */
export function anchorLensDeadlineOnFetch(
  reviewId: string,
  lensId: LensId,
  now: number = Date.now(),
): number | undefined {
  const session = getReview(reviewId);
  if (!session) return undefined;
  const current = session.perLensExpiresAt.get(lensId);
  const key = `${reviewId}:${lensId}`;
  if (anchoredLenses.has(key)) {
    // Re-read: the deadline may have been re-minted by a retry.
    return getReview(reviewId)?.perLensExpiresAt.get(lensId);
  }

  // Eligibility (R8): attempt 1 only, in-window only.
  const hasTerminalAttempt = (session.perLensAttempts.get(lensId) ?? 0) > 0;
  if (hasTerminalAttempt || session.perLensExpired.has(lensId)) {
    anchoredLenses.add(key); // attempt 1 is over; never anchor again
    return current;
  }
  if (current === undefined || now > current) return current;

  let seed: TaskRecord | undefined;
  try {
    seed = readTask(reviewId, lensId, 1);
  } catch {
    seed = undefined;
  }
  if (seed === undefined) {
    // No durable once-marker is possible (registration write lost or
    // memory-only session). Anchor in memory only, guarded by the
    // process-local set.
    const timeoutOnly = session.perLensTimeoutMs.get(lensId);
    if (timeoutOnly === undefined) return current;
    const memDeadline = now + timeoutOnly;
    anchoredLenses.add(key);
    touchLru(reviewId, {
      ...session,
      perLensExpiresAt: new Map(session.perLensExpiresAt).set(
        lensId,
        memDeadline,
      ),
    });
    return memDeadline;
  }
  if (seed.status !== "pending") {
    // Already flipped by a previous process/call: the flip blocks
    // re-anchoring even across restarts.
    anchoredLenses.add(key);
    return current;
  }

  const timeoutMs =
    session.perLensTimeoutMs.get(lensId) ??
    resolveLensTimeoutMs("sonnet", undefined);
  const newDeadline = now + timeoutMs;

  // R5 order: flip the task record FIRST.
  try {
    writeTask({
      ...seed,
      status: "in_flight",
      expiresAt: new Date(newDeadline).toISOString(),
    });
  } catch (err) {
    logSwallow(`anchor flip(${lensId})`, err);
    // Flip failed: no anchor happened; a later fetch may retry.
    return current;
  }
  anchoredLenses.add(key);
  touchLru(reviewId, {
    ...session,
    perLensExpiresAt: new Map(session.perLensExpiresAt).set(
      lensId,
      newDeadline,
    ),
  });
  try {
    updateIndexLensMeta(reviewId, lensId, {
      expiresAt: new Date(newDeadline).toISOString(),
    });
  } catch (err) {
    // Harmless per R5: no durable extension happened; memory carries
    // the anchored value for this process, and the flip blocks
    // re-anchoring.
    logSwallow(`anchor index RMW(${lensId})`, err);
  }
  return newDeadline;
}

/**
 * T-027 R8: mint a fresh retry deadline at NextAction emission time
 * (replacing the pre-T-027 reuse of the hop-1 deadline). Re-anchors
 * server-side so the wire value equals the enforced value, and
 * persists via index.lensMeta read-modify-write ONLY (R7: the retry
 * path never touches task records). The pendingAttempt marker makes
 * hydration reconcile a lost terminal task write (R-B1 ratified
 * alternative branch), so the RMW itself stays best-effort.
 *
 * Returns undefined when the lens has no registered deadline (such a
 * lens never expires; there is nothing to re-anchor, HEAD parity).
 */
export function mintRetryDeadline(
  reviewId: string,
  lensId: LensId,
  now: number = Date.now(),
): number | undefined {
  const session = getReview(reviewId);
  if (!session) return undefined;
  if (!session.perLensExpiresAt.has(lensId)) return undefined;
  const timeoutMs =
    session.perLensTimeoutMs.get(lensId) ??
    resolveLensTimeoutMs("sonnet", undefined);
  const newDeadline = now + timeoutMs;
  touchLru(reviewId, {
    ...session,
    perLensExpiresAt: new Map(session.perLensExpiresAt).set(
      lensId,
      newDeadline,
    ),
  });
  const pendingAttempt = (session.perLensAttempts.get(lensId) ?? 0) + 1;
  try {
    updateIndexLensMeta(reviewId, lensId, {
      expiresAt: new Date(newDeadline).toISOString(),
      pendingAttempt,
    });
  } catch (err) {
    logSwallow(`retry mint index RMW(${lensId})`, err);
  }
  return newDeadline;
}

/**
 * T-027: build the per-lens coverage disclosure for the verdict
 * envelope. One entry per expected lens; status precedence per R14(e):
 * expired -> ok -> parse_failed -> error -> cached -> skipped. With
 * the R1 disposition order this can never mislabel a contributing
 * lens.
 */
export function buildLensCoverage(
  session: ReviewSession,
): LensCoverageEntry[] {
  const out: LensCoverageEntry[] = [];
  for (const lensId of session.expectedLensIds) {
    const attempts = session.perLensAttempts.get(lensId) ?? 0;
    if (session.perLensExpired.has(lensId)) {
      out.push({ lensId, status: "expired", attempts, contributedFindings: 0 });
      continue;
    }
    const latest = session.perLensLatestOutput.get(lensId);
    if (latest !== undefined) {
      if (latest.status === "ok") {
        out.push({
          lensId,
          status: "ok",
          attempts,
          contributedFindings: latest.findings.length,
        });
      } else if (
        latest.error !== null &&
        latest.error.startsWith("parse failure")
      ) {
        out.push({
          lensId,
          status: "parse_failed",
          attempts,
          contributedFindings: 0,
        });
      } else {
        out.push({ lensId, status: "error", attempts, contributedFindings: 0 });
      }
      continue;
    }
    const cached = session.cachedResults.get(lensId);
    if (cached !== undefined) {
      out.push({
        lensId,
        status: "cached",
        attempts,
        contributedFindings: cached.findings.length,
      });
      continue;
    }
    out.push({ lensId, status: "skipped", attempts, contributedFindings: 0 });
  }
  return out;
}

/**
 * RULES.md §4 peer to `persistRoundBestEffort` and
 * `persistLensCacheBestEffort`: write the updated task records for each
 * accepted submission. T-027: `applyCompletion` calls this internally;
 * the export stays, and an external re-call with the same submissions
 * is an idempotent same-content overwrite.
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
 * T-027 R9: persist AGENT_TIMEOUT expired task records for lenses the
 * disposition expired this call.
 *
 * WRITER INVARIANT (R2): NO code path may write a task record with
 * status "expired" for a lens whose latest accepted output is "ok".
 * The R1 disposition order removes the only producer of that geometry;
 * this writer additionally SKIPS (with a best-effort log) any such
 * lens, defense-in-depth against a future caller regression.
 */
export function persistExpiredBestEffort(
  session: ReviewSession,
  lensIds: readonly LensId[],
  now: number,
): void {
  try {
    for (const lensId of lensIds) {
      try {
        if (session.perLensLatestOutput.get(lensId)?.status === "ok") {
          console.error(
            `review-state: refusing to write expired record for ok-covered lens '${lensId}' (R2 writer invariant)`,
          );
          continue;
        }
        const promptHash = session.promptHashes.get(lensId);
        const expiresMs = session.perLensExpiresAt.get(lensId);
        if (promptHash === undefined || expiresMs === undefined) continue;
        const attempt = session.perLensAttempts.get(lensId) ?? 1;
        const nowIso = new Date(now).toISOString();
        writeTask({
          schemaVersion: CURRENT_IN_FLIGHT_SCHEMA_VERSION,
          taskId: taskId(session.reviewId, lensId, attempt),
          reviewId: session.reviewId,
          lensId,
          attempt,
          status: "expired",
          promptHash,
          chunkIndex: null,
          startedAt: nowIso,
          completedAt: nowIso,
          expiresAt: new Date(expiresMs).toISOString(),
          errorCode: "AGENT_TIMEOUT",
          lensOutput: null,
        });
      } catch (err) {
        logSwallow(`writeTask expired(${lensId})`, err);
      }
    }
  } catch (err) {
    logSwallow("persistExpiredBestEffort", err);
  }
}

/**
 * @internal Test-only reset. Clears the in-process Map, the anchored
 * set, every pending in-flight failure hook (R-D6: hook clearing runs
 * in this same test-reset path), AND the on-disk in-flight directory
 * so per-test `LENSES_IN_FLIGHT_DIR` isolation actually holds between
 * cases.
 */
export function _resetForTests(): void {
  sessions.clear();
  anchoredLenses.clear();
  _clearFailureHooksForTests();
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
 * @internal Test-only: clear ONLY the in-memory Map (and the equally
 * process-local anchored set), preserving the on-disk in-flight
 * directory. Used by T-024 rehydration tests that simulate a server
 * restart (memory gone, disk intact).
 */
export function _clearMapOnlyForTests(): void {
  sessions.clear();
  anchoredLenses.clear();
}
