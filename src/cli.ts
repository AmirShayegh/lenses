import process from "node:process";
import { main } from "./server.js";

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
