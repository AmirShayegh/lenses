import { z } from "zod";

import type { Severity } from "../../schema/index.js";
import { untrusted } from "./untrusted.js";

/**
 * Glob-pattern lexical grammar: letters, digits, and the structural set the
 * gitignore/minimatch/extglob grammar uses (dot, underscore, star, question,
 * slash, braces, comma, bang, dash, brackets, parens, @/+ for extglob heads,
 * colon for POSIX classes, backslash for escapes). No whitespace, quotes,
 * angle brackets, or other markup tokens.
 *
 * Accepts minimatch/micromatch shapes like `@(src|test)/**`, `!(dist)/**`,
 * `+(foo|bar)/*.ts`, and escaped literals like `foo\\*bar`.
 *
 * This is a LEXICAL sanity filter, not a semantic safety proof. `hotPaths`
 * values are ALSO wrapped in `<untrusted-context>` at render time -- the
 * wrapper is the real trust boundary.
 *
 * Exported so the T-006 activation-config schema can enforce the same
 * grammar at the user-facing intake boundary -- single source of truth.
 */
export const PERFORMANCE_GLOB_RE = /^[A-Za-z0-9._*?/{}[\]()@+:!|\\,-]+$/;

/** Max length of a single hotPath entry. Exported for T-006 reuse. */
export const PERFORMANCE_HOTPATH_MAX = 200;

/** Max number of hotPath entries. Exported for T-006 reuse. */
export const PERFORMANCE_HOTPATHS_MAX = 50;

export const PerformanceLensOptsSchema = z
  .object({
    /**
     * trust: untrusted-wrap-required -- wrapped in <untrusted-context> on
     * render. Grammar restricts to lexical glob shapes; semantic isolation
     * comes from the wrapper.
     */
    hotPaths: z
      .array(
        z
          .string()
          .min(1)
          .max(PERFORMANCE_HOTPATH_MAX)
          .regex(
            PERFORMANCE_GLOB_RE,
            "hotPath must be a glob pattern (no whitespace, quotes, or markup characters)",
          ),
      )
      .max(PERFORMANCE_HOTPATHS_MAX)
      .optional(),
  })
  .strict();
export type PerformanceLensOpts = z.infer<typeof PerformanceLensOptsSchema>;

export const performanceLensMetadata = {
  id: "performance",
  version: "v1",
  defaultModel: "sonnet",
  maxSeverity: "blocking" as Severity,
  type: "surface-activated",
} as const;

function renderCodeReview(opts: PerformanceLensOpts): string {
  const parts: string[] = [];

  parts.push(
    "You are a Performance reviewer. You find patterns that cause measurable performance degradation at realistic scale -- not micro-optimizations. Focus on user-perceived latency, memory consumption, and database load. You are one of several specialized reviewers running in parallel -- stay in your lane.",
  );

  if (opts.hotPaths !== undefined && opts.hotPaths.length > 0) {
    parts.push(
      `### Additional context\n\nHot paths: ${untrusted("hotPaths", opts.hotPaths.join("\n"))}`,
    );
  }

  parts.push(
    [
      "### What to review",
      "",
      "1. **N+1 queries** -- A loop issuing a database query per iteration. The query may be inside a called function -- use Read to trace.",
      "2. **Missing indexes** -- Query patterns filtering/sorting on columns unlikely to be indexed, on growing tables.",
      "3. **Unbounded result sets** -- Database queries or API responses without LIMIT/pagination.",
      "4. **Synchronous I/O in hot paths** -- fs.readFileSync, execSync, or blocking operations in request handlers, render functions, or hot path config matches.",
      "5. **Memory leaks** -- Event listeners without removal, subscriptions without unsubscribe, setInterval without clearInterval, DB connections not pooled.",
      "6. **Unnecessary re-renders (React)** -- Inline object/array/function allocations passed as JSX props or context values that force a measurably hot subtree to re-render on every parent render. useMemo/useCallback are opt-in optimizations, not defaults -- suggest them only when render cost is measurable.",
      "7. **Large bundle imports** -- Importing entire libraries when one function is used.",
      "8. **Missing memoization** -- Pure functions with expensive computation called repeatedly with same inputs.",
      "9. **Quadratic or worse algorithms** -- O(n^2)+ patterns operating on user-controlled collection sizes.",
      "10. **Missing pagination** -- List endpoints or data fetching without pagination for growing collections.",
    ].join("\n"),
  );

  parts.push(
    [
      "### What to ignore",
      "",
      "- Micro-optimizations that don't affect real performance.",
      "- Performance of test code.",
      "- Premature optimization for infrequently-run code (startup, migrations, one-time setup).",
      "- Performance patterns already optimized by the framework.",
      "- The pagination response-contract shape -- cursor/offset parameters and pagination headers (API-design lens owns that); flag only the measured or demonstrable cost of unbounded fetching here.",
    ].join("\n"),
  );

  parts.push(
    [
      "### How to use tools",
      "",
      "Use Read to trace whether a database call inside a function is actually called in a loop. Use Grep to check if an N+1 pattern has a batch alternative. Use Glob to identify hot path files.",
    ].join("\n"),
  );

  parts.push(
    [
      "### Severity guide",
      "",
      "- **blocking**: N+1 queries on user-facing endpoints, unbounded queries on growing tables, memory leaks in long-running processes.",
      "- **major**: Missing pagination on list endpoints, synchronous I/O in request handlers, O(n^2) on user-sized collections.",
      "- **minor**: Unnecessary re-renders in profiled-hot subtrees, large bundle imports, missing memoization where cost is measurable.",
      "- **suggestion**: Index recommendations, caching opportunities.",
    ].join("\n"),
  );

  parts.push(
    [
      "### Confidence guide",
      "",
      "- 0.9-1.0: N+1 with traceable loop, demonstrable unbounded query, provable O(n^2).",
      "- 0.7-0.8: Likely issue but depends on data volume or call frequency you can't fully verify.",
      "- 0.6-0.7: Pattern could be a problem at scale but current usage may be small.",
    ].join("\n"),
  );

  return `${parts.join("\n\n")}\n`;
}

