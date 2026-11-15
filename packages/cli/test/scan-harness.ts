/**
 * A harness for driving `flakeslash scan` through `run()`: a fetch over canned GitHub answers (no live
 * network), a temp store, and the CLI's stdout, stderr and exit code captured.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClaudeRun, FetchLike, JobRecord, ModelFetch } from "@hackcove/flakeslash-engine";
import { afterEach, beforeEach, vi } from "vitest";
import {
  REPO,
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
} from "../../engine/test/github-fake.ts";
import { run } from "../src/cli.ts";
import { openSqliteStore } from "../src/store.ts";

export const SINCE = "2026-11-01";

/** The record the scan writes for `job(jobId, runId)` of the GitHub fake: attempt 1, finished. */
export const jobRecord = (runId: number, jobId: number): JobRecord => ({
  repo: REPO,
  workflow: "CI",
  jobName: "Gate",
  jobId,
  url: `https://github.com/${REPO}/actions/runs/${runId}/job/${jobId}`,
  commit: shaOf(runId),
  branch: "main",
  prNumber: null,
  provider: "github-actions",
  runner: "github-hosted",
  runnerName: "GitHub Actions 1",
  runId,
  runAttempt: 1,
  conclusion: "success",
  startedAt: "2026-11-03T10:00:00Z",
  completedAt: "2026-11-03T10:01:00Z",
  steps: [],
  annotations: [],
});

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

/** The routes of a set of runs, each `[repo, runId, log]`, with the run listing of each repo. */
export function routesOf(...runs: [string, number, Reply][]): Record<string, Reply> {
  return flakyRoutesOf(runs, []);
}

/**
 * `routesOf`, plus a passing rerun of each run in `passedAgain` on the same commit, an hour later (run id
 * plus 100), so the first run's failure is a proven flake.
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

interface Outcome {
  code: number;
  out: string;
  err: string;
}

/** Sets up a temp dir for the store, and a `scan` that runs the CLI with it. */
export function useScan() {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "flakeslash-scan-"));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });
  const storePath = () => join(dir, "flakeslash.db");

  return {
    storePath,
    /** Runs `flakeslash <args>` against `gh`, with the store flag added unless the args carry one. */
    async exec(
      args: string[],
      gh: { fetch: FetchLike },
      env: Record<string, string | undefined> = { GITHUB_TOKEN: "ghp_test" },
      model?: ModelFetch | { claudeRun: ClaudeRun },
    ): Promise<Outcome> {
      let out = "";
      let err = "";
      vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        out += String(chunk);
        return true;
      });
      vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
        err += String(chunk);
        return true;
      });
      try {
        const withStore = args.includes("--store") ? args : [...args, "--store", storePath()];
        const code = await run(withStore, {
          fetch: gh.fetch,
          env,
          // The store is thrown away with the test, so no write need wait for the disk.
          durable: false,
          ...(typeof model === "function" ? { modelFetch: model } : model),
        });
        return { code, out, err };
      } finally {
        vi.restoreAllMocks();
      }
    },
    /** Every excerpt row the store holds for `repo`. */
    async excerpts(repo = REPO) {
      const store = openSqliteStore(storePath(), { durable: false });
      try {
        return await store.readExcerpts(repo);
      } finally {
        store.close();
      }
    },
    /** Every issue the store holds, across repos. */
    async issues() {
      const store = openSqliteStore(storePath(), { durable: false });
      try {
        return await store.readIssues();
      } finally {
        store.close();
      }
    },
    /** Every failure the store holds, across repos. */
    async failures() {
      const store = openSqliteStore(storePath(), { durable: false });
      try {
        return await store.readFailures();
      } finally {
        store.close();
      }
    },
    /** Every attempt row the store holds for `repo`. */
    async attempts(repo = REPO) {
      const store = openSqliteStore(storePath(), { durable: false });
      try {
        return await store.readAttempts(repo);
      } finally {
        store.close();
      }
    },
    /** Every job row the store holds for `repo`. */
    async rows(repo = REPO) {
      const store = openSqliteStore(storePath(), { durable: false });
      try {
        return await store.readJobs(repo);
      } finally {
        store.close();
      }
    },
  };
}
