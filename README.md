# @storybloq/lenses

Multi-lens code review MCP server — 8 specialized reviewers run in parallel, with findings deduplicated, confidence-filtered, and rolled into a single verdict.

## Installation

```sh
npm install -g @storybloq/lenses
```

## Register with Claude Code

```sh
claude mcp add lenses -s user -- lenses --mcp
```

After registration, three tools become available in your Claude Code session:

- `lens_review_start` — Returns `{reviewId, agents: [{id, model, promptHash, expiresAt}], cached}`. Refs-not-prompts shape keeps the hop-1 payload small; fetch the actual prompt for each agent via `lens_review_get_prompt` before spawning.
- `lens_review_get_prompt` — Looks up the full prompt for one lens in an active review. Stateless per `(reviewId, lensId)`.
- `lens_review_complete` — Accepts the subagent outputs (with optional `attempt` for retry) and returns the merged verdict. The envelope includes `parseErrors[]`, `deferred[]`, `suppressedFindingCount`, `hadAnyFindings`, and `nextActions[]` for the cooperative retry protocol.

## Architecture

See `CLAUDE.md` in the source repository for the two-hop flow, lens activation logic, merger semantics, and session caching.

## Stable library API

The package root (`@storybloq/lenses`) is a stable library surface, not just an MCP server entry point. It is consumed directly by the storybloq autonomous review backend, so existing exports are not renamed or removed across minor versions. The exported core is:

- `LENSES`, `getLens`, `SURFACE_RULES` - the lens registry projection and surface-activation routing rules
- `activate` - decide which lenses fire for a review (with `LensConfigSchema`, `LensIdSchema`)
- `buildLensPrompt`, `buildAgentPrompts` - construct the complete self-contained prompt(s) for activated lenses
- `renderLensBody`, `renderSharedPreamble` - lower-level prompt-body and shared-preamble renderers
- `runMergerPipeline` - the single merger entry that runs dedup, blocking policy, tension detection, and verdict computation over per-lens outputs
- the schema, verdict, and blocking-policy types and Zod validators re-exported from `src/schema`

### Mutability boundary

All registry objects exported from the package root (`LENSES`, each lens projection, `SURFACE_RULES`, its nested rule objects and arrays) are frozen projection copies. The Zod schema instances (`optsSchema`) and `renderBody` implementations that live on the internal lens definitions are internal and unreachable from the public surface. Mutating any exported registry object throws in strict mode and can never alter prompt construction: the internal registry that `buildLensPrompt` and `activate` read is a separate, unfrozen object, disjoint from the frozen public projection.

## License

PolyForm-Noncommercial-1.0.0
