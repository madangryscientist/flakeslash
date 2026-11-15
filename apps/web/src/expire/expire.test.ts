import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { d1Store, type BatchDb } from "#/db/d1-store.ts";
import type { Db } from "#/db/db.ts";
import { attempts, dailyTotals, flakeRecords, jobs } from "#/db/schema.ts";
import { ACME, GLOBEX, OTHER, REPO, failure, issue, kept, withOrgs } from "#/db/test-store.ts";
import { expireOrg } from "./expire.ts";
import { NEW, NOW, OLD, seedRun, tables } from "./test-seed.ts";

const C1 = "c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1";
const C2 = "c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2";
const url = (runId: number, jobId: number) =>
  `https://github.com/${REPO}/actions/runs/${runId}/job/${jobId}`;

let db: BatchDb;
const lines: string[] = [];
const log = (line: string) => lines.push(line);

beforeEach(async () => {
  db = await withOrgs();
  lines.length = 0;
});

/**
 * Run 10, 91 days old. Attempt 1: `test` fails on C1 (5 min 30 s) with a failure on issue `key:a`, an
 * excerpt and a model call; `lint` passes (60.5 s). Attempt 2: `test` passes on C1 (4 min). A
 * self-hosted `build` fails on attempt 1 with no end time.
 */
async function seedOld(orgId = ACME) {
  await seedRun(db, orgId, {
    runId: 10,
    createdAt: OLD,
    jobs: [
      {
        jobId: 1,
        commit: C1,
        conclusion: "failure",
        startedAt: "2026-08-16T10:00:00Z",
        completedAt: "2026-08-16T10:05:30Z",
      },
      {
        jobId: 2,
        jobName: "lint",
        commit: C1,
        startedAt: "2026-08-16T10:00:00Z",
        completedAt: "2026-08-16T10:01:00.500Z",
      },
      {
        jobId: 4,
        jobName: "build",
        commit: C1,
        runner: "self-hosted",
        conclusion: "failure",
        startedAt: "2026-08-16T10:00:00Z",
        completedAt: null,
      },
    ],
  });
  await seedRun(db, orgId, {
    runId: 10,
    runAttempt: 2,
    createdAt: OLD,
    jobs: [
      {
        jobId: 3,
        commit: C1,
        startedAt: "2026-08-16T11:00:00Z",
        completedAt: "2026-08-16T11:04:00Z",
      },
    ],
  });
  const store = d1Store(db, orgId);
  await store.writeIssue(issue("key:a"));
  await store.writeFailures([{ ...failure(1, "key:a"), title: "adds" }]);
  await store.writeExcerpt(kept({ jobId: 1, url: url(10, 1) }));
  await store.writeModelCall({ repo: REPO, jobId: 1, issueId: "key:a", outcome: "explained" });
}

const OLD_TEST_RECORD = {
  orgId: ACME,
  repo: REPO,
  workflow: "CI",
  jobName: "test",
  commitSha: C1,
  day: "2026-08-16",
  failedUrl: url(10, 1),
  passedUrl: url(10, 3),
  issueIds: '["key:a"]',
  provider: "github-actions",
  runner: "github-hosted",
  isSmoke: false,
};

describe("the expiry of one organisation", () => {
  it("removes a run 91 days old, keeping its flake as a record and its day as totals", async () => {
    await seedOld();

    await expireOrg(db, ACME, NOW, log);

    const after = await tables(db);
    expect(after.jobs).toEqual([]);
    expect(after.attempts).toEqual([]);
    expect(after.failures).toEqual([]);
    expect(after.excerpts).toEqual([]);
    expect(after.modelCalls).toEqual([]);
    expect(after.issues).toHaveLength(1);
    expect(after.flakeRecords).toEqual([OLD_TEST_RECORD]);
    const day = { orgId: ACME, repo: REPO, day: "2026-08-16", isSmoke: false };
    expect(after.dailyTotals).toEqual([
      {
        ...day,
        provider: "github-actions",
        runner: "github-hosted",
        // jobs 1, 2 and 3; 1 and 2 on attempt 1, of which 2 passed; 1 failed.
        jobs: 3,
        firstAttemptJobs: 2,
        firstAttemptPassed: 1,
        failedJobs: 1,
        flakes: 1,
        // 330 + 60 (60.5 floored) + 240.
        seconds: 630,
      },
      {
        ...day,
        provider: "github-actions",
        runner: "self-hosted",
        jobs: 1,
        firstAttemptJobs: 1,
        firstAttemptPassed: 0,
        failedJobs: 1,
        flakes: 0,
        seconds: 0,
      },
    ]);
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
    await seedOld();
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
    await seedOld(ACME);
    await seedOld(GLOBEX);
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
