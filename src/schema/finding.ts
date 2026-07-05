import { z } from "zod";

/** Severity tiers used across findings, blocking policy, and verdict counts. */
export const SeveritySchema = z.enum([
  "blocking",
  "major",
  "minor",
  "suggestion",
]);
export type Severity = z.infer<typeof SeveritySchema>;

/** Lifecycle state reported by one lens for a single run. */
export const LensStatusSchema = z.enum(["ok", "error", "skipped"]);
export type LensStatus = z.infer<typeof LensStatusSchema>;

/**
 * T-026: quoted source evidence a lens attaches to a localized finding so
 * the server can text-verify (and, on drift, realign) the claimed line
 * against the retained artifact at complete-time, with zero repo access.
 *
 * The `quote` cap is 400 chars (R3): a source line longer than 400
 * characters is quoted by its first 400 characters, and the anchor
 * matcher recognizes the prefix form. Capping here keeps a pathological
 * multi-KB line from failing LensFindingSchema `.strict()` (which would
 * lose the ENTIRE lens payload to the error-placeholder path). `.strict()`
 * so a lens cannot smuggle extra keys into the evidence object.
 */
export const SnippetSchema = z
  .object({
    quote: z.string().min(1).max(400),
    startLine: z.number().int().positive(),
  })
  .strict();
export type Snippet = z.infer<typeof SnippetSchema>;

/**
 * Shared field shape for lens-reported findings and merger-produced merged
 * findings. Factored out so `LensFindingSchema` and `MergedFindingSchema` stay
 * in lockstep -- adding or renaming a field happens here exactly once.
 *
 * T-026 trust boundary: `snippet` is lens-supplied evidence, while
 * `anchorRealignedFrom` and `integrityKey` are SERVER-OWNED (minted only by
 * `verifyAnchors`). The single-shared-shape rule (both LensFinding and
 * MergedFinding carry every field) is preserved deliberately: rather than
 * splitting the input/internal schemas -- which would either route any lens
 * that supplies a server field to the whole-payload error-placeholder path
 * (LensFindingSchema is `.strict()`) or break this single-shape invariant --
 * the server strips the server-owned fields from lens input via the single
 * `sanitizeFindingForStorage` helper at every ingress (R-C2 / R-C4 / R-D4).
 * All three T-026 fields are `.optional()` (R4): absent means, respectively,
 * no snippet / not realigned / not integrity-flagged.
 */
const findingObjectShape = {
  id: z.string().min(1),
  severity: SeveritySchema,
  category: z.string().min(1),
  file: z.string().min(1).nullable(),
  line: z.number().int().positive().nullable(),
  // T-026: lens-supplied quoted source evidence for the claimed line.
  snippet: SnippetSchema.optional(),
  // T-026 SERVER-OWNED: the original claimed line when `verifyAnchors`
  // realigned this finding. Stripped from lens input by
  // sanitizeFindingForStorage; only the anchor pass sets it.
  anchorRealignedFrom: z.number().int().positive().optional(),
  // T-026 R-D4 SERVER-OWNED: correlates a survived-and-flagged finding to
  // its ReviewIntegrityEntry 1:1. VERDICT-LOCAL -- meaningful only within a
  // single completion round's verdict envelope, never stable across rounds
  // or cache reads. Stripped from lens input by sanitizeFindingForStorage.
  integrityKey: z.string().min(1).optional(),
  // T-028 SCOPE 4: a content-free finding is not actionable. `.min(1)` rejects
  // an empty `description`/`suggestion` at the strict per-finding boundary, so
  // it surfaces as a `parseErrors[]` entry rather than reaching the verdict.
  description: z.string().min(1),
  suggestion: z.string().min(1),
  confidence: z.number().min(0).max(1),
};

/**
 * Shared cross-field refinement: a positional line number without a file
 * coordinate is meaningless. Enforced on both LensFinding and MergedFinding so
 * the dedup key `(file, line, category)` is always well-formed.
 */
