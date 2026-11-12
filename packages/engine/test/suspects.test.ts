import { describe, expect, it } from "vitest";
import {
  findJobFlakes,
  findSuspects,
  flakeRates,
  type Compare,
  type CompareResult,
  type Failure,
  type JobRecord,
} from "../src/index.ts";

const REPO = "madangryscientist/pixelslash";
const FAIL_SHA = "1111111111111111111111111111111111111111";
const NEXT_SHA = "2222222222222222222222222222222222222222";
const BRANCH = "feature/upload";

function record(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    repo: REPO,
    workflow: "CI",
    jobName: "E2E",
    jobId: 10,
    url: "https://github.com/madangryscientist/pixelslash/actions/runs/1/job/10",
    commit: FAIL_SHA,
    branch: BRANCH,
    prNumber: null,
    provider: "github-actions",
    runner: "github-hosted",
    runnerName: "GitHub Actions 2",
    runId: 1,
    runAttempt: 1,
    conclusion: "failure",
    startedAt: "2026-11-04T10:00:00Z",
    completedAt: "2026-11-04T10:05:00Z",
    steps: [],
    annotations: [],
    ...overrides,
  };
}

/** A job that failed on FAIL_SHA, and passed on NEXT_SHA, the next commit of its branch. */
function failThenPass(jobName = "E2E", jobId = 10): JobRecord[] {
  const failed = record({ jobName, jobId, url: `https://example.test/run/1/job/${jobId}` });
  const passed = record({
    jobName,
    jobId: jobId + 1,
    url: `https://example.test/run/2/job/${jobId + 1}`,
    commit: NEXT_SHA,
    runId: 2,
    conclusion: "success",
    startedAt: "2026-11-05T10:00:00Z",
  });
  return [failed, passed];
}

/** The failure the log named for a job's page: a test in `file`. */
function failureAt(url: string, file: string): Failure {
  return {
    repo: REPO,
    jobId: Number(url.split("/").pop()),
    url,
    signature: `sig-${file}`,
    issueId: "key:aaaaaaaa11112222",
    file,
    title: "uploads a file",
    location: `${file}:12:1`,
    errorLine: "Timeout",
  };
}

/** A compare fake: the files it lists for every pair, counting its calls. */
function countingCompare(files: string[]): { compare: Compare; calls: string[] } {
  const calls: string[] = [];
  const compare: Compare = async (repo, base, head) => {
    calls.push(`${repo} ${base} ${head}`);
    return { status: "ok", files };
  };
  return { compare, calls };
}

describe("findSuspects", () => {
  it("labels a failure with no proof a suspect when the next commit passed and the compare misses its file", async () => {
    const records = failThenPass();
    const failures = [failureAt(records[0]?.url ?? "", "e2e/upload.spec.ts")];
    const { compare, calls } = countingCompare(["src/other.ts"]);

    const suspects = await findSuspects(records, failures, compare);

    expect(suspects).toEqual([
      {
        kind: "suspect",
        repo: REPO,
        workflow: "CI",
        jobName: "E2E",
        branch: BRANCH,
        commit: FAIL_SHA,
        nextCommit: NEXT_SHA,
        failedUrl: "https://example.test/run/1/job/10",
        passedUrl: "https://example.test/run/2/job/11",
        files: ["e2e/upload.spec.ts"],
      },
    ]);
    expect(calls).toEqual([`${REPO} ${FAIL_SHA} ${NEXT_SHA}`]);
  });

  it("is not a suspect when the compare touches the failing test's file, under any path that ends in it", async () => {
    const records = failThenPass();
    const failures = [failureAt(records[0]?.url ?? "", "e2e/upload.spec.ts")];

    for (const touched of [
      "e2e/upload.spec.ts",
      "pkg/e2e/upload.spec.ts",
      "./e2e/upload.spec.ts",
    ]) {
      const { compare } = countingCompare([touched, "src/other.ts"]);
      expect(await findSuspects(records, failures, compare)).toEqual([]);
    }
  });

  it("a suspect is no flake: it never reaches the flake rule, so the job's rate has no flaky commit", async () => {
    const records = failThenPass();
    const failures = [failureAt(records[0]?.url ?? "", "e2e/upload.spec.ts")];
    const { compare } = countingCompare(["src/other.ts"]);

    const suspects = await findSuspects(records, failures, compare);
    const flakes = findJobFlakes(records);
    const rows = flakeRates(records, flakes, { now: "2026-11-12T00:00:00Z" });

    expect(suspects).toHaveLength(1);
    expect(flakes).toEqual([]);
    expect(rows).toEqual([
      expect.objectContaining({ jobName: "E2E", test: null, commits: 2, flakyCommits: 0 }),
    ]);
  });

  it("asks GitHub for a pair of commits at most once per call, however many failing jobs share it", async () => {
    const first = failThenPass("E2E", 10);
    const second = failThenPass("Lint", 20);
    const records = [...first, ...second];
    const failures = [
      failureAt(first[0]?.url ?? "", "e2e/upload.spec.ts"),
      failureAt(second[0]?.url ?? "", "e2e/lint.spec.ts"),
    ];
    const { compare, calls } = countingCompare(["src/other.ts"]);

    const suspects = await findSuspects(records, failures, compare);

    expect(suspects.map((suspect) => suspect.jobName)).toEqual(["E2E", "Lint"]);
    expect(calls).toEqual([`${REPO} ${FAIL_SHA} ${NEXT_SHA}`]);
  });

  it("is not a suspect when the compare cannot say what changed, or lists 300 files or more", async () => {
    const records = failThenPass();
    const failures = [failureAt(records[0]?.url ?? "", "e2e/upload.spec.ts")];
    const answers: CompareResult[] = [
      { status: "missing" },
      { status: "rate-limited" },
      { status: "ok", files: Array.from({ length: 300 }, (_, at) => `src/f${at}.ts`) },
    ];
    for (const answer of answers) {
      const compare: Compare = async () => answer;
      expect(await findSuspects(records, failures, compare)).toEqual([]);
    }
  });
});
