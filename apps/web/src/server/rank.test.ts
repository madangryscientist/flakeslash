import { describe, expect, it } from "vitest";
import type { Issue } from "@hackcove/flakeslash-engine";
import { type RankRows, rankCatalogue } from "./rank.ts";

const NOW = "2026-11-15T12:00:00Z";

type Run = {
  job: string;
  commit: string;
  passed?: boolean;
  /** The issue of the run's failure; a failed run needs one. */
  issue?: string;
  repo?: string | undefined;
  /** Days before NOW the run started. */
  daysAgo?: number;
};

/** Plain engine rows, built one run at a time: each run is its own job, run and page. */
function rows(runs: Run[], issues: Issue[], compares: RankRows["compares"] = []): RankRows {
  const out: RankRows = { issues, failures: [], jobs: [], compares };
  runs.forEach((run, at) => {
    const repo = run.repo ?? "acme/app";
    const jobId = at + 1;
    const url = `https://ci.test/${repo}/job/${jobId}`;
    // Each run a minute later than the one before, so the order of `runs` is the commit order.
    const started = Date.parse(NOW) - (run.daysAgo ?? 2) * 86_400_000 + at * 60_000;
    out.jobs.push({
      repo,
      workflow: "CI",
      jobName: run.job,
      jobId,
      url,
      commit: run.commit,
      branch: "main",
      prNumber: null,
      provider: "github-actions",
      runner: "github-hosted",
      runnerName: "runner",
      runId: 100 + jobId,
      runAttempt: 1,
      conclusion: run.passed ? "success" : "failure",
      startedAt: new Date(started).toISOString(),
      completedAt: new Date(started + 120_000).toISOString(),
      steps: [],
      annotations: [],
    });
    if (run.passed) return;
    out.failures.push({
      repo,
      jobId,
      url,
      signature: `sig:${run.issue}`,
      issueId: run.issue ?? "key:none",
      file: "test/a.test.ts",
      title: "a test",
      location: null,
      errorLine: "Error: boom",
    });
  });
  return out;
}

function issue(id: string, status: Issue["status"] = "potential"): Issue {
  return { id, name: id, kind: "test", status, signatures: [], explanation: null, edited: false };
}

/** The `job` failed on `commit` and passed on it too: one flaky commit. */
const flaky = (job: string, commit: string, id: string, repo?: string): Run[] => [
  { job, commit, issue: id, repo },
  { job, commit, passed: true, repo },
];

/** `job` failed on c1, c2 and c3 and passed on c4: a suspect at c3 when the c3..c4 compare is quiet. */
const suspectRuns = (id: string): Run[] => [
  { job: "lint", commit: "c1", issue: id },
  { job: "lint", commit: "c2", issue: id },
  { job: "lint", commit: "c3", issue: id },
  { job: "lint", commit: "c4", passed: true },
];

const quiet = {
  repo: "acme/app",
  base: "c3",
  head: "c4",
  result: { status: "ok" as const, files: ["src/other.ts"] },
};

describe("rankCatalogue", () => {
  it("ranks flaky issues before a suspect-only one, then by commits", async () => {
    const ranking = await rankCatalogue(
      rows(
        [
          ...flaky("unit", "a1", "key:few"),
          ...flaky("e2e", "b1", "key:many"),
          { job: "e2e", commit: "b2", issue: "key:many" },
          ...suspectRuns("key:sus"),
        ],
        [issue("key:few"), issue("key:many"), issue("key:sus")],
        [quiet],
      ),
      NOW,
    );
    expect(ranking.ranked.map((e) => [e.rank, e.issue.id, e.commits])).toEqual([
      [1, "key:many", 2],
      [2, "key:few", 1],
      [3, "key:sus", 3],
    ]);
    expect(ranking.ranked.map((e) => [e.flakyCommits > 0, e.suspect])).toEqual([
      [true, false],
      [true, false],
      [false, true],
    ]);
    expect(ranking.unranked).toBe(0);
  });

  it("takes a suspect from a stored compare only: a missing compare is no suspect", async () => {
    const issues = [issue("key:sus")];
    const stored = await rankCatalogue(rows(suspectRuns("key:sus"), issues, [quiet]), NOW);
    expect(stored.ranked.map((e) => e.issue.id)).toEqual(["key:sus"]);

    const missing = await rankCatalogue(rows(suspectRuns("key:sus"), issues), NOW);
    expect(missing.ranked).toEqual([]);
    expect(missing.unranked).toBe(1);
  });

  it("does not rank a dismissed issue, and returns it as dismissed while it fails in the window", async () => {
    const ranking = await rankCatalogue(
      rows(
        [
          ...flaky("unit", "a1", "key:open"),
          ...flaky("e2e", "b1", "key:gone"),
          { job: "old", commit: "z1", issue: "key:old", daysAgo: 40 },
        ],
        [issue("key:open"), issue("key:gone", "dismissed"), issue("key:old", "dismissed")],
      ),
      NOW,
    );
    expect(ranking.ranked.map((e) => e.issue.id)).toEqual(["key:open"]);
    expect(ranking.dismissed.map((i) => i.id)).toEqual(["key:gone"]);
  });

  it("gives each entry the distinct repos of its counted failures, sorted", async () => {
    const ranking = await rankCatalogue(
      rows(
        [
          ...flaky("unit", "a1", "key:both", "acme/web"),
          ...flaky("unit", "a2", "key:both", "acme/app"),
          { job: "unit", commit: "a3", issue: "key:both", repo: "acme/web" },
          { job: "unit", commit: "a0", issue: "key:both", repo: "acme/old", daysAgo: 40 },
        ],
        [issue("key:both")],
      ),
      NOW,
    );
    expect(ranking.ranked.map((e) => e.repos)).toEqual([["acme/app", "acme/web"]]);
  });
});
