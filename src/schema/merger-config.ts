/**
 * T-011 merger-time configuration.
 *
 * Two knobs drive the post-dedup transform in `src/merger/blocking-policy.ts`:
 *
 *  - `confidenceFloor` -- findings below this confidence are dropped UNLESS
 *    their category is in `alwaysBlock`. Default 0.6.
 *  - `blockingPolicy` -- category/lens rules applied after the floor.
 *      - `alwaysBlock`: categories promoted to severity `blocking` regardless
 *        of what the lens reported. Defaults to the security-critical set
 *        `DEFAULT_ALWAYS_BLOCK` below. Also bypasses the confidence floor.
 *      - `neverBlock`: lens ids whose blocking-severity findings get demoted
 *        to `major` -- BUT only when EVERY `contributingLens` on the finding
 *        is in `neverBlock`. A single non-muted lens agreeing keeps the
 *        blocking signal. Defaults to empty.
 *
 * Precedence: `alwaysBlock > confidenceFloor > neverBlock`.
 */

import { z } from "zod";

export const DEFAULT_ALWAYS_BLOCK: readonly string[] = [
  "injection",
  "auth-bypass",
  "hardcoded-secrets",
] as const;

export const BlockingPolicySchema = z
  .object({
    alwaysBlock: z
      .array(z.string().min(1))
      .default(() => [...DEFAULT_ALWAYS_BLOCK]),
    neverBlock: z.array(z.string().min(1)).default(() => []),
  })
  .strict();
export type BlockingPolicy = z.infer<typeof BlockingPolicySchema>;

/**
 * `blockingPolicy` is `.optional().default(...)` rather than relying on a
 * plain nested `.default({})`: the nested default only fires when the FIELD
 * is `undefined` at parse time, not when the ENCLOSING object is absent.
 * Making it optional at the outer level means a partial config like
 * `{ confidenceFloor: 0.5 }` fills `blockingPolicy` with full defaults
 * instead of erroring on a missing key.
 *
 * The default factory builds the object literal directly instead of
 * calling `BlockingPolicySchema.parse({})` to avoid a per-parse
 * self-reference into the schema.
 */
export const MergerConfigSchema = z
  .object({
    confidenceFloor: z.number().min(0).max(1).default(0.6),
    blockingPolicy: BlockingPolicySchema.optional().default(() => ({
      alwaysBlock: [...DEFAULT_ALWAYS_BLOCK],
      neverBlock: [],
    })),
  })
  .strict()
  .default(() => ({}));
export type MergerConfig = z.infer<typeof MergerConfigSchema>;

/**
 * Frozen, module-level default. The pipeline's hot path resolves
 * `input.mergerConfig ?? DEFAULT_MERGER_CONFIG` instead of re-parsing the
 * schema on every config-absent call. Also makes the default value
 * directly inspectable in tests without exercising the Zod path.
 *
 * `Object.freeze` applied at every nesting level (outer, blockingPolicy,
 * and both arrays) so an accidental write from anywhere in the pipeline
 * throws in strict mode rather than silently corrupting the shared
 * default for every subsequent call.
 */
export const DEFAULT_MERGER_CONFIG: MergerConfig = (() => {
  const parsed = MergerConfigSchema.parse(undefined);
  return Object.freeze({
    confidenceFloor: parsed.confidenceFloor,
    blockingPolicy: Object.freeze({
      alwaysBlock: Object.freeze([...parsed.blockingPolicy.alwaysBlock]),
      neverBlock: Object.freeze([...parsed.blockingPolicy.neverBlock]),
    }),
  }) as MergerConfig;
})();
