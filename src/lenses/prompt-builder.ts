import { z } from "zod";

import type { StartParams } from "../schema/index.js";
import {
  LENSES,
  renderLensBody,
  renderSharedPreamble,
  type LensId,
} from "./prompts/index.js";
import type { LensActivation, Model } from "./registry.js";

/**
 * Preamble tuning knobs -- disjoint from T-006's LensConfigSchema. Activation
 * config answers "which lenses fire / what opts each gets"; preamble config
 * answers "how does each lens body frame its output." Keeping the schemas
 * independent lets T-008 compose both without each test carrying irrelevant
 * fields from the other.
 *
 * Defaults mirror the lensConfig defaults documented in CLAUDE.md:
 *   findingBudget = 10, confidenceFloor = 0.6.
 * When CLAUDE.md's defaults change, update both in lockstep.
 */
export const PreambleConfigSchema = z
  .object({
    findingBudget: z.number().int().min(1).max(50).default(10),
    confidenceFloor: z.number().min(0).max(1).default(0.6),
  })
  .strict();
export type PreambleConfig = z.infer<typeof PreambleConfigSchema>;
export type PreambleConfigInput = z.input<typeof PreambleConfigSchema>;

/**
 * Per-review untrusted context applied to every lens in the run. Strings flow
 * straight into the shared preamble where `untrusted()` wraps them in
 * `<untrusted-context>` blocks -- the wrapper is the trust boundary, no
 * separate validation happens here.
 */
export interface ProjectContext {
  readonly projectRules?: string;
  readonly knownFalsePositives?: string;
}

/**
 * Output shape -- one per activated lens. `lensId` is what the rest of the
 * codebase uses; T-008 aliases it to `id` at the MCP wire boundary to match
 * the CLAUDE.md response contract `agents: [{ id, model, prompt }]`.
 */
export interface AgentPrompt {
  readonly lensId: LensId;
  readonly model: Model;
  readonly prompt: string;
}

export interface BuildLensPromptParams {
  readonly activation: LensActivation;
  readonly startParams: StartParams;
  readonly preambleConfig: PreambleConfig;
  readonly projectContext?: ProjectContext;
}

/**
 * Join the shared preamble and the per-lens body into the single complete
 * string the agent hands verbatim to a spawned subagent. Pure: same input
 * always yields the same output.
 *
 * `LENSES[lensId].version` is the only source of `lensVersion` -- LensActivation
 * deliberately omits identity metadata (T-006 decides WHICH lens and HOW, the
 * registry owns WHO).
 *
 * Per-lens opts validation already happens inside `renderLensBody` via each
 * lens's Zod `optsSchema`. We do NOT re-parse here -- one trust boundary, not
 * two, avoids drift.
 */
export function buildLensPrompt(params: BuildLensPromptParams): AgentPrompt {
  const { activation, startParams, preambleConfig, projectContext } = params;
  const def = LENSES[activation.lensId];

  const preamble = renderSharedPreamble({
    ...startParams,
    lensId: activation.lensId,
    lensVersion: def.version,
    findingBudget: preambleConfig.findingBudget,
    confidenceFloor: preambleConfig.confidenceFloor,
    ...(activation.activationReason.length > 0
      ? { activationReason: activation.activationReason }
      : {}),
    ...(projectContext?.projectRules !== undefined
      ? { projectRules: projectContext.projectRules }
      : {}),
    ...(projectContext?.knownFalsePositives !== undefined
      ? { knownFalsePositives: projectContext.knownFalsePositives }
      : {}),
  });

  const body = renderLensBody(
    activation.lensId,
    startParams.stage,
    activation.opts,
  );

  // renderSharedPreamble returns "...\n\n" and every renderBody returns
  // "...\n" -- concatenation needs no custom separator.
  return {
    lensId: activation.lensId,
    model: activation.model,
    prompt: preamble + body,
  };
}

export interface BuildAgentPromptsParams {
  readonly activations: readonly LensActivation[];
  readonly startParams: StartParams;
  readonly preambleConfig: PreambleConfig;
  readonly projectContext?: ProjectContext;
}

/**
 * Map every activation to its complete prompt. Order is preserved -- T-006
 * emits activations in LENSES-declaration order, which keeps `maxLenses`
 * truncation deterministic and makes test assertions stable.
 */
export function buildAgentPrompts(
  params: BuildAgentPromptsParams,
): AgentPrompt[] {
  return params.activations.map((activation) =>
    buildLensPrompt({
      activation,
      startParams: params.startParams,
      preambleConfig: params.preambleConfig,
      ...(params.projectContext !== undefined
        ? { projectContext: params.projectContext }
        : {}),
    }),
  );
}
