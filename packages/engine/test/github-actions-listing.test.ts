import { describe, expect, it } from "vitest";
import { readGitHubActions } from "../src/index.ts";
import {
  API,
  REPO,
  RUNS,
  attemptIds,
  fakeGitHub,
  fixture,
  jobsFixture,
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

const shaOf = (id: number) => `${id}`.padStart(40, "a");

describe("readGitHubActions: listing", () => {
  it("lists runs with no created filter and stops paging at the first run older than since", async () => {
    const page2 = `${API}/repositories/1/actions/runs?per_page=100&page=2`;
    const page3 = `${API}/repositories/1/actions/runs?per_page=100&page=3`;
    const gh = fakeGitHub({
      [RUNS]: json(
        { total_count: 5, workflow_runs: [run(41, "2026-11-05T00:00:00Z")] },
        { headers: { link: `<${page2}>; rel="next"` } },
      ),
      "/repositories/1/actions/runs?per_page=100&page=2": json(
        {
          total_count: 5,
          workflow_runs: [
            run(42, "2026-11-02T00:00:00Z"),
            run(43, "2026-10-30T00:00:00Z"),
            run(44, "2026-11-03T00:00:00Z"),
          ],
        },
        { headers: { link: `<${page3}>; rel="next"` } },
      ),
      [pullsPath(shaOf(41))]: json([]),
      [pullsPath(shaOf(42))]: json([]),
      [jobsPath(41, 1)]: jobsOf(job(1, 41)),
      [jobsPath(42, 1)]: jobsOf(job(2, 42)),
    });
    const { records, cutShort } = await readGitHubActions({ repo: REPO, since, fetch: gh.fetch });
    expect(cutShort).toBe(false);
    expect(records.map((r) => r.runId)).toEqual([41, 42]);
    expect(gh.calls.some((url) => url.includes("created"))).toBe(false);
    expect(gh.calls.some((url) => url.includes("page=3"))).toBe(false);
    expect(gh.calls.some((url) => url.includes("/runs/43/") || url.includes("/runs/44/"))).toBe(
      false,
    );
    expect(gh.calls.filter((url) => url.includes("/actions/runs?")).length).toBe(2);
  });

  it("sends the token as a bearer header, and sends nothing without one", async () => {
    const withToken = fakeGitHub({ [RUNS]: runsOf() });
    await readGitHubActions({ repo: REPO, since, fetch: withToken.fetch, token: "t0ken" });
    expect(withToken.headers[0]?.authorization).toBe("Bearer t0ken");
    const without = fakeGitHub({ [RUNS]: runsOf() });
    await readGitHubActions({ repo: REPO, since, fetch: without.fetch });
    expect(without.headers[0]).not.toHaveProperty("authorization");
  });

  it("throws on a next link that leaves api.github.com, rather than ending as if complete", async () => {
    const gh = fakeGitHub({
      [RUNS]: json(
        { total_count: 1, workflow_runs: [] },
        { headers: { link: `<https://evil.example/steal>; rel="next"` } },
      ),
    });
    await expect(
      readGitHubActions({ repo: REPO, since, fetch: gh.fetch, token: "x" }),
    ).rejects.toThrow(/off/);
    expect(gh.calls).toHaveLength(1);
  });
});

describe("readGitHubActions: a job killed by a lost runner", () => {
  // The fixtures follow GitHub's documented shape, not a recording: see fixtures/README.md.
  it("carries the step conclusions and annotation that show it, and only cancelled jobs fetch annotations", async () => {
    const head = "0123456789abcdef0123456789abcdef01234567";
    const lost = jobsFixture("jobs-lost-runner.json");
    const fine = job(130000000002, 42200000000, { head_sha: head, head_branch: "ps-lost-runner" });
    const gh = fakeGitHub({
      [RUNS]: runsOf(
        run(42200000000, "2026-11-05T10:00:00Z", { head_sha: head, head_branch: "ps-lost-runner" }),
      ),
      [pullsPath(head)]: json([]),
      [jobsPath(42200000000, 1)]: jobsOf(...lost.jobs, fine),
      [`/repos/${REPO}/check-runs/130000000001/annotations?per_page=100`]: json(
        fixture("annotations-lost-runner.json"),
      ),
    });
    const { records } = await readGitHubActions({ repo: REPO, since, fetch: gh.fetch });
    const killed = records.find((r) => r.jobId === 130000000001);
    expect(killed?.conclusion).toBe("cancelled");
    expect(killed?.steps.map((s) => s.conclusion)).toEqual([
      "success",
      "success",
      "success",
      "cancelled",
      "skipped",
      "skipped",
    ]);
    expect(killed?.annotations.map((a) => a.message)).toEqual([
      expect.stringContaining("The runner has received a shutdown signal"),
      "The operation was canceled.",
    ]);
    expect(records.find((r) => r.jobId === 130000000002)?.annotations).toEqual([]);
    expect(gh.calls.filter((url) => url.includes("annotations"))).toHaveLength(1);
  });
});

describe("readGitHubActions: limits and failures", () => {
  it.each([
    ["429", () => json({}, { status: 429 })],
    [
      "403 with remaining 0",
      () => json({}, { status: 403, headers: { "x-ratelimit-remaining": "0" } }),
    ],
    ["403 with retry-after", () => json({}, { status: 403, headers: { "retry-after": "60" } })],
  ])(
    "ends the read on a %s, returns what it read and marks it cut short",
    async (_label, limited) => {
      const gh = fakeGitHub({ ...realRoutes(), [jobsPath(41676366416, 2)]: limited });
      const { records, cutShort } = await readGitHubActions({ repo: REPO, since, fetch: gh.fetch });
      expect(cutShort).toBe(true);
      expect(records.map((r) => r.jobId).toSorted((a, b) => a - b)).toEqual(
        attemptIds(1).toSorted((a, b) => a - b),
      );
      expect(gh.calls.some((url) => url.includes("/attempts/3/"))).toBe(false);
    },
  );

  it("is cut short, with nothing, when the first listing is rate limited", async () => {
    const gh = fakeGitHub({ [RUNS]: json({}, { status: 429 }) });
    expect(await readGitHubActions({ repo: REPO, since, fetch: gh.fetch })).toEqual({
      records: [],
      cutShort: true,
    });
  });

  it("is cut short when the PR lookup is rate limited, keeping the earlier run", async () => {
    const gh = fakeGitHub({
      [RUNS]: runsOf(run(51, "2026-11-05T00:00:00Z"), run(52, "2026-11-04T00:00:00Z")),
      [pullsPath("51".padStart(40, "a"))]: json([]),
      [pullsPath("52".padStart(40, "a"))]: json({}, { status: 429 }),
      [jobsPath(51, 1)]: jobsOf(job(1, 51)),
    });
    const { records, cutShort } = await readGitHubActions({ repo: REPO, since, fetch: gh.fetch });
    expect(cutShort).toBe(true);
    expect(records.map((r) => r.runId)).toEqual([51]);
  });

  it("throws on any other 403, so a bad token cannot read as a short history", async () => {
    const gh = fakeGitHub({
      [RUNS]: json({ message: "Resource not accessible" }, { status: 403 }),
    });
    await expect(readGitHubActions({ repo: REPO, since, fetch: gh.fetch })).rejects.toThrow(/403/);
  });

  it("skips a run deleted after it was listed, and keeps the rest", async () => {
    const gh = fakeGitHub({
      [RUNS]: runsOf(run(61, "2026-11-05T00:00:00Z"), run(62, "2026-11-04T00:00:00Z")),
      [pullsPath(shaOf(61))]: json([]),
      [pullsPath(shaOf(62))]: json([]),
      [jobsPath(61, 1)]: json({ message: "Not Found" }, { status: 404 }),
      [jobsPath(62, 1)]: jobsOf(job(1, 62)),
    });
    const { records, cutShort } = await readGitHubActions({ repo: REPO, since, fetch: gh.fetch });
    expect(cutShort).toBe(false);
    expect(records.map((r) => r.runId)).toEqual([62]);
  });

  it("refuses a repo that is not owner/name, and a since that is not a date", async () => {
    const gh = fakeGitHub({});
    await expect(readGitHubActions({ repo: "nope", since, fetch: gh.fetch })).rejects.toThrow(
      /owner\/name/,
    );
    await expect(
      readGitHubActions({ repo: REPO, since: "yesterday-ish", fetch: gh.fetch }),
    ).rejects.toThrow(/since/);
    expect(gh.calls).toEqual([]);
  });
});

describe("readGitHubActions: held attempts and run status", () => {
  it("rejects a run listed without a status", async () => {
    const { status: _status, ...noStatus } = run(71, "2026-11-05T00:00:00Z");
    const gh = fakeGitHub({ [RUNS]: runsOf(noStatus) });
    await expect(readGitHubActions({ repo: REPO, since, fetch: gh.fetch })).rejects.toThrow(
      "without an id, head_sha, created_at or status",
    );
  });

  it("hands each run's records to onRecords as the run is read, and skips held attempts", async () => {
    const gh = fakeGitHub({
      [RUNS]: runsOf(run(81, "2026-11-05T00:00:00Z"), run(82, "2026-11-04T00:00:00Z")),
      [pullsPath("82".padStart(40, "a"))]: json([]),
      [jobsPath(82, 1)]: jobsOf(job(821, 82)),
    });
    const batches: number[][] = [];
    const { records } = await readGitHubActions({
      repo: REPO,
      since,
      fetch: gh.fetch,
      held: [{ runId: 81, runAttempt: 1 }],
      onRecords: async (batch) => {
        batches.push(batch.map((r) => r.jobId));
      },
    });
    expect(batches).toEqual([[821]]);
    expect(records.map((r) => r.jobId)).toEqual([821]);
    expect(gh.calls.map((url) => url.replace(API, ""))).toEqual([
      RUNS,
      pullsPath("82".padStart(40, "a")),
      jobsPath(82, 1),
    ]);
  });
});
