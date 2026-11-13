import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  REPO,
  fakeGitHub,
  job,
  jobsOf,
  jobsPath,
  json,
  pullsPath,
  run,
  runsOf,
  runsPath,
  shaOf,
} from "../../engine/test/github-fake.ts";
import { openSqliteStore } from "../src/store.ts";
import { SINCE, useScan } from "./scan-harness.ts";

const CREATED = "2026-11-04T00:00:00Z";
const jobsRequests = (paths: string[]) => paths.filter((path) => path.includes("/jobs?"));

/** The routes of a run that listed no jobs in its attempt 1. */
const emptyRun = (id: number, extra: Record<string, unknown> = {}) => ({
  run: run(id, CREATED, { conclusion: "cancelled", ...extra }),
  routes: { [pullsPath(shaOf(id))]: json([]), [jobsPath(id, 1)]: jobsOf() },
});

/** The routes of a run whose attempt 1 passed with one job. */
const jobRun = (id: number) => ({
  run: run(id, CREATED),
  routes: { [pullsPath(shaOf(id))]: json([]), [jobsPath(id, 1)]: jobsOf(job(id * 10, id)) },
});

function repoOf(...parts: { run: unknown; routes: Record<string, Response> }[]) {
  return {
    [runsPath()]: runsOf(...parts.map((part) => part.run)),
    ...Object.assign({}, ...parts.map((part) => part.routes)),
  };
}

