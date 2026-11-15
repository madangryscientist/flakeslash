/**
 * The batch's bounds at the values in `wrangler.jsonc`, sized for Cloudflare's Workers Paid plan: 10,000
 * subrequests and 1,000 D1 queries per invocation (a `db.batch()` counts as one query), 30 seconds of
 * CPU for a Cron Trigger that runs more often than once an hour, as the scan's (every 10 minutes) does; that
 * is read from Workers Logs after a deploy. Every batch makes at most `SCAN_REQUEST_BUDGET` GitHub
 * requests and runs at most `SCAN_D1_CAP` D1 statements: the database here refuses the one past the
 * cap, as the Worker's capped handle does. Every statement counts, batched or not, which is stricter
 * than Cloudflare (it counts a batch as one). A batch with nothing new fits under the cap; a batch that
 * reads new logs meets it (each new log costs about four statements), stops there, and the next batch
 * carries on, so a backfill takes more batches but loses nothing.
 */
import { readFileSync } from "node:fs";
import { scanRepo } from "@hackcove/flakeslash-engine";
import { describe, expect, it } from "vitest";
import {
  API,
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
import { d1Store } from "#/db/d1-store.ts";
import { attempts, excerpts, jobs } from "#/db/schema.ts";
import { testDb } from "#/db/test-db.ts";
import { playwrightLog, text } from "#/db/test-github.ts";
import { D1CapReached } from "./d1-cap.ts";
import { runBatch, type BatchDeps } from "./hourly.ts";
import { APP, appRoutes, failedHistory, installation, stubGitHub } from "./test-app.ts";

const ORG = 1;
const START = Date.parse("2026-11-15T12:00:00Z");
const hour = (n: number) => new Date(START + n * 60 * 60 * 1000);

/** A var's value in `wrangler.jsonc`, the same at the top level and in `env.e2e`. */
function wranglerVar(name: string): number {
  const config = readFileSync(new URL("../../wrangler.jsonc", import.meta.url), "utf8");
  const values = [...config.matchAll(new RegExp(`"${name}": (\\d+)`, "g"))].map((m) =>
    Number(m[1]),
  );
  expect(values).toHaveLength(2);
  expect(new Set(values).size).toBe(1);
  return values[0] ?? 0;
}

const budget = wranglerVar("SCAN_REQUEST_BUDGET");
const reposPerBatch = wranglerVar("SCAN_REPOS_PER_BATCH");
const cap = wranglerVar("SCAN_D1_CAP");

/**
 * A database and a batch runner that counts D1 statements and GitHub requests per batch. In a batch the
 * database refuses the statement past `cap`; outside one (a test's own setup and reads) it does not.
 */
function counted(routes: Record<string, Reply>, names: string[]) {
  let statements = 0;
  let writes: string[] = [];
  let limit = Infinity;
  const db = testDb({
    onStatement: (sql) => {
      if (statements >= limit) throw new D1CapReached(limit);
      statements += 1;
      if (/^\s*(insert|update|delete)\b/i.test(sql)) writes.push(sql);
    },
  });
  const gh = stubGitHub({ ...appRoutes([installation(7, ORG, "acme")]), ...routes }, { 7: names });
  const deps = (overrides: Partial<BatchDeps>): BatchDeps => ({
    db,
    fetch: gh.fetch,
    app: APP,
    budget,
    reposPerBatch,
    now: hour(0),
    log: () => {},
    ...overrides,
  });
  return {
    db,
    gh,
    async batch(overrides: Partial<BatchDeps> = {}) {
      statements = 0;
      writes = [];
      limit = cap;
      const before = gh.requests();
      try {
        const result = await runBatch(deps(overrides));
        return { result, requests: gh.requests() - before, statements, writes };
      } finally {
        limit = Infinity;
      }
    },
  };
}

/**
 * One passing attempt of `count` jobs, listed 100 to a page as GitHub lists them. A passing job has no
 * log to read, so the batch's statements are the attempt's own rows.
 */
function passingAttempt(repo: string, runId: number, count: number): Record<string, Reply> {
  const routes: Record<string, Reply> = {};
  routes[runsPath(repo)] = runsOf(runOf(runId, "2026-11-04T00:00:00Z", { conclusion: "success" }));
  routes[pullsPath(shaOf(runId), repo)] = json([]);
  const pages = Math.max(1, Math.ceil(count / 100));
  for (let page = 1; page <= pages; page += 1) {
    const items: unknown[] = [];
    for (let at = (page - 1) * 100; at < Math.min(count, page * 100); at += 1) {
      const jobId = runId * 100_000 + at;
      items.push(
        job(jobId, runId, {
          name: `Gate ${at}`,
          html_url: `https://github.com/${repo}/actions/runs/${runId}/job/${jobId}`,
        }),
      );
    }
    const path = `/repos/${repo}/actions/runs/${runId}/attempts/1/jobs?per_page=100`;
    const pageOf = page === 1 ? path : `${path}&page=${page}`;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (page < pages) {
      headers.link = `<${API}${path}&page=${page + 1}>; rel="next"`;
    }
    routes[pageOf] = new Response(JSON.stringify({ total_count: count, jobs: items }), { headers });
  }
  return routes;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A busy repo's 90 days: `runs` completed runs spread evenly over the 90 days before `now`, run ids
 * rising with time, one job each. Every 20th run failed and its job's log is kept; the rest passed. The
 * run listing is newest first, 100 to a page with GitHub's `next` link, so a full listing of 5,700 runs
 * costs 57 requests.
 */
function busyHistory(repo: string, runs: number, now: Date): Record<string, Reply> {
  const routes: Record<string, Reply> = {};
  const listed: unknown[] = [];
  const step = (90 * DAY_MS) / runs;
  const oldest = now.getTime() - 90 * DAY_MS;
  for (let n = 0; n < runs; n += 1) {
    const runId = 100_000 + n;
    const failed = n % 20 === 19;
    const conclusion = failed ? "failure" : "success";
    const createdAt = new Date(oldest + (n + 0.5) * step).toISOString();
    listed.push(runOf(runId, createdAt, { conclusion }));
    routes[pullsPath(shaOf(runId), repo)] = json([]);
    const jobId = runId * 10;
    routes[jobsPath(runId, 1, repo)] = jobsOf(
      job(jobId, runId, {
        conclusion,
        html_url: `https://github.com/${repo}/actions/runs/${runId}/job/${jobId}`,
      }),
    );
    if (failed) {
      routes[logPath(jobId, repo)] = text(
        playwrightLog([`test ${runId}`, `Error: expected ${runId} to be true`]),
      );
    }
  }
  const newestFirst = listed.toReversed();
  const pages = Math.ceil(runs / 100);
  for (let page = 1; page <= pages; page += 1) {
    const path = runsPath(repo);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (page < pages) headers.link = `<${API}${path}&page=${page + 1}>; rel="next"`;
    const workflowRuns = newestFirst.slice((page - 1) * 100, page * 100);
    routes[page === 1 ? path : `${path}&page=${page}`] = new Response(
      JSON.stringify({ total_count: runs, workflow_runs: workflowRuns }),
      { headers },
    );
  }
  return routes;
}

describe("the batch's bounds at the values in wrangler.jsonc", () => {
  it("fit Workers Paid", () => {
    expect({ budget, reposPerBatch, cap }).toEqual({ budget: 200, reposPerBatch: 20, cap: 950 });
  });

  it("carry a backfill larger than one batch to its end, every log kept, the bounds ending some batches", async () => {
    const names = ["acme/one", "acme/two"];
    // Measured: 7 batches. The budget ended the first six (200 requests each); the seventh read the rest.
    // The budget ends each batch before the cap does: a new run costs about three requests (its pulls,
    // its jobs and its log), so the cap never binds here.
    const RUNS_PER_REPO = 200;
    const routes = {
      ...failedHistory("acme/one", {
        firstRun: 1000,
        runs: RUNS_PER_REPO,
        jobsPerRun: 1,
        testsPerLog: 2,
      }),
      ...failedHistory("acme/two", {
        firstRun: 2000,
        runs: RUNS_PER_REPO,
        jobsPerRun: 1,
        testsPerLog: 2,
      }),
    };
    const run = counted(routes, names);
    const seen: { stop: string; requests: number; statements: number }[] = [];
    for (let n = 0; n < 10; n += 1) {
      const { result, requests, statements } = await run.batch({ now: hour(n) });
      seen.push({ stop: result.stop, requests, statements });
      if (result.stop === "all-scanned") break;
    }

    expect(seen.at(-1)?.stop).toBe("all-scanned");
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.length).toBeLessThanOrEqual(8);
    expect(seen.slice(0, -1).every((s) => s.stop === "budget" && s.requests === budget)).toBe(true);
    expect(seen.some((s) => s.stop === "budget" || s.stop === "d1-cap")).toBe(true);
    expect(Math.max(...seen.map((s) => s.requests))).toBeLessThanOrEqual(budget);
    expect(Math.max(...seen.map((s) => s.statements))).toBeLessThanOrEqual(cap);
    expect((await d1Store(run.db, ORG).readFailures()).length).toBe(
      RUNS_PER_REPO * names.length * 2,
    );
  });

  it("carry a busy repo's 90-day backfill of 5,700 runs to its end", async () => {
    // Measured: 72 batches, about 11 seconds here. The budget ended the first 70 (200 requests each), the
    // 71st read the rest (188 requests), and the 72nd scanned the repo and stored nothing new (61
    // requests: discovery and the 57 pages of the listing). At six batches an hour the backfill is
    // stored in just under 12 hours. Every batch re-lists the runs from the newest, so later batches
    // spend more of the budget on the listing and read fewer new runs; the most statements a batch ran
    // was 589. Over 144 batches (24 hours) the next step would be a resume cursor in the listing.
    const repo = "acme/busy";
    const RUNS = 5700;
    const run = counted(busyHistory(repo, RUNS, hour(0)), [repo]);
    const stored = async () => {
      const q = run.db;
      const rows = [];
      for (const table of [attempts, jobs, excerpts]) rows.push(await q.$count(table));
      return rows.join("/");
    };
    const seen: { stop: string; requests: number; statements: number }[] = [];
    for (let n = 0; n < 300; n += 1) {
      const before = await stored();
      // The window is held at the first batch's, so no run ages out of the 90 days mid-backfill.
      const { result, requests, statements } = await run.batch({ now: hour(0) });
      seen.push({ stop: result.stop, requests, statements });
      if (result.scanned.some((turn) => turn.name === repo) && (await stored()) === before) break;
    }

    expect(seen.length).toBeLessThanOrEqual(144);
    expect(seen.at(-1)?.stop).toBe("all-scanned");
    expect(Math.max(...seen.map((s) => s.requests))).toBeLessThanOrEqual(budget);
    expect(Math.max(...seen.map((s) => s.statements))).toBeLessThanOrEqual(cap);
    expect(await run.db.select().from(attempts)).toHaveLength(RUNS);
    expect(await run.db.select().from(jobs)).toHaveLength(RUNS);
    expect(await run.db.select().from(excerpts)).toHaveLength(RUNS / 20);
  }, 60_000);

  it("hold when every repo of a full batch has nothing new", async () => {
    const names = Array.from({ length: reposPerBatch }, (_, n) => `acme/r${n}`);
    const routes = Object.fromEntries(names.map((name) => [runsPath(name), runsOf()]));
    const run = counted(routes, names);
    await run.batch();
    const { result, requests, statements, writes } = await run.batch({ now: hour(1) });

    expect(result.scanned).toHaveLength(reposPerBatch);
    expect(result.stop).toBe("all-scanned");
    // Measured: 23 requests and 183 statements, 22 of them writes: discovery's upsert of the organisation
    // (one row) and its insert of the 20 repos (no row, all held), then the 20 `scanned_at` updates.
    expect(writes).toHaveLength(22);
    expect(writes.filter((sql) => sql.startsWith("update"))).toHaveLength(reposPerBatch);
    expect(requests).toBeLessThanOrEqual(budget);
    expect(statements).toBeLessThanOrEqual(cap);
  });

  it("hold on discovery of an installation with 21 repos, of which the batch scans its share", async () => {
    // One more repo than a batch scans, so the batch stops on "repos" (20 would stop on "all-scanned").
    const names = Array.from(
      { length: reposPerBatch + 1 },
      (_, n) => `acme/r${String(n).padStart(2, "0")}`,
    );
    const routes = Object.fromEntries(names.map((name) => [runsPath(name), runsOf()]));
    const run = counted(routes, names);
    const { result, requests, statements } = await run.batch();

    expect(result.scanned).toHaveLength(reposPerBatch);
    expect(result.stop).toBe("repos");
    // Measured: 23 requests and 184 statements (the 21 repos go in as one insert).
    expect(requests).toBeLessThanOrEqual(budget);
    expect(statements).toBeLessThanOrEqual(cap);
  });

  it("hold at the worst mix, a full batch whose last repo has only logs left to read", async () => {
    const small = Array.from(
      { length: reposPerBatch - 1 },
      (_, n) => `acme/r${String(n).padStart(2, "0")}`,
    );
    const big = "acme/zz";
    // 160 runs of logs left, three tests a log. Measured: the batch stops at the cap with 183 requests,
    // and uncapped it would run 983 statements. At two tests a log, with 180 runs left, the budget ends
    // the batch first, after 177 logs read at 891 statements, so the cap cannot be the stop there. That
    // figure is from a probe run outside the suite.
    const history = failedHistory(big, {
      firstRun: 1000,
      runs: 160,
      jobsPerRun: 1,
      testsPerLog: 3,
    });
    const routes: Record<string, Reply> = { ...history };
    for (const name of small) routes[runsPath(name)] = runsOf();
    const run = counted(routes, [...small, big]);
    // Discovery only (its three requests spend the budget), so every repo is still unscanned.
    await run.batch({ now: hour(-2), budget: 3 });
    // The big repo's jobs are held already and its logs are not: GitHub said try later on each.
    const later = Object.entries(history).map(([path, reply]): [string, Reply] => [
      path,
      path.endsWith("/logs") ? text("", 503) : reply,
    ]);
    await scanRepo({
      repo: big,
      since: "2026-08-01T00:00:00Z",
      fetch: stubGitHub(Object.fromEntries(later), {}).fetch,
      store: d1Store(run.db, ORG),
    });

    const { result, requests, statements } = await run.batch({ now: hour(-1) });
    expect(result.scanned.map((turn) => turn.name).at(-1)).toBe(big);
    expect(result.stop).toBe("d1-cap");
    expect(requests).toBeLessThanOrEqual(budget);
    expect(statements).toBeLessThanOrEqual(cap);
  });

  it("write one attempt of 1,000 passing jobs in full, its attempts row included, in one batch", async () => {
    const repo = "acme/big-attempt";
    const run = counted(passingAttempt(repo, 9000, 1000), [repo]);
    const { result, requests, statements } = await run.batch();

    expect(result.stop).toBe("all-scanned");
    const stored = await run.db.select().from(jobs);
    expect(stored).toHaveLength(1000);
    expect(await run.db.select().from(attempts)).toHaveLength(1);
    // Measured: 15 requests and 213 statements. The job ceiling at 950 is 4,680 (949 statements), from a
    // probe run outside the suite: 4,690 is cut at the cap.
    expect(requests).toBeLessThanOrEqual(budget);
    expect(statements).toBeLessThan(cap);
  });
});
