# Handover — 0.2.0 shipped: contract redesign → publish, end to end

**Session:** 2026-04-23 → 2026-04-24 (collaborative + one autonomous sub-session)
**Branch:** `main` @ `ef9c837`, pushed to `origin/main`, published as `@storybloq/lenses@0.2.0`
**Outcome:** Lenses is live on npm. Repo is done. T-016 / T-017 / T-019 remain, all cross-repo into claudestory.

---

## What shipped

### npm
- **`@storybloq/lenses@0.2.0`** published to https://registry.npmjs.org/. First real release of the rewritten two-hop contract. 10 files, 119.5 kB packed, 501.3 kB unpacked. No OTP required on the `ashayegh` account for `@storybloq` scope.
- Post-publish smoke test (fresh global install → `lenses --mcp` → MCP initialize handshake) confirms `serverInfo.version: "0.2.0"` end-to-end. The T-023 version-drift fix made it through the tarball.

### Code — 4 feature/fix commits + 1 follow-up invariant commit + 1 pre-publish review sweep
| Commit | Scope |
|---|---|
| `1d90d23` | T-023 — tsup/vitest `define` for `__LENSES_VERSION__` + `lensTimeout` schema with `resolveLensTimeoutMs` helper; deleted stale docs for `tokenBudgetPerLens`, `requireSecretsGate`, `requireAccessibility` |
| `c51bbc2` | T-022 — envelope `.passthrough()` + rich verdict envelope (`parseErrors[]` / `deferred[]` / `hadAnyFindings` / `nextActions[]`) + third tool `lens_review_get_prompt` + retry state machine with per-lens attempt tracking |
| `dea1404` | T-024 — disk-backed in-flight state via `src/cache/in-flight.ts` + `LensErrorCode` enum; reviewId survives server restart; Map is bounded LRU read-cache |
| `f2a80b7` | ISS-002 — smoke test spawns `dist/cli.js --mcp` and drives a real MCP handshake + `tools/list` |
| `285198d` | Symmetric ReviewVerdict invariant — schema-enforced `hadAnyFindings=true` coupling with `findings[]`/`deferred[]` non-emptiness (L-003 made enforceable at schema level, not just convention) |
| `80f065a` | 5 pre-publish review gaps closed + ISS-004/005/006 resolved: state-machine rejections surface `LensErrorCode` on the wire; past-`expiresAt` rejection pinned by E2E test; LRU eviction + disk rehydration test; `atomicWriteFile` uses `path.dirname` (Windows-safe); CLI-spawn smoke asserts server version matches `package.json` |

### Tickets & issues
- **T-018** — closed. Publish + post-publish smoke complete.
- **T-022 / T-023 / T-024** — closed via auto-session.
- **T-025** — placeholder for post-T-016 burn-in (chunking, concurrency caps, CLI subcommands, copilot-instructions auto-discovery, full control-plane error taxonomy). Entry criteria: do not start until T-016 landed + one real claudestory session has used lenses end-to-end.
- **ISS-001 / 002 / 003 / 004 / 005 / 006** — all resolved. Zero open issues.
- **T-016 still blocked** on nothing from this repo — only the cross-repo implementation remains. Unblocked side: `@storybloq/lenses@0.2.0` is installable.

### Lessons — first four in the project
- **L-001** — `.strict()` at ingress boundaries must surface `parseErrors[]`, not swallow them.
- **L-002** — Retry must be a cooperative protocol when the server can't execute subagents (two-hop MCP architecture).
- **L-003** — Verdict fields that change how existing fields are interpreted are semantic breaks, not additions — ship `hadAnyFindings` in the same PR as `deferred[]`.
- **L-004** — This project strips `Co-Authored-By: Claude` trailers from commit history. Don't include them; if they leak in during autonomous work, strip before push.

---

## Decisions worth carrying forward

