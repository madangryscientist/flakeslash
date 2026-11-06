import { describe, expect, it } from "vitest";
import { readGitHubActions, type JobRecord } from "../src/index.ts";
import {
  API,
  REPO,
  SHA,
  RUNS,
  attemptIds,
  fakeGitHub,
  jobsFixture,
  runsFixture,
  job,
  jobsOf,
  jobsPath,
  json,
  pullsPath,
  realRoutes,
  run,
  runsOf,
  since,
} from "./github-fake.ts";

describe("readGitHubActions: attempts", () => {
  it("gives a record for each job in each attempt, with every field", async () => {
    const gh = fakeGitHub(realRoutes());
    const { records, cutShort } = await readGitHubActions({ repo: REPO, since, fetch: gh.fetch });
    const perAttempt = [1, 2, 3].map(attemptIds);
    expect(cutShort).toBe(false);
    // The PR comes from the commit lookup: the run's own pull_requests is empty.
    expect(runsFixture().workflow_runs[0]?.pull_requests).toEqual([]);
    expect(records).toHaveLength(perAttempt.flat().length);
    for (const [index, jobs] of perAttempt.entries()) {
      const read = records.filter((r) => r.runAttempt === index + 1).map((r) => r.jobId);
      expect(read.toSorted((a, b) => a - b)).toEqual(jobs.toSorted((a, b) => a - b));
    }
    const gate = records.find((r) => r.jobId === 126057955448);
    expect(gate).toMatchObject<Partial<JobRecord>>({
      repo: REPO,
      workflow: "CI",
      jobName: "Gate (typecheck, lint, format, test)",
      commit: SHA,
      branch: "release/0.6.0",
      prNumber: 84,
      provider: "github-actions",
      runner: "github-hosted",
      runnerName: "GitHub Actions 1000001064",
      runId: 41676366416,
      runAttempt: 1,
      conclusion: "failure",
      startedAt: "2026-11-03T16:39:07Z",
      completedAt: "2026-11-03T16:42:31Z",
      url: `https://github.com/${REPO}/actions/runs/41676366416/job/126057955448`,
      annotations: [],
    });
    expect(gate?.steps.length).toBeGreaterThan(0);
    expect(gate?.steps[0]).toEqual({ name: expect.any(String), conclusion: expect.any(String) });
  });

  it("gives the failed records of a run that reads success", async () => {
    const gh = fakeGitHub(realRoutes());
    const { records } = await readGitHubActions({ repo: REPO, since, fetch: gh.fetch });
    expect(runsFixture().workflow_runs[0]?.conclusion).toBe("success");
    const failed = records.filter((r) => r.conclusion === "failure");
    expect(failed.map((r) => [r.runAttempt, r.jobId])).toEqual(
      expect.arrayContaining([
        [1, 126057955448],
        [1, 126058067053],
      ]),
    );
    expect(failed.every((r) => r.runAttempt < 3)).toBe(true);
  });

  it("pages a long job list with per_page=100 and the Link header", async () => {
    const next = `${API}/repositories/1/actions/runs/5/attempts/1/jobs?per_page=100&page=2`;
    const gh = fakeGitHub({
      [RUNS]: runsOf(run(5, "2026-11-03T00:00:00Z")),
      [pullsPath("5".padStart(40, "a"))]: json([]),
      [jobsPath(5, 1)]: json(
        { total_count: 2, jobs: [job(1, 5)] },
        { headers: { link: `<${next}>; rel="next"` } },
      ),
      "/repositories/1/actions/runs/5/attempts/1/jobs?per_page=100&page=2": jobsOf(job(2, 5)),
    });
    const { records } = await readGitHubActions({ repo: REPO, since, fetch: gh.fetch });
    expect(records.map((r) => r.jobId)).toEqual([1, 2]);
  });
});

describe("readGitHubActions: pull requests", () => {
  it("looks a commit up once, however many runs it has", async () => {
    const sha = "b".repeat(40);
    const gh = fakeGitHub({
      [RUNS]: runsOf(
        run(11, "2026-11-04T00:00:00Z", { head_sha: sha }),
        run(12, "2026-11-03T00:00:00Z", { head_sha: sha }),
      ),
      [pullsPath(sha)]: json([{ number: 7, head: { ref: "main" } }]),
      [jobsPath(11, 1)]: jobsOf(job(1, 11)),
      [jobsPath(12, 1)]: jobsOf(job(2, 12)),
    });
    const { records } = await readGitHubActions({ repo: REPO, since, fetch: gh.fetch });
    expect(gh.calls.filter((url) => url.includes("/pulls"))).toHaveLength(1);
    expect(records.map((r) => r.prNumber)).toEqual([7, 7]);
  });

  it.each([
    ["an empty answer", () => json([])],
    [
      "a commit GitHub no longer has (422)",
      () => json({ message: "No commit found" }, { status: 422 }),
    ],
  ])("reads %s as no PR, not an error", async (_label, answer) => {
    const sha = "c".repeat(40);
    const gh = fakeGitHub({
      [RUNS]: runsOf(run(21, "2026-11-04T00:00:00Z", { head_sha: sha, head_branch: "ps-260" })),
      [pullsPath(sha)]: answer,
      [jobsPath(21, 1)]: jobsOf(job(1, 21)),
    });
    const { records, cutShort } = await readGitHubActions({ repo: REPO, since, fetch: gh.fetch });
    expect(cutShort).toBe(false);
    expect(records.map((r) => r.prNumber)).toEqual([null]);
  });
});

describe("readGitHubActions: runners", () => {
  it("keeps a failed job with an empty runner_name", async () => {
    const attempt1 = jobsFixture("jobs-41676366416-attempt-1.json");
    const dead = attempt1.jobs[0]!;
    dead.runner_name = "";
    dead.steps = [];
    const gh = fakeGitHub({ ...realRoutes(), [jobsPath(41676366416, 1)]: json(attempt1) });
    const { records } = await readGitHubActions({ repo: REPO, since, fetch: gh.fetch });
    const kept = records.find((r) => r.jobId === dead.id);
    expect(kept).toMatchObject({ conclusion: "failure", runnerName: "", runner: "github-hosted" });
    expect(records).toHaveLength([1, 2, 3].flatMap(attemptIds).length);
  });

  it("maps labels to a runner and keeps provider github-actions for all of them", async () => {
    const labelSets = [
      ["ubuntu-latest"],
      ["depot-ubuntu-24.04-4"],
      ["blacksmith-4vcpu-ubuntu-2404"],
      ["self-hosted", "linux", "x64"],
      ["Depot-ubuntu-22.04"],
      ["windows-2022"],
      [],
    ];
    const gh = fakeGitHub({
      [RUNS]: runsOf(run(31, "2026-11-04T00:00:00Z")),
      [pullsPath("31".padStart(40, "a"))]: json([]),
      [jobsPath(31, 1)]: jobsOf(...labelSets.map((labels, i) => job(i + 1, 31, { labels }))),
    });
    const { records } = await readGitHubActions({ repo: REPO, since, fetch: gh.fetch });
    expect(records.map((r) => r.runner)).toEqual([
      "github-hosted",
      "depot",
      "blacksmith",
      "self-hosted",
      "depot",
      "github-hosted",
      "github-hosted",
    ]);
    expect(new Set(records.map((r) => r.provider))).toEqual(new Set(["github-actions"]));
  });
});
