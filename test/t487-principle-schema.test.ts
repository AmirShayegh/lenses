/**
 * T-487 step 1: `principle` and the four provenance fields on the finding
 * schema, and the carry-through that keeps them from being inert.
 *
 * Three kinds of test live here, and they are NOT equal evidence:
 *
 *  1. Schema and sanitizer tests, which pin code this step adds.
 *  2. The deferral test, which pins a real bug this step fixes
 *     (`toSingletonMerged` enumerated its fields and dropped every new one).
 *  3. The MERGE FENCE, which pins behaviour this step does NOT change. The
 *     rule -- a merge carries the representative's claim and never borrows,
 *     fills or escalates from another member -- is what the plain `spreadRep`
 *     already does. These tests exist so that property is stated and defended
 *     rather than emergent, and their mutants INJECT the forbidden borrow
 *     rather than delete a line of mine. That is weaker evidence and is
 *     labelled as such wherever it is reported.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { renderSharedPreamble } from "../src/lenses/prompts/shared-preamble.js";
import { buildLensPrompt } from "../src/lenses/prompt-builder.js";
import { hashLensPrompt, readLensCache, writeLensCache } from "../src/cache/lens-cache.js";
import { dedupeFindings } from "../src/merger/dedup.js";
import {
  sanitizeFindingForStorage,
  verifyAnchors,
  type AnchoringInput,
} from "../src/merger/anchor.js";
import type { LensRunResult } from "../src/merger/pipeline.js";
import {
  DEFAULT_ALWAYS_BLOCK,
  LensFindingSchema,
  MergedFindingSchema,
  type LensFinding,
  type LensOutput,
} from "../src/schema/index.js";

const FLOOR = 0.6;
const ALWAYS_BLOCK = [...DEFAULT_ALWAYS_BLOCK];

function base(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "f-1",
    severity: "minor",
    category: "naming",
    file: "src/x.ts",
    line: 10,
    description: "d",
    suggestion: "s",
    confidence: 0.8,
    ...overrides,
  };
}

function mergedBase(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return base({ contributingLenses: ["clean-code"], ...overrides });
}

/**
 * Every field this step adds, with a legal value. Table-driven so a test named
 * for "each added field" actually exercises each one: a single-field assertion
 * standing in for five is how M4 in an earlier draft would have passed while
 * four of the five fields were missing.
 */
const ADDED_FIELDS: ReadonlyArray<readonly [string, unknown]> = [
  ["principle", "robustness"],
  ["dispositionReason", "owner-accepted-risk"],
  ["origin", "pre-existing"],
  ["originClass", "reintroduced"],
  ["sinceRound", 4],
];

describe("T-487 S1: the added fields parse", () => {
  it("the table covers every field this step adds", () => {
    expect(ADDED_FIELDS.map(([k]) => k)).toEqual([
      "principle",
      "dispositionReason",
      "origin",
      "originClass",
      "sinceRound",
    ]);
  });

  it("LensFindingSchema accepts each added field", () => {
    for (const [key, value] of ADDED_FIELDS) {
      const parsed = LensFindingSchema.safeParse(base({ [key]: value }));
      expect(parsed.success, `${key} was rejected`).toBe(true);
      if (parsed.success) {
        expect((parsed.data as Record<string, unknown>)[key]).toEqual(value);
      }
    }
  });

  it("MergedFindingSchema accepts each added field, from the shared shape", () => {
    for (const [key, value] of ADDED_FIELDS) {
      const parsed = MergedFindingSchema.safeParse(mergedBase({ [key]: value }));
      expect(parsed.success, `${key} was rejected on MergedFinding`).toBe(true);
      if (parsed.success) {
        expect((parsed.data as Record<string, unknown>)[key]).toEqual(value);
      }
    }
  });

  it("an absent added field stays absent after parse", () => {
    const parsed = LensFindingSchema.parse(base()) as Record<string, unknown>;
    for (const [key] of ADDED_FIELDS) {
      // Own-property, not a truthiness check: a `.default("")` would satisfy
      // `=== undefined` on some shapes and still put the key on the object.
      expect(Object.hasOwn(parsed, key), `${key} was materialised`).toBe(false);
    }
  });

  it("exports FindingOriginSchema and FindingOriginClassSchema for step 2", async () => {
    const mod = (await import("../src/schema/index.js")) as Record<string, unknown>;
    expect(mod.FindingOriginSchema).toBeDefined();
    expect(mod.FindingOriginClassSchema).toBeDefined();
  });
});

