/**
 * Follow-on failures: a job that failed only because another job in its run had already failed, such as
 * a job that gathers the reports of the test jobs. It passes and fails with the jobs it follows, so it is
 * not a flake of its own. Pure: from the records and failures alone, no I/O, and the input is not changed.
 */
import type { Failure } from "./catalogue.ts";
import { followOnKey, outcomeOf } from "./flakes.ts";
import type { JobRecord } from "./providers/github-actions.ts";

/**
 * The share of a job's failed records that must look like follow-ons before any of them is taken as one.
 * A gather job (vitest's `Merge Reports`: 158 of 169) fails after a sibling nearly every time. A test job
 * that merely started late fails that way now and then (5 to 11 of 30 to 88), and those failures, often a
 * flaky install or build, are its own and must still count.
 */
const FOLLOW_ON_SHARE = 0.8;

/** Epoch milliseconds, or null when the time is missing or does not parse. */
function msOf(time: string | null): number | null {
  if (time === null) return null;
  const ms = Date.parse(time);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The failed jobs that followed another job's failure, by `followOnKey`. A failed job looks like a
 * follow-on when none of its failures names a test, and another job in the same repo, run and attempt
 * failed and had finished by the time this one started. Both parts are needed: a job that names a test
 * failed on its own, and a lint or build job that names no test is not a follow-on unless a sibling failed
 * first. It is a follow-on only when its job (repo, workflow and name) looks like one in at least
 * `FOLLOW_ON_SHARE` of that job's failed records.
 */
export function followOnJobs(records: JobRecord[], failures: Failure[]): Set<string> {
  const titled = new Set(
    failures
      .filter((failure) => failure.title !== null)
      .map((failure) => followOnKey(failure.repo, failure.jobId)),
  );
  const looks: FailedJob[] = [];
  const failed = new Map<string, number>();
  for (const run of failedByRun(records)) {
    for (const job of run) {
      failed.set(job.name, (failed.get(job.name) ?? 0) + 1);
      if (!titled.has(job.key) && followsAFailure(job, run)) looks.push(job);
    }
  }
  const looked = new Map<string, number>();
  for (const job of looks) looked.set(job.name, (looked.get(job.name) ?? 0) + 1);
  return new Set(
    looks
      .filter((job) => (looked.get(job.name) ?? 0) >= FOLLOW_ON_SHARE * (failed.get(job.name) ?? 0))
      .map((job) => job.key),
  );
}

/** A failed job with its start and end times. */
interface FailedJob {
  key: string;
  /** The job across runs: its repo (lower case), workflow and name. */
  name: string;
  startMs: number | null;
  endMs: number | null;
}

/** The failed jobs of each run attempt. */
function failedByRun(records: JobRecord[]): FailedJob[][] {
  const runs = new Map<string, FailedJob[]>();
  for (const record of records) {
    if (outcomeOf(record) !== "failed") continue;
    const run = JSON.stringify([record.repo.toLowerCase(), record.runId, record.runAttempt]);
    const failed = runs.get(run) ?? [];
    failed.push({
      key: followOnKey(record.repo, record.jobId),
      name: JSON.stringify([record.repo.toLowerCase(), record.workflow, record.jobName]),
      startMs: msOf(record.startedAt),
      endMs: msOf(record.completedAt),
    });
    runs.set(run, failed);
  }
  return [...runs.values()];
}

/** Whether another of the run's failed jobs had finished by the time `job` started. */
function followsAFailure(job: FailedJob, failed: FailedJob[]): boolean {
  const { startMs } = job;
  if (startMs === null) return false;
  return failed.some(
    (other) => other.key !== job.key && other.endMs !== null && other.endMs <= startMs,
  );
}
