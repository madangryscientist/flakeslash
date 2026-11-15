import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { d1Store, type BatchDb } from "#/db/d1-store.ts";
import type { Db } from "#/db/db.ts";
import { attempts, dailyTotals, flakeRecords, jobs } from "#/db/schema.ts";
import { ACME, GLOBEX, OTHER, REPO, kept, withOrgs } from "#/db/test-store.ts";
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
  seedRun,
  tables,
  url,
} from "./test-seed.ts";

let db: BatchDb;
const lines: string[] = [];
const log = (line: string) => lines.push(line);

beforeEach(async () => {
  db = await withOrgs();
  lines.length = 0;
});

describe("the expiry of one organisation", () => {
  it("removes a run 91 days old, keeping its flake as a record and its day as totals", async () => {
    await seedOld(db);

    await expireOrg(db, ACME, NOW, log);

    const after = await tables(db);
    expect(after.jobs).toEqual([]);
    expect(after.attempts).toEqual([]);
    expect(after.failures).toEqual([]);
    expect(after.excerpts).toEqual([]);
    expect(after.modelCalls).toEqual([]);
    expect(after.issues).toHaveLength(1);
    expect(after.flakeRecords).toEqual([OLD_TEST_RECORD]);
    expect(after.dailyTotals).toEqual(OLD_TOTALS);
    expect(lines).toEqual([
      `expired organisation ${ACME}'s runs before 2026-08-17: 1 flake records, 1 days totalled`,
    ]);
  });

  it("keeps a run 89 days old, rows and all, and totals nothing for its day", async () => {
    await seedRun(db, ACME, { runId: 30, createdAt: NEW, jobs: [{ jobId: 30 }] });
    await d1Store(db, ACME).writeExcerpt(kept({ jobId: 30 }));
    const before = await tables(db);

    await expireOrg(db, ACME, NOW, log);

    expect(await tables(db)).toEqual(before);
  });

  it("records a flake whose passing attempt is newer, and keeps the newer run", async () => {
    await seedRun(db, ACME, {
      runId: 10,
      createdAt: OLD,
      jobs: [{ jobId: 1, commit: C1, conclusion: "failure" }],
    });
    await seedRun(db, ACME, { runId: 20, createdAt: NEW, jobs: [{ jobId: 2, commit: C1 }] });

    await expireOrg(db, ACME, NOW, log);

    const after = await tables(db);
    expect(after.flakeRecords).toEqual([
      { ...OLD_TEST_RECORD, failedUrl: url(10, 1), passedUrl: url(20, 2), issueIds: "[]" },
    ]);
    const q: Db = db;
    expect(await q.select({ runId: jobs.runId }).from(jobs)).toEqual([{ runId: 20 }]);
    expect(await q.select({ runId: attempts.runId }).from(attempts)).toEqual([{ runId: 20 }]);
  });

  it("removes nothing further and changes no total or record when run twice", async () => {
    await seedOld(db);
    await seedRun(db, ACME, { runId: 20, createdAt: NEW, jobs: [{ jobId: 20, commit: C2 }] });
    await expireOrg(db, ACME, NOW, log);
    const once = await tables(db);

    await expireOrg(db, ACME, NOW, log);

    expect(await tables(db)).toEqual(once);
    expect(lines[1]).toBe(
      `expired organisation ${ACME}'s runs before 2026-08-17: 0 flake records, 0 days totalled`,
    );
  });

  it("removes smoke rows, but counts them in no total and makes no record of them", async () => {
    await seedRun(
      db,
      ACME,
      {
        runId: 10,
        createdAt: OLD,
        jobs: [
          { jobId: 1, commit: C1, conclusion: "failure" },
          { jobId: 2, commit: C1 },
        ],
      },
      { smoke: true },
    );

    await expireOrg(db, ACME, NOW, log);

    const after = await tables(db);
    expect(after.jobs).toEqual([]);
    expect(after.attempts).toEqual([]);
    expect(after.flakeRecords).toEqual([]);
    expect(after.dailyTotals).toEqual([]);
  });

  it("deletes a compare whose commits are both gone, and keeps one with a commit remaining", async () => {
    await seedRun(db, ACME, { runId: 10, createdAt: OLD, jobs: [{ jobId: 1, commit: C1 }] });
    await seedRun(db, ACME, { runId: 20, createdAt: NEW, jobs: [{ jobId: 2, commit: C2 }] });
    const store = d1Store(db, ACME);
    await store.writeCompare(REPO, "c0", C1, { status: "ok", files: ["a.ts"] });
    await store.writeCompare(REPO, C1, C2, { status: "ok", files: ["b.ts"] });
    // C2 is on a job of REPO only: in OTHER it is gone.
    await store.writeCompare(OTHER, C1, C2, { status: "missing" });

    await expireOrg(db, ACME, NOW, log);

    const after = await tables(db);
    expect(after.compares).toEqual([
      { orgId: ACME, repo: REPO, base: C1, head: C2, files: '["b.ts"]', isSmoke: false },
    ]);
  });

  it("keeps two organisations apart", async () => {
    await seedOld(db, ACME);
    await seedOld(db, GLOBEX);
    const q: Db = db;

    await expireOrg(db, ACME, NOW, log);

    expect(await q.select().from(jobs).where(eq(jobs.orgId, GLOBEX))).toHaveLength(4);
    expect(await q.select().from(jobs).where(eq(jobs.orgId, ACME))).toEqual([]);
    expect(await q.select().from(flakeRecords).where(eq(flakeRecords.orgId, GLOBEX))).toEqual([]);
    expect(await q.select().from(dailyTotals).where(eq(dailyTotals.orgId, GLOBEX))).toEqual([]);
    expect(await q.select().from(dailyTotals).where(eq(dailyTotals.orgId, ACME))).toHaveLength(2);
  });

  it("records a flake whose pass is older when the pass expires, and totals it with its failure", async () => {
    await seedRun(db, ACME, { runId: 10, createdAt: OLD, jobs: [{ jobId: 1, commit: C1 }] });
    await seedRun(db, ACME, {
      runId: 20,
      createdAt: "2026-08-20T09:00:00Z",
      jobs: [{ jobId: 2, commit: C1, conclusion: "failure" }],
    });
    const q: Db = db;
    const totalsOf = (day: string) =>
      q
        .select({ flakes: dailyTotals.flakes, jobs: dailyTotals.jobs })
        .from(dailyTotals)
        .where(and(eq(dailyTotals.orgId, ACME), eq(dailyTotals.day, day)));

    await expireOrg(db, ACME, NOW, log);

    const record = {
      ...OLD_TEST_RECORD,
      day: "2026-08-20",
      failedUrl: url(20, 2),
      passedUrl: url(10, 1),
      issueIds: "[]",
    };
    expect(await q.select().from(flakeRecords)).toEqual([record]);
    expect(await totalsOf("2026-08-16")).toEqual([{ flakes: 0, jobs: 1 }]);
    expect(await totalsOf("2026-08-20")).toEqual([]);

    // Four days on, the cutoff is 2026-08-21 and the failing run goes too.
    await expireOrg(db, ACME, "2026-11-19T12:00:00Z", log);

    expect(await q.select().from(flakeRecords)).toEqual([record]);
    expect(await totalsOf("2026-08-20")).toEqual([{ flakes: 1, jobs: 1 }]);
    expect(await q.select().from(jobs)).toEqual([]);
  });
});
