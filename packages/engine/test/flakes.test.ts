import { describe, expect, it } from "vitest";
import {
  findJobFlakes,
  nameFlakeTests,
  type Failure,
  type Issue,
  type JobRecord,
} from "../src/index.ts";

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

  it("keeps a job flake's kind and starts it with no tests", () => {
    const [flake] = findJobFlakes([
      job({ runId: 1, conclusion: "failure" }),
      job({ runId: 2, conclusion: "success" }),
    ]);

    expect(flake).toMatchObject({ kind: "job", tests: [] });
  });
});

/** A failure of the job at `url`, with the fields the naming reads filled in. */
function failure(overrides: Partial<Failure> = {}): Failure {
  return {
    repo: "acme/app",
    jobId: 100,
    url: "https://example.test/a1",
    signature: "sig",
    issueId: "key:sig",
    file: null,
    title: null,
    location: null,
    errorLine: "",
    ...overrides,
  };
}

/** An issue with the given id, explained by the model as `component` when one is given. */
function issue(id: string, component?: string): Issue {
  return {
    id,
    name: id,
    kind: "other",
    status: "potential",
    signatures: [],
    edited: false,
    explanation:
      component === undefined
        ? null
        : {
            component,
            kind: "other",
            cause: "a cause",
            evidence: "a line",
            repo: "acme/app",
            jobId: 100,
            model: "m",
          },
  };
}

/** A job that failed in attempt 1 and passed in attempt 2 on one commit, so it is a flake. */
const flakyJob = [
  job({ runAttempt: 1, conclusion: "failure", url: "https://example.test/a1" }),
  job({ runAttempt: 2, conclusion: "success", url: "https://example.test/a2" }),
];

describe("nameFlakeTests", () => {
  it("names a job flake's test from the log, with source log, when its failure prints a test location", () => {
    const flakes = findJobFlakes(flakyJob);
    const named = nameFlakeTests(
      flakes,
      [
        failure({
          file: "e2e/upload.spec.ts",
          title: "uploads a file",
          location: "e2e/upload.spec.ts:141",
        }),
      ],
      [],
    );

    expect(named[0]?.tests).toEqual([
      {
        name: "uploads a file",
        file: "e2e/upload.spec.ts",
        location: "e2e/upload.spec.ts:141",
        source: "log",
      },
    ]);
  });

  it("names a bun failure after a log gap by its title, with an empty file, as source log", () => {
    const named = nameFlakeTests(
      findJobFlakes(flakyJob),
      [failure({ file: "", title: "adds two numbers", location: "" })],
      [],
    );

    expect(named[0]?.tests).toEqual([
      { name: "adds two numbers", file: null, location: null, source: "log" },
    ]);
  });

  it("names a failure with no test location from its issue's model component, with source model", () => {
    const named = nameFlakeTests(
      findJobFlakes(flakyJob),
      [failure({ issueId: "key:x" })],
      [issue("key:x", "tests/login.spec.ts full name")],
    );

    expect(named[0]?.tests).toEqual([
      { name: "tests/login.spec.ts full name", file: null, location: null, source: "model" },
    ]);
  });

  it("gives no flake for a named failure with no pass on that commit, and adds none", () => {
    const records = [job({ runAttempt: 1, conclusion: "failure", url: "https://example.test/a1" })];
    const named = nameFlakeTests(
      findJobFlakes(records),
      [failure({ file: "e2e/upload.spec.ts", title: "uploads", location: "e2e/upload.spec.ts:1" })],
      [],
    );

    expect(findJobFlakes(records)).toEqual([]);
    expect(named).toEqual([]);
  });

  it("gives the same flakes, with the same jobs, commits and evidence, with or without failures and issues", () => {
    const flakes = findJobFlakes(flakyJob);
    const bare = ({ tests: _tests, ...rest }: (typeof flakes)[number]) => rest;
    const named = nameFlakeTests(
      flakes,
      [
        failure({ file: "e2e/upload.spec.ts", title: "uploads", location: "e2e/upload.spec.ts:1" }),
        failure({ url: "https://example.test/a2", issueId: "key:x" }),
      ],
      [issue("key:x", "Install step")],
    );
    const unnamed = nameFlakeTests(flakes, [], []);

    expect(named.map(bare)).toEqual(flakes.map(bare));
    expect(unnamed.map(bare)).toEqual(flakes.map(bare));
    expect(unnamed[0]?.tests).toEqual([]);
  });
});
