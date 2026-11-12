import { describe, expect, it } from "vitest";
import {
  findJobFlakes,
  rankIssues,
  type Failure,
  type Issue,
  type JobRecord,
} from "../src/index.ts";

const NOW = "2026-12-01T00:00:00Z";

/** A failed job in the window, started 2026-11-20, unless the overrides say otherwise. */
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
    startedAt: "2026-11-20T10:00:00Z",
    completedAt: "2026-11-20T10:05:00Z",
    steps: [],
    annotations: [],
    ...overrides,
  };
}

function issue(id: string, status: Issue["status"] = "potential"): Issue {
  return {
    id,
    name: id,
    kind: "other",
    status,
    signatures: [],
    explanation: null,
    edited: false,
  };
}

/** A failure of `issueId` on the job whose page is `record.url`. */
function failureOf(record: JobRecord, issueId: string): Failure {
  return {
    repo: record.repo,
    jobId: record.jobId,
    url: record.url,
    signature: `sig:${record.jobId}`,
    issueId,
    file: null,
    title: null,
    location: null,
    errorLine: "boom",
  };
}

/** One failed job per commit, each on its own job id and page. */
function failedOn(commits: number, issueId: string, overrides: Partial<JobRecord> = {}) {
  const records: JobRecord[] = [];
  const failures: Failure[] = [];
  for (let i = 0; i < commits; i += 1) {
    const record = job({
      jobId: 1000 + i,
      url: `https://github.com/acme/app/actions/runs/${issueId}-${i}/job/${1000 + i}`,
      commit: `${issueId}-${i}`,
      ...overrides,
    });
    records.push(record);
    failures.push(failureOf(record, issueId));
  }
  return { records, failures };
}

function rank(records: JobRecord[], failures: Failure[], issues: Issue[], suspects: never[] = []) {
  return rankIssues({ records, failures, issues, flakes: [], suspects, now: NOW });
}

describe("rankIssues", () => {
  it("ranks the issue with more commits first", () => {
    const many = failedOn(3, "many");
    const few = failedOn(2, "few");
    const ranked = rank(
      [...many.records, ...few.records],
      [...many.failures, ...few.failures],
      [issue("many"), issue("few")],
    );

    expect(ranked.map((entry) => [entry.rank, entry.issue.id, entry.commits])).toEqual([
      [1, "many", 3],
      [2, "few", 2],
    ]);
  });

  it("breaks a tie on commits by the seconds lost, more first", () => {
    const short = failedOn(2, "short", {
      completedAt: "2026-11-20T10:01:00Z",
    });
    const long = failedOn(2, "long", {
      completedAt: "2026-11-20T11:00:00Z",
    });
    const ranked = rank(
      [...short.records, ...long.records],
      [...short.failures, ...long.failures],
      [issue("short"), issue("long")],
    );

    expect(ranked.map((entry) => [entry.issue.id, entry.commits, entry.secondsLost])).toEqual([
      ["long", 2, 7200],
      ["short", 2, 120],
    ]);
  });

  it("does not count a commit whose failure is 31 days old", () => {
    const recent = failedOn(1, "recent");
    const old = failedOn(3, "old", {
      startedAt: "2026-10-30T10:00:00Z",
      completedAt: "2026-10-30T10:05:00Z",
    });
    const ranked = rank(
      [...recent.records, ...old.records],
      [...recent.failures, ...old.failures],
      [issue("recent"), issue("old")],
    );

    expect(ranked.map((entry) => [entry.issue.id, entry.commits])).toEqual([["recent", 1]]);
  });

  it("leaves a dismissed issue out", () => {
    const kept = failedOn(1, "kept");
    const dismissed = failedOn(4, "dismissed");
    const ranked = rank(
      [...kept.records, ...dismissed.records],
      [...kept.failures, ...dismissed.failures],
      [issue("kept"), issue("dismissed", "dismissed")],
    );

    expect(ranked.map((entry) => entry.issue.id)).toEqual(["kept"]);
  });

  it("gives the rate, the PRs and the suspect flag of the issue's own jobs", () => {
    const flaky = failedOn(1, "flaky", { prNumber: 7 });
    const passed = job({
      jobId: 2000,
      url: "https://github.com/acme/app/actions/runs/9/job/2000",
      commit: "flaky-0",
      conclusion: "success",
      startedAt: "2026-11-21T10:00:00Z",
      completedAt: "2026-11-21T10:05:00Z",
    });
    const flakes = findJobFlakes([...flaky.records, passed]);
    const [entry] = rankIssues({
      records: [...flaky.records, passed],
      failures: flaky.failures,
      issues: [issue("flaky")],
      flakes,
      suspects: [
        {
          kind: "suspect",
          repo: "acme/app",
          workflow: "CI",
          jobName: "test",
          branch: "main",
          commit: "x",
          nextCommit: "y",
          failedUrl: flaky.records[0]?.url ?? "",
          passedUrl: passed.url,
          files: [],
        },
      ],
      now: NOW,
    });

    expect(entry).toMatchObject({
      commits: 1,
      prs: [{ repo: "acme/app", number: 7 }],
      flakyCommits: 1,
      ranCommits: 1,
      rate: 1,
      suspect: true,
      latestUrl: flaky.records[0]?.url,
    });
  });
});
