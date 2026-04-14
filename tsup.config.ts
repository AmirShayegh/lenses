import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    cli: "src/cli.ts",
  },
  format: ["esm"],
  target: "node20",
  platform: "node",
  outDir: "dist",
  dts: { entry: { index: "src/index.ts" } },
  sourcemap: true,
  clean: true,
  shims: false,
});