function renderPlanReview(_opts: PerformanceLensOpts): string {
  const parts: string[] = [];

  parts.push(
    "You are a Performance reviewer evaluating an implementation plan. You assess whether the proposed design will perform at realistic scale. You are one of several specialized reviewers running in parallel -- stay in your lane.",
  );

  parts.push(
    [
      "### What to review",
      "",
      "1. **Scalability blind spots** -- Design assumes small data but feature will serve growing collections.",
      "2. **Missing caching** -- Frequently-read, rarely-changed data fetched from database on every request.",
      "3. **Expensive operations in request path** -- Email sending, PDF generation, image processing planned synchronously instead of async queues.",
      "4. **Missing index plan** -- New tables or query patterns without index strategy.",
      "5. **No CDN/edge strategy** -- Static assets or rarely-changing API responses without caching plan.",
      "6. **No lazy loading** -- Large frontend features loaded eagerly when they could be deferred.",
      "7. **Data fetching waterfall** -- Sequential API/DB calls that could run in parallel.",
    ].join("\n"),
  );

  parts.push(
    [
      "### What to ignore",
      "",
      "- Micro-optimizations not justified by realistic scale.",
      "- Performance concerns for components unchanged in this plan.",
    ].join("\n"),
  );

  parts.push(
    [
      "### How to use tools",
      "",
      "Use Read to check existing caching, pagination, and queueing patterns. Use Grep to find how similar features handle scale.",
    ].join("\n"),
  );

  parts.push(
    [
      "### Severity guide",
      "",
      "- **major**: Synchronous expensive operations in request path, no pagination for growing collections.",
      "- **minor**: Missing caching layer, no lazy loading plan.",
      "- **suggestion**: Index planning, CDN opportunities, parallel fetching.",
    ].join("\n"),
  );

  parts.push(
    [
      "### Confidence guide",
      "",
      "- 0.9-1.0: Plan explicitly describes synchronous expensive operation in request handler.",
      "- 0.7-0.8: Plan implies a pattern that commonly causes performance issues at scale.",
      "- 0.6-0.7: Performance concern depends on data volumes not specified in the plan.",
    ].join("\n"),
  );

  return `${parts.join("\n\n")}\n`;
}

export function renderPerformanceBody(
  stage: "PLAN_REVIEW" | "CODE_REVIEW",
  opts: PerformanceLensOpts = {},
): string {
  switch (stage) {
    case "CODE_REVIEW":
      return renderCodeReview(opts);
    case "PLAN_REVIEW":
      return renderPlanReview(opts);
    default: {
      const exhaustive: never = stage;
      throw new Error(`Unknown stage: ${String(exhaustive)}`);
    }
  }
}
