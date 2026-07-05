import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { writeLensCache } from "../src/cache/lens-cache.js";
import type { LensId } from "../src/lenses/prompts/index.js";
import { ReviewVerdictSchema, type LensFinding } from "../src/schema/index.js";
import {
  _clearMapOnlyForTests,
  _resetForTests,
  getReview,
} from "../src/state/review-state.js";
import { handleLensReviewComplete } from "../src/tools/complete.js";
import { handleLensReviewStart } from "../src/tools/start.js";

let sessionDir: string;
let lensCacheDir: string;
let inFlightDir: string;
beforeAll(() => {
  sessionDir = mkdtempSync(join(tmpdir(), "t026-tools-"));
  lensCacheDir = mkdtempSync(join(tmpdir(), "t026-tools-lc-"));
  inFlightDir = mkdtempSync(join(tmpdir(), "t026-tools-if-"));
  process.env.LENSES_SESSION_DIR = sessionDir;
  process.env.LENSES_LENS_CACHE_DIR = lensCacheDir;
  process.env.LENSES_IN_FLIGHT_DIR = inFlightDir;
});
afterAll(() => {
  delete process.env.LENSES_SESSION_DIR;
  delete process.env.LENSES_LENS_CACHE_DIR;
  delete process.env.LENSES_IN_FLIGHT_DIR;
  rmSync(sessionDir, { recursive: true, force: true });
  rmSync(lensCacheDir, { recursive: true, force: true });
  rmSync(inFlightDir, { recursive: true, force: true });
});
beforeEach(() => {
  _resetForTests();
  rmSync(lensCacheDir, { recursive: true, force: true });
});

// New-side lines of src/x.ts: 1 "line one", 2 const secret..., 3 doStuff();,
// 4 moreStuff();, 5 line two, 6 line three.
const CODE_DIFF = [
  "diff --git a/src/x.ts b/src/x.ts",
  "--- a/src/x.ts",
  "+++ b/src/x.ts",
  "@@ -1,3 +1,6 @@",
  " line one",
  '+const secret = "hardcoded";',
  "+doStuff();",
  "+moreStuff();",
  " line two",
  " line three",
].join("\n");

const TWO_LENSES = ["security", "clean-code"];

async function startCode(
  changedFiles: string[] = ["src/x.ts"],
  artifact = CODE_DIFF,
): Promise<{
  reviewId: string;
  agents: Array<{ id: LensId; promptHash: string }>;
  cached: Array<{ id: LensId; findings: LensFinding[] }>;
}> {
  const result = await handleLensReviewStart({
    method: "tools/call",
    params: {
      name: "lens_review_start",
      arguments: {
        stage: "CODE_REVIEW",
        artifact,
        ticketDescription: null,
        reviewRound: 1,
        changedFiles,
        lensConfig: { lenses: TWO_LENSES },
      },
    },
  });
  const first = result.content[0];
  if (!first || first.type !== "text") throw new Error("bad start shape");
  return JSON.parse(String(first.text));
}

function okOut(findings: LensFinding[]) {
  return { status: "ok", findings, error: null, notes: null };
}

async function complete(
  reviewId: string,
  results: Array<{ lensId: string; output: unknown }>,
) {
  const res = await handleLensReviewComplete({
    method: "tools/call",
    params: {
      name: "lens_review_complete",
      arguments: { reviewId, results },
    },
  });
  const first = res.content[0];
  if (!first || first.type !== "text") throw new Error("bad complete shape");
  return { isError: res.isError === true, body: JSON.parse(String(first.text)) };
}

function fnd(overrides: Partial<LensFinding>): LensFinding {
  return {
    id: overrides.id ?? "f",
    severity: overrides.severity ?? "minor",
    category: overrides.category ?? "generic",
    file: overrides.file ?? "src/x.ts",
    line: overrides.line ?? 1,
    description: "",
    suggestion: "",
    confidence: overrides.confidence ?? 0.8,
    ...overrides,
  };
}

