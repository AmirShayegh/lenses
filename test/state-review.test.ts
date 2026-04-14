import { beforeEach, describe, expect, it } from "vitest";

import type { LensId } from "../src/lenses/prompts/index.js";
import {
  _resetForTests,
  getReview,
  registerReview,
  validateAndComplete,
} from "../src/state/review-state.js";

const RID = "11111111-1111-4111-8111-111111111111";
const LENSES: readonly LensId[] = ["security", "clean-code", "performance"];

beforeEach(() => {
  _resetForTests();
});

describe("registerReview", () => {
  it("stores a session in started state with a finite startedAt near now", () => {
    const before = Date.now();
    registerReview({ reviewId: RID, stage: "PLAN_REVIEW", expectedLensIds: LENSES });
    const after = Date.now();
    const s = getReview(RID);
    expect(s).toBeDefined();
    if (!s) throw new Error();
    expect(s.status).toBe("started");
    expect(s.reviewId).toBe(RID);
    expect(s.stage).toBe("PLAN_REVIEW");
    expect(Number.isFinite(s.startedAt)).toBe(true);
    expect(s.startedAt).toBeGreaterThanOrEqual(before);
    expect(s.startedAt).toBeLessThanOrEqual(after);
  });

  it("preserves expectedLensIds order and length exactly", () => {
    registerReview({ reviewId: RID, stage: "CODE_REVIEW", expectedLensIds: LENSES });
    expect(getReview(RID)?.expectedLensIds).toEqual(LENSES);
  });

  it("throws on re-registration of the same reviewId", () => {
    registerReview({ reviewId: RID, stage: "PLAN_REVIEW", expectedLensIds: LENSES });
    expect(() =>
      registerReview({ reviewId: RID, stage: "PLAN_REVIEW", expectedLensIds: LENSES }),
    ).toThrow(/already registered/);
  });
});

describe("getReview", () => {
  it("returns undefined for an unregistered id", () => {
    expect(getReview("not-a-real-id")).toBeUndefined();
  });

  it("returns a session that reflects the fields passed to registerReview", () => {
    registerReview({ reviewId: RID, stage: "CODE_REVIEW", expectedLensIds: LENSES });
    const s = getReview(RID);
    expect(s).toMatchObject({
      reviewId: RID,
      stage: "CODE_REVIEW",
      expectedLensIds: LENSES,
      status: "started",
    });
  });
});

describe("validateAndComplete", () => {
  it("rejects an unknown reviewId without mutating state", () => {
    const v = validateAndComplete({
      reviewId: "unknown-id",
      providedLensIds: LENSES,
    });
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error();
    expect(v.code).toBe("unknown");
    expect(getReview("unknown-id")).toBeUndefined();
  });

  it("transitions started -> complete on an exact-match submission", () => {
    registerReview({ reviewId: RID, stage: "PLAN_REVIEW", expectedLensIds: LENSES });
    const v = validateAndComplete({ reviewId: RID, providedLensIds: LENSES });
    expect(v.ok).toBe(true);
    if (!v.ok) throw new Error();
    expect(v.session.status).toBe("complete");
    expect(getReview(RID)?.status).toBe("complete");
  });

  it("accepts a strict superset (extras ignored) as a successful transition", () => {
    registerReview({ reviewId: RID, stage: "PLAN_REVIEW", expectedLensIds: LENSES });
    const extras: readonly LensId[] = [...LENSES, "accessibility"];
    const v = validateAndComplete({ reviewId: RID, providedLensIds: extras });
    expect(v.ok).toBe(true);
    expect(getReview(RID)?.status).toBe("complete");
  });

  it("rejects a submission missing a lens and leaves state at started", () => {
    registerReview({ reviewId: RID, stage: "PLAN_REVIEW", expectedLensIds: LENSES });
    const partial: readonly LensId[] = ["security", "clean-code"];
    const v = validateAndComplete({ reviewId: RID, providedLensIds: partial });
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error();
    expect(v.code).toBe("missing_lenses");
    if (v.code !== "missing_lenses") throw new Error();
    expect(v.missing).toEqual(["performance"]);
    expect(getReview(RID)?.status).toBe("started");
  });

  it("rejects double-complete with already_complete and preserves complete status", () => {
    registerReview({ reviewId: RID, stage: "PLAN_REVIEW", expectedLensIds: LENSES });
    const first = validateAndComplete({ reviewId: RID, providedLensIds: LENSES });
    expect(first.ok).toBe(true);
    const second = validateAndComplete({ reviewId: RID, providedLensIds: LENSES });
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error();
    expect(second.code).toBe("already_complete");
    expect(getReview(RID)?.status).toBe("complete");
  });

  it("preserves the immutable-record invariant: prior getReview references observe the old status", () => {
    registerReview({ reviewId: RID, stage: "PLAN_REVIEW", expectedLensIds: LENSES });
    const snapshot = getReview(RID);
    expect(snapshot?.status).toBe("started");
    validateAndComplete({ reviewId: RID, providedLensIds: LENSES });
    expect(snapshot?.status).toBe("started");
    expect(getReview(RID)?.status).toBe("complete");
  });
});
