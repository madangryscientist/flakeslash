import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import type { BatchDb } from "#/db/d1-store.ts";
import * as schema from "#/db/schema.ts";
import { d1Db } from "#/db/test-d1.ts";
import { ACME, GLOBEX, OTHER, withOrgs } from "#/db/test-store.ts";
import { capStatements } from "#/scan/d1-cap.ts";
import { expireAll } from "./daily.ts";
import { NEW, NOW, OLD, seedRun, seedRuns, tables, wipe } from "./test-seed.ts";

/**
 * Organisation ACME: two repos, two expiring days and one staying, with 12 flakes on one day so its
 * flake records take two insert chunks. GLOBEX: one expiring run, so the cap can fall between them.
 */
const tests = (attempt: number) =>
  Array.from({ length: 12 }, (_, n) => ({
    jobId: 100 * attempt + n,
    jobName: `test ${n}`,
    conclusion: attempt === 1 ? "failure" : "success",
  }));

async function seed(db: BatchDb): Promise<void> {
  const createdAt = OLD;
  await seedRuns(db, ACME, [
    { runId: 100, createdAt, jobs: tests(1) },
    { runId: 100, runAttempt: 2, createdAt, jobs: tests(2) },
    { runId: 101, createdAt: "2026-08-15T10:00:00Z", jobs: [{ jobId: 500, runner: "depot" }] },
    { repo: OTHER, runId: 200, createdAt, jobs: [{ jobId: 600 }] },
    { runId: 300, createdAt: NEW, jobs: [{ jobId: 9000 }] },
  ]);
  await seedRuns(db, GLOBEX, [{ runId: 100, createdAt, jobs: [{ jobId: 1 }] }]);
}

let held: Awaited<ReturnType<typeof d1Db>>;
beforeAll(async () => {
  held = await d1Db();
}, 60_000);
afterAll(() => held?.dispose());

/** The Worker's env: the local D1, which `deps.db` stands in for or wraps. */
const env = () => ({ DB: held.d1 });

describe("the daily expiry", () => {
  it("expires every organisation", async () => {
    const db = await withOrgs();
    await seedRun(db, ACME, { runId: 10, createdAt: OLD, jobs: [{ jobId: 1 }] });
    await seedRun(db, GLOBEX, { runId: 10, createdAt: OLD, jobs: [{ jobId: 1 }] });
    const lines: string[] = [];

    await expireAll(env(), { db, now: NOW, log: (line) => lines.push(line) });

    const after = await tables(db);
    expect(after.jobs).toEqual([]);
    expect(after.dailyTotals).toHaveLength(2);
    expect(lines).toEqual([
      `expired organisation ${ACME}'s runs before 2026-08-17: 0 flake records, 1 days totalled`,
      `expired organisation ${GLOBEX}'s runs before 2026-08-17: 0 flake records, 1 days totalled`,
    ]);
  });
});

describe("the daily expiry on a local D1, stopped by its statement cap", () => {
  let whole: Record<string, unknown[]>;

  beforeAll(async () => {
    await withOrgs(held.db);
    await seed(held.db);
    await expireAll(env(), { db: held.db, now: NOW, log: () => {} });
    whole = await tables(held.db);
  }, 60_000);

  it("expires the seed in full when nothing stops it", () => {
    expect(whole.flakeRecords).toHaveLength(12);
    // ACME: two days of REPO and one of OTHER. GLOBEX: one day.
    expect(whole.dailyTotals).toHaveLength(4);
    expect(whole.jobs).toHaveLength(1);
  });

  it("ends with the same tables as one whole run, wherever the cap stopped the first", async () => {
    let stopped = true;
    let cap = 1;
    for (; stopped; cap += 1) {
      await wipe(held.db);
      await seed(held.db);
      const lines: string[] = [];
      const capped = drizzle(capStatements(held.d1, cap), { schema });
      await expireAll(env(), { db: capped, now: NOW, log: (line) => lines.push(line) });
      stopped = lines.some((line) => line.includes("statement cap"));
      await expireAll(env(), { db: held.db, now: NOW, log: () => {} });

      expect(await tables(held.db), `cap ${cap}`).toEqual(whole);
    }
    // The run took this many statements, so every stopping point was tried.
    expect(cap).toBeGreaterThan(20);
  }, 60_000);
});
