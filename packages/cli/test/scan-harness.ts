/**
 * A harness for driving `flakeslash scan` through `run()`: a fetch over canned GitHub answers (no live
 * network), a temp store, and the CLI's stdout, stderr and exit code captured.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FetchLike, ModelFetch } from "@hackcove/flakeslash-engine";
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
      modelFetch?: ModelFetch,
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
          ...(modelFetch === undefined ? {} : { modelFetch }),
        });
        return { code, out, err };
      } finally {
        vi.restoreAllMocks();
      }
    },
    /** Every excerpt row the store holds for `repo`. */
    async excerpts(repo = REPO) {
      const store = openSqliteStore(storePath());
      try {
        return await store.readExcerpts(repo);
      } finally {
        store.close();
      }
    },
    /** Every issue the store holds, across repos. */
    async issues() {
      const store = openSqliteStore(storePath());
      try {
        return await store.readIssues();
      } finally {
        store.close();
      }
    },
    /** Every failure the store holds, across repos. */
    async failures() {
      const store = openSqliteStore(storePath());
      try {
        return await store.readFailures();
      } finally {
        store.close();
      }
    },
    /** Every job row the store holds for `repo`. */
    async rows(repo = REPO) {
      const store = openSqliteStore(storePath());
      try {
        return await store.readJobs(repo);
      } finally {
        store.close();
      }
    },
  };
}
