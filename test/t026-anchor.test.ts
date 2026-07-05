import { describe, it, expect } from "vitest";

import {
  buildNewSideIndex,
  normalizeRepoPath,
  sanitizeFindingForStorage,
  verifyAnchors,
  type AnchoringInput,
} from "../src/merger/anchor.js";
import { runMergerPipeline, type LensRunResult } from "../src/merger/pipeline.js";
import {
  DEFAULT_ALWAYS_BLOCK,
  ReviewVerdictSchema,
  SnippetSchema,
  type LensFinding,
  type LensOutput,
  type Severity,
} from "../src/schema/index.js";

const FLOOR = 0.6;
const ALWAYS_BLOCK = [...DEFAULT_ALWAYS_BLOCK];

function finding(overrides: Partial<LensFinding> = {}): LensFinding {
  return {
    id: overrides.id ?? "f1",
    severity: overrides.severity ?? "major",
    category: overrides.category ?? "generic",
    file: overrides.file ?? "src/x.ts",
    line: overrides.line ?? 1,
    description: overrides.description ?? "",
    suggestion: overrides.suggestion ?? "",
    confidence: overrides.confidence ?? 0.8,
    ...overrides,
  };
}

function ok(lensId: string, findings: LensFinding[]): LensRunResult {
  return {
    lensId: lensId as LensRunResult["lensId"],
    output: { status: "ok", findings, error: null, notes: null } as LensOutput,
  };
}

// A diff whose new side for src/x.ts is:
//   1: line one
//   2: const secret = "hardcoded";
//   3: doStuff();
//   4: moreStuff();
//   5: line two
//   6: line three
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

function codeAnchoring(
  overrides: Partial<AnchoringInput> = {},
): AnchoringInput {
  return {
    stage: "CODE_REVIEW",
    artifact: CODE_DIFF,
    changedFiles: ["src/x.ts"],
    ...overrides,
  };
}

function run(
  perLens: LensRunResult[],
  anchoring: AnchoringInput | undefined,
) {
  return verifyAnchors({
    perLens,
    ...(anchoring !== undefined ? { anchoring } : {}),
    alwaysBlock: ALWAYS_BLOCK,
    confidenceFloor: FLOOR,
  });
}

describe("normalizeRepoPath (R-D3)", () => {
  it("converts backslashes to forward slashes", () => {
    expect(normalizeRepoPath("src\\x.ts")).toBe("src/x.ts");
  });
  it("strips leading ./ segments repeatedly", () => {
    expect(normalizeRepoPath("./src/x.ts")).toBe("src/x.ts");
    expect(normalizeRepoPath("././src/x.ts")).toBe("src/x.ts");
  });
  it("collapses consecutive slashes", () => {
    expect(normalizeRepoPath("src//deep///x.ts")).toBe("src/deep/x.ts");
  });
  it("is a comparison key only: no case folding or .. resolution", () => {
    expect(normalizeRepoPath("SRC/../X.ts")).toBe("SRC/../X.ts");
  });
});

