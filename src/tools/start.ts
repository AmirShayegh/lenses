import { randomUUID } from "node:crypto";

import type {
  CallToolRequest,
  CallToolResult,
  ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { hashLensPrompt, readLensCache } from "../cache/lens-cache.js";
import {
  activate,
  LensConfigSchema,
  LensIdSchema,
  ModelSchema,
  resolveLensTimeoutMs,
} from "../lenses/registry.js";
import type { LensId } from "../lenses/prompts/index.js";
import {
  buildAgentPrompts,
  PreambleConfigSchema,
  ProjectContextSchema,
} from "../lenses/prompt-builder.js";
import { sanitizeFindingForStorage } from "../merger/anchor.js";
import { LensFindingSchema, type LensFinding } from "../schema/finding.js";
import { type StartParams } from "../schema/index.js";
import { sharedStartShape } from "../schema/params.js";
import {
  registerReview,
  type CachedLensEntry,
} from "../state/review-state.js";

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
 * Wire response shape (T-022 refs-not-prompts). The agent receives
 * `promptHash` + `expiresAt` per spawned lens and fetches the full prompt
 * via `lens_review_get_prompt` just before spawning its subagent. Collapses
 * the hop-1 payload from ~68KB (inline prompts × 6 lenses) to <5KB for a
 * typical activation -- no more parser-subagent needed to read hop-1.
 *
 * `id` (wire) vs `lensId` (internal) -- the handler renames once at
 * serialization so internal code keeps the more descriptive field name
 * everywhere else.
 */
export const StartToolOutputSchema = z
  .object({
    reviewId: z.string().uuid(),
    agents: z.array(
      z
        .object({
          id: LensIdSchema,
          model: ModelSchema,
          promptHash: z.string().min(1),
          expiresAt: z.string().datetime({ offset: true }),
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
    "Begin a multi-lens review. Returns a reviewId and a list of agents (each " +
    "with promptHash + a PROVISIONAL expiresAt); fetch the actual prompt for " +
    "each agent via lens_review_get_prompt before spawning -- that fetch " +
    "anchors and returns the lens's authoritative deadline. Hop 1 of 2+.",
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
 * Attempt a cache read for one activated lens. Best-effort: a throw
 * from `readLensCache` (shouldn't, but defense-in-depth against a
 * future refactor) is logged and treated as a miss so a broken cache
 * cannot block the review.
 */
function tryCacheRead(
  lensId: LensId,
  promptHash: string,
): CachedLensEntry | undefined {
  try {
    const hit = readLensCache(lensId, promptHash);
    if (!hit) return undefined;
    // T-026 R-C4(b): the lens-cache READ choke point. Strip server-owned
    // finding fields from cached findings so a value that round-tripped the
    // cache (from a lens that supplied it before the ingestion strip, or a
    // pre-upgrade file) never surfaces in round-2's `cached[]` wire array
    // without passing the merger. Single canonical stripper (same helper as
    // the ingestion + cache-write choke points).
    return {
      findings: hit.findings.map(sanitizeFindingForStorage),
      notes: hit.notes,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`lens_review_start: lens cache read failed: ${message}`);
    return undefined;
  }
}

function buildResponse(parsed: StartToolInput): StartToolOutput {
  const { lensConfig, preambleConfig, projectContext, ...startParamsLike } =
    parsed;
  const startParams: StartParams = startParamsLike as StartParams;

  const activations = activate({
    stage: parsed.stage,
    changedFiles: parsed.stage === "CODE_REVIEW" ? parsed.changedFiles : [],
    config: lensConfig,
  });

  const built = buildAgentPrompts({
    activations,
    startParams,
    preambleConfig,
    ...(projectContext !== undefined ? { projectContext } : {}),
  });

  // T-015 cache resolution.
  const promptHashes = new Map<LensId, string>();
  const cachedEntries = new Map<LensId, CachedLensEntry>();
  const cachedWire: Array<{ id: LensId; findings: LensFinding[] }> = [];
  const spawnedAgents: typeof built = [];
  for (const agent of built) {
    const promptHash = hashLensPrompt(agent.prompt);
    promptHashes.set(agent.lensId, promptHash);
    const hit = tryCacheRead(agent.lensId, promptHash);
    if (hit) {
      cachedEntries.set(agent.lensId, hit);
      cachedWire.push({ id: agent.lensId, findings: [...hit.findings] });
    } else {
      spawnedAgents.push(agent);
    }
  }

  // T-022: store the full prompt text + compute expiresAt per lens.
  // The prompt map drives `lens_review_get_prompt`; the expiresAt map
  // drives the per-lens expiry disposition in `lens_review_complete`.
  //
  // T-027 R-D4: the hop-1 expiresAt is PROVISIONAL. It becomes
  // authoritative only if the prompt is never fetched; the first
  // attempt-1 `lens_review_get_prompt` call re-anchors the deadline to
  // fetch-time + the SAME per-lens timeout budget recorded here, so
  // orchestrator think-time between hop-1 and spawn no longer burns
  // the lens's window (DEFECT 1).
  const prompts = new Map<LensId, string>();
  const perLensExpiresAt = new Map<LensId, number>();
  const perLensTimeoutMs = new Map<LensId, number>();
  const nowMs = Date.now();
  const wireAgents: Array<{
    id: LensId;
    model: "opus" | "sonnet";
    promptHash: string;
    expiresAt: string;
  }> = [];
  for (const agent of spawnedAgents) {
    prompts.set(agent.lensId, agent.prompt);
    const timeoutMs = resolveLensTimeoutMs(agent.model, lensConfig);
    perLensTimeoutMs.set(agent.lensId, timeoutMs);
    const expiresMs = nowMs + timeoutMs;
    perLensExpiresAt.set(agent.lensId, expiresMs);
    const hash = promptHashes.get(agent.lensId);
    // Invariant: every spawned agent hashed its prompt above, so `hash`
    // is always defined here. Defensive narrowing for the type system.
    if (hash === undefined) {
      throw new Error(
        `lens_review_start: missing promptHash for ${agent.lensId}`,
      );
    }
    wireAgents.push({
      id: agent.lensId,
      model: agent.model,
      promptHash: hash,
      expiresAt: new Date(expiresMs).toISOString(),
    });
  }

  const reviewId = randomUUID();
  const sessionId = parsed.sessionId ?? randomUUID();
  // T-024: pass lensModels so the in-flight index can record each
  // spawned lens's model. Only spawned agents get a model entry;
  // cached-only lenses aren't re-spawned and have no retry path.
  const lensModels = new Map<LensId, "opus" | "sonnet">();
  for (const agent of spawnedAgents) {
    lensModels.set(agent.lensId, agent.model);
  }
  // T-026 R11: retain the artifact + changedFiles so the complete-time
  // anchor pass can verify snippets. changedFiles is [] for PLAN_REVIEW.
  const retainedChangedFiles =
    parsed.stage === "CODE_REVIEW" ? parsed.changedFiles : [];
  registerReview({
    reviewId,
    sessionId,
    stage: parsed.stage,
    expectedLensIds: built.map((a) => a.lensId),
    reviewRound: parsed.reviewRound,
    priorDeferrals: parsed.priorDeferrals,
    cachedResults: cachedEntries,
    promptHashes,
    prompts,
    perLensExpiresAt,
    lensModels,
    artifact: parsed.artifact,
    changedFiles: retainedChangedFiles,
    // T-027 R14(h): persist each lens's timeout budget so the fetch
    // anchor and retry mint use the caller's configured value (not the
    // model default) even after a restart.
    perLensTimeoutMs,
  });

  return {
    reviewId,
    agents: wireAgents,
    cached: cachedWire,
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