function fileLineCorrelation(
  val: { file: string | null; line: number | null },
  ctx: z.RefinementCtx,
): void {
  if (val.line !== null && val.file === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["line"],
      message: "line cannot be set when file is null",
    });
  }
}

/**
 * A single issue reported by one lens.
 *
 * Dedup key (see RULES.md §5 and T-010) is (file, line, category); all three
 * fields are present on every valid finding. `line` is positive-int-or-null and
 * may only be non-null when `file` is non-null, so the key is always well-formed.
 */
export const LensFindingSchema = z
  .object(findingObjectShape)
  .strict()
  .superRefine(fileLineCorrelation);
export type LensFinding = z.infer<typeof LensFindingSchema>;

/**
 * Post-merger shape (T-010). Carries `contributingLenses` so the agent can see
 * which lenses independently raised the same (file, line, category) concern.
 * Lens identity is attached here (not on LensFinding) because the merger is
 * the first layer where cross-lens attribution makes sense -- a single lens
 * has no use for the field.
 *
 * Invariants:
 *  - contributingLenses is nonempty (every merged finding comes from ≥1 lens).
 *  - contributingLenses contains distinct lens ids (duplicates would mislead
 *    downstream tension/policy layers).
 *  - Same line/file correlation as LensFinding.
 */
export const MergedFindingSchema = z
  .object({
    ...findingObjectShape,
    contributingLenses: z.array(z.string().min(1)).nonempty(),
  })
  .strict()
  .superRefine((val, ctx) => {
    fileLineCorrelation(val, ctx);
    if (new Set(val.contributingLenses).size !== val.contributingLenses.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["contributingLenses"],
        message: "contributingLenses must be distinct",
      });
    }
  });
export type MergedFinding = z.infer<typeof MergedFindingSchema>;

/**
 * One lens run's payload. The lens's identity is carried on the envelope
 * (`CompleteParams.results[].lensId`), not here -- a single source of truth
 * avoids reconciliation logic in T-009.
 *
 * T-022: envelope is `.passthrough()` (was `.strict()`). Unknown bookkeeping
 * fields on the envelope (e.g., an orchestrator annotating `lensId` inside the
 * output for its own tracking) must NOT cause the whole lens payload to parse
 * as a syntheticError and lose all its findings -- the 2026-04-23 live test
 * hit exactly that. `LensFindingSchema` keeps `.strict()` so LLM hallucination
 * on per-finding shape is still rejected; parse errors there surface via
 * `ReviewVerdict.parseErrors[]` rather than being silently swallowed.
 */
export const LensOutputSchema = z
  .object({
    status: LensStatusSchema,
    findings: z.array(LensFindingSchema),
    error: z.string().nullable(),
    notes: z.string().nullable(),
  })
  .passthrough()
  .superRefine((val, ctx) => {
    if (val.status === "error") {
      if (val.error === null || val.error.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["error"],
          message: "error must be a non-empty string when status is 'error'",
        });
      }
      if (val.findings.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["findings"],
          message: "findings must be empty when status is 'error'",
        });
      }
    } else {
      // "ok" or "skipped": error must be null
      if (val.error !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["error"],
          message: `error must be null when status is '${val.status}'`,
        });
      }
      if (val.status === "skipped" && val.findings.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["findings"],
          message: "findings must be empty when status is 'skipped'",
        });
      }
    }
  });
export type LensOutput = z.infer<typeof LensOutputSchema>;

/**
 * Cross-round / cross-lens deferral key. Uses the same (file, line, category)
 * tuple as the merger dedup key, plus `lensId` so the agent can carry a
 * "don't re-raise these" list into the next review round.
 */
export const DeferralKeySchema = z
  .object({
    lensId: z.string().min(1),
    file: z.string().min(1).nullable(),
    line: z.number().int().positive().nullable(),
    category: z.string().min(1),
  })
  .strict()
  .superRefine(fileLineCorrelation);
export type DeferralKey = z.infer<typeof DeferralKeySchema>;
