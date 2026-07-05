import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  readTask,
  _failNextIndexRmwForTests,
  _failNextTaskWriteForTests,
} from "../src/cache/in-flight.js";
import { ReviewVerdictSchema } from "../src/schema/index.js";
import {
  getReview,
  _clearMapOnlyForTests,
  _resetForTests,
} from "../src/state/review-state.js";
import { handleLensReviewComplete } from "../src/tools/complete.js";
import {
  GetPromptOutputSchema,
  handleLensReviewGetPrompt,
} from "../src/tools/get-prompt.js";
import { handleLensReviewStart } from "../src/tools/start.js";

/**
 * T-027 R5/R8/R-B2(Option A)/R-D4: the prompt-fetch anchor. The
 * lens_review_get_prompt response now carries the AUTHORITATIVE spawn
 * deadline; agents[].expiresAt from hop-1 is the provisional one.
 */
let inFlightDir: string;
beforeAll(() => {
  inFlightDir = mkdtempSync(join(tmpdir(), "lenses-t027-anchor-if-"));
  process.env.LENSES_IN_FLIGHT_DIR = inFlightDir;
});
afterAll(() => {
  delete process.env.LENSES_IN_FLIGHT_DIR;
  rmSync(inFlightDir, { recursive: true, force: true });
});

beforeEach(() => _resetForTests());

async function startSecurity(lensTimeout?: number): Promise<{
  reviewId: string;
  hop1ExpiresAt: string;
}> {
  const res = await handleLensReviewStart({
    method: "tools/call",
    params: {
      name: "lens_review_start",
      arguments: {
        stage: "PLAN_REVIEW",
        artifact: "## Plan\n\nDo the thing.",
        ticketDescription: null,
        reviewRound: 1,
        lensConfig: {
          lenses: ["security"],
          ...(lensTimeout !== undefined ? { lensTimeout } : {}),
        },
      },
    },
  });
  const first = res.content[0];
  if (!first || first.type !== "text") throw new Error();
  const parsed = JSON.parse(String(first.text)) as {
    reviewId: string;
    agents: Array<{ id: string; expiresAt: string }>;
  };
  return {
    reviewId: parsed.reviewId,
    hop1ExpiresAt: parsed.agents[0]!.expiresAt,
  };
}

