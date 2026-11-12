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

const FAILED_SHA = shaOf(1);
const PASSED_SHA = shaOf(2);
const COMPARE = `/repos/${REPO}/compare/${FAILED_SHA}...${PASSED_SHA}`;

/**
 * A branch whose job failed on its first commit, naming `e2e/upload.spec.ts`, and passed on the next.
 * The compare lists `src/other.ts`, so the failure is a suspect.
 */
function suspectRoutes() {
  return {
    [runsPath()]: runsOf(
      run(2, "2026-11-05T00:00:00Z", { head_branch: "feature/upload", conclusion: "success" }),
      run(1, "2026-11-04T00:00:00Z", {
        head_branch: "feature/upload",
        conclusion: "failure",
      }),
    ),
    [pullsPath(FAILED_SHA)]: json([]),
    [pullsPath(PASSED_SHA)]: json([]),
    [jobsPath(1, 1)]: jobsOf(
      job(10, 1, {
        name: "E2E",
        conclusion: "failure",
        started_at: "2026-11-04T10:00:00Z",
        html_url: `https://github.com/${REPO}/actions/runs/1/job/10`,
      }),
    ),
    [jobsPath(2, 1)]: jobsOf(
      job(20, 2, {
        name: "E2E",
        started_at: "2026-11-05T10:00:00Z",
        html_url: `https://github.com/${REPO}/actions/runs/2/job/20`,
      }),
    ),
    [logPath(10)]: text(playwrightLog(["uploads a file", "Timeout while uploading"])),
    [COMPARE]: json({ files: [{ filename: "src/other.ts" }] }),
  };
}

describe("flakeslash scan: suspects", () => {
  const scan = useScan();

  it("labels the suspect, stores the compare, and a second scan asks GitHub for it no more", async () => {
    const gh = fakeGitHub(suspectRoutes());

    const first = await scan.exec(["scan", REPO, "--since", SINCE, "--json"], gh);
    expect(first.code).toBe(0);
    const [repo] = JSON.parse(first.out).repos;
    expect(repo.flakes).toEqual([]);
    expect(repo.suspects).toEqual([
      expect.objectContaining({
        kind: "suspect",
        commit: FAILED_SHA,
        nextCommit: PASSED_SHA,
        files: ["e2e/upload.spec.ts"],
      }),
    ]);
    expect(gh.paths.filter((path) => path === COMPARE)).toHaveLength(1);

    const second = await scan.exec(["scan", REPO, "--since", SINCE, "--json"], gh);
    expect(second.code).toBe(0);
    expect(JSON.parse(second.out).repos[0].suspects).toHaveLength(1);
    expect(gh.paths.filter((path) => path === COMPARE)).toHaveLength(1);

    const listed = await scan.exec(["scan", REPO, "--since", SINCE], gh);
    expect(listed.out).toContain("1 suspect (likely flaky, no proof):");
    expect(listed.out).toContain(`CI / E2E  ${FAILED_SHA.slice(0, 8)}..${PASSED_SHA.slice(0, 8)}`);
  });
});
