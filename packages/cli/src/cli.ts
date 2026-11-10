import {
  describeEngine,
  GitHubApiError,
  isRepoName,
  scanRepo,
  type FetchLike,
  type ModelClientOptions,
  type RepoScan,
} from "@hackcove/flakeslash-engine";
import pkg from "../package.json" with { type: "json" };
import { openSqliteStore } from "./store.ts";

const HELP = `flakeslash: flaky-test detection from the terminal.

Usage:
  flakeslash scan <owner/repo>... [--since <date>] [--store <path>] [--json]
                         list the jobs that both failed and passed on one commit
                         [--model-url <url> --model <name> --cap-usd <n> --price-in <n> --price-out <n>]
  flakeslash --version   print the version
  flakeslash --help      print this help

scan reads each repo's GitHub Actions history (no pipeline change) and keeps it in a local SQLite
store, so a second scan fetches only what is new. For each failed job it also reads the log once,
cuts it down to the lines around the failure, removes secrets, and keeps that excerpt with a link to
the full log. The whole log is never stored. Each failure is then grouped into an issue (the same
crash with other ports or times is one issue; known crashes are named by kind), with no model.
The token comes from GITHUB_TOKEN.

scan will use your own OpenAI-compatible endpoint where a model helps. Naming one means you set the
spending cap and both prices; nothing is assumed, and it can never spend past the cap. The scan
itself does not call a model yet; these options are checked and kept for the steps that will.

Options for scan:
  --since <date>   read runs created on or after this date (default: 90 days ago)
  --store <path>   the SQLite file (default: .flakeslash/flakeslash.db)
  --json           write { "repos": [...] } to stdout instead of the summary
  --model-url <url>   the endpoint's base URL, http or https (or FLAKESLASH_MODEL_URL)
  --model <name>      the model to ask for (needed with --model-url)
  --cap-usd <n>       the most to spend, in USD, above 0 (needed with --model-url)
  --price-in <n>      USD per million prompt tokens, 0 or more (needed with --model-url)
  --price-out <n>     USD per million completion tokens, 0 or more (needed with --model-url)

Environment for scan:
  FLAKESLASH_MODEL_URL      the same as --model-url (the flag wins)
  FLAKESLASH_MODEL_KEY      the endpoint's API key, sent as a bearer token (optional)
  FLAKESLASH_MODEL_HEADERS  extra request headers, one "Name: value" per line (optional)

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

/** The model endpoint a scan may call: everything `createModelClient` needs but the fetch. */
export type ModelConfig = Omit<ModelClientOptions, "fetch">;

export interface ScanArgs {
  repos: string[];
  since: string;
  store: string | undefined;
  json: boolean;
  /** Undefined when no endpoint is named. */
  model: ModelConfig | undefined;
}

/** The model flags that mean nothing without an endpoint, in the order they are checked. */
const MODEL_FLAGS: readonly string[] = ["--model", "--cap-usd", "--price-in", "--price-out"];
/** Every scan flag that takes a value. */
const VALUE_FLAGS: readonly string[] = ["--since", "--store", "--model-url", ...MODEL_FLAGS];

function sinceFrom(since: string | undefined): string {
  if (since === undefined) return new Date(Date.now() - DEFAULT_SINCE_DAYS * DAY_MS).toISOString();
  const ms = Date.parse(since);
  if (Number.isNaN(ms)) throw new UsageError(`--since "${since}" is not a date`);
  return new Date(ms).toISOString();
}

/** A number flag's value, which must be finite and pass `allowed` (described by `rule`). */
function numberFlag(
  values: ReadonlyMap<string, string>,
  flag: string,
  allowed: (n: number) => boolean,
  rule: string,
): number {
  const value = values.get(flag) ?? "";
  const number = value.trim() === "" ? Number.NaN : Number(value);
  if (!Number.isFinite(number)) throw new UsageError(`${flag} "${value}" is not a number`);
  if (!allowed(number)) throw new UsageError(`${flag} "${value}" must be ${rule}`);
  return number;
}

function urlFrom(value: string): string {
  let protocol: string;
  try {
    protocol = new URL(value).protocol;
  } catch {
    throw new UsageError("--model-url is not a URL");
  }
  if (protocol !== "http:" && protocol !== "https:") {
    throw new UsageError("--model-url must start with http:// or https://");
  }
  return value;
}

/** `Name: value` per line. A bad line is named by its number only: its text may hold a secret. */
function headersFrom(text: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  if (text === undefined) return headers;
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (line.trim() === "") continue;
    const colon = line.indexOf(":");
    const name = colon < 0 ? "" : line.slice(0, colon).trim();
    if (name === "") {
      throw new UsageError(`FLAKESLASH_MODEL_HEADERS line ${index + 1} is not "Name: value"`);
    }
    headers[name] = line.slice(colon + 1).trim();
  }
  return headers;
}

/** The endpoint named by the flag, else by FLAKESLASH_MODEL_URL; an empty value counts as unset. */
function endpointFrom(values: ReadonlyMap<string, string>, env: Deps["env"]): string | undefined {
  const named = values.get("--model-url") ?? env.FLAKESLASH_MODEL_URL;
  return named === undefined || named === "" ? undefined : named;
}

function modelFrom(values: ReadonlyMap<string, string>, env: Deps["env"]): ModelConfig | undefined {
  const url = endpointFrom(values, env);
  if (url === undefined) {
    const stray = MODEL_FLAGS.find((flag) => values.has(flag));
    if (stray !== undefined) throw new UsageError(`${stray} needs --model-url`);
    return undefined;
  }
  const baseUrl = urlFrom(url);
  for (const flag of MODEL_FLAGS) {
    if (!values.has(flag)) throw new UsageError(`${flag} is required with --model-url`);
  }
  return {
    url: baseUrl,
    key: env.FLAKESLASH_MODEL_KEY === "" ? undefined : env.FLAKESLASH_MODEL_KEY,
    model: values.get("--model") ?? "",
    capUsd: numberFlag(values, "--cap-usd", (n) => n > 0, "above 0"),
    priceIn: numberFlag(values, "--price-in", (n) => n >= 0, "0 or more"),
    priceOut: numberFlag(values, "--price-out", (n) => n >= 0, "0 or more"),
    headers: headersFrom(env.FLAKESLASH_MODEL_HEADERS),
    userAgent: `flakeslash/${pkg.version}`,
  };
}

/** Splits argv into repos, the flags that take a value, and --json. */
function readArgs(args: readonly string[]) {
  const repos: string[] = [];
  const values = new Map<string, string>();
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--json") json = true;
    else if (VALUE_FLAGS.includes(arg)) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new UsageError(`${arg} needs a value`);
      }
      values.set(arg, value);
      index += 1;
    } else if (arg.startsWith("-")) throw new UsageError(`unknown option "${arg}"`);
    else repos.push(arg);
  }
  return { repos, values, json };
}

export function parseScanArgs(args: readonly string[], env: Deps["env"] = {}): ScanArgs {
  const { repos, values, json } = readArgs(args);
  if (repos.length === 0) throw new UsageError("scan needs at least one repo, as owner/name");
  for (const repo of repos) {
    if (!isRepoName(repo)) throw new UsageError(`"${repo}" is not a repo; write it as owner/name`);
  }
  return {
    repos,
    since: sinceFrom(values.get("--since")),
    store: values.get("--store"),
    json,
    model: modelFrom(values, env),
  };
}

function summarize(scan: RepoScan): string {
  const lines = [scan.repo, `  new jobs: ${scan.newJobs}`];
  lines.push(`  logs kept: ${scan.logsKept}, expired: ${scan.logsGone}`);
  if (scan.logsLeft > 0) {
    lines.push(`  ${scan.logsLeft} logs left for the next scan (GitHub said try later)`);
  }
  lines.push(`  new failures: ${scan.newFailures} in ${scan.issuesTouched} issues`);
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
    options = parseScanArgs(args, deps.env);
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
