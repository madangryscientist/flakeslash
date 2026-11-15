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
} from "../../engine/test/github-fake.ts";
import { SINCE, playwrightLog, text, useScan } from "./scan-harness.ts";

/**
 * One run: `Gate` fails a test from 10:00 to 10:01, then `Merge Reports` fails at 10:02 naming none. A
 * rerun on the same commit passes both, so the test's failure is a proven flake and is ranked.
 */
function gatherRun() {
  const runId = 1;
  const gate = job(10, runId, {
    conclusion: "failure",
    started_at: "2026-11-03T10:00:00Z",
    completed_at: "2026-11-03T10:01:00Z",
  });
  const merge = job(11, runId, {
    name: "Merge Reports",
    conclusion: "failure",
    started_at: "2026-11-03T10:02:00Z",
    completed_at: "2026-11-03T10:03:00Z",
  });
  const rerunId = 2;
  const sha = shaOf(runId);
  const passed = { head_sha: sha, started_at: "2026-11-03T11:00:00Z" };
  return fakeGitHub({
    [runsPath()]: runsOf(
      run(runId, "2026-11-03T09:59:00Z", { conclusion: "failure" }),
      run(rerunId, "2026-11-03T10:59:00Z", { head_sha: sha }),
    ),
    [pullsPath(sha)]: json([]),
    [jobsPath(runId, 1)]: jobsOf(gate, merge),
    [jobsPath(rerunId, 1)]: jobsOf(
      job(20, rerunId, passed),
      job(21, rerunId, { ...passed, name: "Merge Reports" }),
    ),
    [logPath(10)]: text(playwrightLog(["uploads a file", "Error: expected 1 to be 2"])),
    [logPath(11)]: text("##[error]Process completed with exit code 1."),
  });
}

describe("flakeslash scan: a job that failed because another job did", () => {
  const scan = useScan();

  it("says how many failed jobs it left out", async () => {
    const result = await scan.exec(["scan", REPO, "--since", SINCE], gatherRun());
    expect(result.code).toBe(0);
    expect(result.out).toContain("followed another job's failure: 1 failed job, not counted");
  });

  it("lists the follow-on jobs on the scan in --json and ranks only the test's issue", async () => {
    const result = await scan.exec(["scan", REPO, "--since", SINCE, "--json"], gatherRun());
    expect(result.code).toBe(0);
    const { repos, catalogue } = JSON.parse(result.out);
    expect(repos[0].followOn).toEqual([`${REPO}:11`]);
    expect(catalogue.map((entry: { name: string }) => entry.name)).toEqual([
      "e2e/upload.spec.ts:141: uploads a file",
    ]);
  });
});
