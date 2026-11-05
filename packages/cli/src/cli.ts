import { describeEngine } from "@hackcove/flakeslash-engine";
import pkg from "../package.json" with { type: "json" };

const HELP = `flakeslash: flaky-test detection from the terminal.

Usage:
  flakeslash --version   print the version
  flakeslash --help      print this help

There are no detection commands yet.
`;

/** Runs the CLI for `args` and returns the exit code: 0 ok, 2 a usage error. */
export async function run(args: readonly string[]): Promise<number> {
  const [first] = args;
  if (first === "--version" || first === "-v") {
    process.stdout.write(`flakeslash ${pkg.version} (${describeEngine()})\n`);
    return 0;
  }
  if (first === undefined || first === "--help" || first === "-h") {
    process.stdout.write(HELP);
    return 0;
  }
  process.stderr.write(`flakeslash: unknown argument "${first}". Try --help.\n`);
  return 2;
}
