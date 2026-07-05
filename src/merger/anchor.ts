/**
 * T-026 server-side evidence anchoring.
 *
 * The producer-side anchor pass: the FIRST merger-pipeline stage (PRE-dedup).
 * It text-verifies each localized finding's lens-supplied `snippet.quote`
 * against the retained artifact, realigns a drifted claimed line onto the
 * matched location, and routes an unverifiable finding to either the
 * survive-and-flag path (with a reviewIntegrity entry) or the
 * `evidence_unverified` deferral, per severity. It also strips SERVER-OWNED
 * finding fields from every input finding (defense-in-depth behind the
 * ingestion-point strip) and mints the server-owned fields it is entitled to.
 *
 * TRUST BOUNDARY (R-D1a / R-C4a): this pass is PROMPT-CONSISTENCY anchoring.
 * The server verifies quotes against the SAME caller-supplied artifact string
 * that was embedded in every lens prompt and bound by promptHash
 * (hashLensPrompt, src/tools/start.ts). It attests that all lenses and the
 * anchor pass saw one identical artifact; it NEVER attests that the artifact
 * faithfully reflects any repository state. Artifact authenticity remains the
 * caller's responsibility -- the server has zero repo access and calls no AI
 * API (RULES.md §6). The pass ALWAYS runs (R-C4a): in normalize-only mode
 * (no anchoring input, PLAN_REVIEW, or an empty artifact) it strips server
 * fields and passes everything else through, contributing 0 to every count
 * and [] to anchorUnindexedFiles -- provably a no-op for any input expressible
 * before this ticket, where LensFindingSchema.strict() rejected the server
 * fields outright.
 *
 * Purity: no I/O, no module-level state, inputs never mutated.
 */

import type {
  DeferredFinding,
  LensFinding,
  MergedFinding,
  ReviewIntegrityEntry,
  Stage,
} from "../schema/index.js";
import type { LensRunResult } from "./pipeline.js";

/** Default +/- recovery window (in lines) for the quote search (SCOPE 3). */
export const DEFAULT_RECOVERY_WINDOW = 10;

/**
 * The complete-time anchoring context, threaded from the retained
 * ReviewSession by `complete.ts` into the merger pipeline. Absent =>
 * normalize-only mode (existing merger unit tests stay behaviorally
 * identical, R10).
 */
export interface AnchoringInput {
  readonly stage: Stage;
  /** The hop-1 artifact: the CODE_REVIEW diff or the PLAN_REVIEW plan text. */
  readonly artifact: string;
  /** The hop-1 changedFiles (empty for PLAN_REVIEW). */
  readonly changedFiles: readonly string[];
}

export interface VerifyAnchorsParams {
  readonly perLens: readonly LensRunResult[];
  readonly anchoring?: AnchoringInput;
  /** Merger `blockingPolicy.alwaysBlock` categories (R6 survivorship). */
  readonly alwaysBlock: readonly string[];
  /** Merger `confidenceFloor` (R6 survivorship). */
  readonly confidenceFloor: number;
  readonly recoveryWindow?: number;
}

export interface AnchorPassResult {
  /**
   * The transformed per-lens outputs feeding dedup: verified/realigned/
   * flagged/pass-through findings, with `evidence_unverified` findings
   * removed (they surface in `deferred`) and server fields sanitized.
   */
  readonly perLens: readonly LensRunResult[];
  /** `evidence_unverified` deferrals (never deduped, R4a). */
  readonly deferred: readonly DeferredFinding[];
  /** One entry per survived-and-flagged finding (R8 / R-D4). */
  readonly integrityEntries: readonly ReviewIntegrityEntry[];
  /** PRE-dedup count of findings realigned this pass (R4a telemetry). */
  readonly realignedCount: number;
  /** Count of evidence_unverified deferrals (exact-mirror, R4a). */
  readonly evidenceUnverifiedCount: number;
  /** changedFiles absent from the diff new-side index, sorted + deduped. */
  readonly anchorUnindexedFiles: readonly string[];
}

