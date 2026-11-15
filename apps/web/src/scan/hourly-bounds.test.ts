/**
 * The batch's bounds at the values in `wrangler.jsonc`, sized for Cloudflare's free plan (50
 * subrequests and 50 D1 queries per invocation). Every batch makes at most `SCAN_REQUEST_BUDGET`
 * GitHub requests and runs at most `SCAN_D1_CAP` D1 statements: the database here refuses the one past
 * the cap, as the Worker's capped handle does. Every statement counts, batched or not, which is
 * stricter than Cloudflare (it counts a batch as one). A batch with nothing new fits under the cap; a
 * batch that reads new logs meets it (each new log costs about four statements), stops there, and the
 * next batch carries on, so a backfill takes more hours but loses nothing.
 */
import { readFileSync } from "node:fs";
import { scanRepo } from "@hackcove/flakeslash-engine";
import { describe, expect, it } from "vitest";
import { runsOf, runsPath, type Reply } from "../../../../packages/engine/test/github-fake.ts";
import { d1Store } from "#/db/d1-store.ts";
import { testDb } from "#/db/test-db.ts";
import { text } from "#/db/test-github.ts";
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
  let limit = Infinity;
  const db = testDb({
    onStatement: () => {
      if (statements >= limit) throw new D1CapReached(limit);
      statements += 1;
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
      limit = cap;
      const before = gh.requests();
      try {
        const result = await runBatch(deps(overrides));
        return { result, requests: gh.requests() - before, statements };
      } finally {
        limit = Infinity;
      }
    },
  };
}

describe("the batch's bounds at the values in wrangler.jsonc", () => {
  it("are the free plan's", () => {
    expect({ budget, reposPerBatch, cap }).toEqual({ budget: 30, reposPerBatch: 2, cap: 45 });
  });

  it("carry a backfill larger than one batch to its end, every log kept, the cap ending some batches", async () => {
    const names = ["acme/one", "acme/two"];
    const routes = {
      ...failedHistory("acme/one", { firstRun: 1000, runs: 20, jobsPerRun: 1, testsPerLog: 2 }),
      ...failedHistory("acme/two", { firstRun: 2000, runs: 20, jobsPerRun: 1, testsPerLog: 2 }),
    };
    const run = counted(routes, names);
    const seen: { stop: string; requests: number; statements: number }[] = [];
    for (let n = 0; n < 20; n += 1) {
      const { result, requests, statements } = await run.batch({ now: hour(n) });
      seen.push({ stop: result.stop, requests, statements });
      if (result.stop === "all-scanned") break;
    }

    // Measured: 9 batches (30 requests at most, 45 statements at most); the cap ended 6 of them.
    expect(seen.at(-1)?.stop).toBe("all-scanned");
    expect(seen.length).toBeLessThanOrEqual(10);
    expect(seen.filter((s) => s.stop === "d1-cap").length).toBeGreaterThan(0);
    expect(Math.max(...seen.map((s) => s.requests))).toBe(budget);
    expect(Math.max(...seen.map((s) => s.statements))).toBeLessThanOrEqual(cap);
    expect((await d1Store(run.db, ORG).readFailures()).length).toBe(80);
  });

  it("hold when every repo of a full batch has nothing new", async () => {
    const names = Array.from({ length: reposPerBatch }, (_, n) => `acme/r${n}`);
    const routes = Object.fromEntries(names.map((name) => [runsPath(name), runsOf()]));
    const run = counted(routes, names);
    await run.batch();
    const { result, requests, statements } = await run.batch({ now: hour(1) });

    expect(result.scanned).toHaveLength(reposPerBatch);
    expect(result.stop).toBe("all-scanned");
    // Measured: 5 requests and 21 statements.
    expect(requests).toBeLessThanOrEqual(budget);
    expect(statements).toBeLessThanOrEqual(cap);
  });

  it("hold on discovery of an installation with 20 repos, of which the batch scans its share", async () => {
    const names = Array.from({ length: 20 }, (_, n) => `acme/r${String(n).padStart(2, "0")}`);
    const routes = Object.fromEntries(names.map((name) => [runsPath(name), runsOf()]));
    const run = counted(routes, names);
    const { result, requests, statements } = await run.batch();

    expect(result.scanned).toHaveLength(reposPerBatch);
    expect(result.stop).toBe("repos");
    // Measured: 5 requests and 21 statements (the 20 repos go in as one insert).
    expect(requests).toBeLessThanOrEqual(budget);
    expect(statements).toBeLessThanOrEqual(cap);
  });

  it("hold at the worst mix, a full batch whose last repo has only logs left to read", async () => {
    const small = Array.from(
      { length: reposPerBatch - 1 },
      (_, n) => `acme/r${String(n).padStart(2, "0")}`,
    );
    const big = "acme/zz";
    const history = failedHistory(big, {
      firstRun: 1000,
      runs: 40,
      jobsPerRun: 1,
      testsPerLog: 2,
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
    // Measured: 30 requests, and the cap at 45 statements (uncapped, this batch runs 121).
    expect(requests).toBeLessThanOrEqual(budget);
    expect(statements).toBeLessThanOrEqual(cap);

    // The batches after it carry on where it stopped, each under the cap, until every log is held.
    const held = async () => (await d1Store(run.db, ORG).readFailures()).length;
    let more = 0;
    while (more < 20 && (await held()) < 80) {
      const next = await run.batch({ now: hour(more) });
      expect(next.statements).toBeLessThanOrEqual(cap);
      more += 1;
    }
    // Measured: 6 more batches.
    expect(await held()).toBe(80);
    expect(more).toBeLessThanOrEqual(8);
  });
});
