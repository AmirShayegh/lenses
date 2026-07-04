import { describe, it, expect } from "vitest";

import {
  activate,
  LensConfigSchema,
  type LensActivation,
} from "../src/lenses/registry.js";
import { LENSES, type LensId } from "../src/lenses/prompts/index.js";

const DECLARATION_ORDER: readonly LensId[] = [
  "security",
  "error-handling",
  "clean-code",
  "performance",
  "api-design",
  "concurrency",
  "test-quality",
  "accessibility",
  "data-safety",
];

function ids(acts: readonly LensActivation[]): LensId[] {
  return acts.map((a) => a.lensId);
}

describe("activate() -- stage-level behavior", () => {
  it("PLAN_REVIEW returns all 9 lenses regardless of changedFiles", () => {
    const out = activate({ stage: "PLAN_REVIEW", changedFiles: [] });
    expect(ids(out)).toEqual([...DECLARATION_ORDER]);
  });

  it("PLAN_REVIEW ordering matches LENSES declaration order", () => {
    const out = activate({
      stage: "PLAN_REVIEW",
      changedFiles: ["anything.md"],
    });
    expect(ids(out)).toEqual([...DECLARATION_ORDER]);
  });

  it("PLAN_REVIEW activates test-quality with empty opts (missing-coverage heuristic off at plan stage)", () => {
    const out = activate({
      stage: "PLAN_REVIEW",
      changedFiles: ["src/foo.ts"],
    });
    const tq = out.find((a) => a.lensId === "test-quality");
    expect(tq?.opts).toEqual({});
    expect(tq?.activationReason).toBe("plan review: all lenses");
  });

  it("CODE_REVIEW with only non-source files returns only 4 core lenses", () => {
    const out = activate({
      stage: "CODE_REVIEW",
      changedFiles: ["README.md", "LICENSE", "docs/notes.md"],
    });
    expect(ids(out)).toEqual([
      "security",
      "error-handling",
      "clean-code",
      "concurrency",
    ]);
    for (const a of out) expect(a.activationReason).toBe("core lens");
  });

  it("CODE_REVIEW with a mixed set activates core + matching surface lenses", () => {
    const out = activate({
      stage: "CODE_REVIEW",
      changedFiles: ["src/api/users.ts"],
    });
    expect(ids(out)).toEqual([
      "security",
      "error-handling",
      "clean-code",
      "performance",
      "api-design",
      "concurrency",
      "test-quality",
      // no accessibility — .ts isn't a UI surface
    ]);
  });
});

