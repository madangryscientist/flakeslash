/**
 * The kept rows, computed from the detailed rows before they expire: a flake record for each proven job
 * flake, and a repo's daily totals. Pure: the caller reads the rows and writes what comes back.
 */
import {
  outcomeOf,
  secondsOf,
  type Failure,
  type FlakeEvidence,
  type JobFlake,
  type JobRecord,
} from "@hackcove/flakeslash-engine";
import type { dailyTotals, flakeRecords } from "#/db/schema.ts";
import { WINDOW_DAYS } from "#/scan/hourly.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** One organisation's real rows, as the expiry reads them. */
export interface Held {
  orgId: number;
  jobs: JobRecord[];
  failures: Failure[];
  /** Every run attempt. */
  runs: { repo: string; runId: number; runAttempt: number; createdAt: string }[];
  /** Each run attempt's `created_at`, by `runKey`. */
  createdAt: Map<string, string>;
}

export type FlakeRecordRow = typeof flakeRecords.$inferInsert;
type DailyTotalRow = typeof dailyTotals.$inferInsert;

export const runKey = (repo: string, runId: number, runAttempt: number) =>
  JSON.stringify([repo, runId, runAttempt]);

export const dayKey = (repo: string, day: string) => JSON.stringify([repo, day]);

export const flakeKey = (
  row: Pick<FlakeRecordRow, "repo" | "workflow" | "jobName" | "commitSha">,
) => JSON.stringify([row.repo, row.workflow, row.jobName, row.commitSha]);

/**
 * The cutoff day, `YYYY-MM-DD`: UTC midnight `WINDOW_DAYS` (the scan's window) days before `now`'s day. A run expires when its
 * `created_at` (GitHub's UTC ISO 8601) sorts before it, which is a text comparison in SQL and here alike.
 */
export function cutoffOf(now: string): string {
  const midnight = new Date(now);
  midnight.setUTCHours(0, 0, 0, 0);
  return new Date(midnight.getTime() - WINDOW_DAYS * DAY_MS).toISOString().slice(0, 10);
}

/** The UTC day of an ISO 8601 time in UTC. */
export const dayOf = (createdAt: string) => createdAt.slice(0, 10);

/** The `runKey`s of the runs created before `cutoff`. */
export function expiringRuns(held: Held, cutoff: string): Set<string> {
  return new Set([...held.createdAt].filter(([, at]) => at < cutoff).map(([key]) => key));
}

const jobKey = (repo: string, url: string, runId: number, runAttempt: number) =>
  JSON.stringify([repo, url, runId, runAttempt]);

/** Earliest first: by the run's `created_at`, then run id, then attempt. A run with no attempt row sorts last. */
function byRun(held: Held, repo: string): (a: FlakeEvidence, b: FlakeEvidence) => number {
  const at = (e: FlakeEvidence) => held.createdAt.get(runKey(repo, e.runId, e.runAttempt)) ?? "~";
  return (a, b) => {
    if (at(a) !== at(b)) return at(a) < at(b) ? -1 : 1;
    return a.runId - b.runId || a.runAttempt - b.runAttempt;
  };
}

/** The sorted issue ids of the failures of `failed`'s jobs. */
function issueIdsOf(failed: JobRecord[], failures: Failure[]): string[] {
  const jobIds = new Set(failed.map((job) => JSON.stringify([job.repo, job.jobId])));
  const ids = failures
    .filter((failure) => jobIds.has(JSON.stringify([failure.repo, failure.jobId])))
    .map((failure) => failure.issueId);
  return [...new Set(ids)].toSorted();
}

function recordOf(
  held: Held,
  flake: JobFlake,
  jobs: Map<string, JobRecord>,
): FlakeRecordRow | null {
  const sorted = flake.evidence.toSorted(byRun(held, flake.repo));
  const jobOf = (e: FlakeEvidence) => jobs.get(jobKey(flake.repo, e.url, e.runId, e.runAttempt));
  const failed = sorted.filter((e) => e.outcome === "failed");
  const passed = sorted.find((e) => e.outcome === "passed");
  const first = failed[0] === undefined ? undefined : jobOf(failed[0]);
  if (first === undefined || passed === undefined) return null;
  const failedJobs = failed.map(jobOf).filter((job) => job !== undefined);
  return {
    orgId: held.orgId,
    repo: flake.repo,
    workflow: flake.workflow,
    jobName: flake.jobName,
    commitSha: flake.commit,
    day: dayOf(held.createdAt.get(runKey(flake.repo, first.runId, first.runAttempt)) ?? ""),
    failedUrl: first.url,
    passedUrl: passed.url,
    issueIds: JSON.stringify(issueIdsOf(failedJobs, held.failures)),
    provider: first.provider,
    runner: first.runner,
  };
}

/**
 * A record for each flake with evidence in an expiring run, leaving out the flakes in `recorded` (by
 * `flakeKey`).
 */
export function flakeRecordRows(
  held: Held,
  flakes: JobFlake[],
  expiring: Set<string>,
  recorded: Set<string>,
): FlakeRecordRow[] {
  const jobs = new Map(
    held.jobs.map((job) => [jobKey(job.repo, job.url, job.runId, job.runAttempt), job]),
  );
  const rows: FlakeRecordRow[] = [];
  for (const flake of flakes) {
    if (!flake.evidence.some((e) => expiring.has(runKey(flake.repo, e.runId, e.runAttempt)))) {
      continue;
    }
    const row = recordOf(held, flake, jobs);
    if (row !== null && !recorded.has(flakeKey(row))) rows.push(row);
  }
  return rows;
}

const groupKey = (repo: string, day: string, provider: string, runner: string) =>
  JSON.stringify([repo, day, provider, runner]);

function emptyTotal(orgId: number, key: [string, string, string, string]): DailyTotalRow {
  const [repo, day, provider, runner] = key;
  return {
    orgId,
    repo,
    day,
    provider,
    runner,
    jobs: 0,
    firstAttemptJobs: 0,
    firstAttemptPassed: 0,
    failedJobs: 0,
    flakes: 0,
    seconds: 0,
  };
}

function addJob(total: DailyTotalRow, job: JobRecord): void {
  const outcome = outcomeOf(job);
  total.jobs += 1;
  if (job.runAttempt === 1) {
    total.firstAttemptJobs += 1;
    if (outcome === "passed") total.firstAttemptPassed += 1;
  }
  if (outcome === "failed") total.failedJobs += 1;
  total.seconds += Math.floor(secondsOf(job));
}

/**
 * The totals of `day` in `repo`, one row per provider and runner, from the jobs of that day's runs, with
 * `flakes` counted from `records` (the organisation's flake records).
 */
export function dailyTotalRows(
  held: Held,
  repo: string,
  day: string,
  records: FlakeRecordRow[],
): DailyTotalRow[] {
  const totals = new Map<string, DailyTotalRow>();
  const totalOf = (provider: string, runner: string) => {
    const key = groupKey(repo, day, provider, runner);
    const total = totals.get(key) ?? emptyTotal(held.orgId, [repo, day, provider, runner]);
    totals.set(key, total);
    return total;
  };
  for (const job of held.jobs) {
    const at = held.createdAt.get(runKey(job.repo, job.runId, job.runAttempt));
    if (job.repo === repo && at !== undefined && dayOf(at) === day) {
      addJob(totalOf(job.provider, job.runner), job);
    }
  }
  for (const record of records) {
    if (record.repo !== repo || record.day !== day) continue;
    const total = totalOf(record.provider, record.runner);
    total.flakes += 1;
  }
  return [...totals.values()];
}
