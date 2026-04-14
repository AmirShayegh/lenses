/**
 * In-memory state machine for the two-hop lens review flow. Tracks each
 * review by its `reviewId` so that `lens_review_complete` (T-009) can
 * enforce: (1) the reviewId came from a real `lens_review_start`, (2) the
 * agent returned a result for every expected lens, (3) the same reviewId
 * is never completed twice. Schema validation of per-lens payloads is
 * Zod's responsibility in T-009 -- this module tracks identity, not
 * content.
 *
 * Storage is a process-local `Map`. T-014 (session cache) will layer
 * disk-backed storage + TTL on top later; keeping this synchronous and
 * in-memory now means the callers stay simple and T-014 can swap the
 * backing behind the same surface.
 */

import type { LensId } from "../lenses/prompts/index.js";
import type { Stage } from "../schema/index.js";

export type ReviewStatus = "started" | "complete";

/**
 * A single in-flight review session. Every field is `readonly` so the
 * whole record acts as an immutable value -- state transitions REPLACE
 * the Map entry via spread (`{ ...session, status: "complete" }`), they
 * never mutate in place. References handed out by a prior `getReview`
 * call therefore keep observing the state that was current at lookup
 * time, which is the contract the test suite pins.
 */
export interface ReviewSession {
  readonly reviewId: string;
  readonly stage: Stage;
  readonly expectedLensIds: readonly LensId[];
  readonly startedAt: number;
  readonly status: ReviewStatus;
}

/**
 * Result of `validateAndComplete`. Fully discriminated on `code` so
 * `exactOptionalPropertyTypes` callers can read `missing` directly after
 * narrowing to `"missing_lenses"` without `?? []` boilerplate.
 */
export type CompleteValidationResult =
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
    };

const sessions = new Map<string, ReviewSession>();

/**
 * Record a fresh session after `lens_review_start` built prompts. Throws
 * on a duplicate `reviewId` -- with `crypto.randomUUID()` a collision is
 * a programmer error, not an expected condition. The throw propagates
 * into `buildResponse`, where the existing outer try/catch in
 * `handleLensReviewStart` converts it into an MCP isError response.
 */
export function registerReview(params: {
  readonly reviewId: string;
  readonly stage: Stage;
  readonly expectedLensIds: readonly LensId[];
}): void {
  if (sessions.has(params.reviewId)) {
    throw new Error(
      `review state: reviewId already registered: ${params.reviewId}`,
    );
  }
  sessions.set(params.reviewId, {
    reviewId: params.reviewId,
    stage: params.stage,
    expectedLensIds: params.expectedLensIds,
    startedAt: Date.now(),
    status: "started",
  });
}

/** Look up without mutation. Undefined means "never registered or
 * already evicted" -- this module doesn't evict, so for T-020 the only
 * reason is "never registered". */
export function getReview(reviewId: string): ReviewSession | undefined {
  return sessions.get(reviewId);
}

/**
 * Validate a `lens_review_complete` submission and, on success, atomically
 * transition `started → complete`. Returns a discriminated union so T-009
 * can `switch (v.code)` exhaustively instead of parsing a string message.
 *
 * Extra lens ids beyond `expectedLensIds` are ignored here -- T-009's
 * Zod pass owns unknown-id rejection, and reporting the same mistake
 * from two layers would produce noisy overlapping errors.
 */
export function validateAndComplete(params: {
  readonly reviewId: string;
  readonly providedLensIds: readonly LensId[];
}): CompleteValidationResult {
  const session = sessions.get(params.reviewId);
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
  const provided = new Set<string>(params.providedLensIds);
  const missing = session.expectedLensIds.filter((id) => !provided.has(id));
  if (missing.length > 0) {
    return {
      ok: false,
      code: "missing_lenses",
      message: `review state: submission missing ${missing.length} expected lens result(s): ${missing.join(", ")}`,
      missing,
    };
  }
  const next: ReviewSession = { ...session, status: "complete" };
  sessions.set(session.reviewId, next);
  return { ok: true, session: next };
}

/**
 * @internal Test-only reset. Imported directly by test files; NOT
 * re-exported from the package barrel so production code cannot reach it.
 */
export function _resetForTests(): void {
  sessions.clear();
}