describe("activate() -- surface activation matrix", () => {
  it("performance activates for .py, .go, .rs, .rb, .php (not just TS)", () => {
    for (const file of [
      "src/foo.py",
      "cmd/server.go",
      "src/lib.rs",
      "app/user.rb",
      "web/index.php",
    ]) {
      const out = activate({
        stage: "CODE_REVIEW",
        changedFiles: [file],
      });
      expect(ids(out)).toContain("performance");
    }
  });

  it("api-design activates for API surface paths, filenames, and extensions", () => {
    const cases = [
      "src/api/users.ts",
      "app/routes/index.ts",
      "server/controllers/auth.ts",
      "pkg/handlers/webhook.go",
      "service/endpoints/v1.ts",
      "schema.ts",
      "openapi.yaml",
      "openapi.json",
      "proto/service.proto",
      "schema/user.graphql",
      "query.gql",
    ];
    for (const file of cases) {
      const out = activate({
        stage: "CODE_REVIEW",
        changedFiles: [file],
      });
      expect(
        ids(out),
        `api-design should activate for ${file}`,
      ).toContain("api-design");
    }
  });

  it("api-design does NOT activate for prefix-only path matches (no trailing slash)", () => {
    // `/api/` requires the trailing slash; `src/api-client/` must not match.
    const out = activate({
      stage: "CODE_REVIEW",
      changedFiles: ["src/api-client/request.ts"],
    });
    expect(ids(out)).not.toContain("api-design");
  });

  it("accessibility activates for .html, .vue, .svelte, .css, .scss, .astro", () => {
    for (const file of [
      "pages/index.html",
      "src/App.vue",
      "src/Nav.svelte",
      "styles/main.css",
      "styles/theme.scss",
      "pages/about.astro",
    ]) {
      const out = activate({
        stage: "CODE_REVIEW",
        changedFiles: [file],
      });
      expect(ids(out)).toContain("accessibility");
    }
  });

  it(".tsx file activates BOTH performance AND accessibility", () => {
    const out = activate({
      stage: "CODE_REVIEW",
      changedFiles: ["src/Button.tsx"],
    });
    const names = ids(out);
    expect(names).toContain("performance");
    expect(names).toContain("accessibility");
  });

  it("test-quality activates via test file (no focusMissingCoverage opt)", () => {
    const out = activate({
      stage: "CODE_REVIEW",
      changedFiles: ["src/foo.test.ts"],
    });
    const tq = out.find((a) => a.lensId === "test-quality");
    expect(tq).toBeDefined();
    expect(tq?.opts).toEqual({});
    expect(tq?.activationReason).toMatch(/^test file changed/);
  });

  it("test-quality activates via /test/ path segment", () => {
    const out = activate({
      stage: "CODE_REVIEW",
      changedFiles: ["project/test/helper.ts"],
    });
    expect(ids(out)).toContain("test-quality");
  });

  it("test-quality activates for ROOT-level test/ directory (no leading slash)", () => {
    // Repos that put their test dir at the root (like this one:
    // test/lens-registry-activate.test.ts) must not fall through to the
    // source-without-tests branch.
    const out = activate({
      stage: "CODE_REVIEW",
      changedFiles: ["test/helper.ts"],
    });
    const tq = out.find((a) => a.lensId === "test-quality");
    expect(tq).toBeDefined();
    expect(tq?.opts).toEqual({});
    expect(tq?.activationReason).toMatch(/^test file changed/);
  });

  it("test-quality activates for root-level tests/ and __tests__/ directories", () => {
    for (const p of ["tests/unit.ts", "__tests__/foo.ts"]) {
      const out = activate({
        stage: "CODE_REVIEW",
        changedFiles: [p],
      });
      const tq = out.find((a) => a.lensId === "test-quality");
      expect(
        tq?.opts,
        `${p} should activate test-quality without focusMissingCoverage`,
      ).toEqual({});
    }
  });

  it("test-quality activates via .spec. infix", () => {
    const out = activate({
      stage: "CODE_REVIEW",
      changedFiles: ["app/user.spec.ts"],
    });
    expect(ids(out)).toContain("test-quality");
  });

  it("test-quality activates with focusMissingCoverage when source changes without tests", () => {
    const out = activate({
      stage: "CODE_REVIEW",
      changedFiles: ["src/user.ts"],
    });
    const tq = out.find((a) => a.lensId === "test-quality");
    expect(tq).toBeDefined();
    expect(tq?.opts).toEqual({ focusMissingCoverage: true });
    expect(tq?.activationReason).toMatch(/^source changed without tests/);
  });

  it("test-quality does NOT activate when only docs change", () => {
    const out = activate({
      stage: "CODE_REVIEW",
      changedFiles: ["docs/x.md", "CHANGELOG.md"],
    });
    expect(ids(out)).not.toContain("test-quality");
  });

  it("test file takes precedence over missing-coverage (no focusMissingCoverage opt when tests present)", () => {
    const out = activate({
      stage: "CODE_REVIEW",
      changedFiles: ["src/user.ts", "src/user.test.ts"],
    });
    const tq = out.find((a) => a.lensId === "test-quality");
    expect(tq?.opts).toEqual({});
  });

  it("Windows-style backslash path is normalized and matches /api/ surface", () => {
    const out = activate({
      stage: "CODE_REVIEW",
      changedFiles: ["src\\api\\users.ts"],
    });
    expect(ids(out)).toContain("api-design");
  });
});

