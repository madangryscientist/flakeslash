import { readFileSync } from "node:fs";
import type { FetchLike } from "../src/index.ts";

export const API = "https://api.github.com";
export const REPO = "madangryscientist/pixelslash";
export const SHA = "865de4094426ac13811eb7cb2db5d7ccef9ed274";

export interface RunsFixture {
  workflow_runs: { run_attempt: number; conclusion: string; pull_requests: unknown[] }[];
}

export interface JobsFixture {
  jobs: {
    id: number;
    runner_name: string;
    steps: unknown[];
  }[];
}

export function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
}

export function runsFixture(): RunsFixture {
  return JSON.parse(
    readFileSync(new URL("./fixtures/runs-41676366416.json", import.meta.url), "utf8"),
  );
}

export function jobsFixture(name: string): JobsFixture {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
}

/** Job ids of the real run's attempt n. */
export function attemptIds(n: number): number[] {
  return jobsFixture(`jobs-41676366416-attempt-${n}.json`).jobs.map((j) => j.id);
}

export type Reply = Response | (() => Response);

export function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

/** A fetch over canned answers, keyed by path and query. An unlisted request fails the test: no live network. */
export function fakeGitHub(routes: Record<string, Reply>) {
  const calls: string[] = [];
  const headers: Record<string, string>[] = [];
  const redirects: (string | undefined)[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push(url);
    headers.push(init.headers);
    redirects.push(init.redirect);
    const reply = routes[url.replace(API, "")];
    if (reply === undefined) throw new Error(`unexpected request: ${url}`);
    return typeof reply === "function" ? reply() : reply.clone();
  };
  return { fetch, calls, headers, redirects };
}

export const RUNS = "/repos/" + REPO + "/actions/runs?per_page=100";
export const jobsPath = (runId: number, attempt: number) =>
  `/repos/${REPO}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`;
export const pullsPath = (sha: string) => `/repos/${REPO}/commits/${sha}/pulls`;
export const since = "2026-11-01T00:00:00Z";

/** The real run: three attempts, reads `success`, attempt 1 failed. */
export function realRoutes(): Record<string, Reply> {
  return {
    [RUNS]: json(fixture("runs-41676366416.json")),
    [jobsPath(41676366416, 1)]: json(fixture("jobs-41676366416-attempt-1.json")),
    [jobsPath(41676366416, 2)]: json(fixture("jobs-41676366416-attempt-2.json")),
    [jobsPath(41676366416, 3)]: json(fixture("jobs-41676366416-attempt-3.json")),
    [pullsPath(SHA)]: json(fixture("pulls-865de40.json")),
  };
}

export function run(id: number, createdAt: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name: "CI",
    head_sha: `${id}`.padStart(40, "a"),
    head_branch: "main",
    run_attempt: 1,
    status: "completed",
    conclusion: "success",
    created_at: createdAt,
    ...extra,
  };
}

export function job(id: number, runId: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    run_id: runId,
    run_attempt: 1,
    name: "Gate",
    workflow_name: "CI",
    head_sha: `${runId}`.padStart(40, "a"),
    head_branch: "main",
    status: "completed",
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

export const jobsOf = (...jobs: unknown[]) => json({ total_count: jobs.length, jobs });
export const runsOf = (...runs: unknown[]) =>
  json({ total_count: runs.length, workflow_runs: runs });
