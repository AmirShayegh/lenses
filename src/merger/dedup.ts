/**
 * T-010 cross-lens deduplication.
 *
 * When multiple lenses report findings at the same `(file, line, category)`
 * key, collapse them into a single `MergedFinding`:
 *  - Winner is the finding with the strictly-greater `confidence`; equal
 *    confidence keeps the first-seen representative (stable tiebreak).
 *  - `contributingLenses` accumulates in first-seen order and always contains
 *    distinct lens ids.
 *
 * Scope decisions:
 *  - `file === null` findings are NEVER deduped. A null file means the
 *    finding has no locality; two lenses raising the same categorical concern
 *    without a file almost always mean different things. Each becomes its own
 *    MergedFinding with a singleton `contributingLenses`.
 *  - `file !== null` with `line === null` (file-level findings) deduplicate
 *    normally via the `(file, null, category)` key.
 *  - Dedup applies cross-lens AND within-lens -- a lens reporting the same
 *    key twice is collapsed in the same way.
 *
 * Known trade-off (intentional for T-010; to be layered in T-011):
 *  - Confidence-wins can let a low-severity / high-confidence finding displace
 *    a blocking-severity sibling at the same key. T-011's `alwaysBlock`
 *    categories + confidence floor will address this policy-side.
 *
 * Pure function: no I/O, no module-level state, inputs never mutated. Every
 * write to the internal Map stores a freshly-constructed MergedFinding via
 * `toMerged`; `contributingLenses` arrays are treated as immutable throughout
 * (shared references are safe because we only ever spread, never mutate).
 */

import type { LensId } from "../lenses/prompts/index.js";
import type { LensFinding, MergedFinding } from "../schema/index.js";
import type { LensRunResult } from "./pipeline.js";

export function dedupeFindings(
  perLens: readonly LensRunResult[],
): MergedFinding[] {
  const bucketedByKey = new Map<string, MergedFinding>();
  const ungrouped: MergedFinding[] = [];

  for (const { lensId, output } of perLens) {
    if (output.status !== "ok") continue;
    for (const f of output.findings) {
      if (f.file === null) {
        ungrouped.push(toMerged(f, [lensId]));
        continue;
      }
      // `\x00` separator so ("a", 12, "b") and ("a1", 2, "b") do not alias.
      const key = `${f.file}\x00${f.line ?? ""}\x00${f.category}`;
      const existing = bucketedByKey.get(key);
      if (existing === undefined) {
        bucketedByKey.set(key, toMerged(f, [lensId]));
        continue;
      }
      // Winner: strictly-greater confidence displaces; equal keeps existing.
      const base: LensFinding = f.confidence > existing.confidence ? f : existing;
      const nextLenses: readonly string[] = existing.contributingLenses.includes(
        lensId,
      )
        ? existing.contributingLenses
        : [...existing.contributingLenses, lensId];
      bucketedByKey.set(key, toMerged(base, nextLenses));
    }
  }

  return [...ungrouped, ...bucketedByKey.values()];
}

/**
 * Copy the finding-shaped fields from `base` and attach a fresh merged
 * finding with the provided `contributingLenses`. The winner's `id` is
 * preserved -- it identifies the surviving representative, not a new merged
 * entity. `contributingLenses` is stored by reference; callers treat the
 * array as immutable (the module only ever spreads it, never mutates).
 */
function toMerged(
  base: LensFinding | MergedFinding,
  contributingLenses: readonly (LensId | string)[],
): MergedFinding {
  return {
    id: base.id,
    severity: base.severity,
    category: base.category,
    file: base.file,
    line: base.line,
    description: base.description,
    suggestion: base.suggestion,
    confidence: base.confidence,
    contributingLenses: contributingLenses as MergedFinding["contributingLenses"],
  };
}