describe("activate() -- data-safety segment-aware surface (T-030)", () => {
  it("activates for a root-level migrations/ dir (non-SQL file)", () => {
    const out = activate({
      stage: "CODE_REVIEW",
      changedFiles: ["migrations/001_add_users.ts"],
    });
    expect(ids(out)).toContain("data-safety");
  });

  it("activates for a root-level migrate/ dir (non-SQL file)", () => {
    const out = activate({
      stage: "CODE_REVIEW",
      changedFiles: ["migrate/001.py"],
    });
    expect(ids(out)).toContain("data-safety");
  });

  it("activates for a nested db/migrations/ .sql file", () => {
    const out = activate({
      stage: "CODE_REVIEW",
      changedFiles: ["db/migrations/20260101_add_users.sql"],
    });
    expect(ids(out)).toContain("data-safety");
  });

  it("activates for an exact schema.prisma basename", () => {
    const out = activate({
      stage: "CODE_REVIEW",
      changedFiles: ["prisma/schema.prisma"],
    });
    expect(ids(out)).toContain("data-safety");
  });

  it("does NOT activate for src/immigrations/ (substring-collision guard)", () => {
    const out = activate({
      stage: "CODE_REVIEW",
      changedFiles: ["src/immigrations/handler.ts"],
    });
    expect(ids(out)).not.toContain("data-safety");
  });

  it("does NOT activate for a pure UI diff", () => {
    const out = activate({
      stage: "CODE_REVIEW",
      changedFiles: ["src/Button.tsx", "styles/main.css"],
    });
    expect(ids(out)).not.toContain("data-safety");
  });
});

describe("activate() -- PLAN_REVIEW plan-kind hint (T-030)", () => {
  it("planKind:backend excludes accessibility but keeps security", () => {
    const out = activate({
      stage: "PLAN_REVIEW",
      changedFiles: [],
      config: { planKind: "backend" },
    });
    expect(ids(out)).not.toContain("accessibility");
    expect(ids(out)).toContain("security");
  });

  it("planKind:infra excludes accessibility", () => {
    const out = activate({
      stage: "PLAN_REVIEW",
      changedFiles: [],
      config: { planKind: "infra" },
    });
    expect(ids(out)).not.toContain("accessibility");
  });

  it("planKind:ui keeps accessibility", () => {
    const out = activate({
      stage: "PLAN_REVIEW",
      changedFiles: [],
      config: { planKind: "ui" },
    });
    expect(ids(out)).toContain("accessibility");
  });

  it("planKind schema: valid value accepted, unknown value rejected", () => {
    expect(
      LensConfigSchema.safeParse({ planKind: "backend" }).success,
    ).toBe(true);
    expect(
      LensConfigSchema.safeParse({ planKind: "nope" }).success,
    ).toBe(false);
  });
});