describe("buildNewSideIndex (R-C3 hunk bounding)", () => {
  it("indexes only the declared new-side lines of each hunk", () => {
    const idx = buildNewSideIndex(CODE_DIFF);
    const file = idx.get("src/x.ts");
    expect(file).toBeDefined();
    expect(file!.get(1)).toBe("line one");
    expect(file!.get(3)).toBe("doStuff();");
    expect(file!.get(6)).toBe("line three");
    expect(file!.has(7)).toBe(false);
  });

  it("a blank separator line never extends a closed hunk into the next file (R-C3)", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,1 +1,2 @@",
      " alpha",
      "+beta",
      "", // genuinely blank separator, OUTSIDE the (now closed) hunk
      "diff --git a/b.ts b/b.ts",
      "--- a/b.ts",
      "+++ b/b.ts",
      "@@ -1,1 +1,2 @@",
      " gamma",
      "+delta",
    ].join("\n");
    const idx = buildNewSideIndex(diff);
    const a = idx.get("a.ts")!;
    expect([...a.keys()].sort((x, y) => x - y)).toEqual([1, 2]);
    expect(a.has(3)).toBe(false); // one past the declared hunk end
    const b = idx.get("b.ts")!;
    expect([...b.keys()].sort((x, y) => x - y)).toEqual([1, 2]);
    expect(b.get(2)).toBe("delta");
  });

  it("a deletion (+++ /dev/null) creates no index entry (R-D3e)", () => {
    const diff = [
      "diff --git a/gone.ts b/gone.ts",
      "--- a/gone.ts",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-was here",
      "-and here",
    ].join("\n");
    const idx = buildNewSideIndex(diff);
    expect(idx.has("gone.ts")).toBe(false);
    expect(idx.has("/dev/null")).toBe(false);
  });

  it("a hunk content line colliding with a header prefix is recorded as content, not structure", () => {
    // Added source line "++ more" -> diff line "+++ more"; the +++ header
    // prefix must NOT swallow it while the hunk still has budget.
    const diff = [
      "diff --git a/c.ts b/c.ts",
      "--- a/c.ts",
      "+++ b/c.ts",
      "@@ -1,1 +1,3 @@",
      " one",
      "+++ more",
      "+two",
    ].join("\n");
    const idx = buildNewSideIndex(diff);
    const file = idx.get("c.ts")!;
    expect(file.get(1)).toBe("one");
    expect(file.get(2)).toBe("++ more"); // marker stripped, content kept
    expect(file.get(3)).toBe("two");
    expect(file.has(4)).toBe(false);
  });

  it("no-prefix diffs are honored when the header lacks a/ b/ (pen res 3)", () => {
    const diff = [
      "diff --git src/x.ts src/x.ts",
      "--- src/x.ts",
      "+++ src/x.ts",
      "@@ -1,1 +1,2 @@",
      " keep",
      "+add",
    ].join("\n");
    const idx = buildNewSideIndex(diff);
    expect(idx.get("src/x.ts")!.get(2)).toBe("add");
  });

  it("decodes git C-style quoted paths so index keys equal real repo paths (codex round)", () => {
    const diff = [
      'diff --git "a/src/with space.ts" "b/src/with space.ts"',
      '--- "a/src/with space.ts"',
      '+++ "b/src/with space.ts"',
      "@@ -1,1 +1,2 @@",
      " keep",
      "+added",
    ].join("\n");
    const idx = buildNewSideIndex(diff);
    expect(idx.has("src/with space.ts")).toBe(true);
    expect(idx.get("src/with space.ts")!.get(2)).toBe("added");
  });

  it("decodes octal escapes (non-ASCII bytes) in quoted paths", () => {
    // git core.quotePath=true emits UTF-8 bytes as octal: caf\303\251 is
    // "cafe" with an accented e.
    const diff = [
      'diff --git "a/src/caf\\303\\251.ts" "b/src/caf\\303\\251.ts"',
      '--- "a/src/caf\\303\\251.ts"',
      '+++ "b/src/caf\\303\\251.ts"',
      "@@ -1,1 +1,2 @@",
      " keep",
      "+accent",
    ].join("\n");
    const idx = buildNewSideIndex(diff);
    expect(idx.has("src/café.ts")).toBe(true);
    expect(idx.get("src/café.ts")!.get(2)).toBe("accent");
  });

  it("decodes tab and quote escapes in quoted paths", () => {
    const diff = [
      'diff --git "a/src/tab\\there.ts" "b/src/tab\\there.ts"',
      '--- "a/src/tab\\there.ts"',
      '+++ "b/src/tab\\there.ts"',
      "@@ -1,1 +1,2 @@",
      " keep",
      "+tabbed",
    ].join("\n");
    const idx = buildNewSideIndex(diff);
    expect(idx.has("src/tab\there.ts")).toBe(true);

    const diff2 = [
      'diff --git "a/src/q\\"uote.ts" "b/src/q\\"uote.ts"',
      '--- "a/src/q\\"uote.ts"',
      '+++ "b/src/q\\"uote.ts"',
      "@@ -1,1 +1,2 @@",
      " keep",
      "+quoted",
    ].join("\n");
    const idx2 = buildNewSideIndex(diff2);
    expect(idx2.has('src/q"uote.ts')).toBe(true);
  });

  it("mixed quoted/unquoted diff --git header still confirms the prefix form", () => {
    // git quotes each side independently; a rename to a spaced name quotes
    // only the b-side.
    const diff = [
      'diff --git a/old.ts "b/new name.ts"',
      "rename from old.ts",
      "rename to new name.ts",
      "--- a/old.ts",
      '+++ "b/new name.ts"',
      "@@ -1,1 +1,2 @@",
      " keep",
      "+fresh",
    ].join("\n");
    const idx = buildNewSideIndex(diff);
    expect(idx.has("new name.ts")).toBe(true);
    expect(idx.get("new name.ts")!.get(2)).toBe("fresh");
  });
});

