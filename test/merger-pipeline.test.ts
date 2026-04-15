import { describe, expect, it } from "vitest";

import type { LensId } from "../src/lenses/prompts/index.js";
import {
  runMergerPipeline,
  type LensRunResult,
} from "../src/merger/pipeline.js";
import type { LensFinding, LensOutput, Severity } from "../src/schema/index.js";

const RID = "merger-pipeline-test-review-id";

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

function perLens(lensId: LensId, output: LensOutput): LensRunResult {
  return { lensId, output };
}

describe("runMergerPipeline -- baseline severity → verdict", () => {
  it("empty perLens produces approve with zero counts and empty tensions", () => {
    const v = runMergerPipeline({ reviewId: RID, perLens: [] });
    expect(v.verdict).toBe("approve");
    expect(v.findings).toEqual([]);
    expect(v.tensions).toEqual([]);
    expect(v.blocking).toBe(0);
    expect(v.major).toBe(0);
    expect(v.minor).toBe(0);
    expect(v.suggestion).toBe(0);
    expect(v.sessionId).toBe(RID);
  });

  it("single lens with zero findings → approve", () => {
    const v = runMergerPipeline({
      reviewId: RID,
      perLens: [perLens("security", ok())],
    });
    expect(v.verdict).toBe("approve");
    expect(v.findings).toHaveLength(0);
  });

  it("a single suggestion finding → approve, suggestion=1", () => {
    const v = runMergerPipeline({
      reviewId: RID,
      perLens: [perLens("clean-code", ok([finding("suggestion")]))],
    });
    expect(v.verdict).toBe("approve");
    expect(v.suggestion).toBe(1);
  });

  it("a single minor finding → approve, minor=1 (minor alone never blocks)", () => {
    const v = runMergerPipeline({
      reviewId: RID,
      perLens: [perLens("clean-code", ok([finding("minor")]))],
    });
    expect(v.verdict).toBe("approve");
    expect(v.minor).toBe(1);
  });

  it("a single major finding → revise, major=1", () => {
    const v = runMergerPipeline({
      reviewId: RID,
      perLens: [perLens("clean-code", ok([finding("major")]))],
    });
    expect(v.verdict).toBe("revise");
    expect(v.major).toBe(1);
  });

  it("a single blocking finding → reject, blocking=1", () => {
    const v = runMergerPipeline({
      reviewId: RID,
      perLens: [perLens("security", ok([finding("blocking")]))],
    });
    expect(v.verdict).toBe("reject");
    expect(v.blocking).toBe(1);
  });
});

describe("runMergerPipeline -- aggregation across lenses", () => {
  it("mixed severity counts sum exactly and verdict reflects the highest severity present", () => {
    const v = runMergerPipeline({
      reviewId: RID,
      perLens: [
        perLens(
          "security",
          ok([
            finding("blocking", { id: "s1" }),
            finding("minor", { id: "s2" }),
          ]),
        ),
        perLens(
          "clean-code",
          ok([
            finding("major", { id: "c1" }),
            finding("suggestion", { id: "c2" }),
          ]),
        ),
      ],
    });
    expect(v.verdict).toBe("reject");
    expect(v.findings).toHaveLength(4);
    expect(v.blocking).toBe(1);
    expect(v.major).toBe(1);
    expect(v.minor).toBe(1);
    expect(v.suggestion).toBe(1);
  });

  it("'error' status lens contributes no findings (LensOutputSchema invariant pinned at the merger layer too)", () => {
    const v = runMergerPipeline({
      reviewId: RID,
      perLens: [
        perLens("security", errored("parse failure")),
        perLens("clean-code", ok([finding("major")])),
      ],
    });
    expect(v.verdict).toBe("revise");
    expect(v.findings).toHaveLength(1);
    expect(v.major).toBe(1);
  });
});

describe("runMergerPipeline -- sessionId coupling", () => {
  it("sessionId equals reviewId (T-009 baseline; T-014 will decouple)", () => {
    const v = runMergerPipeline({ reviewId: "arbitrary-id", perLens: [] });
    expect(v.sessionId).toBe("arbitrary-id");
  });
});

describe("runMergerPipeline -- cross-lens dedup (T-010)", () => {
  it("two lenses colliding on (file, line, category) collapse to one finding; severity counts reflect the winner", () => {
    const v = runMergerPipeline({
      reviewId: RID,
      perLens: [
        perLens(
          "security",
          ok([
            finding("blocking", {
              id: "sec-1",
              file: "src/auth.ts",
              line: 42,
              category: "auth-bypass",
              confidence: 0.95,
            }),
          ]),
        ),
        perLens(
          "error-handling",
          ok([
            finding("major", {
              id: "eh-1",
              file: "src/auth.ts",
              line: 42,
              category: "auth-bypass",
              confidence: 0.7,
            }),
          ]),
        ),
      ],
    });
    expect(v.findings).toHaveLength(1);
    expect(v.findings[0]!.contributingLenses).toEqual([
      "security",
      "error-handling",
    ]);
    // security won on confidence: severity = blocking, verdict = reject.
    expect(v.verdict).toBe("reject");
    expect(v.blocking).toBe(1);
    expect(v.major).toBe(0);
  });

  it("minor-wins-over-major trade-off propagates to the verdict (T-010 known behavior)", () => {
    // A major-severity low-confidence finding is displaced by a minor-severity
    // higher-confidence finding at the same key. Post-T-010 the surviving
    // finding is `minor`, so the verdict is `approve` (no major remains).
    // T-011 will layer blocking policy on top; this test codifies the trade-off.
    const v = runMergerPipeline({
      reviewId: RID,
      perLens: [
        perLens(
          "clean-code",
          ok([
            finding("major", {
              id: "cc-1",
              file: "src/x.ts",
              line: 8,
              category: "complexity",
              confidence: 0.55,
            }),
          ]),
        ),
        perLens(
          "performance",
          ok([
            finding("minor", {
              id: "perf-1",
              file: "src/x.ts",
              line: 8,
              category: "complexity",
              confidence: 0.92,
            }),
          ]),
        ),
      ],
    });
    expect(v.findings).toHaveLength(1);
    expect(v.findings[0]!.severity).toBe("minor");
    expect(v.findings[0]!.contributingLenses).toEqual([
      "clean-code",
      "performance",
    ]);
    expect(v.verdict).toBe("approve");
    expect(v.major).toBe(0);
    expect(v.minor).toBe(1);
  });
});
