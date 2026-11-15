import { describe, expect, it } from "vitest";
import { followOnJobs, type Failure, type JobRecord } from "../src/index.ts";

/** A job record in run 100, attempt 1; the overrides say which job and when. */
function job(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    repo: "acme/app",
    workflow: "CI",
    jobName: "test",
    jobId: 1,
    url: "https://github.com/acme/app/actions/runs/100/job/1",
    commit: "abc123",
    branch: "main",
    prNumber: null,
    provider: "github-actions",
    runner: "github-hosted",
    runnerName: "GitHub Actions 1",
    runId: 100,
    runAttempt: 1,
    conclusion: "failure",
    startedAt: "2026-11-01T10:00:00Z",
    completedAt: "2026-11-01T10:05:00Z",
    steps: [],
    annotations: [],
    ...overrides,
  };
}

function failureOf(record: JobRecord, title: string | null = null): Failure {
  return {
    repo: record.repo,
    jobId: record.jobId,
    url: record.url,
    signature: `sig:${record.jobId}`,
    issueId: "issue",
    file: null,
    title,
    location: null,
    errorLine: "boom",
  };
}

/** A test job that failed from 10:00 to 10:05. */
const sibling = job({ jobId: 1, jobName: "test", url: "https://example.test/1" });

/** A gather job that ran after the sibling finished, unless the overrides say otherwise. */
function gather(overrides: Partial<JobRecord> = {}): JobRecord {
  return job({
    jobId: 2,
    jobName: "Merge Reports",
    url: "https://example.test/2",
    startedAt: "2026-11-01T10:05:00Z",
    completedAt: "2026-11-01T10:06:00Z",
    ...overrides,
  });
}

/** Run `runId`: the sibling fails, then the gather job fails after it, or before it when `early`. */
const runOf = (runId: number, early = false) => {
  const failed = job({ ...sibling, runId, jobId: runId * 10 });
  const merge = gather({
    runId,
    jobId: runId * 10 + 1,
    ...(early ? { startedAt: "2026-11-01T10:00:00Z" } : {}),
  });
  return { records: [failed, merge], failures: [failureOf(merge)] };
};
const ofRuns = (runs: ReturnType<typeof runOf>[]) =>
  followOnJobs(
    runs.flatMap((run) => run.records),
    runs.flatMap((run) => run.failures),
  );

describe("followOnJobs", () => {
  it("names a job that started after a failed sibling and names no test", () => {
    const merge = gather();
    const followOn = followOnJobs(
      [sibling, merge],
      [failureOf(sibling, "a test"), failureOf(merge)],
    );

    expect([...followOn]).toEqual(["acme/app:2"]);
  });

  it("does not name a job whose failure names a test", () => {
    const merge = gather();
    const followOn = followOnJobs(
      [sibling, merge],
      [failureOf(sibling, "a test"), failureOf(merge, "its own test")],
    );

    expect(followOn.size).toBe(0);
  });

  it("does not name a job that started before the sibling finished", () => {
    const merge = gather({ startedAt: "2026-11-01T10:04:59Z" });

    expect(followOnJobs([sibling, merge], [failureOf(merge)]).size).toBe(0);
  });

  it("does not name a job in another attempt of the run", () => {
    const merge = gather({ runAttempt: 2 });

    expect(followOnJobs([sibling, merge], [failureOf(merge)]).size).toBe(0);
  });

  it("does not name a job with no start time", () => {
    const merge = gather({ startedAt: null });

    expect(followOnJobs([sibling, merge], [failureOf(merge)]).size).toBe(0);
  });

  it("does not count a sibling with no end time", () => {
    const open = job({ ...sibling, completedAt: null });
    const merge = gather();

    expect(followOnJobs([open, merge], [failureOf(merge)]).size).toBe(0);
  });

  it("does not take a job as its own failed sibling", () => {
    const merge = gather({ startedAt: "2026-11-01T10:06:00Z" });

    expect(followOnJobs([merge], [failureOf(merge)]).size).toBe(0);
  });

  it("keys on the repo in lower case, as the store does", () => {
    const upper = job({ ...sibling, repo: "Acme/App" });
    const merge = gather({ repo: "Acme/App" });

    expect([...followOnJobs([upper, merge], [failureOf(merge)])]).toEqual(["acme/app:2"]);
  });

  it("names a job only when it fails after a sibling in at least 80% of its failed runs", () => {
    // 4 of 5 follow a failure: every one of the 4 is a follow-on.
    expect(ofRuns([runOf(1), runOf(2), runOf(3), runOf(4), runOf(5, true)])).toEqual(
      new Set(["acme/app:11", "acme/app:21", "acme/app:31", "acme/app:41"]),
    );
    // 3 of 4 is under 80%: none is.
    expect(ofRuns([runOf(1), runOf(2), runOf(3), runOf(4, true)]).size).toBe(0);
  });
});
