/**
 * The job-level flake rule: from pass and fail records alone, which jobs both failed and passed on one
 * commit. A flake is one job (repo, workflow and job name) on one commit. Its records are read from any
 * number of runs and attempts. Nothing here does I/O, reads the clock, or changes its input.
 */
import type { JobRecord } from "./providers/github-actions.ts";

/** One record that counts as a failure or a pass for a flaky job. */
export interface FlakeEvidence {
  outcome: "failed" | "passed";
  url: string;
  runId: number;
  runAttempt: number;
  conclusion: string;
}

/** A job that both failed and passed on one commit. */
export interface JobFlake {
  repo: string;
  workflow: string;
  jobName: string;
  commit: string;
  /** Every record of this job on this commit that counts as a failure or a pass, by run then attempt. */
  evidence: FlakeEvidence[];
}

/**
 * A `cancelled` job is a failure only when GitHub's annotation says the runner was lost or the job ran
 * out of time. A person's cancel, a concurrency cancel and an unrelated notice carry other words.
 */
const CANCELLED_FAILURE_MESSAGES = [
  "lost communication",
  "shutdown signal",
  "exceeded the maximum execution time",
];

/**
 * Whether a record counts as a failure, a pass, or neither. The one rule for what failed: the flake
 * rule uses it, and so does the log reader.
 */
export function outcomeOf(record: JobRecord): FlakeEvidence["outcome"] | null {
  if (record.conclusion === "success") return "passed";
  if (record.conclusion === "failure" || record.conclusion === "timed_out") return "failed";
  if (record.conclusion === "cancelled") {
    const lost = record.annotations.some((annotation) => {
      const message = annotation.message.toLowerCase();
      return CANCELLED_FAILURE_MESSAGES.some((phrase) => message.includes(phrase));
    });
    return lost ? "failed" : null;
  }
  return null;
}

function keyOf(record: JobRecord): string {
  return JSON.stringify([record.repo, record.workflow, record.jobName, record.commit]);
}

/** Every job that both failed and passed on one commit, in the order each first appears in the input. */
export function findJobFlakes(records: JobRecord[]): JobFlake[] {
  // A job's place is its first record of any kind, so the order follows the input, not the evidence.
  const jobs = new Map<string, JobFlake>();

  for (const record of records) {
    const key = keyOf(record);
    let job = jobs.get(key);
    if (!job) {
      job = {
        repo: record.repo,
        workflow: record.workflow,
        jobName: record.jobName,
        commit: record.commit,
        evidence: [],
      };
      jobs.set(key, job);
    }
    const outcome = outcomeOf(record);
    if (outcome === null) continue;
    job.evidence.push({
      outcome,
      url: record.url,
      runId: record.runId,
      runAttempt: record.runAttempt,
      conclusion: record.conclusion ?? "",
    });
  }

  return [...jobs.values()]
    .filter(
      (job) =>
        job.evidence.some((item) => item.outcome === "failed") &&
        job.evidence.some((item) => item.outcome === "passed"),
    )
    .map((job) => ({
      ...job,
      evidence: job.evidence.toSorted((a, b) => a.runId - b.runId || a.runAttempt - b.runAttempt),
    }));
}