describe("verifyAnchors quoted-path enforcement (codex minor 3)", () => {
  it("a finding on a quoted-path file gates against the DECODED index key (deferred, not passed through)", () => {
    const diff = [
      'diff --git "a/src/with space.ts" "b/src/with space.ts"',
      '--- "a/src/with space.ts"',
      '+++ "b/src/with space.ts"',
      "@@ -1,1 +1,2 @@",
      " keep",
      "+added",
    ].join("\n");
    const f = finding({
      id: "q",
      severity: "minor",
      file: "src/with space.ts",
      line: 2,
      snippet: { quote: "not present anywhere", startLine: 2 },
    });
    const res = run([ok("security", [f])], {
      stage: "CODE_REVIEW",
      artifact: diff,
      changedFiles: ["src/with space.ts"],
    });
    expect(res.perLens[0]!.output.findings).toHaveLength(0);
    expect(res.deferred).toHaveLength(1);
    expect(res.deferred[0]!.reason).toBe("evidence_unverified");
  });
});

describe("sanitizeFindingForStorage (R-C2 / R-D4b)", () => {
  it("strips server-owned anchorRealignedFrom and integrityKey", () => {
    const dirty = finding({
      anchorRealignedFrom: 999,
      integrityKey: "ie-1",
    });
    const clean = sanitizeFindingForStorage(dirty);
    expect("anchorRealignedFrom" in clean).toBe(false);
    expect("integrityKey" in clean).toBe(false);
    expect(clean.id).toBe("f1");
  });
  it("preserves reference identity when no server field is present", () => {
    const f = finding();
    expect(sanitizeFindingForStorage(f)).toBe(f);
  });
});

describe("SnippetSchema", () => {
  it("accepts a 400-char quote and rejects 401", () => {
    expect(
      SnippetSchema.safeParse({ quote: "x".repeat(400), startLine: 1 }).success,
    ).toBe(true);
    expect(
      SnippetSchema.safeParse({ quote: "x".repeat(401), startLine: 1 }).success,
    ).toBe(false);
  });
  it("rejects empty quote and non-positive startLine", () => {
    expect(SnippetSchema.safeParse({ quote: "", startLine: 1 }).success).toBe(
      false,
    );
    expect(
      SnippetSchema.safeParse({ quote: "a", startLine: 0 }).success,
    ).toBe(false);
  });
});

