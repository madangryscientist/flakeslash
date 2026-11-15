/** Catalogue rows as D1 holds them, for tests that write them straight into `testDb()`. */

/** A failed job on commit `c1` of `main`. */
export function jobRow(orgId: number, repo: string, jobId: number) {
  return {
    orgId,
    provider: "github-actions",
    repo,
    runId: jobId,
    runAttempt: 1,
    jobId,
    workflow: "CI",
    jobName: "test",
    url: `https://ci/${repo}/${jobId}`,
    commitSha: "c1",
    branch: "main",
    runner: "github-hosted",
    runnerName: "runner",
    conclusion: "failure",
    startedAt: "2026-11-15T00:00:00Z",
    completedAt: "2026-11-15T00:05:00Z",
    steps: "[]",
    annotations: "[]",
  };
}

/** GitHub's answer for `c1` to `c2`: one file changed. */
export const compareRow = (orgId: number, repo: string) => ({
  orgId,
  repo,
  base: "c1",
  head: "c2",
  files: '["src/a.ts"]',
});