describe("T-026 CODE_REVIEW anchoring end-to-end (VERIFICATION)", () => {
  it("realigns a one-line-off finding and both lenses appear in contributingLenses", async () => {
    const { reviewId, agents } = await startCode();
    expect(agents.map((a) => a.id).sort()).toEqual(["clean-code", "security"]);
    const { isError, body } = await complete(reviewId, [
      {
        lensId: "security",
        output: okOut([
          fnd({
            id: "a",
            confidence: 0.8,
            line: 3,
            snippet: { quote: "doStuff();", startLine: 3 },
          }),
        ]),
      },
      {
        lensId: "clean-code",
        output: okOut([
          fnd({
            id: "b",
            confidence: 0.9,
            line: 2, // one line off; snippet matches line 3
            snippet: { quote: "doStuff();", startLine: 2 },
          }),
        ]),
      },
    ]);
    expect(isError).toBe(false);
    const v = ReviewVerdictSchema.parse(body);
    expect(v.findings).toHaveLength(1);
    expect(v.findings[0]!.line).toBe(3);
    expect(v.findings[0]!.anchorRealignedFrom).toBe(2);
    expect([...v.findings[0]!.contributingLenses].sort()).toEqual([
      "clean-code",
      "security",
    ]);
    expect(v.anchorRealignedCount).toBe(1);
  });

  it("flipping lens B to a non-matching minor snippet defers it as evidence_unverified", async () => {
    const { reviewId } = await startCode();
    const { body } = await complete(reviewId, [
      {
        lensId: "security",
        output: okOut([
          fnd({ id: "a", line: 3, snippet: { quote: "doStuff();", startLine: 3 } }),
        ]),
      },
      {
        lensId: "clean-code",
        output: okOut([
          fnd({
            id: "b",
            severity: "minor",
            line: 2,
            snippet: { quote: "no-such-line", startLine: 2 },
          }),
        ]),
      },
    ]);
    const v = ReviewVerdictSchema.parse(body);
    expect(v.findings).toHaveLength(1); // only lens A survives
    expect(v.evidenceUnverifiedCount).toBe(1);
    expect(v.deferred.some((d) => d.reason === "evidence_unverified")).toBe(true);
  });

  it("a non-matching blocking snippet survives with line null + a reviewIntegrity entry", async () => {
    const { reviewId } = await startCode();
    const { body } = await complete(reviewId, [
      {
        lensId: "security",
        output: okOut([
          fnd({
            id: "blk",
            severity: "blocking",
            confidence: 0.9,
            line: 2,
            snippet: { quote: "absent quote", startLine: 2 },
          }),
        ]),
      },
      { lensId: "clean-code", output: okOut([]) },
    ]);
    const v = ReviewVerdictSchema.parse(body);
    expect(v.verdict).toBe("reject");
    expect(v.reviewIntegrity).toHaveLength(1);
    const key = v.reviewIntegrity[0]!.integrityKey;
    const carriers = v.findings.filter((f) => f.integrityKey === key);
    expect(carriers).toHaveLength(1);
    expect(carriers[0]!.line).toBeNull();
    expect(v.reviewIntegrity[0]!.line).toBe(2); // original claimed line
  });
});

describe("T-026 R-D1 anchorUnindexedFiles E2E", () => {
  it("a changedFiles entry absent from the diff completes normally, is listed, findings pass through", async () => {
    const { reviewId } = await startCode(["src/x.ts", "src/ghost.ts"]);
    const { isError, body } = await complete(reviewId, [
      {
        lensId: "security",
        output: okOut([
          fnd({
            id: "g",
            severity: "blocking",
            confidence: 0.9,
            file: "src/ghost.ts",
            line: 12,
            snippet: { quote: "whatever", startLine: 12 },
          }),
        ]),
      },
      { lensId: "clean-code", output: okOut([]) },
    ]);
    expect(isError).toBe(false);
    const v = ReviewVerdictSchema.parse(body);
    expect(v.anchorUnindexedFiles).toEqual(["src/ghost.ts"]);
    // finding on the unindexed file passes through untouched (R2)
    expect(v.findings).toHaveLength(1);
    expect(v.findings[0]!.line).toBe(12);
    expect(v.reviewIntegrity).toHaveLength(0);
  });
});

