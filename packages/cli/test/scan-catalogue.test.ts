import { readFileSync } from "node:fs";
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
  run,
  runsOf,
  runsPath,
  shaOf,
  type Reply,
} from "../../engine/test/github-fake.ts";
import { SINCE, useScan } from "./scan-harness.ts";

const OTHER = "madangryscientist/hackcove";

const text = (body: string, status = 200): Response => new Response(body, { status });

/** A Playwright log of failed tests: `[title, error line]` pairs, each a numbered block. */
function playwrightLog(...tests: [string, string][]): string {
  return [
    "##[group]Run bunx playwright test",
    ...tests.flatMap(([title, error], at) => [
      `  ${at + 1}) [chromium] › e2e/upload.spec.ts:${141 + at}:1 › ${title} ──────────────`,
      "",
      `    ${error}`,
      "",
    ]),
    `  ${tests.length} failed`,
    "##[error]Process completed with exit code 1.",
    "##[endgroup]",
  ].join("\n");
}

/** One run of `repo` with one failed job (its `CI / Gate`) whose log is `log`. */
function failedRun(
  repo: string,
  runId: number,
  log: Reply,
  extra: { run?: Record<string, unknown>; job?: Record<string, unknown> } = {},
): Record<string, { run: unknown; routes: Record<string, Reply> }> {
  const jobId = runId * 10;
  return {
    [repo]: {
      run: run(runId, "2026-11-04T00:00:00Z", { conclusion: "failure", ...extra.run }),
      routes: {
        [pullsPath(shaOf(runId), repo)]: json([]),
        [jobsPath(runId, 1, repo)]: jobsOf(
          job(jobId, runId, {
            conclusion: "failure",
            html_url: `https://github.com/${repo}/actions/runs/${runId}/job/${jobId}`,
            ...extra.job,
          }),
        ),
        [logPath(jobId, repo)]: log,
      },
    },
  };
}

/** The routes of a set of runs, each `[repo, runId, log]`, with the run listing of each repo. */
function routesOf(...runs: [string, number, Reply][]): Record<string, Reply> {
  const routes: Record<string, Reply> = {};
  const byRepo = new Map<string, unknown[]>();
  for (const [repo, runId, log] of runs) {
    const made = failedRun(repo, runId, log)[repo];
    if (made === undefined) continue;
    Object.assign(routes, made.routes);
    byRepo.set(repo, [...(byRepo.get(repo) ?? []), made.run]);
  }
  for (const [repo, list] of byRepo) routes[runsPath(repo)] = runsOf(...list);
  return routes;
}

