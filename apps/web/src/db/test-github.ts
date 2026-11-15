/**
 * Flaky GitHub scenarios over the engine's GitHub fake, for scanning into a `d1Store`. The builders are
 * copied from the CLI's `scan-harness.ts`, which also pulls in the CLI itself.
 */
import {
  job,
  jobsOf,
  jobsPath,
  json,
  logPath,
  pullsPath,
  run as runOf,
  runsOf,
  runsPath,
  shaOf,
  type Reply,
} from "../../../../packages/engine/test/github-fake.ts";

export const text = (body: string, status = 200): Response => new Response(body, { status });

/** A Playwright log of failed tests: `[title, error line]` pairs, each a numbered block. */
export function playwrightLog(...tests: [string, string][]): string {
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
export function failedRun(
  repo: string,
  runId: number,
  log: Reply,
  extra: { run?: Record<string, unknown>; job?: Record<string, unknown> } = {},
): Record<string, { run: unknown; routes: Record<string, Reply> }> {
  const jobId = runId * 10;
  return {
    [repo]: {
      run: runOf(runId, "2026-11-04T00:00:00Z", { conclusion: "failure", ...extra.run }),
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

/**
 * The routes of a set of failed runs, each `[repo, runId, log]`, with the run listing of each repo, plus a
 * passing rerun of each run in `passedAgain` on the same commit, an hour later (run id plus 100), so the
 * first run's failure is a proven flake.
 */
export function flakyRoutesOf(
  runs: [string, number, Reply][],
  passedAgain: [string, number][],
): Record<string, Reply> {
  const routes: Record<string, Reply> = {};
  const byRepo = new Map<string, unknown[]>();
  const list = (repo: string, listed: unknown) =>
    byRepo.set(repo, [...(byRepo.get(repo) ?? []), listed]);
  for (const [repo, runId, log] of runs) {
    const made = failedRun(repo, runId, log)[repo];
    if (made === undefined) continue;
    Object.assign(routes, made.routes);
    list(repo, made.run);
  }
  for (const [repo, runId] of passedAgain) {
    const rerunId = runId + 100;
    const sha = shaOf(runId);
    list(repo, runOf(rerunId, "2026-11-04T01:00:00Z", { head_sha: sha }));
    routes[jobsPath(rerunId, 1, repo)] = jobsOf(
      job(rerunId * 10, rerunId, {
        head_sha: sha,
        html_url: `https://github.com/${repo}/actions/runs/${rerunId}/job/${rerunId * 10}`,
      }),
    );
  }
  for (const [repo, listing] of byRepo) routes[runsPath(repo)] = runsOf(...listing);
  return routes;
}
