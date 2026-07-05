/**
 * T-027 R10/R-D1: the single source of truth for the CORE lens set.
 *
 * This is a LEAF module with ZERO runtime imports (the LensId import
 * below is type-only and erased at compile time), so it can be consumed
 * by BOTH src/lenses/registry.ts (which builds the four "core"
 * SURFACE_RULES entries from it) and src/schema/verdict.ts (which
 * enforces the core-coverage approve cap) without creating an ESM
 * cycle. schema code must import THIS leaf directly, never registry:
 * the registry route is a real cycle because prompts/index.ts
 * export-stars shared-preamble.ts, which value-imports schema/index.ts.
 */

import type { LensId } from "./prompts/index.js";

export const CORE_LENS_IDS = [
  "security",
  "error-handling",
  "clean-code",
  "concurrency",
] as const satisfies readonly LensId[];

export type CoreLensId = (typeof CORE_LENS_IDS)[number];
