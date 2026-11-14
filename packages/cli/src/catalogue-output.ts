/**
 * What a scan makes of the store after it has read: the ranked issues of the repos it scanned, as the
 * `--json` catalogue and as `report.html` next to the store.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  rankIssues,
  type JobExcerpt,
  type RankedIssue,
  type RepoScan,
  type Store,
} from "@hackcove/flakeslash-engine";
import { minutesOf, reportHtml, type ReportInput } from "./report-html.ts";
import { DEFAULT_STORE_PATH } from "./store.ts";

/** The ranked issues of the repos scanned, read from the store as it stands after the scan. */
export async function catalogueOf(
  store: Store,
  repos: string[],
  scans: RepoScan[],
): Promise<ReportInput> {
  const now = new Date().toISOString();
  // The store keys repos by their lowercase name, as the scan wrote them.
  const stored = repos.map((repo) => repo.toLowerCase());
  const records = (await Promise.all(stored.map((repo) => store.readJobs(repo)))).flat();
  const excerpts = new Map<string, JobExcerpt>();
  for (const repo of stored) {
    for (const row of await store.readExcerpts(repo)) excerpts.set(row.url, row);
  }
  const ranked = rankIssues({
    records,
    failures: await store.readFailures(),
    issues: await store.readIssues(),
    flakes: scans.flatMap((scan) => scan.flakes),
    suspects: scans.flatMap((scan) => scan.suspects),
    now,
  });
  const coverage = scans.map((scan) => ({ repo: scan.repo, coverage: scan.coverage }));
  return { ranked, excerpts, repos, coverage, now };
}

/** The catalogue's JSON: each ranked issue, in rank order. */
export function catalogueJson(ranked: readonly RankedIssue[]) {
  return ranked.map((entry) => ({
    rank: entry.rank,
    id: entry.issue.id,
    name: entry.issue.name,
    kind: entry.issue.kind,
    status: entry.issue.status,
    rate: entry.rate,
    commits: entry.commits,
    flakyCommits: entry.flakyCommits,
    ranCommits: entry.ranCommits,
    minutesLost: minutesOf(entry.secondsLost),
    prs: entry.prs,
    suspect: entry.suspect,
  }));
}

/**
 * Writes `report.html` in the store's folder and returns its path. A failed write throws, with the path
 * in its message.
 */
export function writeReportFile(catalogue: ReportInput, storePath: string | undefined): string {
  const path = join(dirname(storePath ?? DEFAULT_STORE_PATH), "report.html");
  try {
    writeFileSync(path, reportHtml(catalogue));
  } catch (error) {
    throw new Error(
      `could not write ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  return path;
}