- **"Architecture vs contract" is the durable diagnostic frame for lenses issues.** The machinery (dedup, blocking-policy, tension detection, verdict computation) is IP and rarely the problem. The JSON shapes at the MCP boundary are. When reviewing future reliability concerns, look at the contract first.
- **Envelope `.passthrough()` + findings `.strict()` — the layering is asymmetric on purpose.** Envelope relaxation fixes the live-test regression (callers inject bookkeeping fields without losing data). Finding-level strict + `parseErrors[]` surfaces LLM hallucination (invented categories) without silent swallow. Don't relax both.
- **Disk-as-source-of-truth + Map-as-bounded-LRU is the persistence shape.** Not SQLite, not "add eviction to the Map." `src/cache/session.ts`'s atomic-tmp+rename + mode 0o600 + schema versioning + TTL sweep is the pattern; `src/cache/in-flight.ts` is its sibling.
- **`nextActions[]` is a cooperative protocol, not a server-internal loop.** Generalizes to retry, timeout (`expiresAt`), and future concurrency throttling. Don't reinvent when post-T-016 work needs any of those.
- **Do not copy codex-bridge's sequential-in-one-thread review loop.** That pattern is load-bearing for a unified reviewer and cuts directly against lenses's differentiator. Copy the reliability primitives (persistence, idempotency, error taxonomy), not the review semantics. Both codex-gpt-5.4 and the external reviewer reached this independently.
- **Do not add random-delimiter prompt-injection defense.** `shared-preamble.ts`'s untrusted-context block is a better solution to the same problem. Adding a second mechanism muddies the defense.
- **Strip `Co-Authored-By: Claude` trailers from commit messages.** Origin/main has been clean since `d47e3c4`. Local backup branch `backup/pre-strip-coauthor` retains originals in case anyone needs to consult them.

---

## What the session actually did (narrative, not bullet points)

1. **First real end-to-end test of the lens review system** against `6e6aee6`'s diff. Registry correctly activated 6 of 8 lenses. Verdict came back `approve` — but 5 real test-quality findings (confidence 0.62–0.78) silently vanished between lens output and verdict. Hop-1 response was 67,783 chars and overflowed the orchestrator's context.

2. **Compared architecture against codex-claude-bridge** via an Explore subagent. Mapped 5-tool surface, SQLite persistence, sequential chunking with context accumulation, 2-attempt parse-retry, 12-code error taxonomy, random-delimiter injection defense, `.reviewbridge.json` config, copilot-instructions auto-discovery.

3. **Got codex-gpt-5.4's critique** of my adoption plan (session `019dbe18-b4a8-7980-9609-bda68a3e36cb`). Verdict: `revise`. 10 findings. Central critique: "the biggest gap is not chunking itself; it is the absence of an idempotent review state machine."

4. **User provided a third agent's code-level review.** Sharpest of the three: "architecture is right, contract is wrong." Claimed three leaks (parse-failure swallow, silent confidence-floor drop, hop-1 too big); self-flagged parse-failure as unverified.

5. **Verified the parse-failure claim against source + on-disk JSON.** Found the actual cause: my orchestrator injected `lensId` inside `output` for bookkeeping; `LensOutputSchema.strict()` rejected the unknown key; `complete.ts:317` routed to `syntheticError(status:"error")`; `dedup.ts:43` skipped it as `status !== "ok"`; 5 findings lost at the parse boundary, never reached the merger. Also verified `serverInfo.version = "0.0.0"` hardcoded vs `package.json = "0.1.0"`, and `lensTimeout`/`tokenBudgetPerLens`/`requireSecretsGate`/`requireAccessibility` documented but unconsumed.

6. **Filed T-022 / T-023 / T-024 + L-001**, blocked T-016 on them.

7. **User showed reviewer #4's critique** of those tickets. Caught: schema-fix section in T-022 inverted the layers (I wrote "passthrough at finding-level + strict at envelope-level" — exactly backwards); nextActions[] semantics under-specified; doc sweep buried; Map-eviction vs Map-replacement conflated; typed error enum punted to `string`; path scheme inconsistent; tsup-define vs readFileSync undecided. Also suggested T-025 placeholder + two more lessons. Two factually-wrong claims (no handover, no lessons) were a timing artifact — handover and L-001 already existed.

8. **Sharpened all three tickets + created T-025 + L-002, L-003 + wired T-024 blockedBy T-022.** The reviewer's substantive catches all incorporated.

9. **Ran `/story auto T-023 T-022 T-024 ISS-002`** for the autonomous implementation sub-session. 4 primary commits + 2 follow-up (symmetric invariant + 5 pre-publish gaps). 575/575 tests passing (was 502).

10. **Reviewed the auto-session work against spec.** Every acceptance criterion met. The follow-ups exceeded spec — schema-enforced symmetric invariant (L-003 made absolute), `LensErrorCode` wired through the wire (ISS-004 self-caught during review), union-coverage guard for post-restart rehydration (ISS-006), Windows-safe `atomicWriteFile` (ISS-005).

11. **Committed `.story/` artifacts** (3 handovers, L-001/L-002/L-003, T-025, T-016 blocker update) — `3e43a30`.

