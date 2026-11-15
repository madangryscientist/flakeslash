/**
 * Follow-on failures: a job that failed only because another job in its run had already failed, such as
 * a job that gathers the reports of the test jobs. It passes and fails with the jobs it follows, so it is
 * not a flake of its own. Pure: from the records and failures alone, no I/O, and the input is not changed.
 */
import type { Failure } from "./catalogue.ts";
import { followOnKey, outcomeOf } from "./flakes.ts";
import type { JobRecord } from "./providers/github-actions.ts";

/** Epoch milliseconds, or null when the time is missing or does not parse. */
function msOf(time: string | null): number | null {
  if (time === null) return null;
  const ms = Date.parse(time);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The failed jobs that followed another job's failure, by `followOnKey`. A failed job is a follow-on when
 * none of its failures names a test, and another job in the same repo, run and attempt failed and had
 * finished by the time this one started. Both parts are needed: a job that names a test failed on its
 * own, and a lint or build job that names no test is not a follow-on unless a sibling failed first.
 */
export function followOnJobs(records: JobRecord[], failures: Failure[]): Set<string> {
  const titled = new Set(
    failures
      .filter((failure) => failure.title !== null)
      .map((failure) => followOnKey(failure.repo, failure.jobId)),
  );
  const followOn = new Set<string>();
  for (const failed of failedByRun(records)) {
    for (const job of failed) {
      if (!titled.has(job.key) && followsAFailure(job, failed)) followOn.add(job.key);
    }
  }
  return followOn;
}

/** A failed job with its start and end times. */
interface FailedJob {
  key: string;
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
