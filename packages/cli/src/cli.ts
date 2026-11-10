import {
  describeEngine,
  GitHubApiError,
  isRepoName,
  scanRepo,
  type FetchLike,
  type RepoScan,
} from "@hackcove/flakeslash-engine";
import pkg from "../package.json" with { type: "json" };
import { openSqliteStore } from "./store.ts";

const HELP = `flakeslash: flaky-test detection from the terminal.

Usage:
  flakeslash scan <owner/repo>... [--since <date>] [--store <path>] [--json]
                         list the jobs that both failed and passed on one commit
  flakeslash --version   print the version
  flakeslash --help      print this help

scan reads each repo's GitHub Actions history (no pipeline change) and keeps it in a local SQLite
store, so a second scan fetches only what is new. For each failed job it also reads the log once,
cuts it down to the lines around the failure, removes secrets, and keeps that excerpt with a link to
the full log. The whole log is never stored. The token comes from GITHUB_TOKEN.

Options for scan:
  --since <date>   read runs created on or after this date (default: 90 days ago)
  --store <path>   the SQLite file (default: .flakeslash/flakeslash.db)
  --json           write { "repos": [...] } to stdout instead of the summary

Exit codes: 0 ok, 1 the run failed (an outage, a refused token), 2 a usage error.
`;

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SINCE_DAYS = 90;

/** What the CLI reaches outside itself through, so a test can stand in for the network and the shell. */
interface Deps {
  fetch: FetchLike;
  env: Readonly<Record<string, string | undefined>>;
}

/** An error in how the command was called. It ends the run with exit code 2. */
class UsageError extends Error {}

interface ScanArgs {
  repos: string[];
  since: string;
  store: string | undefined;
  json: boolean;
}

function sinceFrom(since: string | undefined): string {
  if (since === undefined) return new Date(Date.now() - DEFAULT_SINCE_DAYS * DAY_MS).toISOString();
  const ms = Date.parse(since);
  if (Number.isNaN(ms)) throw new UsageError(`--since "${since}" is not a date`);
  return new Date(ms).toISOString();
}

function parseScanArgs(args: readonly string[]): ScanArgs {
  const repos: string[] = [];
  const flags: { since?: string; store?: string; json: boolean } = { json: false };

  const valueOf = (flag: string, index: number): string => {
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new UsageError(`${flag} needs a value`);
    }
    return value;
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--json") flags.json = true;
    else if (arg === "--since") flags.since = valueOf(arg, index++);
    else if (arg === "--store") flags.store = valueOf(arg, index++);
    else if (arg.startsWith("-")) throw new UsageError(`unknown option "${arg}"`);
    else repos.push(arg);
  }

  if (repos.length === 0) throw new UsageError("scan needs at least one repo, as owner/name");
  for (const repo of repos) {
    if (!isRepoName(repo)) throw new UsageError(`"${repo}" is not a repo; write it as owner/name`);
  }
  return { repos, since: sinceFrom(flags.since), store: flags.store, json: flags.json };
}

function summarize(scan: RepoScan): string {
  const lines = [scan.repo, `  new jobs: ${scan.newJobs}`];
  lines.push(`  logs kept: ${scan.logsKept}, expired: ${scan.logsGone}`);
  if (scan.logsLeft > 0) {
    lines.push(`  ${scan.logsLeft} logs left for the next scan (GitHub said try later)`);
  }
  if (scan.flakes.length === 0) lines.push("  no flaky jobs");
  else lines.push(`  ${scan.flakes.length} flaky ${scan.flakes.length === 1 ? "job" : "jobs"}:`);
  for (const flake of scan.flakes) {
    lines.push(`  ${flake.workflow} / ${flake.jobName}  ${flake.commit.slice(0, 8)}`);
    for (const item of flake.evidence) lines.push(`    ${item.outcome.padEnd(6)} ${item.url}`);
  }
  if (scan.cutShort) {
    lines.push(
      `  A rate limit stopped the read after ${scan.newJobs} new jobs (oldest read: ${scan.oldestRead ?? "none"}).`,
      "  Run the scan again to continue from there.",
    );
  }
  return `${lines.join("\n")}\n`;
}

function report(scans: readonly RepoScan[], json: boolean): void {
  if (json) process.stdout.write(`${JSON.stringify({ repos: scans })}\n`);
  else process.stdout.write(scans.map(summarize).join("\n"));
}

async function scanCommand(args: readonly string[], deps: Deps): Promise<number> {
  let options: ScanArgs;
  let token: string;
  try {
    options = parseScanArgs(args);
    const fromEnv = deps.env.GITHUB_TOKEN;
    if (fromEnv === undefined || fromEnv === "") throw new UsageError("GITHUB_TOKEN is not set");
    token = fromEnv;
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`flakeslash: ${error.message}. Try --help.\n`);
    return 2;
  }

  const scans: RepoScan[] = [];
  let code = 0;
  try {
    const store = openSqliteStore(options.store);
    try {
      for (const repo of options.repos) {
        scans.push(await scanRepo({ repo, since: options.since, fetch: deps.fetch, token, store }));
      }
    } finally {
      store.close();
    }
  } catch (error) {
    const missing = error instanceof GitHubApiError && error.httpStatus === 404;
    const message = error instanceof Error ? error.message : String(error);
    if (missing) {
      const repo = options.repos[scans.length];
      process.stderr.write(
        `flakeslash: repo ${repo} was not found, or the token cannot see it (${message})\n`,
      );
      code = 2;
    } else {
      process.stderr.write(`flakeslash: ${message}\n`);
      code = 1;
    }
  }
  // Repos finished before an error are still reported.
  report(scans, options.json);
  return code;
}

/** Runs the CLI for `args` and returns the exit code: 0 ok, 1 the run failed, 2 a usage error. */
export async function run(
  args: readonly string[],
  deps: Deps = { fetch: globalThis.fetch, env: process.env },
): Promise<number> {
  const [first, ...rest] = args;
  if (first === "--version" || first === "-v") {
    process.stdout.write(`flakeslash ${pkg.version} (${describeEngine()})\n`);
    return 0;
  }
  if (first === undefined || first === "--help" || first === "-h") {
    process.stdout.write(HELP);
    return 0;
  }
  if (first === "scan") return scanCommand(rest, deps);
  process.stderr.write(`flakeslash: unknown argument "${first}". Try --help.\n`);
  return 2;
}
