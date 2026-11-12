import { describe, expect, it } from "vitest";
import { findJobFlakes, flakeRates, type FlakeTest, type JobRecord } from "../src/index.ts";

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

const NOW = "2026-12-01T00:00:00Z";

const modelTest = (name: string): FlakeTest => ({
  name,
  file: null,
  location: null,
  source: "model",
});

describe("flakeRates", () => {
  it("counts ten re-runs of one commit as one commit", () => {
    const records = Array.from({ length: 10 }, (_, i) =>
      job({
        runAttempt: i + 1,
        conclusion: i === 0 ? "failure" : "success",
        url: `https://example.test/attempt-${i + 1}`,
      }),
    );

    const rates = flakeRates(records, findJobFlakes(records), { now: NOW });

    expect(rates).toEqual([
      {
        repo: "acme/app",
        workflow: "CI",
        jobName: "test",
        test: null,
        commits: 1,
        flakyCommits: 1,
        rate: 1,
        ranBy: "job",
      },
    ]);
  });

  it("keeps a commit 29 days old in the window and drops one 31 days old", () => {
    const records = [
      job({
        commit: "old",
        runAttempt: 1,
        conclusion: "failure",
        startedAt: "2026-10-31T00:00:00Z",
      }),
      job({
        commit: "old",
        runAttempt: 2,
        conclusion: "success",
        startedAt: "2026-10-31T00:00:00Z",
      }),
      job({
        commit: "new",
        runAttempt: 1,
        conclusion: "failure",
        startedAt: "2026-11-02T00:00:00Z",
      }),
      job({
        commit: "new",
        runAttempt: 2,
        conclusion: "success",
        startedAt: "2026-11-02T00:00:00Z",
      }),
    ];

    const rates = flakeRates(records, findJobFlakes(records), { now: NOW });

    expect(rates).toHaveLength(1);
    expect(rates[0]).toMatchObject({ commits: 1, flakyCommits: 1, rate: 1 });
  });

  it("gives commits 0 and rate null for a job whose records are all outside the window", () => {
    const records = [
      job({ conclusion: "success", startedAt: "2026-10-01T00:00:00Z" }),
      job({ runAttempt: 2, conclusion: "failure", startedAt: "2026-10-01T00:00:00Z" }),
    ];

    const rates = flakeRates(records, findJobFlakes(records), { now: NOW });

    expect(rates).toEqual([
      {
        repo: "acme/app",
        workflow: "CI",
        jobName: "test",
        test: null,
        commits: 0,
        flakyCommits: 0,
        rate: null,
        ranBy: "job",
      },
    ]);
  });

  it("gives a log test its own row, with the job's commits as the denominator", () => {
    const records = [
      job({ commit: "c1", runAttempt: 1, conclusion: "failure" }),
      job({ commit: "c1", runAttempt: 2, conclusion: "success" }),
      job({ commit: "c2", conclusion: "success", startedAt: "2026-11-03T10:00:00Z" }),
      job({ commit: "c3", conclusion: "success", startedAt: "2026-11-04T10:00:00Z" }),
    ];
    const logTest: FlakeTest = {
      name: "adds two numbers",
      file: "test/sum.test.ts",
      location: "test/sum.test.ts:12",
      source: "log",
    };
    const flakes = findJobFlakes(records).map((flake) => ({ ...flake, tests: [logTest] }));

    const rates = flakeRates(records, flakes, { now: NOW });

    expect(rates).toEqual([
      {
        repo: "acme/app",
        workflow: "CI",
        jobName: "test",
        test: null,
        commits: 3,
        flakyCommits: 1,
        rate: 1 / 3,
        ranBy: "job",
      },
      {
        repo: "acme/app",
        workflow: "CI",
        jobName: "test",
        test: { name: "adds two numbers", file: "test/sum.test.ts" },
        commits: 3,
        flakyCommits: 1,
        rate: 1 / 3,
        ranBy: "job",
      },
    ]);
  });

  it("leaves every row equal when a model-sourced name is renamed, added or removed", () => {
    const records = [
      job({ commit: "c1", runAttempt: 1, conclusion: "failure" }),
      job({ commit: "c1", runAttempt: 2, conclusion: "success" }),
      job({ commit: "c2", conclusion: "success", startedAt: "2026-11-03T10:00:00Z" }),
    ];
    const withTests = (tests: FlakeTest[]) =>
      findJobFlakes(records).map((flake) => ({ ...flake, tests }));

    const none = flakeRates(records, withTests([]), { now: NOW });

    expect(flakeRates(records, withTests([modelTest("Checkout component")]), { now: NOW })).toEqual(
      none,
    );
    expect(flakeRates(records, withTests([modelTest("Login component")]), { now: NOW })).toEqual(
      none,
    );
  });
});
