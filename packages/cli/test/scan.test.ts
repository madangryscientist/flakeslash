import { describe, expect, it } from "vitest";
import {
  REPO,
  fakeGitHub,
  job,
  jobsOf,
  jobsPath,
  json,
  logPath,
  pullsPath,
  realRoutes,
  run,
  runsOf,
  runsPath,
  shaOf,
} from "../../engine/test/github-fake.ts";
import { SINCE, useScan } from "./scan-harness.ts";

/** The four failed jobs of the real run: attempt 2 first, as a scan reads them (newest run, then attempt). */
const REAL_FAILED = [126063284092, 126063283282, 126058067053, 126057955448];

/** A 404 for each job's log: the log does not matter to the test, and a 404 is stored as expired. */
const expiredLogs = (...jobIds: number[]) =>
  Object.fromEntries(jobIds.map((id) => [logPath(id), json({}, { status: 404 })]));

const realRoutesWithLogs = () => ({ ...realRoutes(), ...expiredLogs(...REAL_FAILED) });

const JOB_URL = `https://github.com/${REPO}/actions/runs/41676366416/job/`;

describe("flakeslash scan: the summary", () => {
  const scan = useScan();

  it("lists each flake with its evidence URLs, as text and as --json", async () => {
    const gh = fakeGitHub(realRoutesWithLogs());

    const first = await scan.exec(["scan", REPO, "--since", SINCE, "--json"], gh);
    expect(first.code).toBe(0);
    expect(first.out.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(first.out);
    expect(Object.keys(parsed)).toEqual(["repos", "explanations"]);
    expect(parsed.explanations).toBeNull();
    const [repo] = parsed.repos;
    expect(repo).toMatchObject({ repo: REPO, cutShort: false, newJobs: 12 });
    expect(repo.oldestRead).toBe("2026-11-03T16:39:07Z");
    expect(repo.flakes).toHaveLength(2);
    const gate = repo.flakes.find((f: { jobName: string }) => f.jobName.startsWith("Gate"));
    expect(gate.commit).toBe("865de4094426ac13811eb7cb2db5d7ccef9ed274");
    expect(gate.evidence.map((e: { url: string }) => e.url)).toContain(`${JOB_URL}126057955448`);
    expect(gate.evidence.map((e: { outcome: string }) => e.outcome)).toEqual(
      expect.arrayContaining(["failed", "passed"]),
    );

    const text = await scan.exec(["scan", REPO, "--since", SINCE], gh);
    expect(text.code).toBe(0);
    expect(text.err).toBe("");
    expect(text.out).toContain(REPO);
    expect(text.out).toContain("2 flaky jobs");
    expect(text.out).toContain("CI / Gate (typecheck, lint, format, test)  865de409");
    expect(text.out).toContain(`failed ${JOB_URL}126057955448`);
    expect(text.out).toMatch(/passed https:\/\/github\.com\/\S+\/job\/\d+/);
  });

  it("reads a run created inside the default 90 days", async () => {
    const created = new Date(Date.now() - 80 * 24 * 3600 * 1000).toISOString();
    const old = new Date(Date.now() - 100 * 24 * 3600 * 1000).toISOString();
    const gh = fakeGitHub({
      [runsPath()]: runsOf(run(1, created), run(2, old)),
      [pullsPath(shaOf(1))]: json([]),
      [jobsPath(1, 1)]: jobsOf(job(11, 1)),
    });
    const result = await scan.exec(["scan", REPO, "--json"], gh);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out).repos[0].newJobs).toBe(1);
  });
});