describe("T-487 S1: absence is the only way to name no principle", () => {
  it("principle rejects the empty string and whitespace-only", () => {
    for (const bad of ["", " ", "\t", "\n  \n"]) {
      expect(
        LensFindingSchema.safeParse(base({ principle: bad })).success,
        `principle ${JSON.stringify(bad)} was accepted`,
      ).toBe(false);
    }
    expect(LensFindingSchema.safeParse(base({ principle: "robustness" })).success).toBe(true);
  });

  it("dispositionReason rejects the empty string and whitespace-only", () => {
    for (const bad of ["", " ", "\t"]) {
      expect(
        LensFindingSchema.safeParse(base({ dispositionReason: bad })).success,
        `dispositionReason ${JSON.stringify(bad)} was accepted`,
      ).toBe(false);
    }
    expect(
      LensFindingSchema.safeParse(base({ dispositionReason: "valid-deferred" })).success,
    ).toBe(true);
  });
});

describe("T-487 S1: the provenance vocabularies are closed", () => {
  it("origin accepts exactly its two values", () => {
    for (const good of ["introduced", "pre-existing"]) {
      expect(LensFindingSchema.safeParse(base({ origin: good })).success).toBe(true);
    }
    for (const bad of ["Introduced", "preexisting", "unknown", ""]) {
      expect(
        LensFindingSchema.safeParse(base({ origin: bad })).success,
        `origin ${JSON.stringify(bad)} was accepted`,
      ).toBe(false);
    }
  });

  it("originClass accepts exactly its four values", () => {
    for (const good of ["new", "reintroduced", "unchanged", "introduced-by-fix"]) {
      expect(LensFindingSchema.safeParse(base({ originClass: good })).success).toBe(true);
    }
    // "re-introduced" is the one-hyphen typo that slipped past an earlier
    // version of the CPM guard. Named here so this schema is the place it
    // cannot slip past again.
    for (const bad of ["re-introduced", "New", "reintroduced ", ""]) {
      expect(
        LensFindingSchema.safeParse(base({ originClass: bad })).success,
        `originClass ${JSON.stringify(bad)} was accepted`,
      ).toBe(false);
    }
  });

  it("sinceRound rejects zero, negatives and fractions", () => {
    for (const bad of [0, -1, 1.5, "4"]) {
      expect(
        LensFindingSchema.safeParse(base({ sinceRound: bad })).success,
        `sinceRound ${JSON.stringify(bad)} was accepted`,
      ).toBe(false);
    }
    expect(LensFindingSchema.safeParse(base({ sinceRound: 1 })).success).toBe(true);
  });
});

describe("T-487 S1: the sanitizer boundary", () => {
  it("strips neither principle nor any provenance field", () => {
    for (const [key, value] of ADDED_FIELDS) {
      const f = LensFindingSchema.parse(base({ [key]: value })) as LensFinding;
      const out = sanitizeFindingForStorage(f) as unknown as Record<string, unknown>;
      expect(out[key], `${key} was stripped`).toEqual(value);
    }
  });

  it("still strips both server-owned fields", () => {
    const f = {
      ...(LensFindingSchema.parse(base({ principle: "security" })) as LensFinding),
      integrityKey: "ie-1",
      anchorRealignedFrom: 3,
    } as LensFinding;
    const out = sanitizeFindingForStorage(f) as unknown as Record<string, unknown>;
    expect(Object.hasOwn(out, "integrityKey")).toBe(false);
    expect(Object.hasOwn(out, "anchorRealignedFrom")).toBe(false);
    expect(out.principle).toBe("security");
  });
});

// The new side of src/x.ts is lines 1..6; line 3 is "doStuff();".
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

const anchoring: AnchoringInput = {
  stage: "CODE_REVIEW",
  artifact: CODE_DIFF,
  changedFiles: ["src/x.ts"],
};

function lensRun(lensId: string, findings: LensFinding[]): LensRunResult {
  return {
    lensId: lensId as LensRunResult["lensId"],
    output: { status: "ok", findings, error: null, notes: null } as LensOutput,
  };
}