async function getPrompt(reviewId: string): Promise<{
  prompt: string;
  expiresAt: string | undefined;
}> {
  const res = await handleLensReviewGetPrompt({
    method: "tools/call",
    params: {
      name: "lens_review_get_prompt",
      arguments: { reviewId, lensId: "security" },
    },
  });
  const first = res.content[0];
  if (!first || first.type !== "text") throw new Error(String(res.content[0]));
  const parsed = GetPromptOutputSchema.parse(JSON.parse(String(first.text)));
  return { prompt: parsed.prompt, expiresAt: parsed.expiresAt };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("T-027 prompt-fetch anchoring", () => {
  it("R-D4(a): the anchored attempt-1 fetch returns expiresAt >= the hop-1 provisional deadline", async () => {
    const { reviewId, hop1ExpiresAt } = await startSecurity();
    await sleep(5);
    const gp = await getPrompt(reviewId);
    expect(gp.prompt.length).toBeGreaterThan(100);
    expect(gp.expiresAt).toBeDefined();
    expect(Date.parse(gp.expiresAt!)).toBeGreaterThanOrEqual(
      Date.parse(hop1ExpiresAt),
    );
  });

  it("R8: anchoring is once-per-attempt; a second fetch does not extend the deadline again", async () => {
    const { reviewId } = await startSecurity();
    const gp1 = await getPrompt(reviewId);
    await sleep(10);
    const gp2 = await getPrompt(reviewId);
    expect(gp2.expiresAt).toBe(gp1.expiresAt);
  });

  // Codex round (resolution 4): durability first. When the index RMW
  // fails, NO anchor happens: the fetch returns the pre-existing
  // deadline, durable state agrees after a restart, and a later fetch
  // (healthy disk) may anchor durably, exactly once.
  it("R5: an index RMW failure means no anchor: the fetch returns the OLD deadline and durable state agrees", async () => {
    const { reviewId, hop1ExpiresAt } = await startSecurity();
    _failNextIndexRmwForTests({ reviewId });
    const gp1 = await getPrompt(reviewId);
    expect(gp1.expiresAt).toBe(hop1ExpiresAt);

    // Simulated restart: hydration reads index.lensMeta and agrees
    // with the wire value (no memory-only extension survived).
    _clearMapOnlyForTests();
    const hydrated = getReview(reviewId);
    expect(hydrated?.perLensExpiresAt.get("security")).toBe(
      Date.parse(hop1ExpiresAt),
    );

    // The anchor was NOT consumed by the failed attempt: the next
    // fetch (disk healthy again) anchors durably, once.
    await sleep(5);
    const gp2 = await getPrompt(reviewId);
    expect(gp2.expiresAt).toBeDefined();
    expect(Date.parse(gp2.expiresAt!)).toBeGreaterThanOrEqual(
      Date.parse(hop1ExpiresAt),
    );
    await sleep(5);
    const gp3 = await getPrompt(reviewId);
    expect(gp3.expiresAt).toBe(gp2.expiresAt);
  });

  // Codex round 2: the once-guard is atomic with the deadline in the
  // index RMW. A lost seed flip after a successful RMW must NOT allow
  // a post-restart fetch to re-anchor and extend the deadline again.
  it("codex round 2: seed-flip failure after a successful index RMW never re-extends after a restart", async () => {
    const { reviewId, hop1ExpiresAt } = await startSecurity();
    _failNextTaskWriteForTests({ reviewId, lensId: "security", attempt: 1 });
    const gp1 = await getPrompt(reviewId);
    expect(gp1.expiresAt).toBeDefined();
    expect(Date.parse(gp1.expiresAt!)).toBeGreaterThanOrEqual(
      Date.parse(hop1ExpiresAt),
    );
    // The flip was lost: the seed record is still pending on disk.
    expect(readTask(reviewId, "security", 1)?.status).toBe("pending");

    // Simulated restart: fresh hydration, then a second fetch. The
    // durable guard forbids re-anchoring: same deadline on the wire.
    _clearMapOnlyForTests();
    await sleep(5);
    const gp2 = await getPrompt(reviewId);
    expect(gp2.expiresAt).toBe(gp1.expiresAt);
    // The bookkeeping seed flip completed harmlessly on that fetch.
    expect(readTask(reviewId, "security", 1)?.status).toBe("in_flight");

    // And hydration still agrees with the anchored deadline.
    _clearMapOnlyForTests();
    expect(getReview(reviewId)?.perLensExpiresAt.get("security")).toBe(
      Date.parse(gp1.expiresAt!),
    );
  });

  it("R8: a fetch after the deadline returns the prompt but leaves the old deadline intact", async () => {
    const { reviewId, hop1ExpiresAt } = await startSecurity(50);
    await sleep(80);
    const gp = await getPrompt(reviewId);
    expect(gp.prompt.length).toBeGreaterThan(100);
    expect(gp.expiresAt).toBe(hop1ExpiresAt);
  });

  it("R8: retry attempts never anchor via get_prompt; the fetch reflects the minted retry deadline unchanged", async () => {
    const { reviewId } = await startSecurity();
    const gp1 = await getPrompt(reviewId);

    // Terminal attempt 1 (malformed -> placeholder failed) mints a retry.
    const res = await handleLensReviewComplete({
      method: "tools/call",
      params: {
        name: "lens_review_complete",
        arguments: {
          reviewId,
          results: [{ lensId: "security", output: { status: "ok" } }],
        },
      },
    });
    const first = res.content[0];
    if (!first || first.type !== "text") throw new Error();
    const verdict = ReviewVerdictSchema.parse(JSON.parse(String(first.text)));
    expect(verdict.nextActions).toHaveLength(1);
    const minted = verdict.nextActions[0]!.expiresAt;
    expect(Date.parse(minted)).toBeGreaterThanOrEqual(Date.parse(gp1.expiresAt!));

    // Post-retry fetches return the minted deadline without extending it.
    const gp2 = await getPrompt(reviewId);
    expect(gp2.expiresAt).toBe(minted);
    await sleep(10);
    const gp3 = await getPrompt(reviewId);
    expect(gp3.expiresAt).toBe(minted);
  });
});
