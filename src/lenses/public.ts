/**
 * T-033 public projection of the lens registry.
 *
 * This module is the ONLY place the lens registry and surface-routing rules
 * become part of the stable 0.3.0 library surface consumed by the storybloq
 * autonomous backend (workspace ISS-822 Option A). It exposes identity +
 * routing metadata as deep-frozen projection copies -- never the internal
 * `LensDefinition` singletons, their Zod `optsSchema` instances, or their
 * `renderBody` closures. Freezing the public copies means a consumer cannot
 * reach or mutate any object that `buildLensPrompt` / `activate` read, so the
 * public surface can never alter prompt construction. See the "Mutability
 * boundary" note in README.md.
 */

import {
  LENSES as INTERNAL_LENSES,
  type LensDefinition,
  type LensId,
} from "./prompts/index.js";
import {
  SURFACE_RULES as INTERNAL_SURFACE_RULES,
  type SurfaceRule,
} from "./registry.js";

/**
 * Public projection of a lens: identity + routing metadata only. No Zod
 * schema, no renderBody -- see the Mutability boundary note in README.
 */
export type PublicLensDefinition = Pick<
  LensDefinition,
  "id" | "version" | "defaultModel" | "maxSeverity" | "type"
>;

/**
 * Re-export so `Readonly<Record<LensId, SurfaceRule>>` names a public type.
 * The underlying `Surface` interface stays internal to registry.ts.
 */
export type { SurfaceRule };

/**
 * Frozen per-lens identity + routing projections, built once at module load.
 * All five projected fields are strings, so shallow freeze is a full deep
 * freeze. Mutating any projection (or the record) throws in strict mode and
 * can never alter prompt construction -- the internal registry read by
 * `buildLensPrompt` is a disjoint, unfrozen object.
 */
export const LENSES: Readonly<Record<LensId, PublicLensDefinition>> =
  Object.freeze(
    Object.fromEntries(
      (Object.keys(INTERNAL_LENSES) as LensId[]).map((id) => {
        const def = INTERNAL_LENSES[id];
        const projection: PublicLensDefinition = {
          id: def.id,
          version: def.version,
          defaultModel: def.defaultModel,
          maxSeverity: def.maxSeverity,
          type: def.type,
        };
        return [id, Object.freeze(projection)];
      }),
    ) as Record<LensId, PublicLensDefinition>,
  );

/**
 * Look up the frozen public projection for a lens id. Throws with the valid
 * id list on an unknown id, mirroring `renderLensBody`'s runtime guard.
 */
export function getLens(lensId: LensId): PublicLensDefinition {
  const def = (LENSES as Record<string, PublicLensDefinition | undefined>)[
    lensId
  ];
  if (!def) {
    throw new Error(
      `Unknown lensId: ${JSON.stringify(lensId)}. Valid ids: ${Object.keys(LENSES).join(", ")}`,
    );
  }
  return def;
}

/**
 * Deep-freeze one surface rule: string sentinels pass through; object rules
 * are copied field-by-field with each array value frozen, then the object is
 * frozen.
 */
function freezeRule(rule: SurfaceRule): SurfaceRule {
  if (typeof rule === "string") {
    return rule;
  }
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rule)) {
    copy[key] = Array.isArray(value) ? Object.freeze([...value]) : value;
  }
  return Object.freeze(copy) as SurfaceRule;
}

/**
 * Deep-frozen deep COPY of the internal surface-activation rules. Mutating any
 * rule, nested array, or the record throws in strict mode and can never alter
 * activation -- `activate` reads the internal, unfrozen `SURFACE_RULES`.
 */
export const SURFACE_RULES: Readonly<Record<LensId, SurfaceRule>> =
  Object.freeze(
    Object.fromEntries(
      (Object.keys(INTERNAL_SURFACE_RULES) as LensId[]).map((id) => [
        id,
        freezeRule(INTERNAL_SURFACE_RULES[id]),
      ]),
    ) as Record<LensId, SurfaceRule>,
  );