describe("T-487 S2a: a deferral is built by spreading, not by enumeration", () => {
  /**
   * Routes down the `evidence_unverified` deferral branch: localized, on a
   * file the diff indexes, with a quote that matches nothing in the recovery
   * window, at a severity that does not survive.
   */
  function unverifiable(overrides: Partial<LensFinding> = {}): LensFinding {
    return {
      id: "f-def",
      severity: "minor",
      category: "naming",
      file: "src/x.ts",
      line: 3,
      snippet: { quote: "nothing in this diff says this", startLine: 3 },
      description: "d",
      suggestion: "s",
      confidence: 0.8,
      ...overrides,
    } as LensFinding;
  }

  it("keeps principle and every provenance field on the deferred finding", () => {
    const f = unverifiable({
      principle: "robustness",
      dispositionReason: "valid-deferred",
      origin: "pre-existing",
      originClass: "unchanged",
      sinceRound: 2,
    } as Partial<LensFinding>);
    const res = verifyAnchors({
      perLens: [lensRun("clean-code", [f])],
      anchoring,
      alwaysBlock: ALWAYS_BLOCK,
      confidenceFloor: FLOOR,
    });
    expect(res.deferred).toHaveLength(1);
    const got = res.deferred[0]!.finding as unknown as Record<string, unknown>;
    expect(res.deferred[0]!.reason).toBe("evidence_unverified");
    for (const [key, value] of ADDED_FIELDS) {
      const expected = (f as unknown as Record<string, unknown>)[key];
      expect(got[key], `${key} was dropped by the deferral shape`).toEqual(expected);
      expect(value).toBeDefined();
    }
  });

  it("never carries a server-owned field even though it spreads", () => {
    const f = {
      ...unverifiable({ principle: "security" } as Partial<LensFinding>),
      integrityKey: "ie-99",
      anchorRealignedFrom: 1,
    } as LensFinding;
    const res = verifyAnchors({
      perLens: [lensRun("clean-code", [f])],
      anchoring,
      alwaysBlock: ALWAYS_BLOCK,
      confidenceFloor: FLOOR,
    });
    expect(res.deferred).toHaveLength(1);
    const got = res.deferred[0]!.finding as unknown as Record<string, unknown>;
    expect(Object.hasOwn(got, "integrityKey")).toBe(false);
    expect(Object.hasOwn(got, "anchorRealignedFrom")).toBe(false);
    expect(got.principle).toBe("security");
  });
});

/**
 * THE MERGE FENCE. See the module header for why these are a weaker form of
 * evidence than the tests above.
 *
 * Representative selection is confidence desc first (`compareRep`), so every
 * fixture below picks its representative by confidence and says which one it
 * expects, rather than relying on argument order.
 */
