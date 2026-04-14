import { chmod, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export const SHEBANG = "#!/usr/bin/env node\n";

/**
 * Prepend the Node shebang to `content` unless it already starts with `#!`.
 * Pure function so tests can exercise it without touching the filesystem.
 */
export function prependShebangIfMissing(content) {
  return content.startsWith("#!") ? content : SHEBANG + content;
}

/**
 * Apply the CLI postbuild steps against a path on disk: ensure line 1 is the
 * Node shebang, and set mode 0755 (no-op on Windows).
 */
export async function applyPostbuild(cliPath) {
  const existing = await readFile(cliPath, "utf8");
  const next = prependShebangIfMissing(existing);
  if (next !== existing) {
    await writeFile(cliPath, next, "utf8");
  }
  await chmod(cliPath, 0o755);
}

// Self-invoke only when run directly as `node ./scripts/postbuild.mjs`. When
// imported from a test the comparison fails because process.argv[1] points at
// the test runner, so main() does not execute.
const isMain =
  typeof process.argv[1] === "string" &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
  const here = dirname(fileURLToPath(import.meta.url));
  const cliPath = resolve(here, "..", "dist", "cli.js");
  applyPostbuild(cliPath).catch((err) => {
    console.error("postbuild failed:", err);
    process.exit(1);
  });
}
