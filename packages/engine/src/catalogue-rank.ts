/**
 * The local report's ranking: the issues that cost the most in the window, each with its flake rate, the
 * commits and PRs it hit, and whether a suspect points at it. Pure: no clock (the caller gives `now`), no
 * I/O, and the input is not changed. The window and the flake rule are the ones `rate.ts` uses.
 */
import type { Failure, Issue } from "./catalogue.ts";
import { outcomeOf, type JobFlake } from "./flakes.ts";
import type { JobRecord } from "./providers/github-actions.ts";
import { inWindow, windowOf } from "./rate.ts";
import type { Suspect } from "./suspects.ts";

export interface RankedIssue {
  /** 1 first. */
  rank: number;
  issue: Issue;
  /** Distinct commits in the window with a failed job holding a failure of this issue. */
  commits: number;
  /** Seconds of the issue's failed jobs in the window: completedAt minus startedAt, summed; a job with no completedAt adds 0. */
  secondsLost: number;
  /** Distinct PRs of those failed jobs (a null `prNumber` is skipped), by repo then number. */
  prs: { repo: string; number: number }[];
  /** Flaky commits over commits that ran, for the jobs the issue's failures sit in; null at 0. */
  rate: number | null;
  flakyCommits: number;
  ranCommits: number;
  /** True when a suspect's failedUrl is the page of one of this issue's failures. */
  suspect: boolean;
  /** The page of the issue's latest failed job in the window (by startedAt): where its excerpt comes from. */
  latestUrl: string | null;
}

export interface RankInput {
  records: JobRecord[];
  failures: Failure[];
  issues: Issue[];
  flakes: JobFlake[];
  suspects: Suspect[];
  now: string;
}

/** What every issue's rank reads, built once per call. */
interface Context {
  /** Each job key's commits (`commitKey`) that ran it in the window. */
  ran: Map<string, Set<string>>;
  flakes: JobFlake[];
  suspectUrls: Set<string>;
}

function commitKey(repo: string, commit: string): string {
  return JSON.stringify([repo, commit]);
}

function jobKeyOf(repo: string, workflow: string, jobName: string): string {
  return JSON.stringify([repo, workflow, jobName]);
}

function jobKeyOfRecord(record: JobRecord): string {
  return jobKeyOf(record.repo, record.workflow, record.jobName);
}

function compareText(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Seconds from the job's start to its end; 0 when either time is missing or does not parse. */
function secondsOf(record: JobRecord): number {
  if (record.startedAt === null || record.completedAt === null) return 0;
  const seconds = (Date.parse(record.completedAt) - Date.parse(record.startedAt)) / 1000;
  return Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
}

/** The job's start time as epoch milliseconds (a counted record always has one). */
function startedMs(record: JobRecord): number {
  return Date.parse(record.startedAt ?? "");
}

function addTo<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
  const set = map.get(key) ?? new Set<V>();
  set.add(value);
  map.set(key, set);
}

/** Orders issues: more commits first, then more seconds lost, then the issue id by code point. */
function compareRanked(a: RankedIssue, b: RankedIssue): number {
  if (a.commits !== b.commits) return b.commits - a.commits;
  if (a.secondsLost !== b.secondsLost) return b.secondsLost - a.secondsLost;
  if (a.issue.id === b.issue.id) return 0;
  return a.issue.id < b.issue.id ? -1 : 1;
}

/** Each job key's commits that ran it in the window. */
function ranByJob(records: JobRecord[], startMs: number, nowMs: number): Map<string, Set<string>> {
  const ran = new Map<string, Set<string>>();
  for (const record of records) {
    if (!inWindow(record, startMs, nowMs)) continue;
    addTo(ran, jobKeyOfRecord(record), commitKey(record.repo, record.commit));
  }
  return ran;
}

/**
 * The failures that count, by issue: each failure whose job is in the window and failed. Also every
 * failure's page by issue, counted or not, for the suspect link.
 */
function indexFailures(
  input: RankInput,
  startMs: number,
  nowMs: number,
): { counted: Map<string, JobRecord[]>; allUrls: Map<string, Set<string>> } {
  const recordByUrl = new Map(input.records.map((record) => [record.url, record]));
  const issueIds = new Set(input.issues.map((issue) => issue.id));
  const counted = new Map<string, JobRecord[]>();
  const allUrls = new Map<string, Set<string>>();
  for (const failure of input.failures) {
    if (!issueIds.has(failure.issueId)) continue;
    addTo(allUrls, failure.issueId, failure.url);
    const record = recordByUrl.get(failure.url);
    if (record === undefined || outcomeOf(record) !== "failed") continue;
    if (!inWindow(record, startMs, nowMs)) continue;
    counted.set(failure.issueId, [...(counted.get(failure.issueId) ?? []), record]);
  }
  return { counted, allUrls };
}