describe("T-487 S2b: a merge carries the representative's claim and borrows nothing", () => {
  function at(
    line: number,
    lensId: string,
    confidence: number,
    extra: Record<string, unknown> = {},
  ): { lensId: string; finding: LensFinding } {
    return {
      lensId,
      // `description` and `id` are keyed on the LENS, not the line: an earlier
      // revision keyed them on the line, so both members of a phase-1 group
      // read `d10` and the "the right member won" assertion could not tell
      // them apart. Distinct per member is what makes that assertion mean
      // anything.
      finding: {
        id: `f-${lensId}-${line}`,
        severity: "minor",
        category: "generic",
        file: "src/x.ts",
        line,
        description: `desc-from-${lensId}`,
        suggestion: "s",
        confidence,
        ...extra,
      } as LensFinding,
    };
  }

  /**
   * Runs the same two members in BOTH input orders and asserts the outcome is
   * identical. Representative selection is by confidence (`compareRep`), so a
   * policy that took the FIRST member instead would agree with this fixture in
   * one order and disagree in the other. Without this, every assertion below
   * would pass under a first-member-wins implementation.
   */
  function bothOrders(
    build: (members: ReadonlyArray<{ lensId: string; finding: LensFinding }>) => Record<string, unknown>,
    rep: { lensId: string; finding: LensFinding },
    other: { lensId: string; finding: LensFinding },
  ): Record<string, unknown> {
    // `contributingLenses` is documented first-seen-distinct, so it is
    // legitimately input-order-dependent and is the ONE field normalised
    // before the comparison. Everything else -- the winner's identity and
    // every claim under test -- must be identical in both orders.
    const norm = (m: Record<string, unknown>): Record<string, unknown> => ({
      ...m,
      contributingLenses: [...(m.contributingLenses as string[])].sort(),
    });
    const a = build([rep, other]);
    const b = build([other, rep]);
    expect(norm(b)).toEqual(norm(a));
    return a;
  }

  function merge(members: ReadonlyArray<{ lensId: string; finding: LensFinding }>, repLens: string) {
    const res = dedupeFindings(members.map((m) => lensRun(m.lensId, [m.finding])));
    expect(res.findings).toHaveLength(1);
    const won = res.findings[0]!;
    // Identity of the winner, asserted on fields that are NOT the claim under
    // test, so the claim assertions cannot prop up a wrong winner.
    expect(won.description).toBe(`desc-from-${repLens}`);
    expect(won.id).toBe(members.find((m) => m.lensId === repLens)!.finding.id);
    return won as unknown as Record<string, unknown>;
  }

  /** Same (file, line, category) from two lenses: phase 1 merges these. */
  function phase1(
    repExtra: Record<string, unknown>,
    otherExtra: Record<string, unknown>,
  ) {
    const rep = at(10, "clean-code", 0.9, repExtra);
    const other = at(10, "security", 0.5, otherExtra);
    return bothOrders((members) => merge(members, "clean-code"), rep, other);
  }

  /**
   * Two DIFFERENT lines, same file and category: phase 1 leaves these distinct
   * (its key includes the line) and only phase 2's two-line cluster window
   * merges them. A phase-2 mutant tested on a phase-1 fixture is equivalent
   * and proves nothing, which is why this helper exists separately.
   */
  function phase2(
    repExtra: Record<string, unknown>,
    otherExtra: Record<string, unknown>,
  ) {
    const rep = at(40, "clean-code", 0.9, repExtra);
    const other = at(42, "security", 0.5, otherExtra);
    return bothOrders((members) => merge(members, "clean-code"), rep, other);
  }

  it("phase 1: the representative's principle survives", () => {
    expect(phase1({ principle: "robustness" }, { principle: "security" }).principle)
      .toBe("robustness");
  });

  it("phase 1: a non-representative's principle is NOT borrowed", () => {
    const merged = phase1({}, { principle: "security" });
    expect(Object.hasOwn(merged, "principle")).toBe(false);
  });

  it("phase 2: the representative's principle survives a cluster merge", () => {
    expect(phase2({ principle: "robustness" }, { principle: "security" }).principle)
      .toBe("robustness");
  });

  it("phase 2: a non-representative's principle is NOT borrowed across a cluster", () => {
    const merged = phase2({}, { principle: "security" });
    expect(Object.hasOwn(merged, "principle")).toBe(false);
  });

  const REP_PROVENANCE = {
    dispositionReason: "valid-deferred",
    origin: "introduced",
    originClass: "new",
    sinceRound: 3,
  };
  const OTHER_PROVENANCE = {
    dispositionReason: "owner-accepted-risk",
    origin: "pre-existing",
    originClass: "reintroduced",
    sinceRound: 7,
  };

  it("phase 1: the representative's whole provenance tuple survives", () => {
    const merged = phase1(REP_PROVENANCE, OTHER_PROVENANCE);
    for (const [key, value] of Object.entries(REP_PROVENANCE)) {
      expect(merged[key], `${key} came from the wrong member`).toEqual(value);
    }
  });

  it("phase 1: a reintroduced non-representative does NOT change originClass", () => {
    const merged = phase1({ originClass: "new" }, { originClass: "reintroduced" });
    expect(merged.originClass).toBe("new");
  });

  it("phase 1: a non-representative's provenance is NOT borrowed into an absence", () => {
    const merged = phase1({}, OTHER_PROVENANCE);
    for (const key of Object.keys(OTHER_PROVENANCE)) {
      expect(Object.hasOwn(merged, key), `${key} was borrowed`).toBe(false);
    }
  });

  it("phase 2: both provenance directions hold across a cluster merge", () => {
    const kept = phase2(REP_PROVENANCE, OTHER_PROVENANCE);
    for (const [key, value] of Object.entries(REP_PROVENANCE)) {
      expect(kept[key], `${key} came from the wrong member`).toEqual(value);
    }
    const absent = phase2({}, OTHER_PROVENANCE);
    for (const key of Object.keys(OTHER_PROVENANCE)) {
      expect(Object.hasOwn(absent, key), `${key} was borrowed`).toBe(false);
    }
  });
});

