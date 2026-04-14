import { randomUUID } from "node:crypto";

import type {
  CallToolRequest,
  CallToolResult,
  ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  activate,
  LensConfigSchema,
  LensIdSchema,
  ModelSchema,
} from "../lenses/registry.js";
import {
  buildAgentPrompts,
  PreambleConfigSchema,
  ProjectContextSchema,
} from "../lenses/prompt-builder.js";
import { LensFindingSchema } from "../schema/finding.js";
import { sharedStartShape, type StartParams } from "../schema/index.js";
import { registerReview } from "../state/review-state.js";

export const LENS_REVIEW_START_NAME = "lens_review_start";

/**
 * T-008 configuration shape shared by both stages. `default({})` fires inside
 * the Zod parse so downstream code always sees fully-populated values.
 *
 * `ProjectContextSchema` is imported from prompt-builder so the Zod validator
 * and the `ProjectContext` type `buildLensPrompt` consumes stay in lockstep --
 * there is one source of truth for that shape, not a parallel declaration.
 */
const configShape = {
  lensConfig: LensConfigSchema.default({}),
  preambleConfig: PreambleConfigSchema.default({}),
  projectContext: ProjectContextSchema.optional(),
} as const;

/**
 * Full MCP arguments envelope. Discriminated on `stage` to enforce the
 * CODE_REVIEW-only `changedFiles` requirement at the contract boundary --
 * the same invariant StartParamsSchema enforces for the preamble input,
 * re-expressed here because the top-level shape also includes config fields.
 *
 * Reuses `sharedStartShape` from schema/params so any evolution of the
 * review envelope propagates to both schemas automatically.
 */
export const StartToolInputSchema = z.discriminatedUnion("stage", [
  z
    .object({
      stage: z.literal("PLAN_REVIEW"),
      ...sharedStartShape,
      ...configShape,
    })
    .strict(),
  z
    .object({
      stage: z.literal("CODE_REVIEW"),
      changedFiles: z.array(z.string().min(1)).nonempty(),
      ...sharedStartShape,
      ...configShape,
    })
    .strict(),
]);
export type StartToolInput = z.infer<typeof StartToolInputSchema>;

/**
 * Wire response shape. Note `id` (wire) vs `lensId` (internal) -- the handler
 * renames once at serialization so internal code keeps the more descriptive
 * field name everywhere else.
 */
export const StartToolOutputSchema = z
  .object({
    reviewId: z.string().uuid(),
    agents: z.array(
      z
        .object({
          id: LensIdSchema,
          model: ModelSchema,
          prompt: z.string().min(1),
        })
        .strict(),
    ),
    cached: z.array(
      z
        .object({
          id: LensIdSchema,
          findings: z.array(LensFindingSchema),
        })
        .strict(),
    ),
  })
  .strict();
export type StartToolOutput = z.infer<typeof StartToolOutputSchema>;

export const lensReviewStartDefinition = {
  name: LENS_REVIEW_START_NAME,
  description:
    "Begin a multi-lens review. Returns prompts for the agent to spawn as subagents, " +
    "plus any cached lens findings. Hop 1 of 2.",
  inputSchema: {
    type: "object" as const,
    properties: {
      stage: { type: "string", enum: ["PLAN_REVIEW", "CODE_REVIEW"] },
      artifact: { type: "string" },
      ticketDescription: { type: ["string", "null"] },
      reviewRound: { type: "integer", minimum: 1 },
      priorDeferrals: { type: "array" },
      changedFiles: { type: "array" },
      lensConfig: { type: "object" },
      preambleConfig: { type: "object" },
      projectContext: { type: "object" },
    },
    required: ["stage", "artifact", "ticketDescription", "reviewRound"],
    additionalProperties: false,
  },
} satisfies ListToolsResult["tools"][number];

/**
 * Build the Hop-1 response: activate → assemble → wire-rename. Pure wrt its
 * inputs; the ONLY side effect is the reviewId generated via
 * `crypto.randomUUID()` (nondeterminism is contained to that one call so
 * tests can assert shape but not value).
 *
 * `cached` is always `[]` in T-008. T-015 will introduce per-lens caching
 * that prunes activations before prompt assembly and populates `cached`
 * from stored prior findings -- the response field is already shaped so
 * that wiring is additive, not a contract change.
 */
function buildResponse(parsed: StartToolInput): StartToolOutput {
  // `StartToolInputSchema` is a superset of `StartParamsSchema` (it adds
  // lensConfig, preambleConfig, projectContext on top of sharedStartShape +
  // stage + changedFiles). Destructuring the three config fields off leaves
  // exactly the StartParams residue. Using spread (not field-by-field
  // reconstruction) so future additions to `sharedStartShape` propagate
  // automatically without a silent drop here.
  const { lensConfig, preambleConfig, projectContext, ...startParamsLike } =
    parsed;
  const startParams: StartParams = startParamsLike as StartParams;

  const activations = activate({
    stage: parsed.stage,
    changedFiles: parsed.stage === "CODE_REVIEW" ? parsed.changedFiles : [],
    config: lensConfig,
  });

  const agents = buildAgentPrompts({
    activations,
    startParams,
    preambleConfig,
    ...(projectContext !== undefined ? { projectContext } : {}),
  });

  // Track the review in the T-020 state machine BEFORE returning so the
  // complementary `lens_review_complete` handler (T-009) can enforce
  // reviewId validity, lens coverage, and one-shot completion. The store
  // is in-memory; T-014 will layer persistence on top without changing
  // this call site.
  const reviewId = randomUUID();
  registerReview({
    reviewId,
    stage: parsed.stage,
    expectedLensIds: agents.map((a) => a.lensId),
  });

  return {
    reviewId,
    agents: agents.map(({ lensId, model, prompt }) => ({
      id: lensId,
      model,
      prompt,
    })),
    cached: [],
  };
}

function errorResult(message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}

export async function handleLensReviewStart(
  req: CallToolRequest,
): Promise<CallToolResult> {
  try {
    const parsed = StartToolInputSchema.parse(req.params.arguments);
    const response = buildResponse(parsed);
    return {
      content: [{ type: "text", text: JSON.stringify(response) }],
    };
  } catch (err) {
    // Return only the human-readable summary -- never leak Error.stack
    // through the MCP wire.
    const message =
      err instanceof z.ZodError
        ? `lens_review_start: invalid arguments: ${err.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; ")}`
        : err instanceof Error
          ? `lens_review_start: ${err.message}`
          : `lens_review_start: unknown error`;
    return errorResult(message);
  }
}
