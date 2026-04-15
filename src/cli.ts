import process from "node:process";
import { main } from "./server.js";
import { parseCliArgs } from "./cli-args.js";

const parsed = parseCliArgs(process.argv.slice(2));
if (!parsed.run) {
  process.stderr.write(`${parsed.error}\n`);
  process.exit(2);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
