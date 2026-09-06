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

- `lens_review_start` -- Returns `{reviewId, agents: [{id, model, promptHash, expiresAt}], cached}`. Refs-not-prompts shape keeps the hop-1 payload small; fetch the actual prompt for each agent via `lens_review_get_prompt` before spawning. The `agents[].expiresAt` is provisional: the prompt fetch anchors the authoritative deadline.
- `lens_review_get_prompt` -- Looks up the full prompt for one lens in an active review (stateless per `(reviewId, lensId)`) and returns the lens's authoritative `expiresAt`: the first attempt-1 fetch starts the lens's timeout clock, once per attempt.
- `lens_review_complete` -- Accepts the subagent outputs (with optional `attempt` for retry) incrementally (partial batches and empty polls are fine) and returns the merged verdict. The envelope includes `parseErrors[]`, `deferred[]`, `suppressedFindingCount`, `hadAnyFindings`, `nextActions[]` for the cooperative retry protocol (each retry carries a fresh per-attempt `expiresAt`), plus the coverage disclosure: `lensCoverage[]`, `coverage` (`full`/`partial`), `errorCodes` (`PARTIAL_RESULTS` when a lens expired), and `reviewComplete` (`false` marks an interim envelope; the review is still open). A late result diverts its lens to `expired` coverage instead of rejecting the call, and an uncovered core lens caps the verdict below `approve`.

## Architecture

See `CLAUDE.md` in the source repository for the two-hop flow, lens activation logic, merger semantics, and session caching.

## Stable library API

The package root (`@storybloq/lenses`) is a stable library surface, not just an MCP server entry point. It is consumed directly by the storybloq autonomous review backend, so existing exports are not renamed or removed across minor versions. The exported core is:

- `LENSES`, `getLens`, `SURFACE_RULES` - the lens registry projection and surface-activation routing rules
- `activate` - decide which lenses fire for a review (with `LensConfigSchema`, `LensIdSchema`)
- `buildLensPrompt`, `buildAgentPrompts` - construct the complete self-contained prompt(s) for activated lenses
- `renderLensBody`, `renderSharedPreamble` - lower-level prompt-body and shared-preamble renderers
- `runMergerPipeline` - the single merger entry that runs dedup, blocking policy, tension detection, and verdict computation over per-lens outputs
- the schema, verdict, and blocking-policy types and Zod validators re-exported from `src/schema`, including `FindingOriginSchema` and `FindingOriginClassSchema`

### Optional finding fields, and one direction of compatibility

As of 0.5.0 a finding may also carry `principle` (the review-contract principle it violates, supplied by the lens) and the reporter-supplied provenance fields `dispositionReason`, `origin`, `originClass` and `sinceRound`. All are optional and none is defaulted: absence means no claim was made, which is a different statement from a known-empty one, and `principle` additionally rejects blank values so that absence stays the only way to name no principle.

The addition is one-directional. A payload produced before 0.5.0 parses on 0.5.0 unchanged. The reverse does NOT hold: `LensFindingSchema` is `.strict()`, so a consumer still on 0.4.x that receives a finding carrying `principle` loses the WHOLE payload to the error-placeholder path, not just the field. Upgrade the consumer before anything starts producing these fields.

A merge carries the REPRESENTATIVE's claim for all five and never borrows, fills or escalates from another member of the same dedup group. Members may well describe the same defect, which is what dedup is for, but group membership does not establish it, so one member's claim is never treated as interchangeable with another's. One consequence is deliberate and worth knowing: a non-representative's `originClass: "reintroduced"` does not survive a merge.

### Mutability boundary

All registry objects exported from the package root (`LENSES`, each lens projection, `SURFACE_RULES`, its nested rule objects and arrays) are frozen projection copies. The Zod schema instances (`optsSchema`) and `renderBody` implementations that live on the internal lens definitions are internal and unreachable from the public surface. Mutating any exported registry object throws in strict mode and can never alter prompt construction: the internal registry that `buildLensPrompt` and `activate` read is a separate, unfrozen object, disjoint from the frozen public projection.

## License

[PolyForm Shield 1.0.0](https://polyformproject.org/licenses/shield/1.0.0/) - source-available, non-compete (not OSI open source). Any use is permitted (personal, internal, commercial) except building a product that competes with storybloq or lenses. Competing, hosted, or white-label use requires a separate license: contact shayegh@me.com. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