describe("T-487 S3: the preamble asks for principle", () => {
  function render(): string {
    return renderSharedPreamble({
      stage: "PLAN_REVIEW",
      artifact: "plan",
      ticketDescription: null,
      reviewRound: 1,
      priorDeferrals: [],
      lensId: "clean-code",
      lensVersion: "v1",
      findingBudget: 10,
      confidenceFloor: 0.6,
    } as never);
  }

  it("lists principle in the finding-format example", () => {
    expect(render()).toContain('"principle"');
  });

  it("tells the lens to omit rather than guess", () => {
    const out = render();
    expect(out).toContain("review contract");
    expect(out).toContain("Omit `principle`");
    expect(out).toContain("never guess");
    expect(out).toContain("lowercase");
  });

  it("does NOT describe principle or snippet as mandatory", () => {
    const out = render();
    // The old wording claimed every listed field was required, which was
    // already false for `snippet` before this change added a second optional.
    expect(out).not.toContain("must have exactly these fields");
    expect(out).toContain("field below is required except `snippet` and `principle`");
  });

  it("hashLensPrompt is sensitive to the instruction text", () => {
    // Named for what it proves and nothing more. This is hash sensitivity in
    // isolation: it would still pass if production prompt construction dropped
    // the preamble, or if the cache stopped keying on the full prompt. The
    // test below is the one that closes those two gaps.
    const out = render();
    const marker = "never guess";
    expect(out).toContain(marker);
    expect(hashLensPrompt(out)).not.toBe(hashLensPrompt(out.replace(marker, "")));
  });
});

/**
 * What this covers, stated at exactly its real width because an earlier
 * revision claimed more than it proved.
 *
 * COVERED: the instruction reaches the prompt `buildLensPrompt` actually
 * produces, and a cache entry written under the pre-instruction prompt's key
 * is not readable under the current prompt's key. That is production PROMPT
 * CONSTRUCTION plus cache-key separation.
 *
 * NOT COVERED: the production cache CALLER. This supplies `hashLensPrompt(prompt)`
 * to `writeLensCache` and `readLensCache` itself, so it would still pass if
 * `lens_review_start` hashed the artifact alone, or hashed some other string,
 * when it looks a lens up. Closing that needs a test driving the MCP tool, and
 * it is not claimed here.
 *
 * Nothing evicts. The old entry stays on disk and simply stops being looked
 * up under the new key, which is what stops a principle-less cached result
 * being served to a consumer that caps on the absence.
 */
describe("T-487 S3: an entry keyed on the pre-change prompt is not found under the new one", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lenses-t487-cache-"));
    process.env.LENSES_LENS_CACHE_DIR = dir;
    delete process.env.LENSES_LENS_CACHE_TTL_MS;
    delete process.env.LENSES_LENS_CACHE_DISABLE;
  });

  afterEach(() => {
    delete process.env.LENSES_LENS_CACHE_DIR;
    delete process.env.LENSES_LENS_CACHE_TTL_MS;
    delete process.env.LENSES_LENS_CACHE_DISABLE;
    rmSync(dir, { recursive: true, force: true });
  });

  function productionPrompt(): string {
    return buildLensPrompt({
      activation: {
        lensId: "clean-code",
        model: "sonnet",
        activationReason: "CORE lens, always active",
        opts: {},
      },
      startParams: {
        stage: "CODE_REVIEW",
        artifact: CODE_DIFF,
        changedFiles: ["src/x.ts"],
        ticketDescription: null,
        reviewRound: 1,
        priorDeferrals: [],
      },
      preambleConfig: { findingBudget: 10, confidenceFloor: 0.6 },
    } as never).prompt;
  }

  it("carries the instruction into the prompt production actually builds", () => {
    const prompt = productionPrompt();
    expect(prompt).toContain("never guess");
    expect(prompt).toContain('"principle"');
  });

  it("does not serve an entry written under the pre-instruction prompt", () => {
    const prompt = productionPrompt();
    const instruction = prompt.slice(
      prompt.indexOf("If the Context section below"),
      prompt.indexOf("never guess a principle, and never name one the finding's own `description` does not support.")
        + "never guess a principle, and never name one the finding's own `description` does not support.".length,
    );
    expect(instruction.length).toBeGreaterThan(80);

    // The prompt this same review would have produced BEFORE the instruction
    // existed, and the cache entry a lens run against it would have written:
    // a clean review naming no principle.
    const beforePrompt = prompt.replace(instruction, "");
    expect(beforePrompt).not.toContain("never guess");
    writeLensCache({
      lensId: "clean-code",
      promptHash: hashLensPrompt(beforePrompt),
      findings: [],
      notes: "written before the principle instruction existed",
    });

    // Reachable under its own key, so the fixture is real and not a no-op
    // write that would make the next assertion vacuous.
    expect(readLensCache("clean-code", hashLensPrompt(beforePrompt))).toBeDefined();

    // ...and NOT reachable under the key the current prompt produces.
    expect(readLensCache("clean-code", hashLensPrompt(prompt))).toBeUndefined();
  });
});
