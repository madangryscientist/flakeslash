/**
 * The batch's bounds at the values in `wrangler.jsonc`, sized for Cloudflare's free plan (50
 * subrequests and 50 D1 queries per invocation): every measured batch makes at most
 * `SCAN_REQUEST_BUDGET` GitHub requests and at most `SCAN_D1_CAP` D1 statements, so the cap never
 * cuts a normal batch. Every statement counts, batched or not, which is stricter than Cloudflare (it
 * counts a batch as one). The database here is uncapped, so a count over the cap shows as a failure.
 */
import { readFileSync } from "node:fs";
import { scanRepo } from "@hackcove/flakeslash-engine";
import { describe, expect, it } from "vitest";
import { runsOf, runsPath, type Reply } from "../../../../packages/engine/test/github-fake.ts";
import { d1Store } from "#/db/d1-store.ts";
import { testDb } from "#/db/test-db.ts";
import { text } from "#/db/test-github.ts";
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

/** A database and a batch runner that counts D1 statements and GitHub requests per batch. */
function counted(routes: Record<string, Reply>, names: string[]) {
  let statements = 0;
  const db = testDb({ onStatement: () => (statements += 1) });
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
      const before = gh.requests();
      const result = await runBatch(deps(overrides));
      return { result, requests: gh.requests() - before, statements };
    },
  };
}

describe("the batch's bounds at the values in wrangler.jsonc", () => {
  it("are the free plan's", () => {
    expect({ budget, reposPerBatch, cap }).toEqual({ budget: 30, reposPerBatch: 2, cap: 45 });
  });

  it("hold over a backfill larger than one batch, where every log is kept", async () => {
    const names = ["acme/one", "acme/two"];
    const routes = {
      ...failedHistory("acme/one", { firstRun: 1000, runs: 20, jobsPerRun: 1, testsPerLog: 2 }),
      ...failedHistory("acme/two", { firstRun: 2000, runs: 20, jobsPerRun: 1, testsPerLog: 2 }),
    };
    const run = counted(routes, names);
    const seen: { requests: number; statements: number }[] = [];
    for (let n = 0; n < 40; n += 1) {
      const { result, requests, statements } = await run.batch({ now: hour(n) });
      seen.push({ requests, statements });
      if (result.stop === "all-scanned") break;
    }

    expect(seen.length).toBeGreaterThan(2);
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
    expect(requests).toBeLessThanOrEqual(budget);
    expect(statements).toBeLessThanOrEqual(cap);
  });

  it("hold on discovery of an installation with 20 repos, of which the batch scans its share", async () => {
    const names = Array.from({ length: 20 }, (_, n) => `acme/r${String(n).padStart(2, "0")}`);
    const routes = Object.fromEntries(names.map((name) => [runsPath(name), runsOf()]));
    const run = counted(routes, names);
    const { result, requests, statements } = await run.batch();

    expect(result.scanned).toHaveLength(reposPerBatch);
    expect(requests).toBeLessThanOrEqual(budget);
    expect(statements).toBeLessThanOrEqual(cap);
  });

  it("hold at the worst mix: a full batch of repos, the last one's budget all on logs", async () => {
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
    expect(requests).toBe(budget);
    expect(statements).toBeLessThanOrEqual(cap);
  });
});
