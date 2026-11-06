import { describe, expect, it } from "vitest";
import { findJobFlakes, type JobRecord } from "../src/index.ts";

/** A job record with only the fields the rule reads filled in; the rest are plausible defaults. */
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

const cancelled = (message: string | null): JobRecord =>
  job({
    conclusion: "cancelled",
    annotations: message === null ? [] : [{ title: "", message }],
  });

describe("findJobFlakes", () => {
  it("gives one flake with two pieces of evidence when attempt 1 failed and attempt 2 passed", () => {
    const flakes = findJobFlakes([
      job({ runAttempt: 1, conclusion: "failure", url: "https://example.test/a1" }),
      job({ runAttempt: 2, conclusion: "success", url: "https://example.test/a2" }),
    ]);

    expect(flakes).toHaveLength(1);
    expect(flakes[0]).toMatchObject({
      repo: "acme/app",
      workflow: "CI",
      jobName: "test",
      commit: "abc123",
    });
    expect(flakes[0]?.evidence).toEqual([
      {
        outcome: "failed",
        url: "https://example.test/a1",
        runId: 100,
        runAttempt: 1,
        conclusion: "failure",
      },
      {
        outcome: "passed",
        url: "https://example.test/a2",
        runId: 100,
        runAttempt: 2,
        conclusion: "success",
      },
    ]);
  });

  it("gives no flake when the job failed in both attempts", () => {
    const flakes = findJobFlakes([
      job({ runAttempt: 1, conclusion: "failure" }),
      job({ runAttempt: 2, conclusion: "failure" }),
    ]);

    expect(flakes).toEqual([]);
  });

  it("gives one flake for two separate runs on one commit, one failing and one passing", () => {
    const flakes = findJobFlakes([
      job({ runId: 200, runAttempt: 1, conclusion: "success", url: "https://example.test/r200" }),
      job({ runId: 100, runAttempt: 1, conclusion: "failure", url: "https://example.test/r100" }),
    ]);

    expect(flakes).toHaveLength(1);
    expect(flakes[0]?.evidence.map((item) => item.runId)).toEqual([100, 200]);
    expect(flakes[0]?.evidence.map((item) => item.outcome)).toEqual(["failed", "passed"]);
  });

  it("counts skipped jobs and jobs a person cancelled as neither a pass nor a failure", () => {
    const flakes = findJobFlakes([
      job({ conclusion: "failure", runId: 1 }),
      job({ conclusion: "skipped", runId: 2 }),
      job({ conclusion: "success", runId: 3 }),
      job({
        conclusion: "cancelled",
        runId: 4,
        annotations: [{ title: "", message: "The run was canceled by @someone." }],
      }),
    ]);

    expect(flakes).toHaveLength(1);
    expect(flakes[0]?.evidence.map((item) => item.runId)).toEqual([1, 3]);
  });

  it.each([
    "The runner has received a shutdown signal. The job was canceled.",
    "The runner lost communication with the server.",
    "The job has exceeded the maximum execution time of 6 hours.",
  ])("counts a cancelled job as a failure when its annotation says %s", (message) => {
    const flakes = findJobFlakes([job({ runId: 1, conclusion: "success" }), cancelled(message)]);

    expect(flakes).toHaveLength(1);
    expect(flakes[0]?.evidence.map((item) => item.outcome)).toEqual(["passed", "failed"]);
  });

  it("counts cancelled jobs with ordinary cancel annotations as neither", () => {
    const flakes = findJobFlakes([
      job({ runId: 1, conclusion: "success" }),
      cancelled(
        "Canceling since a higher priority waiting request for ci-CI-refs/heads/main exists",
      ),
      cancelled("The operation was canceled."),
      cancelled("The run was canceled by @madangryscientist."),
      cancelled(null),
    ]);

    expect(flakes).toEqual([]);
  });

  it("counts a failed job that never got a runner as a failure", () => {
    const flakes = findJobFlakes([
      job({ runId: 1, conclusion: "failure", runner: "github-hosted", runnerName: "" }),
      job({ runId: 2, conclusion: "success" }),
    ]);

    expect(flakes).toHaveLength(1);
    expect(flakes[0]?.evidence[0]).toMatchObject({ outcome: "failed", runId: 1 });
  });

  it("counts timed_out as a failure and a null conclusion as neither", () => {
    const flakes = findJobFlakes([
      job({ runId: 1, conclusion: "timed_out" }),
      job({ runId: 2, conclusion: "success" }),
      job({ runId: 3, conclusion: null }),
    ]);

    expect(flakes).toHaveLength(1);
    expect(flakes[0]?.evidence.map((item) => item.runId)).toEqual([1, 2]);
    expect(flakes[0]?.evidence[0]?.conclusion).toBe("timed_out");
  });

  it("keeps the same job name in two workflows as two jobs", () => {
    const flakes = findJobFlakes([
      job({ workflow: "CI", runId: 1, conclusion: "failure" }),
      job({ workflow: "Nightly", runId: 2, conclusion: "success" }),
    ]);

    expect(flakes).toEqual([]);
  });

  it("keeps the same job on different commits apart, and orders flakes by their first record in the input", () => {
    const flakes = findJobFlakes([
      job({ commit: "bbb", runId: 1, conclusion: "failure" }),
      job({ commit: "aaa", runId: 2, conclusion: "failure" }),
      job({ commit: "aaa", runId: 3, conclusion: "success" }),
      job({ commit: "bbb", runId: 4, conclusion: "success" }),
    ]);

    expect(flakes.map((flake) => flake.commit)).toEqual(["bbb", "aaa"]);
    expect(flakes.map((flake) => flake.evidence.map((item) => item.runId))).toEqual([
      [1, 4],
      [2, 3],
    ]);
  });

  it("does not change its input", () => {
    const records = [
      job({ runId: 2, runAttempt: 1, conclusion: "success" }),
      job({ runId: 1, runAttempt: 1, conclusion: "failure" }),
    ];
    const before = structuredClone(records);

    findJobFlakes(records);

    expect(records).toEqual(before);
  });
});
