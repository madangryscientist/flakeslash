import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { json } from "../../../../packages/engine/test/github-fake.ts";
import type { BatchDb } from "#/db/d1-store.ts";
import type { Db } from "#/db/db.ts";
import { repos } from "#/db/schema.ts";
import { d1Db } from "#/db/test-d1.ts";
import { testDb } from "#/db/test-db.ts";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "#/db/schema.ts";
import { capStatements, D1CapReached } from "./d1-cap.ts";
import { scheduled, type ScanEnv } from "./hourly.ts";
import {
  ACME,
  APP,
  acme,
  appRoutes,
  at,
  batch,
  catalogue,
  history,
  installation,
  stubGitHub,
  tokenPath,
} from "./test-app.ts";

describe("the hourly scan: installations it skips", () => {
  it("skips a suspended installation", async () => {
    const db = testDb();
    const gh = acme(history(), { suspended_at: "2026-11-01T00:00:00Z" });
    const run = batch(db, gh.fetch);
    const result = await run.done;

    expect(result.scanned).toEqual([]);
    expect(gh.gh.paths).toEqual(["/app/installations?per_page=100"]);
    expect(run.lines[0]).toBe("skipped installation 7 (Acme): suspended");
  });

  it("skips a Bot account, and an installation whose token cannot be minted", async () => {
    const db = testDb();
    const gh = stubGitHub(
      {
        ...appRoutes([
          installation(7, ACME, "Acme"),
          installation(8, 202, "robot", { type: "Bot" }),
        ]),
        ...history(),
        [tokenPath(7)]: json({ message: "gone" }, { status: 404 }),
      },
      {},
    );
    const run = batch(db, gh.fetch);
    const result = await run.done;

    expect(result).toMatchObject({ stop: "no-installations", scanned: [] });
    expect(run.lines).toContain("skipped installation 8 (robot): a Bot");
    expect(
      run.lines.some((line) => line.startsWith("skipped installation 7 (Acme): GitHub POST")),
    ).toBe(true);
  });

  it("does not take a slot for a repo whose installation has no token this batch", async () => {
    const db = testDb();
    await batch(db, acme(history()).fetch).done;
    const q: Db = db;
    const before = await q.select().from(repos).orderBy(asc(repos.name));

    const dead = stubGitHub(
      { ...appRoutes([installation(7, ACME, "Acme")]), [tokenPath(7)]: json({}, { status: 500 }) },
      {},
    );
    const result = await batch(db, dead.fetch, { now: at(1), reposPerBatch: 1 }).done;
    expect(result.scanned).toEqual([]);
    expect(await q.select().from(repos).orderBy(asc(repos.name))).toEqual(before);
  });

  it("makes no request without the App's config, and ends on an installations listing that fails", async () => {
    const db = testDb();
    const gh = acme(history());
    const off = batch(db, gh.fetch, { app: null });
    expect(await off.done).toMatchObject({ stop: "not-configured", requests: 0 });
    expect(gh.requests()).toBe(0);
    expect(off.lines).toEqual([
      "the GitHub App is not configured (GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY): no scan",
    ]);

    const down = stubGitHub({ "/app/installations?per_page=100": json({}, { status: 503 }) }, {});
    const failed = batch(db, down.fetch);
    expect(await failed.done).toMatchObject({ stop: "no-installations", requests: 1 });
    expect(failed.lines[0]).toMatch(/^could not list the App's installations: GitHub GET/);
  });
});

/** The Worker's env over a local D1 (miniflare): `scheduled` builds its own Drizzle handle on it. */
let local: { db: BatchDb; d1: D1Database; dispose: () => Promise<void> };
beforeAll(async () => {
  local = await d1Db();
});
afterAll(() => local.dispose());

const env = (extra: Partial<ScanEnv> = {}): ScanEnv => ({
  DB: local.d1,
  GITHUB_APP_ID: APP.appId,
  GITHUB_APP_PRIVATE_KEY: APP.privateKey,
  GITHUB_API_BASE: APP.apiBase,
  SCAN_REQUEST_BUDGET: 200,
  SCAN_REPOS_PER_BATCH: 20,
  ...extra,
});

describe("scheduled", () => {
  it("runs a batch from the Worker's env, on D1", async () => {
    const lines: string[] = [];
    await scheduled(env(), { fetch: acme(history()).fetch, now: at(0), log: (l) => lines.push(l) });

    expect(lines.at(-1)).toMatch(
      /^scanned 2 repos with \d+ GitHub requests; stopped: all-scanned$/,
    );
    expect((await catalogue(local.db)).issues).toHaveLength(4);
  });

  it("records an installation of many repos within D1's 100 bound parameters", async () => {
    const names = Array.from({ length: 45 }, (_, n) => `Wide/repo-${n}`);
    const gh = stubGitHub(appRoutes([installation(9, 909, "Wide")]), { 9: names });
    const lines: string[] = [];
    await scheduled(env({ SCAN_REQUEST_BUDGET: 3 }), {
      fetch: gh.fetch,
      now: at(0),
      log: (l) => lines.push(l),
    });

    const q: Db = local.db;
    const held = await q.select({ name: repos.name }).from(repos).where(eq(repos.orgId, 909));
    expect(held).toHaveLength(45);
    expect(lines.at(-1)).toMatch(/stopped: budget$/);
  });

  it("refuses D1 statements past the batch's cap, batched or not", async () => {
    const capped = drizzle(capStatements(local.d1, 3), { schema });
    const one = () => capped.select().from(repos).where(eq(repos.orgId, ACME));
    await one();
    await capped.batch([one(), one()]);
    await expect(one()).rejects.toThrow("the batch reached its cap of 3 D1 statements");
  });

  it("ends the batch at D1's cap as a stop, with the capped repo's turn taken", async () => {
    let statements = 0;
    let cap = Infinity;
    const db = testDb({
      onStatement: () => {
        statements += 1;
        if (statements > cap) throw new D1CapReached(cap);
      },
    });
    const gh = acme(history());
    // Discovery only: its three requests spend the budget, so both repos are still unscanned.
    await batch(db, gh.fetch, { budget: 3 }).done;
    // Then discovery (2 statements), the pick (1) and the first turn (1) fit; that scan's first read does not.
    statements = 0;
    cap = 4;
    const run = batch(db, gh.fetch, { now: at(1) });
    const result = await run.done;

    expect(result.stop).toBe("d1-cap");
    expect(result.scanned).toHaveLength(1);
    expect(run.lines.at(-1)).toMatch(/stopped: d1-cap$/);
    cap = Infinity;
    const next = await batch(db, gh.fetch, { now: at(2) }).done;
    expect(next.scanned[0]?.name).not.toBe(result.scanned[0]?.name);

    // A cap that lands on the turn's own write: the repo is not reported as scanned, and keeps its place.
    statements = 0;
    cap = 3;
    const untaken = await batch(db, gh.fetch, { now: at(3) }).done;
    expect(untaken).toMatchObject({ stop: "d1-cap", scanned: [] });
  });

  it("leaves the App unconfigured when the id or the key is empty, and never throws", async () => {
    const lines: string[] = [];
    const gh = acme(history());
    const log = (line: string) => lines.push(line);
    await scheduled(env({ GITHUB_APP_ID: "" }), { db: testDb(), fetch: gh.fetch, log });
    await scheduled(env({ SCAN_REQUEST_BUDGET: "lots" }), { db: testDb(), fetch: gh.fetch, log });
    // D1 fails once discovery is done, when the batch picks its repos.
    const down = testDb({
      onStatement: (sql) => {
        if (sql.startsWith('select "org_id", "name" from "repos"')) throw new Error("D1 is down");
      },
    });
    await scheduled(env(), { db: down, fetch: gh.fetch, log });

    expect(lines.slice(0, 2)).toEqual([
      "the GitHub App is not configured (GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY): no scan",
      "SCAN_REQUEST_BUDGET and SCAN_REPOS_PER_BATCH must be positive whole numbers: no scan",
    ]);
    expect(gh.requests()).toBe(3);
    expect(lines.at(-1)).toMatch(/^the hourly scan failed: /);
  });
});
