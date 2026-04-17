# Session Handover — 2026-04-13

**Session:** 7d9b114d-19ad-4adc-b0b5-8eb9464243e0
**Tickets completed:** T-001, T-002, T-003, T-004, T-005 (5/5 — autonomous session cap reached)
**Branch:** main (5 commits ahead of origin)
**Phase:** `lenses` (phase bootstrap → core prompts landed)

## What was accomplished

This autonomous session took the lenses MCP server from an empty package skeleton through the core prompt layer. At the end of the session, `renderLensBody(lensId, stage, opts)` can produce a complete, injection-hardened prompt for any of the 8 lenses in either review stage.

- **T-001** `feat: bootstrap @amirshayegh/lenses npm package with ESM toolchain` (f4228e1)
- **T-002** `feat: bootstrap MCP server skeleton with stub lens tools` (a00e78c)
- **T-003** `feat: add Zod schemas for wire-format contracts` (56d1170)
- **T-004** `feat: port shared preamble prompt with injection-resistant rendering` (d101bb2)
- **T-005** `feat: port 8 lens prompts with typed opts and injection hardening` (32d815b)

## T-005 detail (this session's headline work)

Shipped 8 lens modules under `src/lenses/prompts/` (security, error-handling, clean-code, performance, api-design, concurrency, test-quality, accessibility), plus `index.ts` (registry) and `untrusted.ts` (shared injection helper).

Each lens exposes:
- A strict Zod opts schema (`z.object({...}).strict()`) and `z.infer<>` type.
- Pinned metadata (id, version, defaultModel, maxSeverity, type).
- `renderBody(stage, opts)` covering both PLAN_REVIEW and CODE_REVIEW with stage-specific prose.

The `LENSES` registry in `index.ts` is declared with `as const satisfies Record<string, LensDefinition>` so `type LensId = keyof typeof LENSES` preserves literal-union semantics. `renderLensBody` dispatches through a per-lens `optsSchema.parse(opts === undefined ? {} : opts)` wrapper — **raw null does not get coerced to `{}`**, it hits Zod and is rejected.

### Injection hardening

All model-visible untrusted values (ticket text, scanner findings, hotPaths globs, prior deferrals, known-false-positives) flow through `untrusted(name, body)`:
- Wraps body in `<untrusted-context name="...">…</untrusted-context>`.
- Defangs smuggled closing tags by splicing a ZWSP (U+200B) into the closer.
- Validates `name` against `NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/` so a caller bug can't corrupt the opening tag with quotes, `>`, or whitespace.

Performance lens additionally validates hotPaths globs against a character-class regex (supports `@()`, `!()`, `+()`, `?()` extglobs plus `|` alternation and `\\` escapes).

### Test coverage

174 vitest cases across 8 files, all green. Highlights:
- `test/lens-registry.test.ts` — 8-lens count assertion, metadata pinning, **bidirectional** `AssertEqual<LensId, ExpectedUnion>` type-equality (tuple-wrapped conditional), and a null-rejection loop across all 8 EXPECTED_IDS × both stages (exercises every per-lens parse wrapper).
- `test/lens-bodies.test.ts` — structural heading invariants, per-lens strict-schema rejection of unknown keys, and opt-sensitive rendering (security scanner findings, performance hotPaths, test-quality focusMissingCoverage both positive and **negative** assertions against the `"missing-test-coverage"` category string).
- `test/untrusted.test.ts` — wrapper semantics, ZWSP defanging (single + multiple occurrences), plus a nested `describe("name validation")` with 4 cases covering attribute-breaking chars, empty/overlong names, and non-letter starts.

### Review rounds (4)

- **R1 codex** — 10 findings (opts null-coercion, dependency-vulnerability category gap, SECURITY_CANONICAL_CATEGORIES in PLAN_REVIEW, performance glob regex missing chars, useMemo prescriptive wording, api-design HTTP scope, test-quality focusMissingCoverage wiring, severity-regex test specificity, exported untrusted re-export, extglob test coverage). All fixed.
- **R2 agent** — 3 minor findings. All fixed.
- **R3 codex** — 3 minor findings (untrusted name validation, null-rejection only covered clean-code, test-quality absence-of-category assertion missing). All fixed.
- **R4 agent** — **approve, no findings.**

Every round's codex session id was linked via session continuity so each round built on the prior context.

## Decisions

- **`opts ?? {}` → `opts === undefined ? {} : opts`** — deliberate rejection of null-coercion so Zod can flag misuse. Tested per-lens-per-stage (16 assertions).
- **`untrusted()` name validation throws rather than sanitizes** — keeps the set of legal names narrow and any caller bug loud.
- **`LensDefinition.optsSchema: z.ZodTypeAny`** — agent R4 noted this erases the per-lens Opts type at the registry boundary. Accepted as pragmatic; runtime parse + exhaustive tests compensate.
- **SECURITY_CANONICAL_CATEGORIES only in CODE_REVIEW** — the plan stage has no diff to categorize against, so the 16-category list is omitted from `renderPlanReview()`.

## What's next

Phase `lenses` continues. Blocked/pending tickets in this phase progress from here. Good next candidates:
- **T-006 lens activation** — consumes the `type` field on each lens def (`core` vs `surface-activated`) plus file-glob triggers to decide which subset of lenses runs for a given diff. The registry is ready for this consumer.
- **T-007 lens_review_start tool** — the real tool implementation (current `src/tools/start.ts` is a stub) that takes stage + artifact + changed files, picks active lenses, and emits agent prompts using the shared preamble + `renderLensBody`.
- **T-020 state machine enforcement** — file already tracked as a backlog ticket.

## Session-cap note

This was the 5th ticket in a 5-ticket autonomous session. Session ended per the default `maxTicketsPerSession` cap; pick up with `/story` to queue the next batch.
