import { asc } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  job as apiJob,
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
import { d1Store, type BatchDb } from "#/db/d1-store.ts";
import type { Db } from "#/db/db.ts";
import { organisations, repos } from "#/db/schema.ts";
import { testDb } from "#/db/test-db.ts";
import { text } from "#/db/test-github.ts";
import type { BatchDeps } from "./hourly.ts";
import {
  ACME,
  ONE,
  TWO,
  acme,
  appRoutes,
  at,
  batch,
  catalogue,
  counts,
  history,
  installation,
  stubGitHub,
  uninterrupted,
} from "./test-app.ts";

/** Runs batches an hour apart until one has nothing left to read; returns how many it took. */
async function fill(db: BatchDb, fetch: BatchDeps["fetch"], budget: number) {
  for (let hour = 0; hour < 30; hour += 1) {
    const result = await batch(db, fetch, { budget, now: at(hour) }).done;
    expect(result.requests).toBeLessThanOrEqual(budget);
    if (result.stop === "all-scanned") return hour + 1;
  }
  throw new Error("the catalogue never filled");
}

describe("the hourly scan: a new installation", () => {
  it("finds the installation, records it, and fills its history over several batches", async () => {
    const db = testDb();
    const gh = acme(history());
    const batches = await fill(db, gh.fetch, 20);

    expect(batches).toBeGreaterThan(1);
    const q: Db = db;
    expect(await q.select().from(organisations)).toEqual([
      {
        id: ACME,
        login: "acme",
        type: "Organization",
        createdAt: at(0).toISOString(),
        isSmoke: false,
      },
    ]);
    expect((await q.select().from(repos).orderBy(asc(repos.name))).map((row) => row.name)).toEqual([
      ONE,
      TWO,
    ]);
    const filled = await catalogue(db);
    expect(filled).toEqual(await uninterrupted(history));
    expect(filled.issues.map((issue) => issue.status)).toEqual([
      "confirmed",
      "confirmed",
      "confirmed",
      "confirmed",
    ]);
  });

  it("refreshes a renamed account's login and keeps when it was first seen", async () => {
    const db = testDb();
    await batch(db, acme(history()).fetch).done;
    const renamed = stubGitHub(
      { ...appRoutes([installation(7, ACME, "AcmeCorp")]), ...history() },
      { 7: ["AcmeCorp/One"] },
    );
    await batch(db, renamed.fetch, { now: at(5) }).done;

    const q: Db = db;
    expect(await q.select().from(organisations)).toEqual([
      expect.objectContaining({ login: "acmecorp", createdAt: at(0).toISOString() }),
    ]);
    // A repo that left the installation (or was renamed) is not deleted.
    const held = await q.select().from(repos).orderBy(asc(repos.name));
    expect(held.map((row) => [row.name, row.addedAt])).toEqual([
      [ONE, at(0).toISOString()],
      [TWO, at(0).toISOString()],
      ["acmecorp/one", at(5).toISOString()],
    ]);
  });
});

describe("the hourly scan: resuming from the store", () => {
  it("adds no duplicate rows on a re-scan", async () => {
    const db = testDb();
    const gh = acme(history());
    await batch(db, gh.fetch).done;
    const first = await counts(db);
    const caught = await catalogue(db);

    await batch(db, gh.fetch, { now: at(1) }).done;
    expect(await counts(db)).toEqual(first);
    expect(await catalogue(db)).toEqual(caught);
    expect(first).toEqual({ jobs: 8, attempts: 8, excerpts: 4, failures: 4 });
  });

  it("carries on after a thrown fetch and ends with the same catalogue", async () => {
    const db = testDb();
    const routes = history();
    const jobsOfRun2 = routes[jobsPath(2, 1, ONE)];
    let down = true;
    routes[jobsPath(2, 1, ONE)] = () => {
      if (down) throw new Error("connection reset");
      return jobsOfRun2 instanceof Response ? jobsOfRun2.clone() : json({});
    };
    const gh = acme(routes);

    const broken = batch(db, gh.fetch);
    await broken.done;
    expect(broken.lines).toContain(`scan of ${ONE} failed: connection reset`);
    // The other repo was still scanned in that batch.
    expect((await catalogue(db)).perRepo[1]?.jobs).toHaveLength(4);

    down = false;
    await batch(db, gh.fetch, { now: at(1) }).done;
    expect(await catalogue(db)).toEqual(await uninterrupted(history));
  });
});

