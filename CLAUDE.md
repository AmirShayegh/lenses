# Lenses -- Multi-Lens Code Review MCP Server

## What This Is

An MCP server that runs 8 specialized code reviewers in parallel and returns a structured verdict. Two tool calls: `lens_review_start` (returns prompts for the agent to spawn) and `lens_review_complete` (takes results, returns verdict). The agent spawns subagents -- the server handles everything else: lens selection, prompt construction, deduplication, confidence filtering, blocking policy, tension resolution, and verdict computation.

## Why This Exists

The previous lens review system required the AI agent to orchestrate 7 steps manually (prepare, read files, spawn agents, collect, synthesize, parse, present). Every step was a failure point. Results varied between runs. This server moves all orchestration logic server-side, leaving the agent with one job: spawn agents with provided prompts and pipe results back.

## Architecture

### Two-Hop Flow

**Hop 1: `lens_review_start`**
- Input: stage (PLAN_REVIEW or CODE_REVIEW), artifact (plan text or diff), changed files, config
- Server: selects active lenses, builds complete self-contained prompts (never truncated), decides model per lens
- Output: `{ reviewId, agents: [{ id, model, prompt }], cached: [{ id, findings }] }`

**Hop 2: `lens_review_complete`**
- Input: reviewId, raw JSON output from each spawned agent
- Server: validates (Zod), deduplicates, filters by confidence, applies blocking policy, resolves tensions, computes verdict
- Output: `{ verdict, findings, tensions, blocking, major, minor, suggestions, sessionId }`

### 8 Lenses

| Lens | Default Model | Focus |
|------|--------------|-------|
| security | opus | Auth, injection, secrets, cryptography |
| error-handling | sonnet | Failure modes, rollback, circuit breakers, partial failure |
| clean-code | sonnet | SRP, naming, dead code, coupling, abstraction |
| performance | sonnet | Hot paths, N+1, caching, memory, sync-in-request |
| api-design | sonnet | Contracts, versioning, error envelopes, pagination |
| concurrency | opus | Races, deadlocks, actor isolation, atomicity |
| test-quality | sonnet | Coverage, assertion quality, fixture reuse, flaky tests |
| accessibility | sonnet | WCAG, focus, labels, contrast, screen reader |

### No API Key Required

The server never calls the Claude API. Claude Code is the execution engine -- the server provides the prompts, the agent spawns subagents, and the server processes results. No API key management needed.

## Tech Stack

- **Language**: TypeScript (Node.js 20+)
- **MCP SDK**: @modelcontextprotocol/sdk
- **Schema validation**: Zod
- **Build**: tsup
- **Test**: vitest
- **Package**: @amirshayegh/lenses on npm

## Project Structure

```
src/
  server.ts              -- MCP server entry point
  tools/
    start.ts             -- lens_review_start tool
    complete.ts          -- lens_review_complete tool
  lenses/
    registry.ts          -- lens activation logic (file types, stage, config)
    prompts/             -- complete prompt templates (embedded in code)
      shared-preamble.ts
      security.ts
      error-handling.ts
      clean-code.ts
      performance.ts
      api-design.ts
      concurrency.ts
      test-quality.ts
      accessibility.ts
  merger/
    dedup.ts             -- cross-lens deduplication by file+line
    tension.ts           -- cross-lens tension detection
    verdict.ts           -- deterministic verdict computation
    blocking-policy.ts   -- blocking/non-blocking category rules
  cache/
    session.ts           -- round-to-round session storage
    lens-cache.ts        -- per-lens result caching
  schema/
    finding.ts           -- Zod schemas for lens output
    verdict.ts           -- Zod schemas for final verdict
test/
  ...
```

## Distribution

Standalone: `npm install -g @amirshayegh/lenses && claude mcp add lenses -s user -- lenses --mcp`

Bundled: installed automatically as a dependency of `@anthropologies/claudestory` via `claudestory setup-skill`.

## Relationship to Other Projects

- **claudestory** (`@anthropologies/claudestory`): Project tracking + autonomous guide. Depends on lenses for CODE_REVIEW and PLAN_REVIEW stages. Bundles lenses as npm dependency.
- **codex-bridge** (`@amirshayegh/codex-claude-bridge`): Single-model deep review via OpenAI Codex. Complementary to lenses -- codex gives depth, lenses give breadth.
