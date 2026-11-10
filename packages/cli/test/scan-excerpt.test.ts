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

// Secret-shaped values are joined from parts, so this file holds no literal a secret scanner flags.
const joined = (...parts: string[]): string => parts.join("");
const ESC = String.fromCharCode(27);

const GITHUB_TOKEN = joined("ghp_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8");
const STRADDLING_TOKEN = joined("ghs_", "Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2");
const AWS_KEY_ID = joined("AKIA", "IOSFODNN7EXAMPLE");
const URL_PASSWORD = "hunter2";
const FAILURE = "Error: expected 1 to be 2";
const PASSING_MARKER = "MARKER-passing-step-7f3a9c1e";

/** The excerpt cut is this long (excerpt.ts). The straddling token starts 15 characters before it. */
const CUT_AT = 25_000;

/**
 * A log of a failed job: a passing step, then a failed one. Its lines all hold "error", so the cut
 * keeps every one, in order. The planted secrets sit near the failure; the last token starts 15
 * characters before the 25,000th character of the failed step, which is where the cut falls.
 */
function plantedLog(): string {
  const failedStart = [
    "##[group]Run bun run check",
    FAILURE,
    `error: using token ${GITHUB_TOKEN} to push`,
    `error: aws id ${AWS_KEY_ID.slice(0, 4)}${ESC}[0m${AWS_KEY_ID.slice(4)} rejected`,
    `error: clone https://bob:${URL_PASSWORD}@github.com/x/y.git failed`,
  ];
  const lines = [...failedStart];
  // Lengths are those of the cleaned text: the colour code is removed before anything is cut.
  const length = () => lines.join("\n").replaceAll(`${ESC}[0m`, "").length;
  for (let n = 0; length() < CUT_AT - 15 - 40; n += 1) lines.push(`error: retry ${n} timed out`);
  const lead = "error: leaked ";
  const pad = CUT_AT - 15 - length() - 1 - lead.length - 1;
  // The space keeps the padding from joining the token into one long run.
  lines.push(`${lead}${"x".repeat(pad)} ${STRADDLING_TOKEN} end`);
  lines.push("##[error]Process completed with exit code 1.");
  return [
    "##[group]Run bun install",
    PASSING_MARKER,
    "installed 28 packages",
    "##[endgroup]",
    ...lines,
  ].join("\n");
}

/** One run with one failed job, whose log route is `log`. */
function failedJobRoutes(jobId: number, log: Reply, runId = jobId) {
  return {
    [runsPath()]: runsOf(run(runId, "2026-11-04T00:00:00Z", { conclusion: "failure" })),
    [pullsPath(shaOf(runId))]: json([]),
    [jobsPath(runId, 1)]: jobsOf(job(jobId, runId, { conclusion: "failure" })),
    [logPath(jobId)]: log,
  };
}

const text = (body: string, status = 200): Response => new Response(body, { status });

