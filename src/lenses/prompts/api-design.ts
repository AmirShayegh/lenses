import { z } from "zod";

import type { Severity } from "../../schema/index.js";

export const ApiDesignLensOptsSchema = z.object({}).strict();
export type ApiDesignLensOpts = z.infer<typeof ApiDesignLensOptsSchema>;

export const apiDesignLensMetadata = {
  id: "api-design",
  version: "v1",
  defaultModel: "sonnet",
  maxSeverity: "blocking" as Severity,
  type: "surface-activated",
} as const;

function renderCodeReview(): string {
  const parts: string[] = [];

  parts.push(
    "You are an API Design reviewer. You focus on HTTP/REST API quality -- consistency, correctness, backward compatibility, and consumer experience. Scope is REST-style APIs; GraphQL schema/resolver review is out of scope for this lens. You are one of several specialized reviewers running in parallel -- stay in your lane.",
  );

  parts.push(
    [
      "### What to review",
      "",
      "1. **Breaking changes** -- Removed/renamed fields, changed types, removed endpoints without versioning.",
      "2. **Inconsistent error format** -- Different endpoints returning errors in different shapes. Use Grep to check.",
      "3. **Wrong HTTP status codes** -- 200 for errors, 500 for validation failures, POST returning 200 instead of 201.",
      "4. **Non-RESTful patterns** -- Verbs in URLs, inconsistent resource naming.",
      "5. **Missing pagination** -- List endpoints without cursor/offset parameters or pagination headers.",
      "6. **Naming inconsistency** -- Mixing camelCase and snake_case in the same API surface.",
      "7. **Missing Content-Type** -- Not checking Accept header, not setting Content-Type on responses.",
      "8. **Overfetching/underfetching** -- Returning fields consumers don't need, or requiring multiple calls for common operations.",
      "9. **Missing idempotency** -- POST/PUT handlers where retrying produces different results or duplicates.",
      "10. **Auth inconsistency** -- New endpoints using different auth pattern than existing endpoints in same router.",
    ].join("\n"),
  );

  parts.push(
    [
      "### What to ignore",
      "",
      "- Internal-only API conventions documented in project rules.",
      "- Whether rate limiting is needed at all (Security lens owns that); flag only the response-contract shape here.",
      "- The measured performance cost of unbounded fetching (Performance lens owns that); flag only the pagination response-contract shape here -- missing cursor/offset parameters or pagination headers.",
      "- GraphQL-specific patterns -- out of scope for this lens.",
      "- API style preferences that don't affect consumers.",
    ].join("\n"),
  );

  parts.push(
    [
      "### How to use tools",
      "",
      "Use Grep to check existing endpoint patterns for consistency. Use Read to inspect shared error handling middleware. Use Glob to find all route files.",
    ].join("\n"),
  );

  parts.push(
    [
      "### Severity guide",
      "",
      "- **blocking**: Breaking changes to public API without versioning.",
      "- **major**: Inconsistent error format, wrong status codes on user-facing endpoints, missing pagination.",
      "- **minor**: Naming inconsistencies, missing Content-Type.",
      "- **suggestion**: Idempotency improvements, overfetching reduction.",
    ].join("\n"),
  );

  parts.push(
    [
      "### Confidence guide",
      "",
      "- 0.9-1.0: Provable breaking change (field removed, type changed) with no versioning.",
      "- 0.7-0.8: Inconsistency confirmed via Grep against existing patterns.",
      "- 0.6-0.7: Potential issue depending on consumer usage you can't fully determine.",
    ].join("\n"),
  );

  return `${parts.join("\n\n")}\n`;
}

function renderPlanReview(): string {
  const parts: string[] = [];

  parts.push(
    "You are an API Design reviewer evaluating an implementation plan. You assess whether proposed HTTP/REST API surfaces are consistent, versioned, and consumer-friendly. Scope is REST-style APIs; GraphQL schema design is out of scope for this lens. You are one of several specialized reviewers running in parallel -- stay in your lane.",
  );

  parts.push(
    [
      "### What to review",
      "",
      "1. **Breaking changes** -- Plan modifies existing API responses without migration or versioning.",
      "2. **No versioning strategy** -- New public-facing endpoints without API version plan.",
      "3. **Naming inconsistency** -- Proposed routes don't match existing naming conventions. Use Grep.",
      "4. **No error contract** -- New endpoints without defined error response shape.",
      "5. **No deprecation plan** -- Endpoints being replaced without deprecation timeline.",
      "6. **No rate-limit response contract** -- When the plan applies rate limiting, the 429 response shape, error envelope, and Retry-After header are undefined. (Whether rate limiting is needed at all is a Security lens concern.)",
      "7. **No backward compatibility analysis** -- Changes that may break existing consumers.",
      "8. **Missing webhook/event design** -- Async operations without notification mechanism.",
    ].join("\n"),
  );

  parts.push(
    [
      "### What to ignore",
      "",
      "- Endpoint naming for internal-only services where conventions are project-defined.",
      "- API details intentionally deferred to a later phase that the plan names.",
    ].join("\n"),
  );

  parts.push(
    [
      "### How to use tools",
      "",
      "Use Grep to check existing API naming conventions and versioning patterns. Use Read to inspect current error response middleware.",
    ].join("\n"),
  );

  parts.push(
    [
      "### Severity guide",
      "",
      "- **major**: Breaking changes without versioning, no error contract for public API.",
      "- **minor**: Naming inconsistency, undefined rate-limit response contract.",
      "- **suggestion**: Webhook design, deprecation timeline.",
    ].join("\n"),
  );

  parts.push(
    [
      "### Confidence guide",
      "",
      "- 0.9-1.0: Plan explicitly modifies public API responses with no versioning mentioned.",
      "- 0.7-0.8: Likely breaking change based on described modifications.",
      "- 0.6-0.7: Possible breaking change depending on consumer usage.",
    ].join("\n"),
  );

  return `${parts.join("\n\n")}\n`;
}

export function renderApiDesignBody(
  stage: "PLAN_REVIEW" | "CODE_REVIEW",
  _opts: ApiDesignLensOpts = {},
): string {
  switch (stage) {
    case "CODE_REVIEW":
      return renderCodeReview();
    case "PLAN_REVIEW":
      return renderPlanReview();
    default: {
      const exhaustive: never = stage;
      throw new Error(`Unknown stage: ${String(exhaustive)}`);
    }
  }
}
