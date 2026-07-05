import path from "node:path";
import { z } from "zod";

import type { Stage } from "../schema/index.js";
import { LENSES, type LensId } from "./prompts/index.js";
import {
  PERFORMANCE_GLOB_RE,
  PERFORMANCE_HOTPATH_MAX,
  PERFORMANCE_HOTPATHS_MAX,
} from "./prompts/performance.js";

/**
 * Lens-id enum derived at compile time from the `LENSES` registry keys. Using
 * `keyof typeof LENSES` as the enum tuple keeps the Zod schema in lockstep
 * with the static registry -- adding a lens to LENSES without updating this
 * file is impossible because `Object.keys(LENSES)` would drift from the type,
 * caught by the `satisfies` constraint below.
 */
const LENS_IDS = Object.keys(LENSES) as [LensId, ...LensId[]];
export const LensIdSchema = z.enum(LENS_IDS);

export const ModelSchema = z.enum(["opus", "sonnet"]);
export type Model = z.infer<typeof ModelSchema>;

/**
 * User-facing activation config -- the subset of `lensConfig` that determines
 * which lenses fire, what opts each receives, and how long the caller should
 * let each spawned agent run. `findingBudget` and `confidenceFloor` are
 * preamble-framing knobs and live on `PreambleConfigSchema` in
 * `src/lenses/prompt-builder.ts`.
 *
 * `maxLenses` caps active-lens count below the 9-lens total. Unset = no cap.
 * The `.max(9)` upper bound matches the total lens count, so values ≥ 9
 * behave identically to "unset" (no truncation ever fires).
 *
 * `lensTimeout` is what T-022 will hand to spawned agents via
 * `agents[].expiresAt`. It is an activation-time concern (per-call, per-model)
 * rather than a merger-time constant, so it lives here rather than on
 * `MergerConfigSchema`. The scalar form applies to every model; the object
 * form distinguishes opus (typically slower) from the default.
 *
 * `hotPaths` mirrors PerformanceLensOptsSchema byte-for-byte via the three
 * re-exported constants so a malformed hotPath fails at this trust boundary,
 * not deferred to `renderBody` at T-007 prompt-render time.
 */
export const LensTimeoutSchema = z.union([
  z.number().int().positive(),
  z
    .object({
      default: z.number().int().positive(),
      opus: z.number().int().positive(),
    })
    .strict(),
]);
export type LensTimeout = z.infer<typeof LensTimeoutSchema>;

export const LensConfigSchema = z
  .object({
    lenses: z
      .union([z.literal("auto"), z.array(LensIdSchema).nonempty()])
      .optional(),
    maxLenses: z.number().int().min(1).max(9).optional(),
    lensModels: z.record(LensIdSchema, ModelSchema).optional(),
    lensTimeout: LensTimeoutSchema.optional(),
    hotPaths: z
      .array(
        z
          .string()
          .min(1)
          .max(PERFORMANCE_HOTPATH_MAX)
          .regex(PERFORMANCE_GLOB_RE),
      )
      .max(PERFORMANCE_HOTPATHS_MAX)
      .optional(),
    scannerFindings: z.string().max(8192).optional(),
    planKind: z.enum(["ui", "backend", "infra"]).optional(),
  })
  .strict();
export type LensConfig = z.infer<typeof LensConfigSchema>;

/**
 * Coarse PLAN_REVIEW hint: skip lenses that are obviously inapplicable to a
 * plan's kind before spawning them. Conservative on purpose -- only
 * accessibility is excluded, and only for backend/infra plans. This is the
 * minimal plan-kind filter, not a content-aware selection engine.
 */
type PlanKind = NonNullable<LensConfig["planKind"]>;
const PLAN_KIND_EXCLUSIONS: Record<PlanKind, readonly LensId[]> = {
  ui: [],
  backend: ["accessibility"],
  infra: ["accessibility"],
};

/**
 * Default per-model timeouts in milliseconds. Opus lenses (security,
 * concurrency) get 2x the default budget because they reason slower. T-022
 * sets `agents[].expiresAt = now() + resolveLensTimeoutMs(model, config)`
 * at hop-1 and rejects hop-2 resubmissions past that wall-clock deadline.
 */
export const DEFAULT_LENS_TIMEOUT_MS = {
  default: 60_000,
  opus: 120_000,
} as const;