describe("flakeslash scan: the excerpt of a failed job", () => {
  const scan = useScan();

  it("keeps the failure and none of the secrets, including one across the cut point", async () => {
    const log = plantedLog();
    // The test is only meaningful if the token would have been cut in two by cutting first.
    const cleaned = log
      .slice(log.indexOf("##[group]Run bun run check"))
      .replaceAll(`${ESC}[0m`, "");
    expect(cleaned.indexOf(STRADDLING_TOKEN)).toBe(CUT_AT - 15);

    const gh = fakeGitHub(failedJobRoutes(51, text(log)));
    const result = await scan.exec(["scan", REPO, "--since", SINCE], gh);
    expect(result.code).toBe(0);
    expect(result.out).toContain("logs kept: 1, expired: 0");

    const [row] = await scan.excerpts();
    expect(row?.status).toBe("kept");
    const excerpt = row?.excerpt ?? "";
    expect(excerpt).toContain(FAILURE);
    expect(excerpt).toContain("[redacted]");
    expect(excerpt.length).toBeLessThanOrEqual(CUT_AT);
    for (const secret of [GITHUB_TOKEN, AWS_KEY_ID, URL_PASSWORD, STRADDLING_TOKEN]) {
      expect(excerpt).not.toContain(secret);
    }
    // Not even a piece of the straddling token: the 15 characters a cut-first order would leave.
    for (let at = 0; at + 10 <= STRADDLING_TOKEN.length; at += 1) {
      expect(excerpt).not.toContain(STRADDLING_TOKEN.slice(at, at + 10));
    }
  });

  it("stores the excerpt and the link to the job, and never the whole log", async () => {
    const gh = fakeGitHub(failedJobRoutes(51, text(plantedLog())));
    await scan.exec(["scan", REPO, "--since", SINCE], gh);

    const [row] = await scan.excerpts();
    expect(row).toMatchObject({
      repo: REPO,
      jobId: 51,
      url: `https://github.com/${REPO}/actions/runs/51/job/51`,
      status: "kept",
    });
    expect(row?.excerpt).toContain(FAILURE);
    expect(row?.excerpt).not.toContain(PASSING_MARKER);

    const bytes = readFileSync(scan.storePath()).toString("latin1");
    expect(bytes).not.toContain(PASSING_MARKER);
    expect(bytes).toContain(FAILURE);
  });

  it("a re-scan fetches no log for a job that has an excerpt, kept or gone", async () => {
    const gh = fakeGitHub({
      [runsPath()]: runsOf(run(5, "2026-11-04T00:00:00Z", { conclusion: "failure" })),
      [pullsPath(shaOf(5))]: json([]),
      [jobsPath(5, 1)]: jobsOf(
        job(51, 5, { conclusion: "failure" }),
        job(52, 5, { conclusion: "failure", name: "Other" }),
      ),
      [logPath(51)]: text(plantedLog()),
      [logPath(52)]: json({}, { status: 404 }),
    });
    const first = await scan.exec(["scan", REPO, "--since", SINCE], gh);
    expect(first.out).toContain("logs kept: 1, expired: 1");
    expect(gh.paths).toContain(logPath(51));
    expect(gh.paths).toContain(logPath(52));

    gh.paths.length = 0;
    const second = await scan.exec(["scan", REPO, "--since", SINCE], gh);
    expect(second.code).toBe(0);
    expect(gh.paths).toEqual([runsPath()]);
    expect(second.out).toContain("logs kept: 0, expired: 0");
    expect((await scan.excerpts()).map((row) => [row.jobId, row.status])).toEqual([
      [51, "kept"],
      [52, "gone"],
    ]);
  });

  it("records an expired log as gone and carries on to the next log", async () => {
    const gh = fakeGitHub({
      [runsPath()]: runsOf(run(5, "2026-11-04T00:00:00Z", { conclusion: "failure" })),
      [pullsPath(shaOf(5))]: json([]),
      [jobsPath(5, 1)]: jobsOf(
        job(51, 5, { conclusion: "failure" }),
        job(52, 5, { conclusion: "failure", name: "Other" }),
      ),
      [logPath(52)]: text("gone", 410),
      [logPath(51)]: text(plantedLog()),
    });
    const result = await scan.exec(["scan", REPO, "--since", SINCE], gh);
    expect(result.code).toBe(0);
    expect(result.out).toContain("logs kept: 1, expired: 1");
    expect(result.out).not.toContain("logs left");
    // Newest first: job 52 is read first, then the scan goes on to job 51.
    expect(gh.paths.filter((path) => path.includes("/logs"))).toEqual([logPath(52), logPath(51)]);
    const rows = await scan.excerpts();
    expect(rows.find((row) => row.jobId === 52)).toMatchObject({ status: "gone", excerpt: null });
    expect(rows.find((row) => row.jobId === 51)?.status).toBe("kept");
  });

  it("does not record a try-later log as gone, counts it, and the next scan fetches it", async () => {
    const gh = fakeGitHub({
      [runsPath()]: runsOf(run(5, "2026-11-04T00:00:00Z", { conclusion: "failure" })),
      [pullsPath(shaOf(5))]: json([]),
      [jobsPath(5, 1)]: jobsOf(
        job(51, 5, { conclusion: "failure" }),
        job(52, 5, { conclusion: "failure", name: "Other" }),
      ),
      [logPath(52)]: text("unavailable", 503),
      [logPath(51)]: text(plantedLog()),
    });
    const first = await scan.exec(["scan", REPO, "--since", SINCE], gh);
    expect(first.code).toBe(0);
    expect(first.out).toContain("logs kept: 0, expired: 0");
    expect(first.out).toContain("2 logs left for the next scan (GitHub said try later)");
    // The first try-later ends the reading, so job 51's log is not asked for either.
    expect(gh.paths.filter((path) => path.includes("/logs"))).toEqual([logPath(52)]);
    expect(await scan.excerpts()).toEqual([]);

    gh.routes[logPath(52)] = text(plantedLog());
    gh.paths.length = 0;
    const next = await scan.exec(["scan", REPO, "--since", SINCE], gh);
    expect(next.code).toBe(0);
    expect(next.out).toContain("logs kept: 2, expired: 0");
    expect(next.out).not.toContain("logs left");
    expect(gh.paths).toEqual([runsPath(), logPath(52), logPath(51)]);
    expect((await scan.excerpts()).map((row) => row.status)).toEqual(["kept", "kept"]);
  });

  it("reads no log when a rate limit cut the read short, and says how many are left", async () => {
    let limited = true;
    const gh = fakeGitHub({
      [runsPath()]: runsOf(
        run(2, "2026-11-04T00:00:00Z", { conclusion: "failure" }),
        run(1, "2026-11-03T00:00:00Z"),
      ),
      [pullsPath(shaOf(2))]: json([]),
      [pullsPath(shaOf(1))]: json([]),
      [jobsPath(2, 1)]: jobsOf(job(21, 2, { conclusion: "failure" })),
      [jobsPath(1, 1)]: () => (limited ? json({}, { status: 429 }) : jobsOf(job(11, 1))),
      [logPath(21)]: text(plantedLog()),
    });
    const first = await scan.exec(["scan", REPO, "--since", SINCE], gh);
    expect(first.code).toBe(0);
    expect(first.out).toContain("1 logs left for the next scan (GitHub said try later)");
    expect(first.out).toContain("A rate limit stopped the read");
    expect(gh.paths).not.toContain(logPath(21));

    limited = false;
    const next = await scan.exec(["scan", REPO, "--since", SINCE], gh);
    expect(next.out).toContain("logs kept: 1, expired: 0");
    expect(gh.paths).toContain(logPath(21));
  });
});