/**
 * T-026 R-D3: normalize a repo path into a COMPARISON KEY (never a rewrite).
 * Convert every backslash to a forward slash, strip leading "./" segments
 * repeatedly, then collapse consecutive slashes. No case folding, no ".."
 * resolution, no trailing-slash handling. The activation-side variant lives
 * in src/lenses/registry.ts (backslash-only) and is intentionally left
 * untouched -- changing activation behavior is out of ticket scope.
 */
export function normalizeRepoPath(p: string): string {
  let s = p.replace(/\\/g, "/");
  while (s.startsWith("./")) s = s.slice(2);
  s = s.replace(/\/{2,}/g, "/");
  return s;
}

/**
 * T-026 R-C2 / R-C4(b) / R-D4(b): the SINGLE canonical stripper of
 * SERVER-OWNED finding fields. A lens can never inject a value the server
 * alone is entitled to mint. Mandated at three callsites: the complete.ts
 * ingestion point (R-C2), and both lens-cache choke points -- the write in
 * complete.ts and the read in start.ts (R-C4b). The anchor pass applies it
 * again as defense-in-depth. Any FUTURE server-minted finding field MUST be
 * added here (R-C2). Server-owned finding fields today: `anchorRealignedFrom`,
 * `integrityKey`. Reference identity is preserved when nothing is stripped.
 */
export function sanitizeFindingForStorage(f: LensFinding): LensFinding {
  if (f.anchorRealignedFrom === undefined && f.integrityKey === undefined) {
    return f;
  }
  const { anchorRealignedFrom: _drop1, integrityKey: _drop2, ...rest } = f;
  return rest;
}

/**
 * T-026 R-C3 / R-D3(1): parse a unified diff into a per-file map of new-side
 * line number -> new-side line text. Each hunk's new-side extension is BOUNDED
 * by the `@@ -a,b +c,d @@` header's declared new-side count `d` (an omitted
 * `,d` means 1). Once `d` new-side lines (context " " + added "+") are
 * recorded the hunk is CLOSED: blank separator lines, the next `diff --git`
 * header, `\ No newline at end of file` markers, and trailing newlines never
 * extend it. New-side keys are `normalizeRepoPath` of the "+++ b/<path>"
 * header path with the "b/" prefix stripped ONLY when the `diff --git` header
 * confirms the standard a/ b/ prefix form (pen res 3); "+++ /dev/null" (a
 * deletion) creates no entry. Standard git prefixes are the primary contract.
 */
export function buildNewSideIndex(diff: string): Map<string, Map<number, string>> {
  const index = new Map<string, Map<number, string>>();
  const lines = diff.split("\n");
  let currentFile: string | null = null;
  let prefixForm = false;
  let newLineNo = 0;
  let hunkRemaining = 0;

  for (const raw of lines) {
    // Inside an open hunk (budget remaining), a line is CONTENT. This takes
    // precedence over the structural-prefix checks so a content line whose
    // text collides with a header prefix -- e.g. an added source line "++ x"
    // becomes the diff line "+++ x" -- is never misread as structure. A
    // well-formed diff always completes a hunk's declared new-side lines
    // before the next "@@"/"diff --git", so structural lines never appear
    // while `hunkRemaining > 0`.
    if (currentFile !== null && hunkRemaining > 0) {
      const head = raw.length > 0 ? raw[0] : "";
      if (head === "-" || head === "\\") {
        // "-" deleted (old-side) line or "\ No newline" marker: no new-side
        // line, no budget consumed.
        continue;
      }
      // "+" added, " " context, or an empty context line ("") missing its
      // space marker: a new-side line. Strip the one-char diff marker.
      const content = head === "+" || head === " " ? raw.slice(1) : raw;
      const fileMap = index.get(currentFile) ?? new Map<number, string>();
      fileMap.set(newLineNo, content);
      index.set(currentFile, fileMap);
      newLineNo += 1;
      hunkRemaining -= 1;
      continue;
    }

    if (raw.startsWith("diff --git ")) {
      // Confirm the standard a/ b/ prefix form for the following file
      // section (pen res 3). A no-prefix diff (git diff --no-prefix) does
      // not match and its "+++" path is used verbatim.
      prefixForm = /^diff --git a\/.+ b\/.+$/.test(raw);
      currentFile = null;
      hunkRemaining = 0;
      continue;
    }
    if (raw.startsWith("--- ")) {
      // old-side header: never indexed.
      continue;
    }
    if (raw.startsWith("+++ ")) {
      let path = raw.slice(4);
      const tab = path.indexOf("\t");
      if (tab !== -1) path = path.slice(0, tab);
      if (path === "/dev/null") {
        currentFile = null;
      } else {
        const stripped =
          prefixForm && path.startsWith("b/") ? path.slice(2) : path;
        currentFile = normalizeRepoPath(stripped);
      }
      hunkRemaining = 0;
      continue;
    }
    if (raw.startsWith("@@")) {
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(raw);
      if (m === null) {
        hunkRemaining = 0;
        continue;
      }
      newLineNo = Number.parseInt(m[1]!, 10);
      hunkRemaining = m[2] === undefined ? 1 : Number.parseInt(m[2], 10);
      continue;
    }
    // Outside any hunk: blank separators, "index abc..def", "rename from/to",
    // "similarity index", etc. are ignored.
  }
  return index;
}

