// ISS-1043 (storybloq): importing this package must not touch process.stdin.
//
// index.ts re-exports main from server.ts, so a static StdioServerTransport
// import there makes EVERY importer of the package construct the stdin TTY at
// ESM link time -- Node's builtin facade eagerly reads all of node:process's
// exports, including the stdin getter. On a wedged pty that open() hangs
// uninterruptibly. The fix defers the stdio import into main(); this test pins
// it at the source, before bundling, independent of any consumer.
//
// The probe is in-process: poison the stdin getter, import the package entry,
// assert the getter never fired. Getter poisoning is fd-type-independent, so
// this is deterministic with or without a tty.

import { describe, it, expect } from "vitest";

describe("package import does not touch process.stdin (ISS-1043)", () => {
  it("importing src/index.js leaves the stdin getter unfired", async () => {
    const original = Object.getOwnPropertyDescriptor(process, "stdin");
    if (!original) throw new Error("process.stdin descriptor missing");
    let touched = 0;
    Object.defineProperty(process, "stdin", {
      configurable: true,
      get() {
        touched += 1;
        // Restore and delegate so anything that legitimately needs stdin
        // later in the worker still works.
        Object.defineProperty(process, "stdin", original);
        return original.get
          ? original.get.call(process)
          : (original.value as NodeJS.ReadStream);
      },
    });
    try {
      const mod = await import("../src/index.js");
      expect(typeof mod.main).toBe("function");
      // Static-import graph fully linked; the getter must not have fired.
      expect(touched).toBe(0);
    } finally {
      Object.defineProperty(process, "stdin", original);
    }
  });
});
