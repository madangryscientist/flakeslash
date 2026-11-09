/**
 * The scan pipeline: read a repo's Actions history into the store, then decide its flakes from
 * everything the store holds. It joins the reader, the `Store` and the flake rule and does no I/O of its
 * own: the fetch and the store come in as arguments.
 */
import { findJobFlakes, type JobFlake } from "./flakes.ts";
import { readGitHubActions, type FetchLike } from "./providers/github-actions.ts";
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
  /** Every flake among the jobs the store holds for the repo. */
  flakes: JobFlake[];
}

/**
 * Scan one repo. Attempts the store already holds are not fetched again, and each run's records are
 * stored as soon as the run is read, so a failure partway through loses only the run it was in.
 * A held attempt keeps the pull request number it was read with.
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
  return {
    repo,
    cutShort,
    newJobs: records.length,
    oldestRead,
    flakes: findJobFlakes(await store.readJobs(repo)),
  };
}