describe("verifyAnchors realignment (SCOPE 3, acceptance 1)", () => {
  it("realigns a finding whose quote sits 3 lines below the reported line", () => {
    const f = finding({
      line: 1,
      snippet: { quote: "moreStuff();", startLine: 1 },
    });
    const res = run([ok("security", [f])], codeAnchoring());
    const emitted = res.perLens[0]!.output.findings[0]!;
    expect(emitted.line).toBe(4);
    expect(emitted.anchorRealignedFrom).toBe(1);
    expect(emitted.snippet!.startLine).toBe(4);
    expect(res.realignedCount).toBe(1);
    expect(res.deferred.length).toBe(0);
  });

  it("verifies without realigning when the quote already sits at the claimed line", () => {
    const f = finding({
      line: 3,
      snippet: { quote: "doStuff();", startLine: 3 },
    });
    const res = run([ok("security", [f])], codeAnchoring());
    const emitted = res.perLens[0]!.output.findings[0]!;
    expect(emitted.line).toBe(3);
    expect(emitted.anchorRealignedFrom).toBeUndefined();
    expect(res.realignedCount).toBe(0);
  });

  it("matches a >400-char source line by its 400-char prefix (R3)", () => {
    const longLine = "L" + "o".repeat(500);
    const diff = [
      "diff --git a/big.ts b/big.ts",
      "--- a/big.ts",
      "+++ b/big.ts",
      "@@ -1,1 +1,2 @@",
      " head",
      "+" + longLine,
    ].join("\n");
    const f = finding({
      file: "big.ts",
      line: 1,
      snippet: { quote: longLine.slice(0, 400), startLine: 1 },
    });
    const res = run([ok("security", [f])], {
      stage: "CODE_REVIEW",
      artifact: diff,
      changedFiles: ["big.ts"],
    });
    const emitted = res.perLens[0]!.output.findings[0]!;
    expect(emitted.line).toBe(2);
    expect(emitted.anchorRealignedFrom).toBe(1);
  });
});

describe("verifyAnchors R6 survive-or-defer routing", () => {
  it("survives-and-flags a blocking finding with a non-matching snippet (acceptance 2)", () => {
    const f = finding({
      id: "b1",
      severity: "blocking",
      category: "generic",
      confidence: 0.9,
      line: 2,
      snippet: { quote: "not present in the diff at all", startLine: 2 },
    });
    const res = run([ok("security", [f])], codeAnchoring());
    const emitted = res.perLens[0]!.output.findings[0]!;
    expect(emitted.line).toBeNull();
    expect(emitted.integrityKey).toBe("ie-1");
    expect(res.integrityEntries).toHaveLength(1);
    const entry = res.integrityEntries[0]!;
    expect(entry.findingId).toBe("b1");
    expect(entry.file).toBe("src/x.ts");
    expect(entry.line).toBe(2);
    expect(entry.category).toBe("generic");
    expect(entry.integrityKey).toBe("ie-1");
    expect(res.deferred.length).toBe(0);
  });

  it("defers a minor finding with an absent snippet (acceptance 3), preserving its line", () => {
    const f = finding({ id: "m1", severity: "minor", line: 5, snippet: undefined });
    const res = run([ok("security", [f])], codeAnchoring());
    expect(res.perLens[0]!.output.findings).toHaveLength(0);
    expect(res.deferred).toHaveLength(1);
    expect(res.deferred[0]!.reason).toBe("evidence_unverified");
    expect(res.deferred[0]!.finding.line).toBe(5);
    expect(res.evidenceUnverifiedCount).toBe(1);
  });

  it("defers low-confidence unverified blocking and major (no alwaysBlock) as evidence_unverified (R6)", () => {
    const b = finding({
      id: "lb",
      severity: "blocking",
      category: "generic",
      confidence: 0.5,
      line: 2,
      snippet: { quote: "nope", startLine: 2 },
    });
    const m = finding({
      id: "lm",
      severity: "major",
      category: "generic",
      confidence: 0.5,
      line: 2,
      snippet: { quote: "nope either", startLine: 2 },
    });
    const res = run([ok("security", [b, m])], codeAnchoring());
    expect(res.integrityEntries).toHaveLength(0);
    expect(res.deferred).toHaveLength(2);
    for (const d of res.deferred) expect(d.reason).toBe("evidence_unverified");
  });

  it("survives-and-flags an alwaysBlock category regardless of low confidence (R6)", () => {
    const f = finding({
      id: "inj",
      severity: "minor",
      category: "injection",
      confidence: 0.1,
      line: 2,
      snippet: { quote: "nope", startLine: 2 },
    });
    const res = run([ok("security", [f])], codeAnchoring());
    expect(res.integrityEntries).toHaveLength(1);
    expect(res.deferred).toHaveLength(0);
  });
});

