import {
  createModelClient,
  describeEngine,
  explainIssues,
  GitHubApiError,
  scanRepo,
  type RankedIssue,
  type RepoScan,
} from "@hackcove/flakeslash-engine";
import pkg from "../package.json" with { type: "json" };
import { catalogueJson, catalogueOf, writeReportFile } from "./catalogue-output.ts";
import type { ReportInput } from "./report-html.ts";
import { summarizeExplanations, type Explanations } from "./explanations.ts";
import { suspectLines } from "./suspect-lines.ts";
import { ISSUE_HELP, ISSUE_USAGE, issueCommand } from "./issue.ts";
import { nameScans, testText } from "./flake-tests.ts";
import { parseScanArgs, type Deps, type ScanArgs } from "./scan-args.ts";
import { openSqliteStore } from "./store.ts";
import { UsageError } from "./usage-error.ts";

const HELP = `flakeslash: flaky-test detection from the terminal.

Usage:
  flakeslash scan <owner/repo>... [--since <date>] [--store <path>] [--json]
                         list the jobs that both failed and passed on one commit
                         [--model-url <url> --model <name> --cap-usd <n> --price-in <n> --price-out <n>]
${ISSUE_USAGE}  flakeslash --version   print the version
  flakeslash --help      print this help

scan reads each repo's GitHub Actions history (no pipeline change) and keeps it in a local SQLite
store, so a second scan fetches only what is new. For each failed job it also reads the log once,
cuts it down to the lines around the failure, removes secrets, and keeps that excerpt with a link to
the full log. The whole log is never stored. Each failure is then grouped into an issue (the same
crash with other ports or times is one issue; known crashes are named by kind), with no model.
The token comes from GITHUB_TOKEN. When every repo is scanned, scan also writes report.html next to the
store: the issues ranked by commits in the last 30 days, each with its flake rate, PRs and log excerpt.

scan explains the failures no known signature recognises, with your own OpenAI-compatible endpoint.
With no endpoint named, nothing is sent anywhere and the summary says explanations are off. Naming
one means you set the spending cap and both prices; nothing is assumed, and it can never spend past
the cap. One redacted excerpt is sent per unexplained issue (never the log), so a failure repeated
50 times costs one call. The model's answer is stored on the issue; the flake list never depends on it.

Options for scan:
  --since <date>   read runs created on or after this date (default: 90 days ago)
  --store <path>   the SQLite file (default: .flakeslash/flakeslash.db)
  --json           write { "repos", "explanations", "catalogue" } to stdout instead of the summary
  --model-url <url>   the endpoint's base URL, http or https (or FLAKESLASH_MODEL_URL)
  --model <name>      the model to ask for (needed with --model-url)
  --cap-usd <n>       the most to spend, in USD, above 0 (needed with --model-url)
  --price-in <n>      USD per million prompt tokens, 0 or more (needed with --model-url)
  --price-out <n>     USD per million completion tokens, 0 or more (needed with --model-url)

Environment for scan:
  FLAKESLASH_MODEL_URL      the same as --model-url (the flag wins)
  FLAKESLASH_MODEL_KEY      the endpoint's API key, sent as a bearer token (optional)
  FLAKESLASH_MODEL_HEADERS  extra request headers, one "Name: value" per line (optional)

${ISSUE_HELP}
Exit codes: 0 ok, 1 the run failed (an outage, a refused token), 2 a usage error.
`;

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
    for (const test of flake.tests) lines.push(`    test: ${testText(test)}`);
    for (const item of flake.evidence) lines.push(`    ${item.outcome.padEnd(6)} ${item.url}`);
  }
  lines.push(...suspectLines(scan.suspects));
  if (scan.cutShort) {
    lines.push(
      `  A rate limit stopped the read after ${scan.newJobs} new jobs (oldest read: ${scan.oldestRead ?? "none"}).`,
      "  Run the scan again to continue from there.",
    );
  }
  return `${lines.join("\n")}\n`;
}

