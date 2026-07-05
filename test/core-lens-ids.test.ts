import { describe, expect, it, vi } from "vitest";

import { CORE_LENS_IDS } from "../src/lenses/core-lens-ids.js";
import { LENSES } from "../src/lenses/prompts/index.js";
import { SURFACE_RULES } from "../src/lenses/registry.js";

/**
 * T-027 R10 / R-D1: the core lens set has exactly one source of truth,
 * a leaf module with zero runtime imports, consumed by BOTH the
 * registry (SURFACE_RULES "core" entries) and schema/verdict.ts (the
 * core-coverage approve cap). These tests pin the content, the
 * registry tie, and the cycle-freedom of the module graph in both
 * evaluation orders.
 */
describe("CORE_LENS_IDS single source (T-027 R10/R-D1)", () => {
  it("pins the four core lens ids exactly, in order", () => {
    expect([...CORE_LENS_IDS]).toEqual([
      "security",
      "error-handling",
      "clean-code",
      "concurrency",
    ]);
  });

  it("every core lens id is a registered lens (runtime membership)", () => {
    const registered = Object.keys(LENSES);
    for (const id of CORE_LENS_IDS) {
      expect(registered).toContain(id);
    }
  });

  it("SURFACE_RULES ties bidirectionally to CORE_LENS_IDS", () => {
    for (const id of CORE_LENS_IDS) {
      expect(SURFACE_RULES[id]).toBe("core");
    }
    for (const [id, rule] of Object.entries(SURFACE_RULES)) {
      if (rule === "core") {
        expect(CORE_LENS_IDS).toContain(id);
      }
    }
  });

  it("module evaluation succeeds importing schema/index before lenses/registry", async () => {
    vi.resetModules();
    const schema = await import("../src/schema/index.js");
    const registry = await import("../src/lenses/registry.js");
    expect(schema.ReviewVerdictSchema).toBeDefined();
    expect(registry.SURFACE_RULES.security).toBe("core");
  });

  it("module evaluation succeeds importing lenses/registry before schema/index", async () => {
    vi.resetModules();
    const registry = await import("../src/lenses/registry.js");
    const schema = await import("../src/schema/index.js");
    expect(registry.SURFACE_RULES.security).toBe("core");
    expect(schema.ReviewVerdictSchema).toBeDefined();
  });
});