describe("flakeslash scan: failures grouped into issues", () => {
  const scan = useScan();

  it("joins the same crash with other ports and times, and keeps two different errors apart", async () => {
    const gh = fakeGitHub(
      routesOf(
        [
          REPO,
          1,
          text(
            playwrightLog([
              "uploads a file",
              "Error: connect ECONNREFUSED 127.0.0.1:3001 at 2026-11-04T10:00:01Z",
            ]),
          ),
        ],
        [
          REPO,
          2,
          text(
            playwrightLog([
              "uploads a file",
              "Error: connect ECONNREFUSED 127.0.0.1:48212 at 2026-11-05T22:41:09Z",
            ]),
          ),
        ],
        [REPO, 3, text(playwrightLog(["uploads a file", "Error: expected 1 to be 2"]))],
      ),
    );
    const result = await scan.exec(["scan", REPO, "--since", SINCE], gh);
    expect(result.code).toBe(0);
    expect(result.out).toContain("new failures: 3 in 2 issues");

    const issues = await scan.issues();
    expect(issues).toHaveLength(2);
    expect(issues.every((issue) => issue.kind === "other" && issue.status === "potential")).toBe(
      true,
    );
    const failures = await scan.failures();
    expect(failures).toHaveLength(3);
    const byJob = new Map(failures.map((failure) => [failure.jobId, failure.issueId]));
    expect(byJob.get(10)).toBe(byJob.get(20));
    expect(byJob.get(30)).not.toBe(byJob.get(10));
    expect(issues.find((issue) => issue.id === byJob.get(10))?.name).toBe(
      "e2e/upload.spec.ts:141: uploads a file",
    );
  });

  it("names a known crash by what it is, in one issue across both repos", async () => {
    const crash = text(playwrightLog(["opens the page", "Error: page.goto: Page crashed"]));
    const gh = fakeGitHub(routesOf([REPO, 1, crash], [OTHER, 2, crash]));
    const result = await scan.exec(["scan", REPO, OTHER, "--since", SINCE], gh);
    expect(result.code).toBe(0);

    expect(await scan.issues()).toEqual([
      {
        id: "starter:Page crashed",
        name: "Page crashed",
        kind: "browser-crash",
        status: "potential",
        signatures: [{ type: "pattern", all: ["Page crashed"] }],
      },
    ]);
    const failures = await scan.failures();
    expect(failures.map((failure) => failure.repo).toSorted()).toEqual([OTHER, REPO]);
    expect(new Set(failures.map((failure) => failure.issueId))).toEqual(
      new Set(["starter:Page crashed"]),
    );
  });

  it("puts one error found in two repos in one issue that lists both repos", async () => {
    const log = text(
      playwrightLog(["uploads a file", "Error: connect ECONNREFUSED 127.0.0.1:3001"]),
    );
    const gh = fakeGitHub(routesOf([REPO, 1, log], [OTHER, 2, log]));
    await scan.exec(["scan", REPO, OTHER, "--since", SINCE], gh);

    const issues = await scan.issues();
    expect(issues).toHaveLength(1);
    const failures = (await scan.failures()).filter((failure) => failure.issueId === issues[0]?.id);
    expect(failures.map((failure) => failure.repo).toSorted()).toEqual([OTHER, REPO]);
  });

  it("adds no failures and no issues when the scan is run again", async () => {
    const gh = fakeGitHub(
      routesOf(
        [REPO, 1, text(playwrightLog(["a", "Error: one"], ["b", "Error: two"]))],
        [REPO, 2, json({}, { status: 404 })],
      ),
    );
    const first = await scan.exec(["scan", REPO, "--since", SINCE, "--json"], gh);
    const before = { issues: await scan.issues(), failures: await scan.failures() };
    expect(before.failures).toHaveLength(3);
    expect(JSON.parse(first.out).repos[0]).toMatchObject({ newFailures: 3, issuesTouched: 3 });

    const second = await scan.exec(["scan", REPO, "--since", SINCE, "--json"], gh);
    expect(JSON.parse(second.out).repos[0]).toMatchObject({ newFailures: 0, issuesTouched: 0 });
    expect({ issues: await scan.issues(), failures: await scan.failures() }).toEqual(before);
  });

  it("gives a job with two failing tests two failures in two issues", async () => {
    const gh = fakeGitHub(
      routesOf([REPO, 1, text(playwrightLog(["first", "Error: one"], ["second", "Error: two"]))]),
    );
    await scan.exec(["scan", REPO, "--since", SINCE], gh);

    const failures = await scan.failures();
    expect(failures.map((failure) => failure.jobId)).toEqual([10, 10]);
    expect(new Set(failures.map((failure) => failure.issueId)).size).toBe(2);
    expect(await scan.issues()).toHaveLength(2);
  });

  it("does not pull a job's other failing tests into a crash in one of them", async () => {
    const gh = fakeGitHub(
      routesOf([
        REPO,
        1,
        text(playwrightLog(["crashes", "Error: page.goto: Page crashed"], ["fails", "Error: one"])),
      ]),
    );
    await scan.exec(["scan", REPO, "--since", SINCE], gh);

    const issueOf = new Map((await scan.failures()).map((f) => [f.title, f.issueId]));
    expect(issueOf.get("crashes")).toBe("starter:Page crashed");
    expect(issueOf.get("fails")).toMatch(/^key:/);
  });

  it("makes a failure of a failed job with no log, keyed on the job", async () => {
    const gh = fakeGitHub(routesOf([REPO, 1, json({}, { status: 404 })]));
    const result = await scan.exec(["scan", REPO, "--since", SINCE], gh);
    expect(result.out).toContain("new failures: 1 in 1 issues");

    const [failure] = await scan.failures();
    expect(failure).toMatchObject({ jobId: 10, file: null, title: null, errorLine: "" });
    const [issue] = await scan.issues();
    expect(issue).toMatchObject({
      id: `key:${failure?.signature}`,
      name: "CI: Gate",
      kind: "other",
    });
  });

  it("calls a job with no log runner-died when its record shows the runner was lost", async () => {
    const annotations = JSON.parse(
      readFileSync(
        new URL("../../engine/test/fixtures/annotations-lost-runner.json", import.meta.url),
        "utf8",
      ),
    );
    const gh = fakeGitHub({
      [runsPath()]: runsOf(run(1, "2026-11-04T00:00:00Z", { conclusion: "cancelled" })),
      [pullsPath(shaOf(1))]: json([]),
      [jobsPath(1, 1)]: jobsOf(job(10, 1, { conclusion: "cancelled" })),
      [`/repos/${REPO}/check-runs/10/annotations?per_page=100`]: json(annotations),
      [logPath(10)]: json({}, { status: 404 }),
    });
    await scan.exec(["scan", REPO, "--since", SINCE], gh);

    const [failure] = await scan.failures();
    expect(failure?.issueId).toBe("starter:Runner shutdown signal");
    expect(await scan.issues()).toMatchObject([{ kind: "runner-died" }]);
  });

  it("confirms an issue with a proven flake, leaves one with no proof, and never moves one back", async () => {
    const sha = shaOf(1);
    const ghRoutes = {
      [runsPath()]: runsOf(
        run(1, "2026-11-04T00:00:00Z", { conclusion: "failure", head_sha: sha }),
        run(2, "2026-11-04T01:00:00Z", { head_sha: sha }),
        run(3, "2026-11-04T02:00:00Z", { conclusion: "failure" }),
      ),
      [pullsPath(sha)]: json([]),
      [pullsPath(shaOf(3))]: json([]),
      [jobsPath(1, 1)]: jobsOf(job(10, 1, { conclusion: "failure", head_sha: sha })),
      [jobsPath(2, 1)]: jobsOf(job(20, 2, { head_sha: sha })),
      [jobsPath(3, 1)]: jobsOf(job(30, 3, { conclusion: "failure", name: "Other" })),
      [logPath(10)]: text(playwrightLog(["flaky", "Error: timed out"])),
      [logPath(30)]: text(playwrightLog(["solid", "Error: really broken"])),
    };
    const gh = fakeGitHub(ghRoutes);
    await scan.exec(["scan", REPO, "--since", SINCE], gh);

    const statusOf = async () =>
      Object.fromEntries((await scan.issues()).map((issue) => [issue.name, issue.status]));
    expect(await statusOf()).toEqual({
      "e2e/upload.spec.ts:141: flaky": "confirmed",
      "e2e/upload.spec.ts:141: solid": "potential",
    });

    await scan.exec(["scan", REPO, "--since", SINCE], gh);
    expect(await statusOf()).toEqual({
      "e2e/upload.spec.ts:141: flaky": "confirmed",
      "e2e/upload.spec.ts:141: solid": "potential",
    });
  });

  it("waits for the log of a job GitHub said try later on, rather than guessing", async () => {
    const gh = fakeGitHub(routesOf([REPO, 1, json({}, { status: 429 })]));
    const result = await scan.exec(["scan", REPO, "--since", SINCE], gh);
    expect(result.out).toContain("new failures: 0 in 0 issues");
    expect(await scan.failures()).toEqual([]);
  });
});
