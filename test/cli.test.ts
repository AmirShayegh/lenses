import { describe, it, expect } from "vitest";
import { parseCliArgs } from "../src/cli-args.js";

describe("parseCliArgs", () => {
  it("accepts --mcp as the sole argument", () => {
    expect(parseCliArgs(["--mcp"])).toEqual({ run: true });
  });

  it("rejects empty argv with a usage error", () => {
    const result = parseCliArgs([]);
    expect(result.run).toBe(false);
    if (!result.run) {
      expect(result.error).toBe("usage: lenses --mcp");
    }
  });

  it("rejects unknown flags with a usage error", () => {
    const result = parseCliArgs(["--unknown"]);
    expect(result.run).toBe(false);
    if (!result.run) {
      expect(result.error).toBe("usage: lenses --mcp");
    }
  });

  it("rejects extra args alongside --mcp", () => {
    const result = parseCliArgs(["--mcp", "extra"]);
    expect(result.run).toBe(false);
    if (!result.run) {
      expect(result.error).toBe("usage: lenses --mcp");
    }
  });

  it("rejects --mcp= forms (exact match only)", () => {
    const result = parseCliArgs(["--mcp=true"]);
    expect(result.run).toBe(false);
    if (!result.run) {
      expect(result.error).toBe("usage: lenses --mcp");
    }
  });
});