/**
 * Resolve the effective timeout for a lens given its model and the caller's
 * `lensConfig`. Pure; same input always yields the same output.
 */
export function resolveLensTimeoutMs(
  model: Model,
  config: LensConfig | undefined,
): number {
  const override = config?.lensTimeout;
  if (override === undefined) {
    return model === "opus"
      ? DEFAULT_LENS_TIMEOUT_MS.opus
      : DEFAULT_LENS_TIMEOUT_MS.default;
  }
  if (typeof override === "number") return override;
  return model === "opus" ? override.opus : override.default;
}

export interface LensActivation {
  readonly lensId: LensId;
  readonly model: Model;
  readonly activationReason: string;
  readonly opts: Record<string, unknown>;
}

/**
 * File-surface predicate. All four fields are optional; a file matches when
 * ANY predicate hits. Paths are normalized to forward slashes before check so
 * `src\api\users.ts` on Windows still activates `/api/` rules.
 */
interface Surface {
  readonly extensions?: readonly string[];
  readonly pathSegments?: readonly string[];
  readonly dirSegments?: readonly string[]; // whole directory-name match, root or nested
  readonly basenamePrefixes?: readonly string[];
  readonly exactBasenames?: readonly string[];
}

export type SurfaceRule = Surface | "core" | "test-quality-dual-mode";

export const SURFACE_RULES: Record<LensId, SurfaceRule> = {
  security: "core",
  "error-handling": "core",
  "clean-code": "core",
  concurrency: "core",
  performance: {
    extensions: [
      ".ts",
      ".tsx",
      ".js",
      ".jsx",
      ".mjs",
      ".cjs",
      ".py",
      ".go",
      ".rs",
      ".java",
      ".kt",
      ".swift",
      ".cs",
      ".cpp",
      ".c",
      ".rb",
      ".php",
    ],
  },
  "api-design": {
    extensions: [".graphql", ".gql", ".proto"],
    pathSegments: [
      "/api/",
      "/routes/",
      "/controllers/",
      "/handlers/",
      "/endpoints/",
    ],
    basenamePrefixes: ["openapi."],
    exactBasenames: ["schema.ts", "schema.js", "schema.py"],
  },
  // test-quality has two activation modes (see findTestFile /
  // findNonTestSourceFile) that can't be expressed with a plain Surface
  // predicate -- the missing-coverage heuristic also sets
  // opts.focusMissingCoverage=true. The sentinel makes the special-case
  // branch in activate() explicit rather than a magic lensId comparison.
  "test-quality": "test-quality-dual-mode",
  accessibility: {
    extensions: [
      ".html",
      ".vue",
      ".svelte",
      ".astro",
      ".tsx",
      ".jsx",
      ".css",
      ".scss",
    ],
  },
  "data-safety": {
    extensions: [".sql"],
    dirSegments: ["migrations", "migrate"],
    exactBasenames: ["schema.prisma"],
  },
};