/** What the report shows: the ranked issues (null when the scan stopped early) and the file it went to. */
interface Output {
  ranked: readonly RankedIssue[] | null;
  reportPath: string | null;
}

/** Writes the summary or the JSON. */
function report(
  scans: readonly RepoScan[],
  explanations: Explanations,
  json: boolean,
  output: Output,
): void {
  if (json) {
    const catalogue = output.ranked === null ? undefined : catalogueJson(output.ranked);
    process.stdout.write(
      `${JSON.stringify({ repos: scans, explanations: explanations.result, catalogue })}\n`,
    );
  } else {
    const line = output.reportPath === null ? "" : `  report: ${output.reportPath}\n`;
    process.stdout.write(
      `${scans.map(summarize).join("\n")}${summarizeExplanations(explanations)}${line}`,
    );
  }
}

/** The scan arguments and token, or null after a usage error was written. */
function readScanArgs(
  args: readonly string[],
  deps: Deps,
): { options: ScanArgs; token: string } | null {
  try {
    const options = parseScanArgs(args, deps.env);
    const token = deps.env.GITHUB_TOKEN;
    if (token === undefined || token === "") throw new UsageError("GITHUB_TOKEN is not set");
    return { options, token };
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`flakeslash: ${error.message}. Try --help.\n`);
    return null;
  }
}

/** Scans every repo, then (if a model is named) explains what is left, then ranks the issues. */
async function scanAll(
  { options, token }: { options: ScanArgs; token: string },
  deps: Deps,
  scans: RepoScan[],
  explanations: Explanations,
): Promise<ReportInput> {
  const store = openSqliteStore(options.store, { durable: deps.durable });
  try {
    for (const repo of options.repos) {
      scans.push(await scanRepo({ repo, since: options.since, fetch: deps.fetch, token, store }));
    }
    if (options.model !== undefined) {
      const client = createModelClient({
        ...options.model,
        fetch: deps.modelFetch ?? globalThis.fetch,
      });
      const explain = { store, client, model: options.model.model, repos: options.repos };
      const result = await explainIssues(explain);
      explanations.result = result;
      if (result.explained > 0) await nameScans(store, scans);
    }
    return await catalogueOf(store, options.repos, scans);
  } finally {
    store.close();
  }
}

/** Writes the failure and returns the exit code: 2 for a repo that cannot be seen, else 1. */
function failScan(error: unknown, options: ScanArgs, done: number): number {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof GitHubApiError && error.httpStatus === 404) {
    const repo = options.repos[done];
    process.stderr.write(
      `flakeslash: repo ${repo} was not found, or the token cannot see it (${message})\n`,
    );
    return 2;
  }
  process.stderr.write(`flakeslash: ${message}\n`);
  return 1;
}

async function scanCommand(args: readonly string[], deps: Deps): Promise<number> {
  const read = readScanArgs(args, deps);
  if (read === null) return 2;
  const { options } = read;

  const scans: RepoScan[] = [];
  const explanations: Explanations = {
    named: options.model !== undefined,
    result: null,
    capUsd: options.model?.capUsd ?? 0,
  };
  let code = 0;
  let catalogue: ReportInput | null = null;
  try {
    catalogue = await scanAll(read, deps, scans, explanations);
  } catch (error) {
    code = failScan(error, options, scans.length);
  }
  // The report file is written only when every repo was scanned. A failed write is exit 1.
  const output: Output = { ranked: catalogue?.ranked ?? null, reportPath: null };
  if (catalogue !== null) {
    try {
      output.reportPath = writeReportFile(catalogue, options.store);
    } catch (error) {
      process.stderr.write(
        `flakeslash: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      code = 1;
    }
  }
  // Repos finished before an error are still reported.
  report(scans, explanations, options.json, output);
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
  if (first === "issue") return issueCommand(rest, deps.durable);
  process.stderr.write(`flakeslash: unknown argument "${first}". Try --help.\n`);
  return 2;
}