/** The commits that ran any of the jobs, each commit once. */
function ranOf(jobs: JobRecord[], ran: Map<string, Set<string>>): Set<string> {
  const commits = new Set<string>();
  for (const key of new Set(jobs.map(jobKeyOfRecord))) {
    for (const commit of ran.get(key) ?? []) commits.add(commit);
  }
  return commits;
}

/** The commits on which one of the jobs flaked with a failed page among the issue's own, and that ran. */
function flakyOf(jobs: JobRecord[], ranCommits: Set<string>, flakes: JobFlake[]): Set<string> {
  const jobKeys = new Set(jobs.map(jobKeyOfRecord));
  const urls = new Set(jobs.map((record) => record.url));
  const flaky = new Set<string>();
  for (const flake of flakes) {
    const key = commitKey(flake.repo, flake.commit);
    if (!jobKeys.has(jobKeyOf(flake.repo, flake.workflow, flake.jobName))) continue;
    if (!ranCommits.has(key)) continue;
    if (flake.evidence.some((e) => e.outcome === "failed" && urls.has(e.url))) flaky.add(key);
  }
  return flaky;
}

/** The distinct PRs of the jobs, by repo then number. */
function prsOf(jobs: JobRecord[]): { repo: string; number: number }[] {
  const prs = new Map<string, { repo: string; number: number }>();
  for (const record of jobs) {
    if (record.prNumber === null) continue;
    prs.set(JSON.stringify([record.repo, record.prNumber]), {
      repo: record.repo,
      number: record.prNumber,
    });
  }
  return [...prs.values()].toSorted((a, b) => compareText(a.repo, b.repo) || a.number - b.number);
}

/** The job that started last; ties go to the lower page. */
function latestOf(jobs: JobRecord[]): JobRecord | undefined {
  return jobs.toSorted((a, b) => startedMs(b) - startedMs(a) || compareText(a.url, b.url))[0];
}

/** One issue's ranked entry. `counted` is non-empty, so the issue has at least one commit. */
function rankOne(
  issue: Issue,
  counted: JobRecord[],
  allUrls: Set<string>,
  ctx: Context,
): RankedIssue {
  // One job can hold several failures of the issue: each job counts once, by its page.
  const jobs = [...new Map(counted.map((record) => [record.url, record])).values()];
  const ranCommits = ranOf(jobs, ctx.ran);
  const flakyCommits = flakyOf(jobs, ranCommits, ctx.flakes);
  return {
    rank: 0,
    issue,
    commits: new Set(jobs.map((record) => commitKey(record.repo, record.commit))).size,
    secondsLost: jobs.reduce((sum, record) => sum + secondsOf(record), 0),
    prs: prsOf(jobs),
    rate: ranCommits.size === 0 ? null : flakyCommits.size / ranCommits.size,
    flakyCommits: flakyCommits.size,
    ranCommits: ranCommits.size,
    suspect: [...allUrls].some((url) => ctx.suspectUrls.has(url)),
    latestUrl: latestOf(jobs)?.url ?? null,
  };
}

/**
 * The issues that count, ranked. An issue counts when it is not dismissed and one of its failures sits on
 * a failed job in the window. A failure whose job is not in `records` does not count.
 */
export function rankIssues(input: RankInput): RankedIssue[] {
  const { startMs, nowMs } = windowOf(input.now);
  const { counted, allUrls } = indexFailures(input, startMs, nowMs);
  const ctx: Context = {
    ran: ranByJob(input.records, startMs, nowMs),
    flakes: input.flakes,
    suspectUrls: new Set(input.suspects.map((suspect) => suspect.failedUrl)),
  };
  const ranked: RankedIssue[] = [];
  for (const issue of input.issues) {
    const jobs = counted.get(issue.id);
    if (jobs === undefined || issue.status === "dismissed") continue;
    ranked.push(rankOne(issue, jobs, allUrls.get(issue.id) ?? new Set(), ctx));
  }
  return ranked.toSorted(compareRanked).map((entry, index) => ({ ...entry, rank: index + 1 }));
}
