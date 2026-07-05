import { describe, expect, it } from "vitest";

import {
  LENS_ERROR_MESSAGES,
  LensErrorCodeSchema,
  type LensErrorCode,
} from "../src/schema/error-code.js";

/**
 * T-024: bidirectional exhaustiveness guard over `LensErrorCode`.
 * Matches the pattern T-021 established for `LensId` in
 * `test/public-api.test.ts`: `satisfies readonly X[]` catches removals
 * but not additions; a `Record<X, true>` map catches both. Adding a new
 * enum value without updating this map is a COMPILE error. Removing a
 * value without updating this map is also a compile error ("excess
 * property").
 */
const _exhaustive: Record<LensErrorCode, true> = {
  PARSE_FAILURE: true,
  DUPLICATE_COMPLETE: true,
  REVIEW_EXPIRED: true,
  REVIEW_CANCELLED: true,
  PARTIAL_RESULTS: true,
  MERGE_CONFLICT: true,
  CONFIG_MISMATCH: true,
  AGENT_TIMEOUT: true,
  // T-027 (pen resolution 6): durable-completion write failure on a
  // finalizing call.
  PERSISTENCE_FAILED: true,
  UNKNOWN_ERROR: true,
} satisfies Record<LensErrorCode, true>;

describe("LensErrorCodeSchema", () => {
  it("accepts every documented enum value", () => {
    const codes: readonly LensErrorCode[] = Object.keys(
      _exhaustive,
    ) as LensErrorCode[];
    for (const c of codes) {
      expect(LensErrorCodeSchema.safeParse(c).success).toBe(true);
    }
  });

  it("rejects strings that are not in the enum", () => {
    expect(LensErrorCodeSchema.safeParse("FAKE_CODE").success).toBe(false);
    expect(LensErrorCodeSchema.safeParse("").success).toBe(false);
  });
});

describe("LENS_ERROR_MESSAGES", () => {
  it("has a non-empty message for every LensErrorCode", () => {
    const codes: readonly LensErrorCode[] = Object.keys(
      _exhaustive,
    ) as LensErrorCode[];
    for (const c of codes) {
      const msg = LENS_ERROR_MESSAGES[c];
      expect(typeof msg).toBe("string");
      expect(msg.length).toBeGreaterThan(0);
    }
  });

  it("has no leftover keys that do not correspond to LensErrorCode values", () => {
    const messageKeys = Object.keys(LENS_ERROR_MESSAGES);
    for (const key of messageKeys) {
      expect(LensErrorCodeSchema.safeParse(key).success).toBe(true);
    }
  });

  // T-027 R6: neutral wording that does not claim the code is
  // unproduced (T-032 scope item 4 will produce it again for the 24h
  // in-flight TTL path).
  it("pins the R6 REVIEW_EXPIRED wording", () => {
    expect(LENS_ERROR_MESSAGES.REVIEW_EXPIRED).toBe(
      "The review's retained state expired; start a fresh review round.",
    );
  });
});
