/**
 * The scan pipeline: read a repo's Actions history into the store, then decide its flakes from
 * everything the store holds. It joins the reader, the `Store` and the flake rule and does no I/O of its
 * own: the fetch and the store come in as arguments.
 */
import { failureFrom, matchText, place, type Failure, type Issue } from "./catalogue.ts";
import { cleanLog, cutLog } from "./excerpt.ts";
import { findJobFlakes, outcomeOf, type JobFlake } from "./flakes.ts";
import {
  readGitHubActions,
  readJobLog,
  type FetchLike,
  type JobRecord,
} from "./providers/github-actions.ts";
import { redact } from "./redact.ts";
import { signatures } from "./signature.ts";
import type { Store } from "./store.ts";

interface ScanRepoOptions {
  /** `owner/name`, in any case: GitHub repo names are case-insensitive. */
  repo: string;
  /** An ISO date. Limits reading only; flakes cover every row the store holds. */
  since: string;
  fetch: FetchLike;
  token?: string;
  store: Store;
}

export interface RepoScan {
  /** The repo as the store knows it (lower case). */
  repo: string;
  /** True when a rate limit ended the read. The next scan continues from there. */
  cutShort: boolean;
  /** Job records read and stored by this scan. */
  newJobs: number;
  /** The earliest `startedAt` among the records read by this scan, or null when there were none. */
  oldestRead: string | null;
  /** Excerpts written by this scan from a log that was read. */
  logsKept: number;
  /** Excerpts written by this scan for a log the provider no longer serves. */
  logsGone: number;
  /** Failed jobs still without an excerpt when the scan ends: GitHub said try later, or the read was cut short. */
  logsLeft: number;
  /** Failures written by this scan, one per signature entry of each failed job it grouped. */
  newFailures: number;
  /** Distinct issues that got a new failure in this scan. */
  issuesTouched: number;
  /** Every flake among the jobs the store holds for the repo. */
  flakes: JobFlake[];
}

/**
 * Reads the log of every failed job that has no excerpt yet, newest run first, and stores its excerpt.
 * The order is clean, redact the whole log, then cut, so a colour code cannot split a secret and a cut
 * cannot leave half of one behind. Each excerpt is written as soon as it is made. The first "try later"
 * ends the reading, and nothing is stored for that job or the ones after it.
 */
async function readLogs(
  options: ScanRepoOptions,
  repo: string,
  jobs: JobRecord[],
  cutShort: boolean,
): Promise<{ kept: number; gone: number; left: number }> {
  const { store } = options;
  const have = new Set(await store.excerptJobIds(repo));
  const todo = jobs
    .filter((job) => outcomeOf(job) === "failed" && !have.has(job.jobId))
    .toSorted((a, b) => b.runId - a.runId || b.runAttempt - a.runAttempt || b.jobId - a.jobId);
  let kept = 0;
  let gone = 0;
  if (cutShort) return { kept, gone, left: todo.length };
  for (const job of todo) {
    const log = await readJobLog({
      job,
      fetch: options.fetch,
      ...(options.token === undefined ? {} : { token: options.token }),
    });
    if (log.status === "try-later") break;
    const row = { repo, jobId: job.jobId, url: job.url };
    if (log.status === "ok") {
      await store.writeExcerpt({
        ...row,
        status: "kept",
        excerpt: cutLog(redact(cleanLog(log.text))),
      });
      kept += 1;
    } else {
      await store.writeExcerpt({ ...row, status: "gone", excerpt: null });
      gone += 1;
    }
  }
  return { kept, gone, left: todo.length - kept - gone };
}

/**
 * Makes the failures of every failed job that has an excerpt row and no failure yet, and groups each
 * into an issue (see `place`). A job with no excerpt row waits for the scan that reads its log. A new
 * issue is written before the failures that name it, and a job's failures are written together.
 */
async function groupFailures(
  store: Store,
  repo: string,
  jobs: JobRecord[],
  issues: Map<string, Issue>,
): Promise<{ failures: number; touched: number }> {
  const done = new Set(await store.failureJobIds(repo));
  const excerpts = new Map((await store.readExcerpts(repo)).map((row) => [row.jobId, row]));
  const touched = new Set<string>();
  let failures = 0;
  for (const job of jobs) {
    const row = excerpts.get(job.jobId);
    if (outcomeOf(job) !== "failed" || row === undefined || done.has(job.jobId)) continue;
    const excerpt = row.excerpt ?? "";
    const made: Failure[] = [];
    for (const entry of signatures(excerpt, job)) {
      const { issue, created } = place(entry, matchText(entry, excerpt, job), job, issues);
      if (created) await store.writeIssue(issue);
      made.push(failureFrom(entry, job, issue.id));
    }
    await store.writeFailures(made);
    failures += made.length;
    for (const failure of made) touched.add(failure.issueId);
  }
  return { failures, touched: touched.size };
}

/**
 * Marks `confirmed` every issue that has a failure in a proven flake: a failed job whose job and
 * commit also passed. Only ever `potential` to `confirmed`; nothing here moves an issue back.
 */
async function confirmIssues(
  store: Store,
  flakes: JobFlake[],
  issues: Map<string, Issue>,
): Promise<void> {
  const proven = new Set(
    flakes.flatMap((flake) =>
      flake.evidence.filter((item) => item.outcome === "failed").map((item) => item.url),
    ),
  );
  if (proven.size === 0) return;
  for (const failure of await store.readFailures()) {
    const issue = issues.get(failure.issueId);
    if (!proven.has(failure.url) || issue === undefined || issue.status === "confirmed") continue;
    issue.status = "confirmed";
    await store.writeIssue(issue);
  }
}

/**
 * Scan one repo. Attempts the store already holds are not fetched again, and each run's records are
 * stored as soon as the run is read, so a failure partway through loses only the run it was in.
 * A held attempt keeps the pull request number it was read with. Then the log of each failed job
 * without an excerpt is read and cut down to one (see `readLogs`). Each failed job with an excerpt then
 * becomes failures grouped into issues (see `groupFailures`), and the issues with a proven flake are
 * confirmed.
 */
export async function scanRepo(options: ScanRepoOptions): Promise<RepoScan> {
  const { store } = options;
  const repo = options.repo.toLowerCase();
  const { records, cutShort } = await readGitHubActions({
    repo,
    since: options.since,
    fetch: options.fetch,
    ...(options.token === undefined ? {} : { token: options.token }),
    held: await store.heldAttempts(repo),
    onRecords: (read) => store.writeJobs(read),
  });
  let oldestRead: string | null = null;
  for (const { startedAt } of records) {
    if (
      startedAt !== null &&
      (oldestRead === null || Date.parse(startedAt) < Date.parse(oldestRead))
    ) {
      oldestRead = startedAt;
    }
  }
  const jobs = await store.readJobs(repo);
  const logs = await readLogs(options, repo, jobs, cutShort);
  const issues = new Map((await store.readIssues()).map((issue) => [issue.id, issue]));
  const grouped = await groupFailures(store, repo, jobs, issues);
  const flakes = findJobFlakes(jobs);
  await confirmIssues(store, flakes, issues);
  return {
    repo,
    cutShort,
    newJobs: records.length,
    oldestRead,
    logsKept: logs.kept,
    logsGone: logs.gone,
    logsLeft: logs.left,
    newFailures: grouped.failures,
    issuesTouched: grouped.touched,
    flakes,
  };
}