describe("activate() -- config overrides", () => {
  it('lenses: ["security"] returns exactly [security] even when other lenses would activate', () => {
    const out = activate({
      stage: "CODE_REVIEW",
      changedFiles: ["src/api/users.ts", "src/Button.tsx"],
      config: { lenses: ["security"] },
    });
    expect(ids(out)).toEqual(["security"]);
  });

  it('lenses: ["accessibility"] in CODE_REVIEW with zero UI files still activates (explicit bypass)', () => {
    const out = activate({
      stage: "CODE_REVIEW",
      changedFiles: ["src/server.go"],
      config: { lenses: ["accessibility"] },
    });
    expect(ids(out)).toEqual(["accessibility"]);
    expect(out[0]?.activationReason).toBe("explicit lens allow-list");
  });

  it("lensModels override beats the default (security sonnet instead of opus)", () => {
    const out = activate({
      stage: "PLAN_REVIEW",
      changedFiles: [],
      config: { lensModels: { security: "sonnet" } },
    });
    const sec = out.find((a) => a.lensId === "security");
    expect(sec?.model).toBe("sonnet");
  });

  it('lensModels override promotes clean-code to opus; other default-sonnet lenses unchanged', () => {
    const out = activate({
      stage: "PLAN_REVIEW",
      changedFiles: [],
      config: { lensModels: { "clean-code": "opus" } },
    });
    const cc = out.find((a) => a.lensId === "clean-code");
    expect(cc?.model).toBe("opus");
    const eh = out.find((a) => a.lensId === "error-handling");
    expect(eh?.model).toBe("sonnet");
  });

  it("model defaults: security and concurrency default to opus, others to sonnet", () => {
    const out = activate({ stage: "PLAN_REVIEW", changedFiles: [] });
    const byId = new Map(out.map((a) => [a.lensId, a.model]));
    expect(byId.get("security")).toBe("opus");
    expect(byId.get("concurrency")).toBe("opus");
    for (const id of DECLARATION_ORDER) {
      if (id !== "security" && id !== "concurrency") {
        expect(byId.get(id), `${id} should default to sonnet`).toBe("sonnet");
      }
    }
  });

  it("maxLenses: 3 on PLAN_REVIEW returns first 3 by declaration order", () => {
    const out = activate({
      stage: "PLAN_REVIEW",
      changedFiles: [],
      config: { maxLenses: 3 },
    });
    expect(ids(out)).toEqual(["security", "error-handling", "clean-code"]);
  });

  it("maxLenses drops tail (not head), keeping highest-priority lenses", () => {
    const out = activate({
      stage: "CODE_REVIEW",
      changedFiles: ["src/Button.tsx"],
      config: { maxLenses: 5 },
    });
    expect(out.length).toBe(5);
    expect(ids(out).slice(0, 3)).toEqual([
      "security",
      "error-handling",
      "clean-code",
    ]);
  });

  it("maxLenses does NOT truncate an explicit list that fits", () => {
    const out = activate({
      stage: "CODE_REVIEW",
      changedFiles: ["src/x.ts"],
      config: { lenses: ["security", "performance"], maxLenses: 5 },
    });
    expect(ids(out)).toEqual(["security", "performance"]);
  });

  it("maxLenses DOES truncate an explicit list that exceeds the cap", () => {
    const out = activate({
      stage: "CODE_REVIEW",
      changedFiles: ["src/x.ts"],
      config: {
        lenses: ["security", "error-handling", "clean-code", "performance"],
        maxLenses: 2,
      },
    });
    expect(ids(out)).toEqual(["security", "error-handling"]);
  });

  it("hotPaths passes through to performance lens opts", () => {
    const out = activate({
      stage: "CODE_REVIEW",
      changedFiles: ["src/handler.ts"],
      config: { hotPaths: ["src/hot/**", "*.critical.ts"] },
    });
    const perf = out.find((a) => a.lensId === "performance");
    expect(perf?.opts).toEqual({
      hotPaths: ["src/hot/**", "*.critical.ts"],
    });
  });

  it("empty hotPaths array does NOT add an opts key (mirrors T-005 renderBody rule)", () => {
    const out = activate({
      stage: "CODE_REVIEW",
      changedFiles: ["src/handler.ts"],
      config: { hotPaths: [] },
    });
    const perf = out.find((a) => a.lensId === "performance");
    expect(perf?.opts).toEqual({});
  });

  it("scannerFindings passes through to security lens opts", () => {
    const out = activate({
      stage: "PLAN_REVIEW",
      changedFiles: [],
      config: { scannerFindings: "CVE-2024-1234: left-pad RCE" },
    });
    const sec = out.find((a) => a.lensId === "security");
    expect(sec?.opts).toEqual({
      scannerFindings: "CVE-2024-1234: left-pad RCE",
    });
  });

  it('duplicates in lenses: ["security","security"] dedupe to one activation', () => {
    const out = activate({
      stage: "PLAN_REVIEW",
      changedFiles: [],
      config: { lenses: ["security", "security"] },
    });
    expect(ids(out)).toEqual(["security"]);
  });

  it("undefined config is treated the same as {}", () => {
    const outUndef = activate({ stage: "PLAN_REVIEW", changedFiles: [] });
    const outEmpty = activate({
      stage: "PLAN_REVIEW",
      changedFiles: [],
      config: {},
    });
    expect(ids(outUndef)).toEqual(ids(outEmpty));
  });
});

