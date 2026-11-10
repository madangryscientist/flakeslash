/**
 * The scan pipeline: read a repo's Actions history into the store, then decide its flakes from
 * everything the store holds. It joins the reader, the `Store` and the flake rule and does no I/O of its
 * own: the fetch and the store come in as arguments.
 */
import { cleanLog, cutLog } from "./excerpt.ts";
import { findJobFlakes, outcomeOf, type JobFlake } from "./flakes.ts";
import {
  readGitHubActions,
  readJobLog,
  type FetchLike,
  type JobRecord,
} from "./providers/github-actions.ts";
import { redact } from "./redact.ts";
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
 * Scan one repo. Attempts the store already holds are not fetched again, and each run's records are
 * stored as soon as the run is read, so a failure partway through loses only the run it was in.
 * A held attempt keeps the pull request number it was read with. Then the log of each failed job
 * without an excerpt is read and cut down to one (see `readLogs`).
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
  return {
    repo,
    cutShort,
    newJobs: records.length,
    oldestRead,
    logsKept: logs.kept,
    logsGone: logs.gone,
    logsLeft: logs.left,
    flakes: findJobFlakes(jobs),
  };
}
