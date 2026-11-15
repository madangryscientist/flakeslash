/**
 * The catalogue's ranking for a page: the CLI's `flakeRanking(rankIssues(...))` over stored rows, with no
 * scan behind it. Flakes, follow-ons and suspects come from the engine over the same rows; a suspect's
 * compare is looked up in the stored compares only, so ranking never calls GitHub. Pure: the caller
 * gives `now`.
 */
import {
  findJobFlakes,
  findSuspects,
  flakeRanking,
  followOnJobs,
  rankIssues,
  type CompareResult,
  type Failure,
  type Issue,
  type JobRecord,
  type RankInput,
  type RankedIssue,
} from "@hackcove/flakeslash-engine";

/** A stored compare: GitHub's answer for the commits `base` to `head` of `repo`. */
export interface StoredCompare {
  repo: string;
  base: string;
  head: string;
  result: CompareResult;
}

export interface RankRows {
  issues: Issue[];
  failures: Failure[];
  jobs: JobRecord[];
  compares: StoredCompare[];
}

export type RankedEntry = RankedIssue & {
  /** The distinct repos of the entry's counted failures in the window, sorted. */
  repos: string[];
};

export interface Ranking {
  ranked: RankedEntry[];
  unranked: number;
  /** Dismissed issues with a counted failure in the window, in the order the rows give them. */
  dismissed: Issue[];
}

const pairKey = (repo: string, base: string, head: string) => JSON.stringify([repo, base, head]);

/**
 * The ids of `issues` with a failure that counts in the window, by `rankIssues`'s own rule (a failed job
 * in the window that is not a follow-on), whatever their status: each issue is ranked as if it were open.
 */
function countedIds(input: RankInput, issues: Issue[], records: JobRecord[]): Set<string> {
  const open: Issue[] = issues.map((issue) => ({ ...issue, status: "potential" }));
  return new Set(rankIssues({ ...input, issues: open, records }).map((entry) => entry.issue.id));
}

/** Each issue's repos with a counted failure, asking `rankIssues` one repo at a time. */
function reposByIssue(input: RankInput, issues: Issue[]): Map<string, string[]> {
  const byIssue = new Map<string, string[]>();
  const repos = [...new Set(input.records.map((record) => record.repo))].toSorted();
  for (const repo of repos) {
    const records = input.records.filter((record) => record.repo === repo);
    for (const id of countedIds(input, issues, records)) {
      byIssue.set(id, [...(byIssue.get(id) ?? []), repo]);
    }
  }
  return byIssue;
}

export async function rankCatalogue(rows: RankRows, now: string): Promise<Ranking> {
  const stored = new Map(rows.compares.map((c) => [pairKey(c.repo, c.base, c.head), c.result]));
  const followOn = followOnJobs(rows.jobs, rows.failures);
  const suspects = await findSuspects(
    rows.jobs,
    rows.failures,
    // A pair the store does not hold reads as a rate limit: no answer, so no suspect.
    async (repo, base, head) => stored.get(pairKey(repo, base, head)) ?? { status: "rate-limited" },
  );
  const input: RankInput = {
    records: rows.jobs,
    failures: rows.failures,
    issues: rows.issues,
    flakes: findJobFlakes(rows.jobs, followOn),
    suspects,
    now,
    followOn,
  };
  const { ranked, unranked } = flakeRanking(rankIssues(input));
  const repos = reposByIssue(
    input,
    ranked.map((entry) => entry.issue),
  );
  const dismissedRows = rows.issues.filter((issue) => issue.status === "dismissed");
  const counted = countedIds(input, dismissedRows, rows.jobs);
  return {
    ranked: ranked.map((entry) => ({ ...entry, repos: repos.get(entry.issue.id) ?? [] })),
    unranked,
    dismissed: dismissedRows.filter((issue) => counted.has(issue.id)),
  };
}
