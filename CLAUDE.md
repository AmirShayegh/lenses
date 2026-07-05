# Lenses -- Multi-Lens Code Review MCP Server

## What This Is

An MCP server that runs 8 specialized code reviewers in parallel and returns a structured verdict. Three tool calls: `lens_review_start` (returns agent refs — promptHash + expiresAt — plus any cached findings), `lens_review_get_prompt` (fetches one lens's full prompt, called once per spawn), and `lens_review_complete` (takes results, returns verdict with rich envelope including parseErrors / deferred / nextActions). The agent spawns subagents -- the server handles everything else: lens selection, prompt construction, deduplication, confidence filtering, blocking policy, tension resolution, verdict computation, and cooperative retry protocol.

## Why This Exists

The previous lens review system required the AI agent to orchestrate 7 steps manually (prepare, read files, spawn agents, collect, synthesize, parse, present). Every step was a failure point. Results varied between runs. This server moves all orchestration logic server-side, leaving the agent with one job: spawn agents with provided prompts and pipe results back.

## Architecture

### Two-Hop+ Flow

**Hop 1: `lens_review_start`**
- Input: stage (PLAN_REVIEW or CODE_REVIEW), artifact (plan text or diff), changed files, config
- Server: selects active lenses, builds complete self-contained prompts (never truncated), decides model per lens, computes a PROVISIONAL per-lens `expiresAt` from `lensTimeout` (T-027: the authoritative deadline is anchored at prompt-fetch time)
- Output: `{ reviewId, agents: [{ id, model, promptHash, expiresAt }], cached: [{ id, findings }] }` — refs, not prompts, so the hop-1 payload stays small (<5KB for 6 lenses)

**Hop 1.5: `lens_review_get_prompt`**
- Input: `{ reviewId, lensId }`
- Server: returns the full activation prompt for that lens. The first attempt-1 fetch anchors the lens's deadline (full timeout budget from fetch time); anchoring is once-per-attempt and durable, so repeated fetches or restarts never re-extend it.
- Output: `{ prompt, expiresAt }`. The prompt is stateless (same input always yields the same string for the review's lifetime); `expiresAt` is the AUTHORITATIVE deadline for the lens (absent only for a lens with no registered deadline, which never expires).

**Hop 2+: `lens_review_complete`**
- Input: `reviewId`, per-lens outputs with optional `attempt` (default 1); partial batches and empty polls are accepted
- Server: validates envelopes with `.passthrough()` (unknown keys ignored), validates per-finding with `.strict()` (hallucination rejected and surfaced as `parseErrors[]`), deduplicates, filters by confidence (with dropped findings surfaced in `deferred[]`), applies blocking policy, resolves tensions, computes verdict. Emits `nextActions[]` for retryable failures while attempts remain, each with a FRESH per-attempt `expiresAt` (full timeout budget from emission time); rejects stale or non-contiguous attempts. A result past its lens deadline diverts that lens to `expired` coverage instead of rejecting the call; a core lens (security, error-handling, clean-code, concurrency) outside ok/cached coverage caps the verdict below `approve`.
- Output: `{ verdict, findings, tensions, blocking, major, minor, suggestions, sessionId, parseErrors, deferred, suppressedFindingCount, hadAnyFindings, nextActions, lensCoverage, coverage, errorCodes, reviewComplete }`

The caller honors the cooperative retry protocol: when `nextActions[]` is non-empty, re-spawn the named lenses with `retryPrompt` and resubmit via `lens_review_complete` with `attempt: N+1`. `max_attempts` defaults to 2. `reviewComplete: false` marks an INTERIM envelope: the review stays open (retries pending or expected lenses still uncovered), so resubmit or poll again; interim envelopes never carry `approve`. `lensCoverage[]` discloses one entry per expected lens (`ok` / `error` / `parse_failed` / `expired` / `cached` / `skipped`), `coverage` is `partial` iff any lens is outside ok/cached, and `errorCodes` carries `PARTIAL_RESULTS` iff any lens expired.

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
- **Package**: @storybloq/lenses on npm

## Project Structure

```
src/
  server.ts              -- MCP server entry point
  tools/
    start.ts             -- lens_review_start tool (hop 1: refs + expiresAt)
    get-prompt.ts        -- lens_review_get_prompt tool (hop 1.5: prompt fetch)
    complete.ts          -- lens_review_complete tool (hop 2+: verdict + retry)
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

Standalone: `npm install -g @storybloq/lenses && claude mcp add lenses -s user -- lenses --mcp`

Bundled: installed automatically as a dependency of `@anthropologies/claudestory` via `claudestory setup-skill`.

## Relationship to Other Projects

- **claudestory** (`@anthropologies/claudestory`): Project tracking + autonomous guide. Depends on lenses for CODE_REVIEW and PLAN_REVIEW stages. Bundles lenses as npm dependency.
- **codex-bridge** (`@amirshayegh/codex-claude-bridge`): Single-model deep review via OpenAI Codex. Complementary to lenses -- codex gives depth, lenses give breadth.
