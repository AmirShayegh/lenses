/**
 * T-024 typed control-plane error codes. Persisted on failed / expired
 * task records so a disk-hydrated session surfaces WHY a prior attempt
 * ended up in a terminal state, without smuggling that classification
 * through free-form strings.
 *
 * Control-plane, not model-plane: lenses never calls an LLM directly,
 * so these codes classify MCP-server-observable states (a malformed
 * payload, a duplicate submission, an expired deadline) rather than
 * LLM-generation failure modes. Codex-bridge's error taxonomy is the
 * inspiration; the codes here are narrower because lenses outsources
 * generation to the caller's subagents.
 */

import { z } from "zod";

export const LensErrorCodeSchema = z.enum([
  "PARSE_FAILURE",
  "DUPLICATE_COMPLETE",
  "REVIEW_EXPIRED",
  "REVIEW_CANCELLED",
  "PARTIAL_RESULTS",
  "MERGE_CONFLICT",
  "CONFIG_MISMATCH",
  "AGENT_TIMEOUT",
  "PERSISTENCE_FAILED",
  "UNKNOWN_ERROR",
]);
export type LensErrorCode = z.infer<typeof LensErrorCodeSchema>;

/**
 * Exhaustive human-readable messages keyed by `LensErrorCode`. Declared
 * with a literal `Record<LensErrorCode, string>` annotation so adding a
 * new enum value without updating this map is a compile error. A test
 * in `test/error-code.test.ts` additionally pins the bidirectional
 * relationship: every key here is a valid `LensErrorCode`, and every
 * `LensErrorCode` has a non-empty message.
 */
export const LENS_ERROR_MESSAGES: Record<LensErrorCode, string> = {
  PARSE_FAILURE:
    "Lens payload failed validation. See parseErrors[] for the exact Zod issues.",
  DUPLICATE_COMPLETE:
    "A submission with the same (reviewId, lensId, attempt) was already accepted.",
  REVIEW_EXPIRED:
    "The review's retained state expired; start a fresh review round.",
  REVIEW_CANCELLED: "The caller cancelled the review round.",
  PARTIAL_RESULTS:
    "One or more lenses timed out; the verdict is derived from the survivors.",
  MERGE_CONFLICT:
    "Two completions for this review have incompatible state. The stored record was preserved.",
  CONFIG_MISMATCH:
    "mergerConfig changed between submissions for the same reviewId; cached state was invalidated.",
  AGENT_TIMEOUT:
    "Lens exceeded its expiresAt without returning. Treat as a failed attempt.",
  PERSISTENCE_FAILED:
    "The durable completion write failed; the review is still open. Retry the finalizing call once the disk is healthy.",
  UNKNOWN_ERROR:
    "An unexpected error occurred while processing the submission.",
};