describe("flakeslash scan: the second scan", () => {
  const scan = useScan();

  it("adds no rows and fetches no finished attempt again, not even a pull request", async () => {
    const gh = fakeGitHub(realRoutesWithLogs());
    await scan.exec(["scan", REPO, "--since", SINCE], gh);
    const before = await scan.rows();
    expect(before).toHaveLength(12);

    gh.paths.length = 0;
    const result = await scan.exec(["scan", REPO, "--since", SINCE], gh);
    expect(result.code).toBe(0);
    expect(result.out).toContain("new jobs: 0");
    expect(gh.paths).toEqual([runsPath()]);
    expect(await scan.rows()).toEqual(before);
  });

  it("treats Owner/Repo and owner/repo as one repo", async () => {
    const gh = fakeGitHub(realRoutesWithLogs());
    await scan.exec(["scan", "Madangryscientist/PixelSlash", "--since", SINCE], gh);
    const before = await scan.rows();
    expect(before).toHaveLength(12);

    gh.paths.length = 0;
    const result = await scan.exec(["scan", REPO, "--since", SINCE, "--json"], gh);
    expect(JSON.parse(result.out).repos[0].newJobs).toBe(0);
    expect(gh.paths).toEqual([runsPath()]);
    expect(await scan.rows()).toHaveLength(12);
  });

  it("picks up a re-run after the first scan and turns the failure into a flake", async () => {
    const gh = fakeGitHub({
      [runsPath()]: runsOf(run(7, "2026-11-04T00:00:00Z", { conclusion: "failure" })),
      [pullsPath(shaOf(7))]: json([]),
      [jobsPath(7, 1)]: jobsOf(job(71, 7, { conclusion: "failure" })),
      ...expiredLogs(71),
    });
    const first = await scan.exec(["scan", REPO, "--since", SINCE, "--json"], gh);
    expect(JSON.parse(first.out).repos[0].flakes).toEqual([]);

    gh.routes[runsPath()] = runsOf(run(7, "2026-11-04T00:00:00Z", { run_attempt: 2 }));
    gh.routes[jobsPath(7, 2)] = jobsOf(job(72, 7));
    gh.paths.length = 0;
    const second = await scan.exec(["scan", REPO, "--since", SINCE, "--json"], gh);
    expect(gh.paths).toEqual([runsPath(), pullsPath(shaOf(7)), jobsPath(7, 2)]);
    const [repo] = JSON.parse(second.out).repos;
    expect(repo.newJobs).toBe(1);
    expect(repo.flakes).toHaveLength(1);
    expect(repo.flakes[0].evidence.map((e: { outcome: string }) => e.outcome)).toEqual([
      "failed",
      "passed",
    ]);
  });

  it("does not fetch the latest attempt of a run in progress, until it completes", async () => {
    const gh = fakeGitHub({
      [runsPath()]: runsOf(
        run(8, "2026-11-04T00:00:00Z", {
          run_attempt: 2,
          status: "in_progress",
          conclusion: null,
        }),
      ),
      [pullsPath(shaOf(8))]: json([]),
      [jobsPath(8, 1)]: jobsOf(job(81, 8, { conclusion: "failure" })),
      ...expiredLogs(81),
    });
    await scan.exec(["scan", REPO, "--since", SINCE], gh);
    expect(gh.paths).toEqual([runsPath(), pullsPath(shaOf(8)), jobsPath(8, 1), logPath(81)]);
    expect((await scan.rows()).map((r) => r.runAttempt)).toEqual([1]);

    gh.routes[runsPath()] = runsOf(run(8, "2026-11-04T00:00:00Z", { run_attempt: 2 }));
    gh.routes[jobsPath(8, 2)] = jobsOf(job(82, 8));
    gh.paths.length = 0;
    const result = await scan.exec(["scan", REPO, "--since", SINCE, "--json"], gh);
    expect(gh.paths).toEqual([runsPath(), pullsPath(shaOf(8)), jobsPath(8, 2)]);
    expect(JSON.parse(result.out).repos[0].flakes).toHaveLength(1);
  });
});

describe("flakeslash scan: usage errors exit 2 and say which", () => {
  const scan = useScan();

  it.each([
    ["no repo", ["scan"], undefined, "at least one repo"],
    [
      "a repo that is not owner/name",
      ["scan", "pixelslash"],
      undefined,
      '"pixelslash" is not a repo',
    ],
    ["no GITHUB_TOKEN", ["scan", REPO], { GITHUB_TOKEN: undefined }, "GITHUB_TOKEN is not set"],
    ["an unknown flag", ["scan", REPO, "--nope"], undefined, 'unknown option "--nope"'],
    ["a flag with no value", ["scan", REPO, "--since"], undefined, "--since needs a value"],
    [
      "a --since that is not a date",
      ["scan", REPO, "--since", "soon"],
      undefined,
      '"soon" is not a date',
    ],
  ])("%s", async (_name, args, env, message) => {
    const result = await scan.exec(args, fakeGitHub({}), env);
    expect(result.code).toBe(2);
    expect(result.err).toContain(message);
    expect(result.out).toBe("");
  });

  it("a repo that does not exist", async () => {
    const fake = fakeGitHub({
      [runsPath("madangryscientist/nope")]: json({ message: "Not Found" }, { status: 404 }),
    });
    const result = await scan.exec(["scan", "madangryscientist/nope"], fake);
    expect(result.code).toBe(2);
    expect(result.err).toContain(
      "madangryscientist/nope was not found, or the token cannot see it",
    );
  });
});