describe("verifyAnchors R2 file-level enforcement gate", () => {
  it("(a) a blocking finding on an out-of-index file survives with its line intact and no integrity entry", () => {
    const f = finding({
      id: "oob",
      severity: "blocking",
      category: "generic",
      confidence: 0.9,
      file: "src/unchanged.ts",
      line: 42,
      snippet: { quote: "whatever", startLine: 42 },
    });
    const res = run([ok("security", [f])], codeAnchoring());
    const emitted = res.perLens[0]!.output.findings[0]!;
    expect(emitted.line).toBe(42);
    expect(emitted.integrityKey).toBeUndefined();
    expect(res.integrityEntries).toHaveLength(0);
    expect(res.deferred).toHaveLength(0);
  });

  it("(b) a minor finding on an out-of-index file is not deferred", () => {
    const f = finding({
      id: "oob2",
      severity: "minor",
      file: "src/unchanged.ts",
      line: 42,
      snippet: undefined,
    });
    const res = run([ok("security", [f])], codeAnchoring());
    expect(res.perLens[0]!.output.findings).toHaveLength(1);
    expect(res.deferred).toHaveLength(0);
  });

  it("gate is file-level: an out-of-hunk claimed line in an IN-index file whose quote fails routes per R6 (R-C1)", () => {
    // claimed line 99 is far outside the hunk, quote not present -> defer (minor)
    const f = finding({
      id: "far",
      severity: "minor",
      file: "src/x.ts",
      line: 99,
      snippet: { quote: "absent", startLine: 99 },
    });
    const res = run([ok("security", [f])], codeAnchoring());
    expect(res.deferred).toHaveLength(1);
    expect(res.deferred[0]!.reason).toBe("evidence_unverified");
  });

  it("strips server-owned fields even on out-of-index pass-through (R2)", () => {
    const f = finding({
      id: "p",
      file: "src/unchanged.ts",
      line: 3,
      anchorRealignedFrom: 111,
      integrityKey: "ie-hack",
      snippet: undefined,
    });
    const res = run([ok("security", [f])], codeAnchoring());
    const emitted = res.perLens[0]!.output.findings[0]!;
    expect(emitted.anchorRealignedFrom).toBeUndefined();
    expect(emitted.integrityKey).toBeUndefined();
  });
});

describe("verifyAnchors R-D3 path normalization at the gate", () => {
  it("(b) a finding on ./src/x.ts gates against the src/x.ts index entry (enforced, not passed through)", () => {
    const f = finding({
      id: "dot",
      severity: "minor",
      file: "./src/x.ts",
      line: 2,
      snippet: { quote: "absent quote", startLine: 2 },
    });
    const res = run([ok("security", [f])], codeAnchoring());
    // enforced: deferred (not a pass-through)
    expect(res.deferred).toHaveLength(1);
    // emitted finding keeps its original file string byte-for-byte
    expect(res.perLens[0]!.output.findings).toHaveLength(0);
    expect(res.deferred[0]!.finding.file).toBe("./src/x.ts");
  });

  it("(d) a finding on the OLD path of a rename passes through (only new-side path is indexed)", () => {
    const diff = [
      "diff --git a/old.ts b/new.ts",
      "similarity index 90%",
      "rename from old.ts",
      "rename to new.ts",
      "--- a/old.ts",
      "+++ b/new.ts",
      "@@ -1,1 +1,2 @@",
      " keep",
      "+added",
    ].join("\n");
    const f = finding({ id: "ren", severity: "minor", file: "old.ts", line: 1 });
    const res = run([ok("security", [f])], {
      stage: "CODE_REVIEW",
      artifact: diff,
      changedFiles: ["new.ts"],
    });
    // old.ts is not in the new-side index -> pass through
    expect(res.perLens[0]!.output.findings).toHaveLength(1);
    expect(res.deferred).toHaveLength(0);
  });
});

describe("verifyAnchors anchorUnindexedFiles (R-D1 / R-D3)", () => {
  it("lists changedFiles entries absent from the diff, normalized/sorted/deduped", () => {
    const res = run([ok("security", [])], {
      stage: "CODE_REVIEW",
      artifact: CODE_DIFF,
      changedFiles: ["src\\x.ts", "./missing.ts", "missing.ts", "zed.ts"],
    });
    // src/x.ts is indexed; the two spellings of missing.ts collapse to one.
    expect(res.anchorUnindexedFiles).toEqual(["missing.ts", "zed.ts"]);
  });
  it("is empty in normalize-only mode", () => {
    const res = run([ok("security", [])], undefined);
    expect(res.anchorUnindexedFiles).toEqual([]);
  });
});