/**
 * R3 matcher: candidate new-side line `L` matches quote `Q` iff `Q === L`,
 * `Q === L.trim()`, or (when `L` exceeds 400 chars) `Q` equals the 400-char
 * prefix of `L` or of `L.trim()`.
 */
function matchQuote(quote: string, line: string): boolean {
  if (quote === line) return true;
  const trimmed = line.trim();
  if (quote === trimmed) return true;
  if (line.length > 400) {
    if (quote === line.slice(0, 400)) return true;
    if (quote === trimmed.slice(0, 400)) return true;
  }
  return false;
}

/**
 * Find the new-side line in `fileMap` matching `quote` closest to
 * `claimedLine` within +/- `window`. Ties by distance prefer the lower line
 * number. Returns null when no line in the window matches.
 */
function findAnchorMatch(
  fileMap: Map<number, string>,
  claimedLine: number,
  quote: string,
  window: number,
): number | null {
  const lo = claimedLine - window;
  const hi = claimedLine + window;
  let best: number | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const [lineNo, text] of fileMap) {
    if (lineNo < lo || lineNo > hi) continue;
    if (!matchQuote(quote, text)) continue;
    const dist = Math.abs(lineNo - claimedLine);
    if (dist < bestDist || (dist === bestDist && (best === null || lineNo < best))) {
      best = lineNo;
      bestDist = dist;
    }
  }
  return best;
}

/** Convert a lens finding into a singleton merged finding (deferral shape). */
function toSingletonMerged(f: LensFinding, lensId: string): MergedFinding {
  return {
    id: f.id,
    severity: f.severity,
    category: f.category,
    file: f.file,
    line: f.line,
    ...(f.snippet !== undefined ? { snippet: f.snippet } : {}),
    ...(f.anchorRealignedFrom !== undefined
      ? { anchorRealignedFrom: f.anchorRealignedFrom }
      : {}),
    description: f.description,
    suggestion: f.suggestion,
    confidence: f.confidence,
    contributingLenses: [lensId] as MergedFinding["contributingLenses"],
  };
}

/**
 * T-026 anchor pass. See module doc for the trust boundary and mode rules.
 */