describe("flakeslash scan: failures", () => {
  const scan = useScan();

  it("a provider refusal exits 1 and names the error", async () => {
    const gh = fakeGitHub({ [runsPath()]: json({ message: "refused" }, { status: 403 }) });
    const result = await scan.exec(["scan", REPO, "--since", SINCE], gh);
    expect(result.code).toBe(1);
    expect(result.err).toContain("GitHub answered 403");
  });

  it("a bad token exits 1", async () => {
    const gh = fakeGitHub({ [runsPath()]: json({ message: "Bad credentials" }, { status: 401 }) });
    const result = await scan.exec(["scan", REPO, "--since", SINCE], gh);
    expect(result.code).toBe(1);
    expect(result.err).toContain("GitHub answered 401");
  });

  it("a refusal on the third run keeps the first two and the next scan fetches only the third", async () => {
    const runs = runsOf(
      run(3, "2026-11-04T00:00:00Z"),
      run(2, "2026-11-03T00:00:00Z"),
      run(1, "2026-11-02T00:00:00Z"),
    );
    const gh = fakeGitHub({
      [runsPath()]: runs,
      [pullsPath(shaOf(3))]: json([]),
      [pullsPath(shaOf(2))]: json([]),
      [pullsPath(shaOf(1))]: json([]),
      [jobsPath(3, 1)]: jobsOf(job(31, 3)),
      [jobsPath(2, 1)]: jobsOf(job(21, 2)),
      [jobsPath(1, 1)]: json({ message: "refused" }, { status: 403 }),
    });
    const failed = await scan.exec(["scan", REPO, "--since", SINCE], gh);
    expect(failed.code).toBe(1);
    expect(failed.err).toContain("GitHub answered 403");
    expect((await scan.rows()).map((r) => r.runId)).toEqual([2, 3]);

    gh.routes[jobsPath(1, 1)] = jobsOf(job(11, 1));
    gh.paths.length = 0;
    const next = await scan.exec(["scan", REPO, "--since", SINCE], gh);
    expect(next.code).toBe(0);
    expect(gh.paths).toEqual([runsPath(), pullsPath(shaOf(1)), jobsPath(1, 1)]);
    expect((await scan.rows()).map((r) => r.runId)).toEqual([1, 2, 3]);
  });

  it("still reports the repos finished before an error", async () => {
    const gh = fakeGitHub({
      [runsPath()]: runsOf(),
      [runsPath("madangryscientist/other")]: json({}, { status: 403 }),
    });
    const result = await scan.exec(
      ["scan", REPO, "madangryscientist/other", "--since", SINCE, "--json"],
      gh,
    );
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out).repos.map((r: { repo: string }) => r.repo)).toEqual([REPO]);
    expect(result.err).toContain("GitHub answered 403");
  });
});

describe("flakeslash scan: a rate limit", () => {
  const scan = useScan();

  it("exits 0, says how far it got, and the next scan continues from there", async () => {
    let limited = true;
    const gh = fakeGitHub({
      [runsPath()]: runsOf(
        run(3, "2026-11-04T00:00:00Z"),
        run(2, "2026-11-03T00:00:00Z"),
        run(1, "2026-11-02T00:00:00Z"),
      ),
      [pullsPath(shaOf(3))]: json([]),
      [pullsPath(shaOf(2))]: json([]),
      [pullsPath(shaOf(1))]: json([]),
      [jobsPath(3, 1)]: jobsOf(job(31, 3)),
      [jobsPath(2, 1)]: () =>
        limited
          ? json({}, { status: 429 })
          : jobsOf(job(21, 2, { started_at: "2026-11-03T09:00:00Z" })),
      [jobsPath(1, 1)]: jobsOf(job(11, 1, { started_at: "2026-11-02T09:00:00Z" })),
    });
    const first = await scan.exec(["scan", REPO, "--since", SINCE], gh);
    expect(first.code).toBe(0);
    expect(first.out).toContain("new jobs: 1");
    expect(first.out).toContain("A rate limit stopped the read after 1 new jobs");
    expect(first.out).toContain("oldest read: 2026-11-03T10:00:00Z");
    expect(first.out).toContain("Run the scan again to continue from there.");
    expect((await scan.rows()).map((r) => r.runId)).toEqual([3]);

    const cut = await scan.exec(["scan", REPO, "--since", SINCE, "--json"], gh);
    expect(JSON.parse(cut.out).repos[0]).toMatchObject({ cutShort: true, newJobs: 0 });

    limited = false;
    gh.paths.length = 0;
    const next = await scan.exec(["scan", REPO, "--since", SINCE, "--json"], gh);
    expect(next.code).toBe(0);
    expect(gh.paths).toEqual([
      runsPath(),
      pullsPath(shaOf(2)),
      jobsPath(2, 1),
      pullsPath(shaOf(1)),
      jobsPath(1, 1),
    ]);
    expect(JSON.parse(next.out).repos[0]).toMatchObject({ cutShort: false, newJobs: 2 });
  });
});