describe("the hourly scan: bounds and rotation", () => {
  it("stops after SCAN_REPOS_PER_BATCH repos, and takes the oldest scanned_at first", async () => {
    const db = testDb();
    const gh = stubGitHub(
      {
        ...appRoutes([installation(7, ACME, "Acme")]),
        ...history(),
        [runsPath("acme/three")]: runsOf(),
      },
      { 7: ["acme/one", "acme/two", "acme/three"] },
    );
    const order: string[][] = [];
    for (let hour = 0; hour < 4; hour += 1) {
      const result = await batch(db, gh.fetch, { reposPerBatch: 1, now: at(hour) }).done;
      expect(result.stop).toBe("repos");
      order.push(result.scanned.map((turn) => turn.name));
    }
    expect(order).toEqual([[ONE], ["acme/three"], [TWO], [ONE]]);
  });

  it("never passes its budget, sends a cut-short repo to the back, and resumes it later", async () => {
    const db = testDb();
    const gh = acme(history());
    const before = gh.requests();
    const first = await batch(db, gh.fetch, { budget: 8 }).done;

    expect(first.stop).toBe("budget");
    expect(first.requests).toBe(8);
    expect(gh.requests() - before).toBe(8);
    expect(first.scanned.map((turn) => turn.name)).toEqual([ONE]);

    // TWO was never scanned, so it goes first; ONE waits behind it.
    const second = await batch(db, gh.fetch, { budget: 8, now: at(1) }).done;
    expect(second.scanned.map((turn) => turn.name)[0]).toBe(TWO);
    await fill(db, gh.fetch, 8);
    expect(await catalogue(db)).toEqual(await uninterrupted(history));
  });

  it("ends the batch on a real rate limit", async () => {
    const db = testDb();
    const routes = history();
    routes[runsPath(ONE)] = json(
      { message: "limit" },
      {
        status: 403,
        headers: { "x-ratelimit-remaining": "0" },
      },
    );
    const result = await batch(db, acme(routes).fetch).done;
    expect(result.stop).toBe("rate-limit");
    expect(result.scanned.map((turn) => turn.name)).toEqual([ONE]);
  });
});

describe("the hourly scan: what a later batch picks up", () => {
  it("reads a re-run of a run the store already holds", async () => {
    const db = testDb();
    const routes = history();
    const gh = acme(routes);
    await batch(db, gh.fetch).done;
    expect(await d1Store(db, ACME).heldAttempts(ONE)).not.toContainEqual({
      runId: 1,
      runAttempt: 2,
    });

    routes[runsPath(ONE)] = runsOf(
      runOf(1, "2026-11-04T00:00:00Z", { conclusion: "success", run_attempt: 2 }),
      runOf(2, "2026-11-04T00:00:00Z", { conclusion: "failure" }),
    );
    routes[jobsPath(1, 2, ONE)] = jobsOf(apiJob(15, 1, { run_attempt: 2 }));
    await batch(db, gh.fetch, { now: at(1) }).done;

    expect(await d1Store(db, ACME).heldAttempts(ONE)).toContainEqual(
      expect.objectContaining({ runId: 1, runAttempt: 2 }),
    );
    expect((await d1Store(db, ACME).readJobs(ONE)).map((row) => row.jobId)).toContain(15);
  });

  it.each([404, 410])(
    "keeps a gone excerpt and a failure for a job whose log answers %i",
    async (status) => {
      const db = testDb();
      const routes: Record<string, Reply> = {
        [runsPath(ONE)]: runsOf(runOf(9, "2026-11-04T00:00:00Z", { conclusion: "failure" })),
        [pullsPath(shaOf(9), ONE)]: json([]),
        [jobsPath(9, 1, ONE)]: jobsOf(apiJob(90, 9, { conclusion: "failure" })),
        [logPath(90, ONE)]: text("", status),
        [runsPath(TWO)]: runsOf(),
      };
      await batch(db, acme(routes).fetch).done;

      const store = d1Store(db, ACME);
      expect(await store.readExcerpts(ONE)).toEqual([
        expect.objectContaining({ jobId: 90, status: "gone", excerpt: null }),
      ]);
      expect(await store.readFailures()).toEqual([
        expect.objectContaining({ repo: ONE, jobId: 90 }),
      ]);
    },
  );
});
