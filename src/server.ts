import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import {
  LENS_REVIEW_COMPLETE_NAME,
  handleLensReviewComplete,
  lensReviewCompleteDefinition,
} from "./tools/complete.js";
import {
  LENS_REVIEW_GET_PROMPT_NAME,
  handleLensReviewGetPrompt,
  lensReviewGetPromptDefinition,
} from "./tools/get-prompt.js";
import {
  LENS_REVIEW_START_NAME,
  handleLensReviewStart,
  lensReviewStartDefinition,
} from "./tools/start.js";

const SERVER_INFO = { name: "lenses", version: __LENSES_VERSION__ } as const;

/**
 * Build a configured MCP Server. Tool handlers are wired here; transport is not —
 * callers pick stdio (for the CLI bin) or an in-memory pair (for tests).
 *
 * T-022: the server advertises THREE tools. `lens_review_start` returns
 * refs (promptHash + expiresAt); `lens_review_get_prompt` fetches the
 * full prompt for one lens; `lens_review_complete` accepts per-lens
 * outputs and returns the verdict. See RULES.md §4 for the full contract.
 */
export function createServer(): Server {
  const server = new Server(SERVER_INFO, {
    capabilities: { tools: {} },
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      lensReviewStartDefinition,
      lensReviewGetPromptDefinition,
      lensReviewCompleteDefinition,
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    switch (req.params.name) {
      case LENS_REVIEW_START_NAME:
        return handleLensReviewStart(req);
      case LENS_REVIEW_GET_PROMPT_NAME:
        return handleLensReviewGetPrompt(req);
      case LENS_REVIEW_COMPLETE_NAME:
        return handleLensReviewComplete(req);
      default:
        throw new Error(`Unknown tool: ${req.params.name}`);
    }
  });

  return server;
}

/**
 * Entry point for the CLI bin. Binds the server to stdio transport and blocks
 * until the client disconnects (SIGTERM / stdin closed).
 */
export async function main(): Promise<void> {
  const server = createServer();
  // Imported dynamically, not at module scope: the SDK's stdio.js imports
  // node:process, and Node's ESM builtin facade eagerly reads every export at
  // link time -- including the stdin getter, which constructs the TTY. A static
  // import here would make ANY import of this package (index.ts re-exports
  // main) acquire stdin, and on a wedged pty that open() hangs uninterruptibly
  // (storybloq ISS-1043). Dynamic import defers it to the one caller that
  // actually wants stdio.
  const { StdioServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/stdio.js"
  );
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
