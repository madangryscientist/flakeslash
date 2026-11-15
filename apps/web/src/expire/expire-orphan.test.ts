import { beforeEach, describe, expect, it } from "vitest";
import { d1Store, type BatchDb } from "#/db/d1-store.ts";
import { ACME, failure, withOrgs } from "#/db/test-store.ts";
import { expireOrg } from "./expire.ts";
import {
  C1,
  C2,
  NEW,
  NOW,
  OLD,
  OLD_TEST_RECORD,
  OLD_TOTALS,
  seedOld,
  seedOrphan,
  tables,
} from "./test-seed.ts";

let db: BatchDb;
const log = () => {};

beforeEach(async () => {
  db = await withOrgs();
});

describe("the expiry of an orphan run (jobs with no attempts row)", () => {
  it("removes an orphan attempt 91 days old with its run's other attempt, as two normal attempts", async () => {
    await seedOld(db, ACME, { orphan: true });

    await expireOrg(db, ACME, NOW, log);

    const after = await tables(db);
    expect(after.jobs).toEqual([]);
    expect(after.attempts).toEqual([]);
    expect(after.failures).toEqual([]);
    expect(after.excerpts).toEqual([]);
    expect(after.modelCalls).toEqual([]);
    expect(after.flakeRecords).toEqual([OLD_TEST_RECORD]);
    expect(after.dailyTotals).toEqual(OLD_TOTALS);
  });

  it("keeps an orphan attempt 89 days old, rows and all", async () => {
    await seedOld(db, ACME, { orphan: true, day: "2026-08-18" });
    const before = await tables(db);

    await expireOrg(db, ACME, NOW, log);

    expect(await tables(db)).toEqual(before);
  });

  it("removes an orphan whole when its earliest job is before the cutoff and another after", async () => {
    await seedOrphan(db, ACME, {
      runId: 10,
      createdAt: OLD,
      jobs: [
        { jobId: 1, startedAt: "2026-08-16T23:00:00Z", completedAt: "2026-08-16T23:01:00Z" },
        { jobId: 2, startedAt: "2026-08-18T01:00:00Z", completedAt: "2026-08-18T01:01:00Z" },
      ],
    });

    await expireOrg(db, ACME, NOW, log);

    const after = await tables(db);
    expect(after.jobs).toEqual([]);
    expect(after.dailyTotals).toMatchObject([{ day: "2026-08-16", jobs: 2, seconds: 120 }]);
  });

  it("dates an orphan by a job's end when it has no start", async () => {
    await seedOrphan(db, ACME, {
      runId: 10,
      createdAt: OLD,
      jobs: [{ jobId: 1, startedAt: null, completedAt: "2026-08-15T09:00:00Z" }],
    });

    await expireOrg(db, ACME, NOW, log);

    const after = await tables(db);
    expect(after.jobs).toEqual([]);
    expect(after.dailyTotals).toMatchObject([{ day: "2026-08-15", jobs: 1 }]);
  });

  it("keeps an orphan whose jobs have no times", async () => {
    await seedOrphan(db, ACME, {
      runId: 10,
      createdAt: OLD,
      jobs: [{ jobId: 1, conclusion: "failure", startedAt: null, completedAt: null }],
    });
    await d1Store(db, ACME).writeFailures([failure(1, "key:a")]);
    const before = await tables(db);

    await expireOrg(db, ACME, NOW, log);

    expect(await tables(db)).toEqual(before);
  });

  it("removes a smoke orphan, but counts it in no total and makes no record of it", async () => {
    await seedOrphan(
      db,
      ACME,
      {
        runId: 10,
        createdAt: OLD,
        jobs: [
          { jobId: 1, commit: C1, conclusion: "failure", startedAt: OLD },
          { jobId: 2, commit: C1, startedAt: OLD },
        ],
      },
      { smoke: true },
    );

    await expireOrg(db, ACME, NOW, log);

    const after = await tables(db);
    expect(after.jobs).toEqual([]);
    expect(after.dailyTotals).toEqual([]);
    expect(after.flakeRecords).toEqual([]);
  });

  it("changes nothing when run twice", async () => {
    await seedOld(db, ACME, { orphan: true });
    await seedOrphan(db, ACME, {
      runId: 20,
      createdAt: NEW,
      jobs: [{ jobId: 20, commit: C2, startedAt: NEW }],
    });
    await expireOrg(db, ACME, NOW, log);
    const once = await tables(db);
    expect(once.jobs).toHaveLength(1);

    await expireOrg(db, ACME, NOW, log);

    expect(await tables(db)).toEqual(once);
  });
});
