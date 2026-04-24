import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { createServer } from "../src/server.js";

describe("toolchain smoke", () => {
  it("createServer returns a server instance", async () => {
    const server = createServer();
    try {
      expect(server).toBeDefined();
    } finally {
      await server.close();
    }
  });
});

/**
 * ISS-002: exercise the REAL `main()` bootstrap path via the built
 * `dist/cli.js`, not just `createServer()`. Catches CLI-wiring
 * regressions — the shebang, the `--mcp` flag parse, the
 * `StdioServerTransport` connect, and the tools/list response all
 * have to work together for this to pass.
 *
 * Skipped when `dist/cli.js` is missing (a fresh clone before `npm run
 * build`). CI runs `npm run build` before `npm test`, so the skip is
 * only relevant for local-dev iteration.
 */
const here = dirname(fileURLToPath(import.meta.url));
const cliPath = resolve(here, "..", "dist", "cli.js");
const distAvailable = existsSync(cliPath);

describe.skipIf(!distAvailable)("CLI stdio bootstrap (ISS-002)", () => {
  it("spawns `node dist/cli.js --mcp` and advertises all three tools over tools/list", async () => {
    const child = spawn(process.execPath, [cliPath, "--mcp"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    child.stdout.on("data", (buf: Buffer) =>
      stdoutChunks.push(buf.toString("utf8")),
    );
    child.stderr.on("data", (buf: Buffer) =>
      stderrChunks.push(buf.toString("utf8")),
    );

    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolveExit) => {
        child.on("exit", (code, signal) =>
          resolveExit({ code, signal }),
        );
      },
    );

    function waitForResponse(id: number, timeoutMs = 5_000): Promise<unknown> {
      return new Promise((resolveJson, rejectJson) => {
        const t = setTimeout(() => {
          rejectJson(
            new Error(
              `timeout waiting for response id=${id}; stdout=${stdoutChunks.join("")}; stderr=${stderrChunks.join("")}`,
            ),
          );
        }, timeoutMs);
        const onData = () => {
          const joined = stdoutChunks.join("");
          for (const line of joined.split("\n")) {
            if (line.length === 0) continue;
            try {
              const parsed = JSON.parse(line) as { id?: number };
              if (parsed.id === id) {
                clearTimeout(t);
                child.stdout.off("data", onData);
                resolveJson(parsed);
                return;
              }
            } catch {
              // not a complete JSON line yet; keep buffering
            }
          }
        };
        child.stdout.on("data", onData);
      });
    }

    try {
      // 1) MCP initialize handshake.
      const initReq = {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "smoke-test", version: "0.0.0" },
        },
      };
      child.stdin.write(`${JSON.stringify(initReq)}\n`);
      const initResp = (await waitForResponse(1)) as {
        result?: { serverInfo?: { name: string; version: string } };
      };
      expect(initResp.result?.serverInfo?.name).toBe("lenses");
      // T-023 regression pin: the built CLI must advertise the
      // package.json version (not the prior "0.0.0" hardcoded value).
      const pkgVersion = (
        JSON.parse(
          readFileSync(resolve(here, "..", "package.json"), "utf8"),
        ) as { version: string }
      ).version;
      expect(initResp.result?.serverInfo?.version).toBe(pkgVersion);
      expect(initResp.result?.serverInfo?.version).not.toBe("0.0.0");

      // MCP clients must send `notifications/initialized` before the
      // server will accept further requests.
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
        })}\n`,
      );

      // 2) tools/list should return the three T-022 tools.
      const listReq = {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      };
      child.stdin.write(`${JSON.stringify(listReq)}\n`);
      const listResp = (await waitForResponse(2)) as {
        result?: { tools?: Array<{ name: string }> };
      };
      const names = (listResp.result?.tools ?? [])
        .map((t) => t.name)
        .sort();
      expect(names).toEqual([
        "lens_review_complete",
        "lens_review_get_prompt",
        "lens_review_start",
      ]);
    } finally {
      child.kill("SIGTERM");
      // Give the process a moment to exit cleanly; vitest will hang
      // otherwise if the event loop has a pending handle.
      await Promise.race([
        exited,
        new Promise((r) => setTimeout(r, 1_000)),
      ]);
      if (!child.killed) child.kill("SIGKILL");
    }
  });
});