function normalize(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Test-directory segment match that also hits root-level `test/helper.ts`
 * (no leading slash). Without the prefix form a file at the repo root
 * under `test/` would fall through to the source-file branch and get
 * flagged with `focusMissingCoverage: true`, which is wrong.
 */
function inTestDir(f: string): boolean {
  return (
    f.includes("/test/") ||
    f.includes("/tests/") ||
    f.includes("/__tests__/") ||
    f.startsWith("test/") ||
    f.startsWith("tests/") ||
    f.startsWith("__tests__/")
  );
}

function matchesSurface(
  changedFiles: readonly string[],
  s: Surface,
): string | null {
  for (const raw of changedFiles) {
    const f = normalize(raw);
    const base = path.posix.basename(f);
    const ext = path.posix.extname(f);
    if (s.extensions?.some((e) => e === ext)) return f;
    if (s.pathSegments?.some((seg) => f.includes(seg))) return f;
    if (s.dirSegments !== undefined) {
      const dirs = f.split("/").slice(0, -1); // directory segments only (excludes basename)
      if (s.dirSegments.some((d) => dirs.includes(d))) return f;
    }
    if (s.basenamePrefixes?.some((p) => base.startsWith(p))) return f;
    if (s.exactBasenames?.some((b) => b === base)) return f;
  }
  return null;
}

/** Test-file detection: path segment OR `.test.` / `.spec.` infix in basename. */
function findTestFile(changedFiles: readonly string[]): string | null {
  for (const raw of changedFiles) {
    const f = normalize(raw);
    const base = path.posix.basename(f);
    if (inTestDir(f) || /\.test\./.test(base) || /\.spec\./.test(base)) {
      return f;
    }
  }
  return null;
}

/** Source files = performance-surface extensions, minus test files. */
function findNonTestSourceFile(changedFiles: readonly string[]): string | null {
  const performanceSurface = SURFACE_RULES.performance as Surface;
  for (const raw of changedFiles) {
    const f = normalize(raw);
    const base = path.posix.basename(f);
    const ext = path.posix.extname(f);
    if (
      performanceSurface.extensions?.some((e) => e === ext) &&
      !/\.test\./.test(base) &&
      !/\.spec\./.test(base) &&
      !inTestDir(f)
    ) {
      return f;
    }
  }
  return null;
}

function resolveModel(
  lensId: LensId,
  overrides: LensConfig["lensModels"],
): Model {
  return overrides?.[lensId] ?? LENSES[lensId].defaultModel;
}

function buildOpts(
  lensId: LensId,
  config: LensConfig,
  focusMissingCoverage: boolean,
): Record<string, unknown> {
  if (lensId === "security" && config.scannerFindings !== undefined) {
    return { scannerFindings: config.scannerFindings };
  }
  if (
    lensId === "performance" &&
    config.hotPaths !== undefined &&
    config.hotPaths.length > 0
  ) {
    return { hotPaths: config.hotPaths };
  }
  if (lensId === "test-quality" && focusMissingCoverage) {
    return { focusMissingCoverage: true };
  }
  return {};
}

/**
 * Decide which lenses to activate for a review. Pure -- same input always
 * yields the same output. The list is ordered by `LENSES` declaration order
 * (security, error-handling, clean-code, performance, api-design,
 * concurrency, test-quality, accessibility, data-safety) so `maxLenses`
 * truncation drops the tail and keeps the highest-priority core lenses.
 *
 * `changedFiles` is ignored when `stage === "PLAN_REVIEW"`. The test-quality
 * missing-coverage heuristic (which sets opts.focusMissingCoverage=true)
 * runs only in CODE_REVIEW -- renderPlanReview ignores opts anyway.
 */
export function activate(args: {
  stage: Stage;
  changedFiles: readonly string[];
  config?: LensConfig;
}): LensActivation[] {
  const { stage, changedFiles } = args;
  const config: LensConfig = args.config ?? {};

  const explicitAllow = Array.isArray(config.lenses)
    ? new Set<LensId>(config.lenses)
    : null;

  const activations: LensActivation[] = [];

  for (const lensId of LENS_IDS) {
    if (explicitAllow !== null && !explicitAllow.has(lensId)) continue;

    let activationReason: string | null = null;
    let focusMissingCoverage = false;

    if (explicitAllow !== null) {
      activationReason = "explicit lens allow-list";
    } else if (stage === "PLAN_REVIEW") {
      const excluded =
        config.planKind !== undefined
          ? PLAN_KIND_EXCLUSIONS[config.planKind]
          : undefined;
      if (excluded === undefined || !excluded.includes(lensId)) {
        activationReason = "plan review: all lenses";
      }
      // else: filtered by the plan-kind hint; activationReason stays null -> skipped
    } else {
      const rule = SURFACE_RULES[lensId];
      if (rule === "core") {
        activationReason = "core lens";
      } else if (rule === "test-quality-dual-mode") {
        const testHit = findTestFile(changedFiles);
        if (testHit !== null) {
          activationReason = `test file changed (${testHit})`;
        } else {
          const srcHit = findNonTestSourceFile(changedFiles);
          if (srcHit !== null) {
            activationReason = `source changed without tests (${srcHit})`;
            focusMissingCoverage = true;
          }
        }
      } else {
        const hit = matchesSurface(changedFiles, rule);
        if (hit !== null) activationReason = `surface match: ${hit}`;
      }
    }

    if (activationReason === null) continue;

    activations.push({
      lensId,
      model: resolveModel(lensId, config.lensModels),
      activationReason,
      opts: buildOpts(lensId, config, focusMissingCoverage),
    });
  }

  if (
    config.maxLenses !== undefined &&
    activations.length > config.maxLenses
  ) {
    return activations.slice(0, config.maxLenses);
  }
  return activations;
}
