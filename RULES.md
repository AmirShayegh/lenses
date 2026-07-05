# Lenses -- Development Rules

## 1. TypeScript

- Node.js 20+, ESM modules
- Strict TypeScript (`strict: true`)
- Zod for all external input validation (MCP tool params, lens output, config)
- No `any` types -- use `unknown` and narrow with Zod

## 2. Testing

- vitest for all tests
- Every tool, merger function, and schema validator must have tests
- Test lens prompts produce valid output by mocking agent responses
- Integration tests against the MCP SDK test harness

## 3. Prompts

- Lens prompts are the core IP -- they live in `src/lenses/prompts/` as TypeScript template literals
- Never truncate prompts -- if a prompt is too large, the architecture is wrong
- Prompts are self-contained: shared preamble + lens-specific instructions + stage instructions + artifact, all in one string
- Prompt changes require re-running the affected lens against a known artifact and verifying output quality

## 4. MCP Server

- Three tools: `lens_review_start`, `lens_review_get_prompt`, `lens_review_complete`
  - `lens_review_start` (hop 1) returns `{reviewId, agents: [{id, model, promptHash, expiresAt}], cached: [{id, findings}]}`. Refs, not prompts — keeps the hop-1 payload small.
  - `lens_review_get_prompt` fetches the full prompt for one lens in an active review. Called once per spawned agent. The prompt is stateless per (reviewId, lensId); the response also carries the lens's AUTHORITATIVE `expiresAt` (T-027: the first attempt-1 fetch anchors the deadline to fetch time plus the lens's timeout budget, once per attempt, durably; hop-1's `agents[].expiresAt` is provisional).
  - `lens_review_complete` (hop 2+) accepts per-lens outputs with optional `attempt` for retry, incrementally: partial batches and empty polls are fine. Returns a rich verdict envelope including `parseErrors[]`, `deferred[]`, `hadAnyFindings`, `nextActions[]` (each retry carries a FRESH per-attempt `expiresAt`), and the T-027 coverage disclosure (`lensCoverage[]`, `coverage`, `errorCodes`, `reviewComplete`). A late result diverts its lens to `expired` coverage instead of rejecting the call; an expired or otherwise uncovered CORE lens caps the verdict below `approve`; `reviewComplete: false` marks an interim envelope (review still open).
- No side effects beyond session cache files (temp directory)
- Stateless between calls except session cache (keyed by reviewId)
- Graceful degradation: if cache is unavailable, skip caching, don't fail. The ONE deliberate exception (T-027): the durable completion write on a FINALIZING `lens_review_complete` call is strict; if it fails, the call returns the `PERSISTENCE_FAILED` error envelope, the review stays open, and the finalizing call can simply be retried. Interim calls keep the fully graceful path.

## 5. Verdict Logic

- Verdict computation is deterministic -- same findings always produce same verdict
- Blocking policy is configurable but has safe defaults
- Confidence floor filters noise -- findings below threshold are dropped, not downgraded
- Deduplication is by (file, line, category) -- same issue from multiple lenses merges into one finding
- Tensions are detected and reported, not resolved -- the agent/user decides

## 6. No API Keys

- The server never calls any AI API directly
- Claude Code spawns the subagents -- the server only constructs prompts and processes results
- No secrets, tokens, or credentials stored or managed
