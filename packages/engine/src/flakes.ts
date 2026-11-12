/**
 * The flake rule: from pass and fail records alone, which jobs both failed and passed on one commit. A
 * job flake is one job (repo, workflow and job name) on one commit. Its records are read from any number
 * of runs and attempts. Then, from the failures and issues the store holds, each flake is given the tests
 * it can name. Nothing here does I/O, reads the clock, or changes its input.
 */
import type { Failure, Issue } from "./catalogue.ts";
import type { JobRecord } from "./providers/github-actions.ts";

/** One record that counts as a failure or a pass for a flaky job. */
export interface FlakeEvidence {
  outcome: "failed" | "passed";
  url: string;
  runId: number;
  runAttempt: number;
  conclusion: string;
}

/**
 * A test a flake names. `source` says where it came from: `log` for a location the runner printed, `junit`
 * for a JUnit report, and `model` for the component the model named. A `model` name is never a key for
 * counting; a `log` or `junit` name with its file is the test's key for rates (`rate.ts`).
 */
export interface FlakeTest {
  /** The test's title as the runner printed it, or the model's component. A label for people to read. */
  name: string;
  file: string | null;
  location: string | null;
  source: "log" | "junit" | "model";
}

/** A job that both failed and passed on one commit. */
export interface JobFlake {
  kind: "job";
  repo: string;
  workflow: string;
  jobName: string;
  commit: string;
  /** Every record of this job on this commit that counts as a failure or a pass, by run then attempt. */
  evidence: FlakeEvidence[];
  /**
   * Each test the failed attempts named, in the order the failures were given. Empty when none is known.
   * One flaky job can print several failing tests across its failed attempts.
   */
  tests: FlakeTest[];
}

/** Retry evidence inside one passing job (JUnit). Nothing makes one yet; the JUnit ticket does. */
export interface TestFlake {
  kind: "test";
  repo: string;
  workflow: string;
  jobName: string;
  commit: string;
  test: FlakeTest;
  evidence: FlakeEvidence[];
}

export type Flake = JobFlake | TestFlake;

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
        kind: "job",
        repo: record.repo,
        workflow: record.workflow,
        jobName: record.jobName,
        commit: record.commit,
        evidence: [],
        tests: [],
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

/**
 * The test one failure names, if any. A failure with a file is a test the runner printed; a failure with
 * no file takes the component its issue's explanation gives, and a failure with neither names nothing.
 */
function testOf(failure: Failure, issue: Issue | undefined): FlakeTest | null {
  // An empty string is no name. A bun failure after a log gap has a title and an empty file, and the
  // runner printed that title, so it is still a log test.
  const file = failure.file || null;
  const location = failure.location || null;
  const name = failure.title || location || file;
  if (name !== null) return { name, file, location, source: "log" };
  const component = issue?.explanation?.component ?? "";
  if (component.trim() === "") return null;
  return { name: component, file: null, location: null, source: "model" };
}

/**
 * Gives each job flake the tests its failed attempts name. A failure counts for a flake when its job's
 * page is one of the flake's failed evidence. Each failure gives at most one test, and a test is listed
 * once by its source, file and name. Any `tests` the flake already has are replaced, so the same
 * failures and issues always give the same names. It returns new flakes and never adds or drops one.
 */
export function nameFlakeTests(
  flakes: JobFlake[],
  failures: Failure[],
  issues: Issue[],
): JobFlake[] {
  const issueById = new Map(issues.map((issue) => [issue.id, issue]));
  return flakes.map((flake) => {
    const failed = new Set(
      flake.evidence.filter((item) => item.outcome === "failed").map((item) => item.url),
    );
    const tests: FlakeTest[] = [];
    const seen = new Set<string>();
    for (const failure of failures) {
      if (!failed.has(failure.url)) continue;
      const test = testOf(failure, issueById.get(failure.issueId));
      if (test === null) continue;
      const key = JSON.stringify([test.source, test.file, test.name]);
      if (seen.has(key)) continue;
      seen.add(key);
      tests.push(test);
    }
    return { ...flake, tests };
  });
}
