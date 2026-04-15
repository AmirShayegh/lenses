import { describe, expect, it } from "vitest";

import type { LensId } from "../src/lenses/prompts/index.js";
import { dedupeFindings } from "../src/merger/dedup.js";
import type { LensRunResult } from "../src/merger/pipeline.js";
import type { LensFinding, LensOutput, Severity } from "../src/schema/index.js";

function finding(
  severity: Severity,
  overrides: Partial<LensFinding> = {},
): LensFinding {
  return {
    id: overrides.id ?? `f-${severity}`,
    severity,
    category: overrides.category ?? "generic",
    file: overrides.file ?? null,
    line: overrides.line ?? null,
    description: overrides.description ?? "",
    suggestion: overrides.suggestion ?? "",
    confidence: overrides.confidence ?? 0.8,
    ...overrides,
  };
}

function ok(findings: LensFinding[] = []): LensOutput {
  return { status: "ok", findings, error: null, notes: null };
}

function errored(message: string): LensOutput {
  return { status: "error", findings: [], error: message, notes: null };
}

function skipped(reason: string): LensOutput {
  return { status: "skipped", findings: [], error: null, notes: reason };
}

function lens(lensId: LensId, output: LensOutput): LensRunResult {
  return { lensId, output };
}

describe("dedupeFindings -- trivial cases", () => {
  it("empty perLens returns []", () => {
    expect(dedupeFindings([])).toEqual([]);
  });

  it("single lens with a single finding → one merged with contributingLenses=[lensId]", () => {
    const merged = dedupeFindings([
      lens(
        "security",
        ok([
          finding("major", {
            id: "s-1",
            file: "src/a.ts",
            line: 10,
            category: "auth",
          }),
        ]),
      ),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.id).toBe("s-1");
    expect(merged[0]!.contributingLenses).toEqual(["security"]);
  });
});

describe("dedupeFindings -- cross-lens dedup", () => {
  it("two lenses same (file, line, category), higher confidence wins; contributingLenses in first-seen order", () => {
    const merged = dedupeFindings([
      lens(
        "security",
        ok([
          finding("major", {
            id: "sec-1",
            file: "src/x.ts",
            line: 12,
            category: "auth",
            confidence: 0.6,
            description: "sec desc",
          }),
        ]),
      ),
      lens(
        "clean-code",
        ok([
          finding("minor", {
            id: "cc-1",
            file: "src/x.ts",
            line: 12,
            category: "auth",
            confidence: 0.9,
            description: "cc desc",
          }),
        ]),
      ),
    ]);
    expect(merged).toHaveLength(1);
    // Winner = clean-code (higher confidence).
    expect(merged[0]!.id).toBe("cc-1");
    expect(merged[0]!.severity).toBe("minor");
    expect(merged[0]!.confidence).toBeCloseTo(0.9);
    expect(merged[0]!.description).toBe("cc desc");
    // First-seen lens first.
    expect(merged[0]!.contributingLenses).toEqual(["security", "clean-code"]);
  });

  it("confidence tie → first-seen wins (stable tiebreak)", () => {
    const merged = dedupeFindings([
      lens(
        "security",
        ok([
          finding("major", {
            id: "sec-1",
            file: "src/x.ts",
            line: 7,
            category: "auth",
            confidence: 0.75,
          }),
        ]),
      ),
      lens(
        "clean-code",
        ok([
          finding("minor", {
            id: "cc-1",
            file: "src/x.ts",
            line: 7,
            category: "auth",
            confidence: 0.75,
          }),
        ]),
      ),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.id).toBe("sec-1");
    expect(merged[0]!.severity).toBe("major");
    expect(merged[0]!.contributingLenses).toEqual(["security", "clean-code"]);
  });

  it("same (file, line) but different categories → two separate merged findings", () => {
    const merged = dedupeFindings([
      lens(
        "security",
        ok([
          finding("major", {
            id: "sec-1",
            file: "src/x.ts",
            line: 10,
            category: "auth",
          }),
        ]),
      ),
      lens(
        "clean-code",
        ok([
          finding("minor", {
            id: "cc-1",
            file: "src/x.ts",
            line: 10,
            category: "naming",
          }),
        ]),
      ),
    ]);
    expect(merged).toHaveLength(2);
    const categories = merged.map((m) => m.category).sort();
    expect(categories).toEqual(["auth", "naming"]);
  });

  it("same (file, category) with line=null across lenses → merged", () => {
    const merged = dedupeFindings([
      lens(
        "clean-code",
        ok([
          finding("minor", {
            id: "cc-1",
            file: "src/x.ts",
            line: null,
            category: "dead-code",
            confidence: 0.5,
          }),
        ]),
      ),
      lens(
        "performance",
        ok([
          finding("major", {
            id: "perf-1",
            file: "src/x.ts",
            line: null,
            category: "dead-code",
            confidence: 0.95,
          }),
        ]),
      ),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.id).toBe("perf-1");
    expect(merged[0]!.severity).toBe("major");
    expect(merged[0]!.contributingLenses).toEqual([
      "clean-code",
      "performance",
    ]);
  });

  it("file=null findings are NOT deduped across lenses (no locality)", () => {
    const merged = dedupeFindings([
      lens(
        "clean-code",
        ok([
          finding("minor", {
            id: "cc-1",
            file: null,
            line: null,
            category: "coverage-gap",
          }),
        ]),
      ),
      lens(
        "test-quality",
        ok([
          finding("major", {
            id: "tq-1",
            file: null,
            line: null,
            category: "coverage-gap",
          }),
        ]),
      ),
    ]);
    expect(merged).toHaveLength(2);
    const lensLists = merged.map((m) => m.contributingLenses);
    expect(lensLists).toEqual([["clean-code"], ["test-quality"]]);
  });
});

describe("dedupeFindings -- within-lens dedup", () => {
  it("same lens reports same (file, line, category) twice → merged; contributingLenses has the lens once", () => {
    const merged = dedupeFindings([
      lens(
        "security",
        ok([
          finding("major", {
            id: "sec-1",
            file: "src/x.ts",
            line: 3,
            category: "auth",
            confidence: 0.8,
          }),
          finding("minor", {
            id: "sec-2",
            file: "src/x.ts",
            line: 3,
            category: "auth",
            confidence: 0.5,
          }),
        ]),
      ),
    ]);
    expect(merged).toHaveLength(1);
    // First-seen of the two within-lens findings wins (higher confidence
    // here anyway, and also first).
    expect(merged[0]!.id).toBe("sec-1");
    expect(merged[0]!.contributingLenses).toEqual(["security"]);
  });
});

describe("dedupeFindings -- status=error/skipped", () => {
  it("error and skipped statuses contribute nothing", () => {
    const merged = dedupeFindings([
      lens("security", errored("parse failure")),
      lens("performance", skipped("not in surface")),
      lens(
        "clean-code",
        ok([
          finding("major", {
            id: "cc-1",
            file: "src/a.ts",
            line: 4,
            category: "naming",
          }),
        ]),
      ),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.id).toBe("cc-1");
    expect(merged[0]!.contributingLenses).toEqual(["clean-code"]);
  });
});

describe("dedupeFindings -- ordering determinism", () => {
  it("file=null findings precede keyed buckets; keyed buckets in first-insertion order", () => {
    const merged = dedupeFindings([
      lens(
        "clean-code",
        ok([
          finding("minor", {
            id: "cc-null",
            file: null,
            line: null,
            category: "general",
          }),
          finding("major", {
            id: "cc-b",
            file: "src/b.ts",
            line: 5,
            category: "naming",
          }),
        ]),
      ),
      lens(
        "security",
        ok([
          finding("major", {
            id: "sec-a",
            file: "src/a.ts",
            line: 1,
            category: "auth",
          }),
        ]),
      ),
    ]);
    expect(merged.map((m) => m.id)).toEqual(["cc-null", "cc-b", "sec-a"]);
  });

  it("result is deterministic across repeated identical calls", () => {
    const input: readonly LensRunResult[] = [
      lens(
        "security",
        ok([
          finding("major", {
            id: "sec-1",
            file: "src/x.ts",
            line: 10,
            category: "auth",
            confidence: 0.7,
          }),
        ]),
      ),
      lens(
        "clean-code",
        ok([
          finding("minor", {
            id: "cc-1",
            file: "src/x.ts",
            line: 10,
            category: "auth",
            confidence: 0.9,
          }),
        ]),
      ),
    ];
    const a = dedupeFindings(input);
    const b = dedupeFindings(input);
    expect(a).toEqual(b);
  });
});

describe("dedupeFindings -- known T-010 trade-off", () => {
  it("major blocker with lower confidence is displaced by minor with higher confidence (severity copied from winner)", () => {
    const merged = dedupeFindings([
      lens(
        "security",
        ok([
          finding("blocking", {
            id: "sec-1",
            file: "src/x.ts",
            line: 10,
            category: "auth",
            confidence: 0.6,
          }),
        ]),
      ),
      lens(
        "clean-code",
        ok([
          finding("minor", {
            id: "cc-1",
            file: "src/x.ts",
            line: 10,
            category: "auth",
            confidence: 0.95,
          }),
        ]),
      ),
    ]);
    expect(merged).toHaveLength(1);
    // Trade-off: minor wins because confidence is higher.
    // T-011 will layer blocking policy to address this.
    expect(merged[0]!.severity).toBe("minor");
    expect(merged[0]!.id).toBe("cc-1");
    expect(merged[0]!.contributingLenses).toEqual(["security", "clean-code"]);
  });
});

describe("dedupeFindings -- key separator robustness", () => {
  it("distinct (file, line, category) tuples that string-concatenate similarly do not collide", () => {
    // Without a separator, ("a", 12, "b") and ("a1", 2, "b") would both
    // render to "a12b". With `\x00` separators, they cannot collide.
    const merged = dedupeFindings([
      lens(
        "security",
        ok([
          finding("major", {
            id: "x1",
            file: "a",
            line: 12,
            category: "b",
          }),
        ]),
      ),
      lens(
        "clean-code",
        ok([
          finding("major", {
            id: "x2",
            file: "a1",
            line: 2,
            category: "b",
          }),
        ]),
      ),
    ]);
    expect(merged).toHaveLength(2);
  });
});
