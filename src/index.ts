export { main } from "./server.js";
export * from "./schema/index.js";
export type { LensId } from "./lenses/prompts/index.js";

// T-033 stable 0.3.0 library surface (consumed by the storybloq autonomous
// backend, workspace ISS-822 Option A). See README "Stable library API".
export {
  LENSES,
  getLens,
  SURFACE_RULES,
  type PublicLensDefinition,
  type SurfaceRule,
} from "./lenses/public.js";
export {
  activate,
  LensConfigSchema,
  LensIdSchema,
  type LensActivation,
  type Model,
  type LensConfig,
} from "./lenses/registry.js";
export {
  renderLensBody,
  renderSharedPreamble,
  type SharedPreambleParams,
} from "./lenses/prompts/index.js";
export {
  buildLensPrompt,
  buildAgentPrompts,
  PreambleConfigSchema,
  ProjectContextSchema,
  type AgentPrompt,
  type BuildLensPromptParams,
  type BuildAgentPromptsParams,
  type PreambleConfig,
  type PreambleConfigInput,
  type ProjectContext,
} from "./lenses/prompt-builder.js";
export {
  runMergerPipeline,
  type MergerInput,
  type LensRunResult,
} from "./merger/pipeline.js";
