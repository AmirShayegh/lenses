# @amirshayegh/lenses

Multi-lens code review MCP server — 8 specialized reviewers run in parallel, with findings deduplicated, confidence-filtered, and rolled into a single verdict.

## Installation

```sh
npm install -g @amirshayegh/lenses
```

## Register with Claude Code

```sh
claude mcp add lenses -s user -- lenses --mcp
```

After registration, two tools become available in your Claude Code session:

- `lens_review_start` — Returns per-lens prompts for your agent to spawn as subagents, plus any cached findings from prior rounds.
- `lens_review_complete` — Takes the subagent outputs and returns the merged verdict, findings, tensions, and blocking list.

## Architecture

See `CLAUDE.md` in the source repository for the two-hop flow, lens activation logic, merger semantics, and session caching.

## License

MIT
