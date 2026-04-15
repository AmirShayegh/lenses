export type ParsedCliArgs = { run: true } | { run: false; error: string };

export function parseCliArgs(argv: readonly string[]): ParsedCliArgs {
  if (argv.length === 1 && argv[0] === "--mcp") {
    return { run: true };
  }
  return { run: false, error: "usage: lenses --mcp" };
}
