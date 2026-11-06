/**
 * A harness for driving `flakeslash scan` through `run()`: a fetch over canned GitHub answers (no live
 * network), a temp store, and the CLI's stdout, stderr and exit code captured.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FetchLike } from "@hackcove/flakeslash-engine";
import { afterEach, beforeEach, vi } from "vitest";
import { run } from "../src/cli.ts";
import { openSqliteStore } from "../src/store.ts";

export const API = "https://api.github.com";
export const REPO = "madangryscientist/pixelslash";
export const SINCE = "2026-11-01";

export type Reply = Response | (() => Response);

export function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

/** The engine's recorded GitHub answers (real run 41676366416). */
export function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`../../engine/test/fixtures/${name}`, import.meta.url), "utf8"),
  );
}

export const runsPath = (repo = REPO) => `/repos/${repo}/actions/runs?per_page=100`;
export const jobsPath = (runId: number, attempt: number, repo = REPO) =>
  `/repos/${repo}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`;
export const pullsPath = (sha: string, repo = REPO) => `/repos/${repo}/commits/${sha}/pulls`;
export const shaOf = (runId: number) => `${runId}`.padStart(40, "a");

export function runOf(id: number, createdAt: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name: "CI",
    head_sha: shaOf(id),
    head_branch: "main",
    run_attempt: 1,
    status: "completed",
    conclusion: "success",
    created_at: createdAt,
    ...extra,
  };
}

export function jobOf(id: number, runId: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    run_id: runId,
    name: "Gate",
    workflow_name: "CI",
    conclusion: "success",
    runner_name: "GitHub Actions 1",
    labels: ["ubuntu-latest"],
    html_url: `https://github.com/${REPO}/actions/runs/${runId}/job/${id}`,
    started_at: "2026-11-03T10:00:00Z",
    completed_at: "2026-11-03T10:01:00Z",
    steps: [],
    ...extra,
  };
}

export const runsOf = (...runs: unknown[]) =>
  json({ total_count: runs.length, workflow_runs: runs });
export const jobsOf = (...jobs: unknown[]) => json({ total_count: jobs.length, jobs });

/** The recorded run: attempts 1 and 2 failed a job that attempt 3 passed. */
export function realRoutes(): Record<string, Reply> {
  const sha = "865de4094426ac13811eb7cb2db5d7ccef9ed274";
  return {
    [runsPath()]: json(fixture("runs-41676366416.json")),
    [jobsPath(41676366416, 1)]: json(fixture("jobs-41676366416-attempt-1.json")),
    [jobsPath(41676366416, 2)]: json(fixture("jobs-41676366416-attempt-2.json")),
    [jobsPath(41676366416, 3)]: json(fixture("jobs-41676366416-attempt-3.json")),
    [pullsPath(sha)]: json(fixture("pulls-865de40.json")),
  };
}

/** A fetch over `routes`, which a test may change between scans. An unlisted request fails the test. */
export function fakeGitHub(routes: Record<string, Reply>) {
  const calls: string[] = [];
  const fetch: FetchLike = async (url) => {
    calls.push(url.replace(API, ""));
    const reply = routes[url.replace(API, "")];
    if (reply === undefined) throw new Error(`unexpected request: ${url}`);
    return typeof reply === "function" ? reply() : reply.clone();
  };
  return { fetch, calls, routes };
}

export interface Outcome {
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
        const code = await run(withStore, { fetch: gh.fetch, env });
        return { code, out, err };
      } finally {
        vi.restoreAllMocks();
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
