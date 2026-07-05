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
    description: overrides.description ?? "d",
    suggestion: overrides.suggestion ?? "s",
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
  it("empty perLens returns empty findings", () => {
    expect(dedupeFindings([]).findings).toEqual([]);
  });

  it("single lens with a single finding -> one merged with contributingLenses=[lensId]", () => {
    const { findings } = dedupeFindings([
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
    expect(findings).toHaveLength(1);
    expect(findings[0]!.id).toBe("s-1");
    expect(findings[0]!.contributingLenses).toEqual(["security"]);
  });
});

describe("dedupeFindings -- cross-lens dedup (severity-max, T-028)", () => {
  it("two lenses same key: winner id/text from higher confidence, severity = max", () => {
    const { findings } = dedupeFindings([
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
    expect(findings).toHaveLength(1);
    // Representative id/text = clean-code (higher confidence).
    expect(findings[0]!.id).toBe("cc-1");
    expect(findings[0]!.description).toBe("cc desc");
    expect(findings[0]!.confidence).toBeCloseTo(0.9);
    // Severity = max(major, minor) = major (corroboration escalates).
    expect(findings[0]!.severity).toBe("major");
    expect(findings[0]!.contributingLenses).toEqual(["security", "clean-code"]);
  });

  it("confidence tie -> higher severity rank wins (R-C5 total order)", () => {
    const { findings } = dedupeFindings([
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
    expect(findings).toHaveLength(1);
    expect(findings[0]!.id).toBe("sec-1");
    expect(findings[0]!.severity).toBe("major");
    expect(findings[0]!.contributingLenses).toEqual(["security", "clean-code"]);
  });

  it("ACCEPTANCE: blocking/0.7 + minor/0.9 merge to blocking severity, both lenses", () => {
    const { findings } = dedupeFindings([
      lens(
        "security",
        ok([
          finding("blocking", {
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
    ]);
    expect(findings).toHaveLength(1);
    // Winner id/text = cc-1 (confidence 0.9); severity = max = blocking.
    expect(findings[0]!.severity).toBe("blocking");
    expect(findings[0]!.id).toBe("cc-1");
    expect(findings[0]!.contributingLenses).toEqual(["security", "clean-code"]);
  });

  it("R-C5 determinism: equal-confidence, submitted in both orders, deep-equal output", () => {
    const a = finding("major", {
      id: "a-1",
      file: "src/x.ts",
      line: 5,
      category: "auth",
      confidence: 0.7,
    });
    const b = finding("major", {
      id: "b-1",
      file: "src/x.ts",
      line: 5,
      category: "auth",
      confidence: 0.7,
    });
    const forward = dedupeFindings([
      lens("security", ok([a])),
      lens("clean-code", ok([b])),
    ]).findings;
    const backward = dedupeFindings([
      lens("clean-code", ok([b])),
      lens("security", ok([a])),
    ]).findings;
    // Winner = smaller lens id asc ("clean-code" < "security") -> b-1.
    expect(forward[0]!.id).toBe("b-1");
    expect(forward[0]!.severity).toBe(backward[0]!.severity);
    expect(forward[0]!.id).toBe(backward[0]!.id);
    expect([...forward[0]!.contributingLenses].sort()).toEqual(
      [...backward[0]!.contributingLenses].sort(),
    );
  });

  it("same (file, line) but different categories -> two separate merged findings", () => {
    const { findings } = dedupeFindings([
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
    expect(findings).toHaveLength(2);
    const categories = findings.map((m) => m.category).sort();
    expect(categories).toEqual(["auth", "naming"]);
  });

  it("same (file, category) with line=null across lenses -> merged (severity max)", () => {
    const { findings } = dedupeFindings([
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
    expect(findings).toHaveLength(1);
    expect(findings[0]!.id).toBe("perf-1");
    expect(findings[0]!.severity).toBe("major");
    expect(findings[0]!.contributingLenses).toEqual([
      "clean-code",
      "performance",
    ]);
  });

  it("file=null findings are NOT deduped across lenses (no locality)", () => {
    const { findings } = dedupeFindings([
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
    expect(findings).toHaveLength(2);
    const lensLists = findings.map((m) => m.contributingLenses);
    expect(lensLists).toEqual([["clean-code"], ["test-quality"]]);
  });
});

describe("dedupeFindings -- within-lens normalization (pen resolution 2)", () => {
  it("same lens same key: severity-rank winner (not confidence), one contributing lens", () => {
    const { findings } = dedupeFindings([
      lens(
        "security",
        ok([
          finding("minor", {
            id: "sec-hi-conf",
            file: "src/x.ts",
            line: 3,
            category: "auth",
            confidence: 0.9,
          }),
          finding("blocking", {
            id: "sec-lo-conf",
            file: "src/x.ts",
            line: 3,
            category: "auth",
            confidence: 0.1,
          }),
        ]),
      ),
    ]);
    expect(findings).toHaveLength(1);
    // Within-lens winner = highest severity rank -> the blocking/0.1 finding.
    // The high-confidence minor is NOT paired with the escalated severity.
    expect(findings[0]!.severity).toBe("blocking");
    expect(findings[0]!.id).toBe("sec-lo-conf");
    expect(findings[0]!.confidence).toBeCloseTo(0.1);
    expect(findings[0]!.contributingLenses).toEqual(["security"]);
  });
});

describe("dedupeFindings -- adjacency clustering (R-C4 / R11)", () => {
  it("cross-lens lines 42 and 43 collapse into ONE merged with both lenses", () => {
    const { findings } = dedupeFindings([
      lens(
        "performance",
        ok([
          finding("major", {
            id: "perf-1",
            file: "src/x.ts",
            line: 42,
            category: "pagination",
          }),
        ]),
      ),
      lens(
        "api-design",
        ok([
          finding("major", {
            id: "api-1",
            file: "src/x.ts",
            line: 43,
            category: "pagination",
          }),
        ]),
      ),
    ]);
    expect(findings).toHaveLength(1);
    expect([...findings[0]!.contributingLenses].sort()).toEqual([
      "api-design",
      "performance",
    ]);
  });

  it("single-lens within-lens adjacency: lines 42 and 43 collapse, one contributing lens", () => {
    const { findings } = dedupeFindings([
      lens(
        "performance",
        ok([
          finding("major", {
            id: "perf-1",
            file: "src/x.ts",
            line: 42,
            category: "pagination",
          }),
          finding("major", {
            id: "perf-2",
            file: "src/x.ts",
            line: 43,
            category: "pagination",
          }),
        ]),
      ),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.contributingLenses).toEqual(["performance"]);
  });

  it("over-merge guard: lines 42 vs 45 (delta 3) stay separate", () => {
    const { findings } = dedupeFindings([
      lens(
        "performance",
        ok([
          finding("major", {
            id: "perf-1",
            file: "src/x.ts",
            line: 42,
            category: "pagination",
          }),
        ]),
      ),
      lens(
        "api-design",
        ok([
          finding("major", {
            id: "api-1",
            file: "src/x.ts",
            line: 45,
            category: "pagination",
          }),
        ]),
      ),
    ]);
    expect(findings).toHaveLength(2);
  });

  it("R-C4 no transitive chaining: lines 10, 12, 14 -> TWO clusters [10,12] and [14]", () => {
    const mk = (id: string, line: number, lensId: LensId): LensRunResult =>
      lens(
        lensId,
        ok([
          finding("major", {
            id,
            file: "src/x.ts",
            line,
            category: "pagination",
          }),
        ]),
      );
    const { findings } = dedupeFindings([
      mk("a", 10, "performance"),
      mk("b", 12, "api-design"),
      mk("c", 14, "security"),
    ]);
    expect(findings).toHaveLength(2);
    // Anchor window [10,12] merges (delta 2) into one finding carrying both
    // lenses; a NEW cluster opens at 14 (14 - 10 = 4 > 2) with security alone.
    const bySize = findings
      .map((f) => [...f.contributingLenses].sort())
      .sort((a, b) => a.length - b.length);
    expect(bySize).toEqual([["security"], ["api-design", "performance"]]);
  });
});

describe("dedupeFindings -- status=error/skipped", () => {
  it("error and skipped statuses contribute nothing", () => {
    const { findings } = dedupeFindings([
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
    expect(findings).toHaveLength(1);
    expect(findings[0]!.id).toBe("cc-1");
    expect(findings[0]!.contributingLenses).toEqual(["clean-code"]);
  });
});

describe("dedupeFindings -- ordering determinism", () => {
  it("file=null findings precede keyed buckets; keyed buckets in first-insertion order", () => {
    const { findings } = dedupeFindings([
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
    expect(findings.map((m) => m.id)).toEqual(["cc-null", "cc-b", "sec-a"]);
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
    expect(a.findings).toEqual(b.findings);
  });
});

describe("dedupeFindings -- key separator robustness", () => {
  it("distinct (file, line, category) tuples that string-concatenate similarly do not collide", () => {
    const { findings } = dedupeFindings([
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
    expect(findings).toHaveLength(2);
  });
});
