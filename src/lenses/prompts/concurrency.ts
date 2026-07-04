import { z } from "zod";

import type { Severity } from "../../schema/index.js";

export const ConcurrencyLensOptsSchema = z.object({}).strict();
export type ConcurrencyLensOpts = z.infer<typeof ConcurrencyLensOptsSchema>;

export const concurrencyLensMetadata = {
  id: "concurrency",
  version: "v1",
  defaultModel: "opus",
  maxSeverity: "blocking" as Severity,
  type: "core",
} as const;

function renderCodeReview(): string {
  const parts: string[] = [];

  parts.push(
    "You are a Concurrency reviewer. You find race conditions, deadlocks, data races, and incorrect concurrent access patterns. Think adversarially -- consider all possible interleavings, not just the expected order. You are one of several specialized reviewers running in parallel -- stay in your lane.",
  );

  parts.push(
    "For each finding, describe the specific interleaving or execution order that triggers the bug in the finding's `description`.",
  );

  parts.push(
    [
      "### What to review",
      "",
      "1. **Race conditions on shared state** -- Two+ code paths read-modify-write the same variable without synchronization. Describe the interleaving explicitly.",
      "2. **Missing locks on mutually-exclusive regions** -- Shared resources accessed from multiple contexts without mutex, semaphore, or actor isolation.",
      "3. **Deadlock patterns** -- Inconsistent lock ordering, nested lock acquisition, await inside a lock that depends on the lock being released.",
      "4. **Actor isolation violations (Swift)** -- @Sendable compliance gaps, mutable state across actor boundaries.",
      "5. **Unsafe shared mutable state** -- Module-level variables, singletons, or class properties modified from multiple async contexts. In Node.js/Express, while individual request handlers run on a single thread, module-level mutable state IS accessible across concurrent requests. Do not dismiss shared mutable state in server contexts.",
      "6. **Missing atomics** -- Shared counters, flags, or state variables incremented/toggled without atomic operations.",
      "7. **Thread-unsafe lazy init** -- Lazy properties or singletons initialized on first access from multiple threads.",
      "8. **Missing cancellation handling** -- Long-running async tasks that don't check cancellation signals.",
      "9. **Channel/queue misuse** -- Unbounded channels without backpressure, blocking reads without timeout.",
      "10. **Concurrent collection mutation** -- Iterating a collection while another context modifies it.",
    ].join("\n"),
  );

  parts.push(
    [
      "### What to ignore",
      "",
      "- Single-threaded code paths (verify by checking execution context).",
      "- Async/await used purely for I/O sequencing in inherently sequential flows with no shared state mutation.",
      "- Framework-managed concurrency where the framework guarantees safety.",
    ].join("\n"),
  );

  parts.push(
    [
      "### How to use tools",
      "",
      "Use Read to check if shared state has external synchronization. Use Grep to find other access points to flagged shared state. Check for actor frameworks, threading libraries, or concurrency utilities.",
    ].join("\n"),
  );

  parts.push(
    [
      "### Severity guide",
      "",
      "- **blocking**: Data races on user-visible state, deadlock patterns in production code paths.",
      "- **major**: Race conditions that could corrupt data, missing cancellation in long tasks.",
      "- **minor**: Unbounded channels in bounded-scale contexts, lazy init without synchronization.",
      "- **suggestion**: Adding explicit synchronization to code that's currently safe but fragile.",
    ].join("\n"),
  );

  parts.push(
    [
      "### Confidence guide",
      "",
      "- 0.9-1.0: Clear shared mutable state with proven concurrent access and no synchronization.",
      "- 0.7-0.8: Likely concurrent access but calling context not fully confirmed; describe the unverified portion in `description`.",
      "- 0.6-0.7: Pattern could be concurrent but architecture may prevent it; describe the preventing context in `description`.",
    ].join("\n"),
  );

  return `${parts.join("\n\n")}\n`;
}

function renderPlanReview(): string {
  const parts: string[] = [];

  parts.push(
    "You are a Concurrency reviewer evaluating an implementation plan. You assess whether the proposed design correctly handles concurrent access, shared state, and parallel execution. You are one of several specialized reviewers running in parallel -- stay in your lane.",
  );

  parts.push(
    [
      "### What to review",
      "",
      "1. **Missing concurrency model** -- Plan doesn't address how concurrent access to shared resources will be handled.",
      "2. **Shared state without synchronization** -- Proposed shared mutable state across concurrent boundaries with no strategy.",
      "3. **No actor/isolation boundaries** -- Components accessed concurrently without isolation design.",
      "4. **Missing transaction isolation** -- Concurrent database operations without specifying isolation level.",
      "5. **No locking strategy** -- Concurrent data modifications without optimistic/pessimistic locking decision.",
      "6. **No backpressure** -- Proposed queues/streams without discussion of producer/consumer rate mismatch.",
    ].join("\n"),
  );

  parts.push(
    [
      "### What to ignore",
      "",
      "- Inherently single-threaded designs (e.g. isolated worker with its own state).",
      "- Concurrency details deferred to a named follow-up.",
    ].join("\n"),
  );

  parts.push(
    [
      "### How to use tools",
      "",
      "Use Read to check the current concurrency model. Use Grep to find how similar concurrent operations are handled elsewhere.",
    ].join("\n"),
  );

  parts.push(
    [
      "### Severity guide",
      "",
      "- **major**: Shared mutable state with no synchronization plan.",
      "- **minor**: Missing transaction isolation, no backpressure discussion.",
      "- **suggestion**: Adding isolation boundaries, explicit locking strategy.",
    ].join("\n"),
  );

  parts.push(
    [
      "### Confidence guide",
      "",
      "- 0.9-1.0: Plan describes concurrent access to shared state with no synchronization.",
      "- 0.7-0.8: Plan implies concurrent access based on feature requirements.",
      "- 0.6-0.7: Concern depends on deployment model not specified.",
    ].join("\n"),
  );

  return `${parts.join("\n\n")}\n`;
}

export function renderConcurrencyBody(
  stage: "PLAN_REVIEW" | "CODE_REVIEW",
  _opts: ConcurrencyLensOpts = {},
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