12. **Bumped version 0.1.0 → 0.2.0** for the T-022/T-024 protocol break — `2116b3c`. Dry-run pack verified clean.

13. **Discovered git divergence** on `git push`. Remote had been rewritten to strip `Co-Authored-By: Claude` trailers — 22 parallel-path commits with identical trees but different hashes. Root-caused by byte-diffing the first-diverged commit on each side: one line difference, the trailer itself.

14. **Option C: force-pushed local** (with trailers restored) via `--force-with-lease`. Then ran `git filter-branch --msg-filter 'grep -v "^Co-Authored-By: Claude" || true'` to strip trailers on the now-local history. Backup branch `backup/pre-strip-coauthor` preserved originals. Tests re-verified 575/575. Force-pushed the cleaned history — origin/main at `d47e3c4`. Filed L-004 as the durable convention.

15. **Committed L-004** (no Claude trailer, per L-004) — `ef9c837`. Pushed.

16. **`npm publish --ignore-scripts`** — succeeded, no OTP required. Post-publish global install smoke showed `serverInfo.version: "0.2.0"` via live MCP handshake. Closed T-018.

---

## Key artifacts for the next session

| Path | Why it matters |
|---|---|
| `src/schema/finding.ts:114` | `LensOutputSchema.passthrough()` — the exact envelope fix |
| `src/schema/finding.ts:59,81,163` | `LensFindingSchema.strict()` — kept for LLM hallucination surfacing |
| `src/schema/verdict.ts:79-158` | Hop-2 rich envelope with superRefine invariants (symmetric `hadAnyFindings` check) |
| `src/cache/in-flight.ts` | Disk persistence pattern for T-024 — sibling of `cache/session.ts` |
| `src/schema/error-code.ts` | `LensErrorCode` enum (9 codes) |
| `src/tools/get-prompt.ts` | Third MCP tool added by T-022 |
| `test/schema.test.ts:218`, `:233`, `:474` | Regression pins for the three live-test leaks + L-003 semantic break |
| `backup/pre-strip-coauthor` (local only) | Pre-filter-branch history with Claude attribution intact |
| codex session `019dbe18-b4a8-7980-9609-bda68a3e36cb` | gpt-5.4's plan critique, chainable for T-016 review |

---

## What's explicitly deferred / cross-repo

- **T-016 (claudestory integration).** Cross-repo. Start a fresh session rooted in `~/Developer/CPM/claudestory`. Approved plan at `.story/sessions/efc26ffb-44b6-4cb2-88d4-d837f9c697c8/plan.md` in the lenses repo (copy or consult from claudestory side). Now fully unblocked — `@storybloq/lenses@0.2.0` installable, contract stable, public API pinned.
- **T-017 (setup-skill registration), T-019 (skill docs rewrite for two-hop flow).** Cross-repo into claudestory.
- **T-025** — do not touch until T-016 burn-in produces evidence.

## What's NOT deferred but worth flagging

- **`backup/pre-strip-coauthor` branch** lives locally only. Delete with `git branch -D backup/pre-strip-coauthor` once you're sure you don't need pre-strip attribution.
- **User's Claude Code MCP config.** If any existing `lenses` registration points at a local repo path, replace with the published binary: `claude mcp add lenses -s user -- lenses --mcp`.
- **Version-drift test** is now load-bearing. Future version bumps must update `package.json` or the test will fail the build.

---

## Invariants to protect going forward

- `ReviewVerdictSchema.superRefine` — severity counts == findings-by-severity; `verdict=='reject'` iff `blocking>0`; `suppressedFindingCount == deferred.length`; `hadAnyFindings=false` implies `findings.length + deferred.length == 0`; `hadAnyFindings=true` implies `findings.length + deferred.length > 0`.
- `RULES.md §4` — persistence failure never flips `isError: true`. Applies to `src/cache/session.ts`, `src/cache/lens-cache.ts`, and now `src/cache/in-flight.ts`. The outside-try/catch pattern at `complete.ts:400-401` is the reference.
- Two-hop architecture — server never calls an LLM. Retry is a protocol (`nextActions[]`), not a server loop.
- SHA-256 prompt-hash caching at `lens-cache.ts:130` — cache invalidates by construction.
- `LensId` bidirectional coverage (`Record<LensId, true>` pattern from T-021) — additions and removals both caught at compile time. Same pattern now applied to `LensErrorCode`.
- Strip `Co-Authored-By: Claude` from commit messages (L-004).