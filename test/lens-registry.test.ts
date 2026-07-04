import { describe, it, expect } from "vitest";

import { SeveritySchema } from "../src/schema/index.js";
import {
  LENSES,
  renderLensBody,
  type LensId,
} from "../src/lenses/prompts/index.js";

const EXPECTED_IDS = [
  "security",
  "error-handling",
  "clean-code",
  "performance",
  "api-design",
  "concurrency",
  "test-quality",
  "accessibility",
  "data-safety",
] as const;

/**
 * Pinned metadata (plan: "Expected metadata per lens"). Drift in either the
 * registry declaration or this table fails the suite, so both sides stay in
 * sync as T-006 activation consumes the `type` field.
 */
const EXPECTED_METADATA = {
  security: { defaultModel: "opus", maxSeverity: "blocking", type: "core" },
  "error-handling": {
    defaultModel: "sonnet",
    maxSeverity: "blocking",
    type: "core",
  },
  "clean-code": {
    defaultModel: "sonnet",
    maxSeverity: "major",
    type: "core",
  },
  performance: {
    defaultModel: "sonnet",
    maxSeverity: "blocking",
    type: "surface-activated",
  },
  "api-design": {
    defaultModel: "sonnet",
    maxSeverity: "blocking",
    type: "surface-activated",
  },
  concurrency: {
    defaultModel: "opus",
    maxSeverity: "blocking",
    type: "core",
  },
  "test-quality": {
    defaultModel: "sonnet",
    maxSeverity: "major",
    type: "surface-activated",
  },
  accessibility: {
    defaultModel: "sonnet",
    maxSeverity: "major",
    type: "surface-activated",
  },
  "data-safety": {
    defaultModel: "sonnet",
    maxSeverity: "blocking",
    type: "surface-activated",
  },
} as const;

describe("LENSES registry", () => {
  it("has exactly the 9 expected ids", () => {
    expect(Object.keys(LENSES).sort()).toEqual([...EXPECTED_IDS].sort());
  });

  it("every entry's defaultModel is opus or sonnet", () => {
    for (const id of EXPECTED_IDS) {
      expect(["opus", "sonnet"]).toContain(LENSES[id].defaultModel);
    }
  });

  it("every entry's maxSeverity is a SeveritySchema option", () => {
    const allowed = new Set(SeveritySchema.options as readonly string[]);
    for (const id of EXPECTED_IDS) {
      expect(allowed).toContain(LENSES[id].maxSeverity);
    }
  });

  it("every entry has an optsSchema with a .parse function", () => {
    for (const id of EXPECTED_IDS) {
      const schema = LENSES[id].optsSchema;
      expect(schema).toBeDefined();
      expect(typeof (schema as { parse: unknown }).parse).toBe("function");
    }
  });

  it("every entry's renderBody accepts both stages with undefined opts", () => {
    for (const id of EXPECTED_IDS) {
      for (const stage of ["PLAN_REVIEW", "CODE_REVIEW"] as const) {
        const out = LENSES[id].renderBody(stage, undefined);
        expect(typeof out).toBe("string");
        expect(out.length).toBeGreaterThan(0);
      }
    }
  });

  it("pinned metadata matches for every lens", () => {
    for (const id of EXPECTED_IDS) {
      expect(LENSES[id]).toMatchObject(EXPECTED_METADATA[id]);
    }
  });

  it("registry key equals the registered metadata id (no drift)", () => {
    for (const [key, def] of Object.entries(LENSES)) {
      expect(def.id, `registry key ${key} disagrees with def.id`).toBe(key);
    }
  });

  it("type-level exhaustiveness: LensId equals the 9 expected ids (bidirectional)", () => {
    // AssertEqual<A, B> resolves to `true` iff A and B are mutually
    // assignable. If the registry grows a lens without adding it to
    // EXPECTED_IDS (or vice versa), one direction fails and the assignment
    // to `true` becomes a tsc error.
    type ExpectedUnion = (typeof EXPECTED_IDS)[number];
    type AssertEqual<A, B> = [A] extends [B]
      ? [B] extends [A]
        ? true
        : false
      : false;
    const _typeEquality: AssertEqual<LensId, ExpectedUnion> = true;
    void _typeEquality;

    // Runtime companion: registry size matches the pin.
    expect(Object.keys(LENSES).length).toBe(EXPECTED_IDS.length);
    expect(EXPECTED_IDS.length).toBe(9);
  });
});

describe("renderLensBody()", () => {
  it("validates security scannerFindings through the schema path", () => {
    expect(() =>
      renderLensBody("security", "CODE_REVIEW", { scannerFindings: "ok" }),
    ).not.toThrow();
  });

  it("rejects wrong type for security scannerFindings (ZodError)", () => {
    expect(() =>
      renderLensBody("security", "CODE_REVIEW", { scannerFindings: 123 }),
    ).toThrow();
  });

  it("rejects unknown opts keys (strict schema)", () => {
    expect(() =>
      renderLensBody("security", "CODE_REVIEW", { unknownKey: "x" }),
    ).toThrow();
  });

  it("throws a clear 'Unknown lensId' error when id is invalid at runtime", () => {
    expect(() =>
      renderLensBody("not-a-lens" as LensId, "CODE_REVIEW", {}),
    ).toThrow(/Unknown lensId/);
    expect(() =>
      renderLensBody("not-a-lens" as LensId, "CODE_REVIEW", {}),
    ).toThrow(/not-a-lens/);
  });

  it("treats raw undefined opts as {}", () => {
    const out = renderLensBody("clean-code", "CODE_REVIEW", undefined);
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
  });

  it("rejects raw null opts (distinct from undefined) for every lens", () => {
    // Regression: renderLensBody used `opts ?? {}` which silently coerced
    // null to {}. With `opts === undefined ? {} : opts`, null now reaches
    // Zod and is rejected by the object schema. Loop every lens id so the
    // per-lens parse wrapper gets exercised -- testing only clean-code left
    // the other 7 wrappers unverified.
    for (const lensId of EXPECTED_IDS) {
      for (const stage of ["PLAN_REVIEW", "CODE_REVIEW"] as const) {
        expect(
          () =>
            renderLensBody(lensId, stage, null as unknown as object),
          `${lensId} ${stage} should reject null opts`,
        ).toThrow();
      }
    }
  });
});