export function verifyAnchors(params: VerifyAnchorsParams): AnchorPassResult {
  const window = params.recoveryWindow ?? DEFAULT_RECOVERY_WINDOW;
  const alwaysBlockSet = new Set(params.alwaysBlock);
  const floor = params.confidenceFloor;

  const anchoring = params.anchoring;
  // Normalize-only mode (R1 / R10): no anchoring input, PLAN_REVIEW, or an
  // empty retained artifact. Strip server fields, pass everything through.
  const enforce =
    anchoring !== undefined &&
    anchoring.stage === "CODE_REVIEW" &&
    anchoring.artifact.length > 0;

  if (!enforce) {
    const perLens = params.perLens.map(({ lensId, output }) =>
      output.status === "ok"
        ? {
            lensId,
            output: {
              ...output,
              findings: output.findings.map(sanitizeFindingForStorage),
            },
          }
        : { lensId, output },
    );
    return {
      perLens,
      deferred: [],
      integrityEntries: [],
      realignedCount: 0,
      evidenceUnverifiedCount: 0,
      anchorUnindexedFiles: [],
    };
  }

  const newSideIndex = buildNewSideIndex(anchoring.artifact);
  const deferred: DeferredFinding[] = [];
  const integrityEntries: ReviewIntegrityEntry[] = [];
  let realignedCount = 0;
  let flagOrder = 0;
  const outPerLens: LensRunResult[] = [];

  for (const { lensId, output } of params.perLens) {
    if (output.status !== "ok") {
      outPerLens.push({ lensId, output });
      continue;
    }
    const kept: LensFinding[] = [];
    for (const raw of output.findings) {
      const f = sanitizeFindingForStorage(raw);

      // Non-localized findings pass through untouched (R10).
      if (f.line === null || f.file === null) {
        kept.push(f);
        continue;
      }

      // FILE-LEVEL gate (R-C1 / R2): the ONLY gate is presence of the
      // finding's (normalized) file in the diff new-side index. No
      // claimed-line-membership condition. Files absent from the index pass
      // through untouched (R2).
      const normFile = normalizeRepoPath(f.file);
      if (!newSideIndex.has(normFile)) {
        kept.push(f);
        continue;
      }
      const fileMap = newSideIndex.get(normFile)!;

      // Localized finding on an in-index file: verify its quote within the
      // recovery window. An absent snippet is unverified by construction.
      const matched =
        f.snippet !== undefined
          ? findAnchorMatch(fileMap, f.line, f.snippet.quote, window)
          : null;

      if (matched !== null) {
        if (matched === f.line) {
          kept.push(f); // verified in place
        } else {
          // Realign (SCOPE 3, R-C1g rescue): overwrite line + snippet
          // startLine and record the original claimed line.
          realignedCount += 1;
          kept.push({
            ...f,
            line: matched,
            anchorRealignedFrom: f.line,
            ...(f.snippet !== undefined
              ? { snippet: { ...f.snippet, startLine: matched } }
              : {}),
          });
        }
        continue;
      }

      // Unverified localized finding on an in-index file -> route per R6.
      const survives =
        alwaysBlockSet.has(f.category) ||
        ((f.severity === "blocking" || f.severity === "major") &&
          f.confidence >= floor);
      if (survives) {
        flagOrder += 1;
        const integrityKey = `ie-${flagOrder}`;
        integrityEntries.push({
          findingId: f.id,
          lensId,
          file: f.file,
          line: f.line,
          category: f.category,
          integrityKey,
        });
        // Survive with line nulled + the integrity correlation key. Keep the
        // snippet as-is (evidence preserved for a downstream consumer).
        kept.push({ ...f, line: null, integrityKey });
      } else {
        // Defer as evidence_unverified, preserving the claimed line (R6).
        deferred.push({
          finding: toSingletonMerged(f, lensId),
          reason: "evidence_unverified",
        });
      }
    }
    outPerLens.push({ lensId, output: { ...output, findings: kept } });
  }

  // anchorUnindexedFiles (R-D1b / R-D3(2)): changedFiles with no new-side
  // index entry, normalized then deduped then sorted.
  const unindexed = new Set<string>();
  for (const cf of anchoring.changedFiles) {
    const norm = normalizeRepoPath(cf);
    if (!newSideIndex.has(norm)) unindexed.add(norm);
  }

  return {
    perLens: outPerLens,
    deferred,
    integrityEntries,
    realignedCount,
    evidenceUnverifiedCount: deferred.length,
    anchorUnindexedFiles: [...unindexed].sort(),
  };
}