describe("verifyAnchors normalize-only mode (R1 / R10)", () => {
  it("PLAN_REVIEW: a finding whose quote appears elsewhere in the plan is NOT realigned/deferred/flagged (R1)", () => {
    const plan = "## Plan\nalpha\nbeta\nmoreStuff();\ngamma\n";
    const f = finding({
      file: "src/x.ts",
      line: 42,
      snippet: { quote: "moreStuff();", startLine: 42 },
    });
    const res = run([ok("security", [f])], {
      stage: "PLAN_REVIEW",
      artifact: plan,
      changedFiles: [],
    });
    const emitted = res.perLens[0]!.output.findings[0]!;
    expect(emitted.line).toBe(42);
    expect(emitted.anchorRealignedFrom).toBeUndefined();
    expect(res.deferred).toHaveLength(0);
    expect(res.integrityEntries).toHaveLength(0);
    expect(res.realignedCount).toBe(0);
  });

  it("empty artifact -> normalize-only even for CODE_REVIEW (R10), but still strips server fields", () => {
    const f = finding({
      file: "src/x.ts",
      line: 2,
      anchorRealignedFrom: 5,
      snippet: { quote: "doStuff();", startLine: 2 },
    });
    const res = run([ok("security", [f])], {
      stage: "CODE_REVIEW",
      artifact: "",
      changedFiles: ["src/x.ts"],
    });
    const emitted = res.perLens[0]!.output.findings[0]!;
    expect(emitted.line).toBe(2);
    expect(emitted.anchorRealignedFrom).toBeUndefined();
    expect(res.deferred).toHaveLength(0);
  });

  it("non-localized (line null) findings pass through untouched (R10)", () => {
    const f = finding({ file: null, line: null });
    const res = run([ok("security", [f])], codeAnchoring());
    expect(res.perLens[0]!.output.findings).toHaveLength(1);
    expect(res.deferred).toHaveLength(0);
  });
});

describe("R8 / R-D4 integrity entry identity", () => {
  it("duplicate finding ids from two lenses produce two distinguishable integrity entries (R8)", () => {
    const a = finding({
      id: "dup",
      severity: "blocking",
      category: "generic",
      confidence: 0.9,
      line: 2,
      snippet: { quote: "nope", startLine: 2 },
    });
    const b = finding({
      id: "dup",
      severity: "blocking",
      category: "generic",
      confidence: 0.9,
      line: 2,
      snippet: { quote: "nope", startLine: 2 },
    });
    const res = run([ok("security", [a]), ok("clean-code", [b])], codeAnchoring());
    expect(res.integrityEntries).toHaveLength(2);
    const keys = res.integrityEntries.map((e) => e.integrityKey);
    expect(new Set(keys).size).toBe(2);
    const lenses = res.integrityEntries.map((e) => e.lensId).sort();
    expect(lenses).toEqual(["clean-code", "security"]);
  });
});

