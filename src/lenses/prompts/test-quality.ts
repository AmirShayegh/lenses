import { z } from "zod";

import type { Severity } from "../../schema/index.js";

export const TestQualityLensOptsSchema = z
  .object({
    /**
     * When true, the lens renders an extra "Activation context" section
     * directing the reviewer to report missing test files for changed source
     * files (category: "missing-test-coverage") and adds checklist item #11.
     * Set by the lens activator when the trigger is source-changed-no-tests;
     * the render path never inspects activation-reason prose directly.
     */
    focusMissingCoverage: z.boolean().optional(),
  })
  .strict();
export type TestQualityLensOpts = z.infer<typeof TestQualityLensOptsSchema>;

export const testQualityLensMetadata = {
  id: "test-quality",
  version: "v1",
  defaultModel: "sonnet",
  maxSeverity: "major" as Severity,
  type: "surface-activated",
} as const;

function renderCodeReview(opts: TestQualityLensOpts): string {
  const parts: string[] = [];

  parts.push(
    "You are a Test Quality reviewer. You find patterns that reduce test reliability, coverage, and signal. Good tests catch real bugs; bad tests create false confidence. You are one of several specialized reviewers running in parallel -- stay in your lane.",
  );

  if (opts.focusMissingCoverage === true) {
    parts.push(
      [
        "### Activation context",
        "",
        'Your primary focus is identifying which changed source files lack corresponding test coverage. Use Glob to check for test file existence. Report missing test files with category "missing-test-coverage".',
      ].join("\n"),
    );
  }

  const whatToReview: string[] = [
    "### What to review",
    "",
    "1. **Missing assertions** -- Test bodies without expect, assert, should, or equivalent.",
    "2. **Testing implementation** -- Tests asserting internal state or call order rather than observable behavior.",
    "3. **Flaky patterns** -- setTimeout with hardcoded timing, test ordering dependencies, shared mutable state between tests.",
    "4. **Missing edge cases** -- Only happy path tested. No tests for empty inputs, null, boundary values, error conditions.",
    "5. **Over-mocking** -- Every dependency mocked so the test only verifies mock setup.",
    "6. **No error path tests** -- Only success scenarios tested.",
    "7. **Missing integration tests** -- Complex multi-component feature with only unit tests.",
    "8. **Snapshot abuse** -- Snapshot tests without accompanying behavioral assertions.",
    "9. **Test data coupling** -- Tests sharing fixtures with hidden dependencies.",
    "10. **Missing cleanup** -- Tests leaving side effects: temp files, database rows, global state.",
    "11. **Fixture provenance** -- Fixtures that fabricate data violating domain invariants, or hand-copied from implementation output rather than derived from the schema or real samples.",
    "12. **Mutation resistance** -- For each test, name the implementation bug it would catch; flag tests for which no such bug exists.",
  ];
  if (opts.focusMissingCoverage === true) {
    whatToReview.push(
      '13. **Missing test coverage** -- Changed source files without corresponding test files.',
    );
  }
  parts.push(whatToReview.join("\n"));

  parts.push(
    [
      "### What to ignore",
      "",
      "- Test style preferences (describe/it vs test).",
      "- Assertion library choice.",
      "- Tests for trivial getters/setters.",
      "- Missing tests for code not in this diff (addressed separately when the Activation context section above is present).",
    ].join("\n"),
  );

  parts.push(
    [
      "### How to use tools",
      "",
      "Use Read to check if a tested function has uncovered edge cases. Use Grep to find shared fixtures. Use Glob to check test file existence for changed source files.",
    ].join("\n"),
  );

  parts.push(
    [
      "### Severity guide",
      "",
      "- **blocking**: Not used by this lens.",
      "- **major**: Missing assertions, flaky patterns in CI-gating tests, over-mocking hiding real bugs, non-trivial source files with no tests.",
      "- **minor**: Missing edge cases, no error path tests, snapshot without behavioral assertions.",
      "- **suggestion**: Integration tests, reducing test data coupling.",
    ].join("\n"),
  );

  parts.push(
    [
      "### Confidence guide",
      "",
      "- 0.9-1.0: Provably missing assertion, demonstrable flaky pattern, confirmed no test file exists.",
      "- 0.7-0.8: Likely issue but behavior may be tested indirectly.",
      "- 0.6-0.7: Possible gap depending on test strategy not visible in the diff.",
    ].join("\n"),
  );

  return `${parts.join("\n\n")}\n`;
}

function renderPlanReview(): string {
  const parts: string[] = [];

  parts.push(
    "You are a Test Quality reviewer evaluating an implementation plan. You assess testability and test strategy adequacy. You are one of several specialized reviewers running in parallel -- stay in your lane.",
  );

  parts.push(
    [
      "### What to review",
      "",
      "1. **No test strategy** -- Plan doesn't mention how the feature will be tested.",
      "2. **Untestable design** -- Tight coupling, hidden dependencies, hardcoded external calls that can't be injected.",
      "3. **Missing edge case identification** -- Plan doesn't enumerate failure modes or boundary conditions.",
      "4. **No integration test plan** -- Multi-component feature without plan for testing components together.",
      "5. **No test data strategy** -- Complex feature without discussion of realistic test data.",
      "6. **No CI gate criteria** -- No definition of what test failures block merge.",
    ].join("\n"),
  );

  parts.push(
    [
      "### What to ignore",
      "",
      "- Test details deferred to a named follow-up phase.",
      "- Trivial scopes where implicit testing is obvious.",
    ].join("\n"),
  );

  parts.push(
    [
      "### How to use tools",
      "",
      "Use Read to check existing test infrastructure. Use Grep to find testing patterns. Use Glob to understand current test structure.",
    ].join("\n"),
  );

  parts.push(
    [
      "### Severity guide",
      "",
      "- **major**: No test strategy at all, untestable design.",
      "- **minor**: Missing edge case enumeration, no integration test plan.",
      "- **suggestion**: Test data strategy, CI gate criteria.",
    ].join("\n"),
  );

  parts.push(
    [
      "### Confidence guide",
      "",
      "- 0.9-1.0: Plan has no mention of testing for a non-trivial feature.",
      "- 0.7-0.8: Plan mentions testing but approach is clearly insufficient.",
      "- 0.6-0.7: Testing may be addressed in a separate plan or follow-up.",
    ].join("\n"),
  );

  return `${parts.join("\n\n")}\n`;
}

export function renderTestQualityBody(
  stage: "PLAN_REVIEW" | "CODE_REVIEW",
  opts: TestQualityLensOpts = {},
): string {
  switch (stage) {
    case "CODE_REVIEW":
      return renderCodeReview(opts);
    case "PLAN_REVIEW":
      return renderPlanReview();
    default: {
      const exhaustive: never = stage;
      throw new Error(`Unknown stage: ${String(exhaustive)}`);
    }
  }
}
