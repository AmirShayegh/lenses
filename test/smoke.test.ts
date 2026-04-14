import { describe, it, expect } from "vitest";
import { main } from "../src/index.js";

describe("toolchain smoke", () => {
  it("main is callable and resolves", async () => {
    await expect(main()).resolves.toBeUndefined();
  });
});
