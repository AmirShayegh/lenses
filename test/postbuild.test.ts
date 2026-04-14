import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// @ts-expect-error - .mjs script has no TS types; vitest loads it at runtime.
import { prependShebangIfMissing, applyPostbuild, SHEBANG } from "../scripts/postbuild.mjs";

describe("postbuild.prependShebangIfMissing", () => {
  it("prepends the shebang when missing", () => {
    const input = 'import { main } from "./server.js";\nmain();\n';
    const output = prependShebangIfMissing(input);
    expect(output.startsWith(SHEBANG)).toBe(true);
    expect(output).toBe(SHEBANG + input);
  });

  it("is idempotent when a shebang is already present", () => {
    const alreadyShebanged = SHEBANG + "console.log('hi');\n";
    const output = prependShebangIfMissing(alreadyShebanged);
    expect(output).toBe(alreadyShebanged);
  });

  it("preserves any other shebang verbatim (does not rewrite)", () => {
    const other = "#!/usr/bin/env -S node --experimental-vm-modules\nfoo\n";
    expect(prependShebangIfMissing(other)).toBe(other);
  });
});

describe("postbuild.applyPostbuild (integration against a tmp file)", () => {
  let dir: string;
  let cliPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "lenses-postbuild-"));
    cliPath = join(dir, "cli.js");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes the shebang and sets the exec bit on a fresh file", async () => {
    const source = 'import { main } from "./server.js";\nmain();\n';
    await writeFile(cliPath, source, "utf8");

    await applyPostbuild(cliPath);

    const after = await readFile(cliPath, "utf8");
    expect(after.startsWith(SHEBANG)).toBe(true);
    expect(after).toBe(SHEBANG + source);

    if (process.platform !== "win32") {
      const st = await stat(cliPath);
      // Unix: owner exec bit must be set.
      expect(st.mode & 0o100).toBe(0o100);
    }
  });

  it("leaves content unchanged when the shebang is already present", async () => {
    const source = SHEBANG + "console.log('hi');\n";
    await writeFile(cliPath, source, "utf8");

    await applyPostbuild(cliPath);

    const after = await readFile(cliPath, "utf8");
    expect(after).toBe(source);
  });
});