describe("LensConfigSchema -- strict validation", () => {
  it("strict() rejects unknown keys", () => {
    expect(
      LensConfigSchema.safeParse({ notARealKey: true }).success,
    ).toBe(false);
  });

  it('lenses: ["not-a-lens"] rejected at schema layer', () => {
    expect(
      LensConfigSchema.safeParse({ lenses: ["not-a-lens"] }).success,
    ).toBe(false);
  });

  it('lensModels: { "not-a-lens": "opus" } rejected at schema layer', () => {
    expect(
      LensConfigSchema.safeParse({
        lensModels: { "not-a-lens": "opus" },
      }).success,
    ).toBe(false);
  });

  it("lensModels with invalid model value rejected", () => {
    expect(
      LensConfigSchema.safeParse({
        lensModels: { security: "haiku" },
      }).success,
    ).toBe(false);
  });

  it("maxLenses: 0 rejected (min 1)", () => {
    expect(LensConfigSchema.safeParse({ maxLenses: 0 }).success).toBe(false);
  });

  it("maxLenses: 10 rejected (max 9)", () => {
    expect(LensConfigSchema.safeParse({ maxLenses: 10 }).success).toBe(false);
  });

  it("maxLenses: 9 accepted (equals total lens count)", () => {
    expect(LensConfigSchema.safeParse({ maxLenses: 9 }).success).toBe(true);
  });

  it("maxLenses: 2.5 rejected (int required)", () => {
    expect(LensConfigSchema.safeParse({ maxLenses: 2.5 }).success).toBe(false);
  });

  it("hotPaths: [''] rejected (min length 1)", () => {
    expect(
      LensConfigSchema.safeParse({ hotPaths: [""] }).success,
    ).toBe(false);
  });

  it("hotPaths with whitespace rejected (regex violation)", () => {
    expect(
      LensConfigSchema.safeParse({ hotPaths: ["has space"] }).success,
    ).toBe(false);
  });

  it("hotPaths with quote rejected (regex violation)", () => {
    expect(
      LensConfigSchema.safeParse({ hotPaths: ['"quoted"'] }).success,
    ).toBe(false);
  });

  it("hotPaths 201-char entry rejected (per-entry .max(200))", () => {
    const tooLong = "a".repeat(201);
    expect(
      LensConfigSchema.safeParse({ hotPaths: [tooLong] }).success,
    ).toBe(false);
  });

  it("hotPaths 51-entry array rejected (array .max(50))", () => {
    const tooMany = Array.from({ length: 51 }, (_, i) => `path${i}/**`);
    expect(
      LensConfigSchema.safeParse({ hotPaths: tooMany }).success,
    ).toBe(false);
  });

  it("scannerFindings > 8192 chars rejected", () => {
    const oversize = "x".repeat(8193);
    expect(
      LensConfigSchema.safeParse({ scannerFindings: oversize }).success,
    ).toBe(false);
  });

  it("lenses: [] rejected (nonempty)", () => {
    expect(LensConfigSchema.safeParse({ lenses: [] }).success).toBe(false);
  });

  it('accepts lenses: "auto" (the default-behavior sentinel)', () => {
    expect(
      LensConfigSchema.safeParse({ lenses: "auto" }).success,
    ).toBe(true);
  });

  it("accepts a fully-specified valid config", () => {
    const result = LensConfigSchema.safeParse({
      lenses: "auto",
      maxLenses: 5,
      lensModels: { security: "opus", "clean-code": "sonnet" },
      hotPaths: ["src/hot/**", "*.critical.ts"],
      scannerFindings: "CVE-2024-1234",
    });
    expect(result.success).toBe(true);
  });
});

describe("activate() -- coherence with LENSES registry", () => {
  it("every activation's model is either opus or sonnet", () => {
    const out = activate({ stage: "PLAN_REVIEW", changedFiles: [] });
    for (const a of out) expect(["opus", "sonnet"]).toContain(a.model);
  });

  it("every activation's lensId is a key of LENSES", () => {
    const out = activate({ stage: "PLAN_REVIEW", changedFiles: [] });
    const validIds = new Set(Object.keys(LENSES));
    for (const a of out) expect(validIds.has(a.lensId)).toBe(true);
  });

  it("activation opts are accepted by the lens's own optsSchema", () => {
    const out = activate({
      stage: "CODE_REVIEW",
      changedFiles: ["src/handler.ts"],
      config: {
        scannerFindings: "CVE",
        hotPaths: ["src/hot/**"],
      },
    });
    for (const a of out) {
      const schema = LENSES[a.lensId].optsSchema;
      const parsed = schema.safeParse(a.opts);
      expect(
        parsed.success,
        `${a.lensId} opts must pass its own optsSchema: ${JSON.stringify(a.opts)}`,
      ).toBe(true);
    }
  });
});