describe("merger pipeline integration (verdict counts + invariants)", () => {
  function pipe(perLens: LensRunResult[], anchoring: AnchoringInput | undefined) {
    return runMergerPipeline({
      reviewId: "11111111-1111-4111-8111-111111111111",
      sessionId: "22222222-2222-4222-8222-222222222222",
      perLens,
      ...(anchoring !== undefined ? { anchoring } : {}),
    });
  }

  it("realigned finding is emitted with corrected line and counts are on the verdict", () => {
    const f = finding({
      line: 1,
      severity: "minor",
      snippet: { quote: "moreStuff();", startLine: 1 },
    });
    const v = pipe([ok("security", [f])], codeAnchoring());
    ReviewVerdictSchema.parse(v); // superRefine invariants hold
    expect(v.findings[0]!.line).toBe(4);
    expect(v.findings[0]!.anchorRealignedFrom).toBe(1);
    expect(v.anchorRealignedCount).toBe(1);
    expect(v.evidenceUnverifiedCount).toBe(0);
  });

  it("evidence_unverified deferrals land in deferred[] with the count set", () => {
    const f = finding({ id: "m", severity: "minor", line: 5, snippet: undefined });
    const v = pipe([ok("security", [f])], codeAnchoring());
    ReviewVerdictSchema.parse(v);
    expect(v.deferred.some((d) => d.reason === "evidence_unverified")).toBe(true);
    expect(v.evidenceUnverifiedCount).toBe(1);
    expect(v.suppressedFindingCount).toBe(v.deferred.length);
  });

  it("blocking survive+flag surfaces one reviewIntegrity entry resolving to the kept finding", () => {
    const f = finding({
      id: "b",
      severity: "blocking",
      category: "generic",
      confidence: 0.9,
      line: 2,
      snippet: { quote: "nope", startLine: 2 },
    });
    const v = pipe([ok("security", [f])], codeAnchoring());
    ReviewVerdictSchema.parse(v);
    expect(v.reviewIntegrity).toHaveLength(1);
    const key = v.reviewIntegrity[0]!.integrityKey;
    const carriers = v.findings.filter((x) => x.integrityKey === key);
    expect(carriers).toHaveLength(1);
    expect(v.verdict).toBe("reject"); // blocking > 0
  });

  it("(R4) a realigned finding that loses the dedup confidence tiebreak still increments anchorRealignedCount", () => {
    // Two lenses, same (file, line-after-realign, category); the higher
    // confidence one wins dedup, but BOTH were realigned operationally.
    const lo = finding({
      id: "lo",
      severity: "minor",
      category: "generic",
      confidence: 0.7,
      line: 1,
      snippet: { quote: "moreStuff();", startLine: 1 },
    });
    const hi = finding({
      id: "hi",
      severity: "minor",
      category: "generic",
      confidence: 0.9,
      line: 2,
      snippet: { quote: "moreStuff();", startLine: 2 },
    });
    const v = pipe([ok("security", [lo]), ok("clean-code", [hi])], codeAnchoring());
    ReviewVerdictSchema.parse(v);
    // both realign to line 4 and dedupe to one kept finding
    expect(v.findings).toHaveLength(1);
    expect(v.findings[0]!.line).toBe(4);
    expect(v.anchorRealignedCount).toBe(2);
  });

  it("(R-D4) two flagged findings sharing (file, category) yield two entries each resolving to one distinct kept finding", () => {
    const a = finding({
      id: "a",
      severity: "blocking",
      category: "generic",
      confidence: 0.9,
      line: 2,
      snippet: { quote: "nope-a", startLine: 2 },
    });
    const b = finding({
      id: "b",
      severity: "blocking",
      category: "generic",
      confidence: 0.9,
      line: 2,
      snippet: { quote: "nope-b", startLine: 2 },
    });
    const v = pipe([ok("security", [a]), ok("clean-code", [b])], codeAnchoring());
    ReviewVerdictSchema.parse(v);
    expect(v.reviewIntegrity).toHaveLength(2);
    const keys = v.reviewIntegrity.map((e) => e.integrityKey);
    expect(new Set(keys).size).toBe(2);
    for (const k of keys) {
      expect(v.findings.filter((x) => x.integrityKey === k)).toHaveLength(1);
    }
  });

  it("(R-D1) findings on unindexed changedFiles pass through and the file is listed", () => {
    const f = finding({
      id: "u",
      severity: "blocking",
      category: "generic",
      confidence: 0.9,
      file: "src/unchanged.ts",
      line: 7,
      snippet: { quote: "whatever", startLine: 7 },
    });
    const v = pipe([ok("security", [f])], {
      stage: "CODE_REVIEW",
      artifact: CODE_DIFF,
      changedFiles: ["src/x.ts", "src/unchanged.ts"],
    });
    ReviewVerdictSchema.parse(v);
    expect(v.findings[0]!.line).toBe(7);
    expect(v.anchorUnindexedFiles).toEqual(["src/unchanged.ts"]);
  });
});