describe("T-026 R11 restart rehydration", () => {
  it("verifies snippets after a memory-only clear because the artifact rehydrates from the index", async () => {
    const { reviewId } = await startCode();
    // Simulate a server restart: memory gone, disk intact.
    _clearMapOnlyForTests();
    const rehydrated = getReview(reviewId);
    expect(rehydrated?.artifact).toBe(CODE_DIFF);
    const { body } = await complete(reviewId, [
      {
        lensId: "security",
        output: okOut([
          fnd({ id: "a", line: 1, snippet: { quote: "moreStuff();", startLine: 1 } }),
        ]),
      },
      { lensId: "clean-code", output: okOut([]) },
    ]);
    const v = ReviewVerdictSchema.parse(body);
    // Realignment happened using the rehydrated artifact.
    expect(v.findings[0]!.line).toBe(4);
    expect(v.findings[0]!.anchorRealignedFrom).toBe(1);
  });
});

describe("T-026 R-C2 server-owned field sanitization at ingestion / persistence", () => {
  it("a lens-supplied anchorRealignedFrom never reaches the on-disk TaskRecord or rehydrated state", async () => {
    const { reviewId } = await startCode();
    // Round 1: submit ONLY security (review stays interim) with a
    // lens-supplied anchorRealignedFrom.
    await complete(reviewId, [
      {
        lensId: "security",
        output: okOut([
          fnd({
            id: "a",
            line: 3,
            anchorRealignedFrom: 999, // lens-injected server field
            snippet: { quote: "doStuff();", startLine: 3 },
          }),
        ]),
      },
    ]);

    // The persisted TaskRecord JSON must not carry the stripped field.
    const tasksDir = join(inFlightDir, reviewId, "tasks");
    const taskFiles = readdirSync(tasksDir).filter((f) => f.startsWith("security."));
    const anyTaskHasField = taskFiles.some((f) =>
      readFileSync(join(tasksDir, f), "utf8").includes("anchorRealignedFrom"),
    );
    expect(anyTaskHasField).toBe(false);

    // Rehydrate: perLensLatestOutput must also lack the key.
    _clearMapOnlyForTests();
    const s = getReview(reviewId);
    const rehydrated = s?.perLensLatestOutput.get("security" as LensId);
    expect(rehydrated).toBeDefined();
    expect("anchorRealignedFrom" in rehydrated!.findings[0]!).toBe(false);

    // Finalize with clean-code; the surviving emitted finding carries no
    // anchorRealignedFrom (server did not realign a correct-in-place quote).
    const { body } = await complete(reviewId, [
      { lensId: "clean-code", output: okOut([]) },
    ]);
    const v = ReviewVerdictSchema.parse(body);
    expect(v.findings[0]!.anchorRealignedFrom).toBeUndefined();
  });
});

describe("T-026 R-C4(b) lens-cache read choke point sanitization", () => {
  it("a contaminated cache entry never surfaces its server field in round-2 cached[]", async () => {
    // Round-1 start: capture security's promptHash so we can seed the cache
    // for the identical round-2 prompt.
    const r1 = await startCode();
    const secAgent = r1.agents.find((a) => a.id === "security");
    expect(secAgent).toBeDefined();

    // Directly contaminate the lens cache with a server-owned field.
    writeLensCache({
      lensId: "security" as LensId,
      promptHash: secAgent!.promptHash,
      findings: [
        fnd({ id: "c", line: 3, anchorRealignedFrom: 777 }),
      ],
      notes: null,
    });

    // Round-2 start with identical args -> same promptHash -> cache HIT.
    const r2 = await startCode();
    const cachedSec = r2.cached.find((c) => c.id === "security");
    expect(cachedSec).toBeDefined();
    expect(cachedSec!.findings).toHaveLength(1);
    expect("anchorRealignedFrom" in cachedSec!.findings[0]!).toBe(false);
  });
});