describe("flakeslash scan: runs that list no jobs", () => {
  const scan = useScan();

  it("fetches an attempt with no jobs once: the second scan makes no request for it", async () => {
    const gh = fakeGitHub(repoOf(emptyRun(1)));
    const first = await scan.exec(["scan", REPO, "--since", SINCE], gh);
    expect(first.code).toBe(0);
    expect(jobsRequests(gh.paths)).toHaveLength(1);

    gh.paths.length = 0;
    const second = await scan.exec(["scan", REPO, "--since", SINCE], gh);
    expect(second.code).toBe(0);
    expect(gh.paths).toEqual([runsPath()]);
    expect(second.out).toContain("runs in the window: 1 read, 1 listed no jobs (1 cancelled)");
  });

  it("holds an attempt whose jobs listing answers 404 the same way", async () => {
    const gh = fakeGitHub(
      repoOf({
        run: run(1, CREATED, { conclusion: "cancelled" }),
        routes: {
          [pullsPath(shaOf(1))]: json([]),
          [jobsPath(1, 1)]: json({ message: "Not Found" }, { status: 404 }),
        },
      }),
    );
    await scan.exec(["scan", REPO, "--since", SINCE], gh);
    expect(jobsRequests(gh.paths)).toHaveLength(1);

    gh.paths.length = 0;
    const second = await scan.exec(["scan", REPO, "--since", SINCE], gh);
    expect(gh.paths).toEqual([runsPath()]);
    expect(second.out).toContain("1 read, 1 listed no jobs (1 cancelled)");
  });

  it("does not hold an attempt a rate limit cut short", async () => {
    const routes = repoOf(emptyRun(1));
    routes[jobsPath(1, 1)] = json({}, { status: 429 });
    const gh = fakeGitHub(routes);
    const cut = await scan.exec(["scan", REPO, "--since", SINCE, "--json"], gh);
    expect(JSON.parse(cut.out).repos[0]).toMatchObject({
      cutShort: true,
      coverage: { read: 0, noJobs: 0 },
    });

    routes[jobsPath(1, 1)] = jobsOf();
    gh.paths.length = 0;
    const again = await scan.exec(["scan", REPO, "--since", SINCE, "--json"], gh);
    expect(jobsRequests(gh.paths)).toHaveLength(1);
    expect(JSON.parse(again.out).repos[0].coverage).toMatchObject({ read: 1, noJobs: 1 });
  });

  it("does not count a run as read or as having no jobs when a later attempt was cut", async () => {
    const routes = repoOf({
      run: run(1, CREATED, { run_attempt: 2 }),
      routes: {
        [pullsPath(shaOf(1))]: json([]),
        [jobsPath(1, 1)]: jobsOf(),
        [jobsPath(1, 2)]: json({}, { status: 429 }),
      },
    });
    const gh = fakeGitHub(routes);
    const cut = await scan.exec(["scan", REPO, "--since", SINCE, "--json"], gh);
    expect(JSON.parse(cut.out).repos[0]).toMatchObject({
      cutShort: true,
      coverage: { read: 0, noJobs: 0 },
    });

    routes[jobsPath(1, 2)] = jobsOf(job(10, 1));
    const again = await scan.exec(["scan", REPO, "--since", SINCE, "--json"], gh);
    expect(JSON.parse(again.out).repos[0].coverage).toMatchObject({ read: 1, noJobs: 0 });
  });

  it("does not hold the latest attempt of a run that has not completed, and counts it as running", async () => {
    const running = {
      run: run(1, CREATED, { status: "in_progress", conclusion: null }),
      routes: {},
    };
    const gh = fakeGitHub(repoOf(running));
    const first = await scan.exec(["scan", REPO, "--since", SINCE, "--json"], gh);
    expect(JSON.parse(first.out).repos[0].coverage).toEqual({
      read: 0,
      noJobs: 0,
      noJobsByConclusion: {},
      stillRunning: 1,
    });
    expect(jobsRequests(gh.paths)).toHaveLength(0);
    expect(await scan.attempts()).toEqual([]);
  });

  it("counts a re-run in progress as running only, whatever its finished attempt 1 listed", async () => {
    const rerun = {
      run: run(1, CREATED, { run_attempt: 2, status: "in_progress", conclusion: null }),
      routes: { [pullsPath(shaOf(1))]: json([]), [jobsPath(1, 1)]: jobsOf() },
    };
    const gh = fakeGitHub(repoOf(rerun));
    const first = await scan.exec(["scan", REPO, "--since", SINCE, "--json"], gh);
    expect(JSON.parse(first.out).repos[0].coverage).toEqual({
      read: 0,
      noJobs: 0,
      noJobsByConclusion: {},
      stillRunning: 1,
    });
    // Attempt 1 is finished, so it is held; attempt 2 is not read.
    expect(jobsRequests(gh.paths)).toEqual([jobsPath(1, 1)]);
    gh.paths.length = 0;
    await scan.exec(["scan", REPO, "--since", SINCE], gh);
    expect(jobsRequests(gh.paths)).toHaveLength(0);
  });

  it("does not call a run empty when it finished after a scan and its attempt 2 was cut", async () => {
    const pulls = { [pullsPath(shaOf(1))]: json([]) };
    const inProgress = {
      run: run(1, CREATED, { run_attempt: 2, status: "in_progress", conclusion: null }),
      routes: { ...pulls, [jobsPath(1, 1)]: jobsOf() },
    };
    const routes = repoOf(inProgress);
    const gh = fakeGitHub(routes);
    await scan.exec(["scan", REPO, "--since", SINCE], gh);

    // The run has finished; attempt 1 is held, attempt 2 hits the rate limit.
    routes[runsPath()] = runsOf(run(1, CREATED, { run_attempt: 2 }));
    routes[jobsPath(1, 2)] = json({}, { status: 429 });
    const cut = await scan.exec(["scan", REPO, "--since", SINCE, "--json"], gh);
    expect(JSON.parse(cut.out).repos[0]).toMatchObject({
      cutShort: true,
      coverage: { read: 0, noJobs: 0 },
    });

    routes[jobsPath(1, 2)] = jobsOf(job(10, 1));
    const again = await scan.exec(["scan", REPO, "--since", SINCE, "--json"], gh);
    expect(JSON.parse(again.out).repos[0].coverage).toMatchObject({ read: 1, noJobs: 0 });
  });

  it("still counts a finished run the store holds when a later scan's listing is cut", async () => {
    const routes = repoOf(emptyRun(1));
    const gh = fakeGitHub(routes);
    await scan.exec(["scan", REPO, "--since", SINCE], gh);

    routes[runsPath()] = json({}, { status: 429 });
    const cut = await scan.exec(["scan", REPO, "--since", SINCE, "--json"], gh);
    expect(JSON.parse(cut.out).repos[0]).toMatchObject({
      cutShort: true,
      coverage: { read: 1, noJobs: 1 },
    });
  });

  it("does not call a run empty when a cut listing never reached it", async () => {
    const rerun = {
      run: run(1, CREATED, { run_attempt: 2, status: "in_progress", conclusion: null }),
      routes: { [pullsPath(shaOf(1))]: json([]), [jobsPath(1, 1)]: jobsOf() },
    };
    const routes = repoOf(rerun);
    const gh = fakeGitHub(routes);
    await scan.exec(["scan", REPO, "--since", SINCE], gh);

    routes[runsPath()] = json({}, { status: 429 });
    const cut = await scan.exec(["scan", REPO, "--since", SINCE, "--json"], gh);
    expect(JSON.parse(cut.out).repos[0]).toMatchObject({
      cutShort: true,
      coverage: { read: 0, noJobs: 0 },
    });
  });

  it("counts a run in progress as running even when a rate limit cuts the read", async () => {
    const rerun = {
      run: run(1, CREATED, { run_attempt: 2, status: "in_progress", conclusion: null }),
      routes: { [pullsPath(shaOf(1))]: json({}, { status: 429 }) },
    };
    const out = await scan.exec(
      ["scan", REPO, "--since", SINCE, "--json"],
      fakeGitHub(repoOf(rerun)),
    );
    expect(JSON.parse(out.out).repos[0]).toMatchObject({
      cutShort: true,
      coverage: { read: 0, stillRunning: 1 },
    });
  });

  it("counts 3 runs with jobs, 2 cancelled with none and 1 running, in the line, --json and report.html", async () => {
    const running = { run: run(6, CREATED, { status: "queued", conclusion: null }), routes: {} };
    const gh = fakeGitHub(
      repoOf(jobRun(1), jobRun(2), jobRun(3), emptyRun(4), emptyRun(5), running),
    );

    const text = await scan.exec(["scan", REPO, "--since", SINCE], gh);
    expect(text.code).toBe(0);
    expect(text.out).toContain(
      "  runs in the window: 5 read, 2 listed no jobs (2 cancelled), 1 still running\n",
    );

    const parsed = JSON.parse(
      (await scan.exec(["scan", REPO, "--since", SINCE, "--json"], gh)).out,
    );
    expect(parsed.repos[0].coverage).toEqual({
      read: 5,
      noJobs: 2,
      noJobsByConclusion: { cancelled: 2 },
      stillRunning: 1,
    });

    const html = readFileSync(join(dirname(scan.storePath()), "report.html"), "utf8");
    expect(html).toContain(
      "runs in the window: 5 read, 2 listed no jobs (2 cancelled), 1 still running",
    );
    expect(html).toContain(REPO);
  });

  it("shows a startup_failure run under its own conclusion", async () => {
    const gh = fakeGitHub(
      repoOf(jobRun(1), emptyRun(2, { conclusion: "startup_failure" }), emptyRun(3), emptyRun(4)),
    );
    const out = await scan.exec(["scan", REPO, "--since", SINCE], gh);
    expect(out.out).toContain(
      "runs in the window: 4 read, 3 listed no jobs (2 cancelled, 1 startup_failure), 0 still running",
    );
  });

  it("does not count a run as listing no jobs when a later attempt listed jobs", async () => {
    const rerun = {
      run: run(1, CREATED, { run_attempt: 2 }),
      routes: {
        [pullsPath(shaOf(1))]: json([]),
        [jobsPath(1, 1)]: jobsOf(),
        [jobsPath(1, 2)]: jobsOf(job(10, 1, { run_attempt: 2 })),
      },
    };
    const gh = fakeGitHub(repoOf(rerun, emptyRun(2)));
    const out = await scan.exec(["scan", REPO, "--since", SINCE], gh);
    expect(out.out).toContain("runs in the window: 2 read, 1 listed no jobs (1 cancelled)");
  });

  it("works on a store made before the attempts table, adding the table without losing jobs", async () => {
    const gh = fakeGitHub(repoOf(jobRun(1), emptyRun(2)));
    await scan.exec(["scan", REPO, "--since", SINCE], gh);
    const raw = new Database(scan.storePath());
    raw.exec("DROP TABLE attempts");
    raw.close();

    gh.paths.length = 0;
    const out = await scan.exec(["scan", REPO, "--since", SINCE, "--json"], gh);
    expect(out.code).toBe(0);
    // The jobs are held, so only the attempt with no jobs is fetched again.
    expect(jobsRequests(gh.paths)).toEqual([jobsPath(2, 1)]);
    expect(JSON.parse(out.out).repos[0].coverage).toMatchObject({ read: 2, noJobs: 1 });
    expect(await scan.rows()).toHaveLength(1);
  });

  it("never returns an attempts row from readJobs", async () => {
    const store = openSqliteStore(scan.storePath(), { durable: false });
    try {
      await store.writeAttempts([
        {
          repo: REPO,
          runId: 1,
          runAttempt: 1,
          conclusion: "cancelled",
          createdAt: CREATED,
          latestAttempt: 1,
          jobCount: 0,
        },
      ]);
      expect(await store.readJobs(REPO)).toEqual([]);
      expect(await store.heldAttempts(REPO)).toEqual([{ runId: 1, runAttempt: 1 }]);
    } finally {
      store.close();
    }
  });
});
