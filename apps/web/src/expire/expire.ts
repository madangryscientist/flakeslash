/**
 * The expiry of one organisation's detailed rows: a run goes once its `created_at` is before the UTC
 * midnight `KEEP_DAYS` days back. What people need over time is written first and stays: a flake record
 * for each proven flake with evidence in an expiring run, and the daily totals of each expiring day.
 * Every step is idempotent, so a run stopped partway (by D1's statement cap) is finished by the next.
 */
import { findJobFlakes, followOnJobs } from "@hackcove/flakeslash-engine";
import { and, eq, lt, not, sql, type SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import type { BatchDb } from "#/db/d1-store.ts";
import { chunks, runBatch, type Statement } from "#/db/d1-store-shared.ts";
import type { Db } from "#/db/db.ts";
import { failureFromRow, jobFromRow } from "#/db/rows.ts";
import {
  attempts,
  compares,
  dailyTotals,
  excerpts,
  failures,
  flakeRecords,
  jobs,
  modelCalls,
} from "#/db/schema.ts";
import { real } from "#/db/synthetic.ts";
import {
  cutoffOf,
  dailyTotalRows,
  dayKey,
  dayOf,
  expiringRuns,
  flakeKey,
  flakeRecordRows,
  runKey,
  type FlakeRecordRow,
  type Held,
} from "./kept.ts";

export interface ExpireResult {
  /** The day before which runs went, `YYYY-MM-DD`. */
  cutoff: string;
  records: number;
  days: number;
}

/** The organisation's real jobs, failures and run times. */
async function readHeld(q: Db, orgId: number): Promise<Held> {
  const [jobRows, failureRows, attemptRows] = await Promise.all([
    q
      .select()
      .from(jobs)
      .where(and(eq(jobs.orgId, orgId), real(jobs.isSmoke))),
    q
      .select()
      .from(failures)
      .where(and(eq(failures.orgId, orgId), real(failures.isSmoke))),
    q
      .select({
        repo: attempts.repo,
        runId: attempts.runId,
        runAttempt: attempts.runAttempt,
        createdAt: attempts.createdAt,
      })
      .from(attempts)
      .where(and(eq(attempts.orgId, orgId), real(attempts.isSmoke))),
  ]);
  return {
    orgId,
    jobs: jobRows.map(jobFromRow),
    failures: failureRows.map(failureFromRow),
    runs: attemptRows,
    createdAt: new Map(
      attemptRows.map((a) => [runKey(a.repo, a.runId, a.runAttempt), a.createdAt]),
    ),
  };
}

/** Multi-row inserts that leave any row already there as it is, chunked under D1's bound values. */
function inserts<T extends typeof flakeRecords | typeof dailyTotals>(
  q: Db,
  table: T,
  rows: T["$inferInsert"][],
): Statement[] {
  return chunks(rows, table).map((chunk) => q.insert(table).values(chunk).onConflictDoNothing());
}

async function readRecords(q: Db, orgId: number): Promise<FlakeRecordRow[]> {
  return q
    .select()
    .from(flakeRecords)
    .where(and(eq(flakeRecords.orgId, orgId), real(flakeRecords.isSmoke)));
}

/** Step 2: a record for each flake with evidence in an expiring run that has none yet. Chunk by chunk. */
async function writeRecords(db: BatchDb, held: Held, expiring: Set<string>): Promise<number> {
  const recorded = new Set((await readRecords(db, held.orgId)).map(flakeKey));
  const flakes = findJobFlakes(held.jobs, followOnJobs(held.jobs, held.failures));
  const rows = flakeRecordRows(held, flakes, expiring, recorded);
  for (const statement of inserts(db, flakeRecords, rows)) await runBatch(db, [statement]);
  return rows.length;
}

/** Step 3: each expiring (repo, day) with no totals yet, written whole in one batch. */
async function writeTotals(db: BatchDb, held: Held, expiring: Set<string>): Promise<number> {
  const q: Db = db;
  const totalled = await q
    .selectDistinct({ repo: dailyTotals.repo, day: dailyTotals.day })
    .from(dailyTotals)
    .where(eq(dailyTotals.orgId, held.orgId));
  const done = new Set(totalled.map((row) => dayKey(row.repo, row.day)));
  const days = new Map<string, [string, string]>();
  for (const run of held.runs) {
    const day = dayOf(run.createdAt);
    const key = dayKey(run.repo, day);
    if (expiring.has(runKey(run.repo, run.runId, run.runAttempt)) && !done.has(key)) {
      days.set(key, [run.repo, day]);
    }
  }
  if (days.size === 0) return 0;
  const records = await readRecords(db, held.orgId);
  for (const [repo, day] of days.values()) {
    await runBatch(db, inserts(db, dailyTotals, dailyTotalRows(held, repo, day, records)));
  }
  return days.size;
}

/** `(cols) IN (subquery)`: SQLite's row values, so one statement deletes a whole set. */
const inSet = (columns: SQLiteColumn[], subquery: SQL | { getSQL(): SQL }) =>
  sql`(${sql.join(columns, sql`, `)}) IN ${subquery}`;

/** Whether a remaining job of the compare's repo is on `commit`. */
const onAJob = (commit: SQLiteColumn) =>
  sql`EXISTS (SELECT 1 FROM ${jobs} WHERE ${jobs.orgId} = ${compares.orgId} AND ${jobs.repo} = ${compares.repo} AND ${jobs.commitSha} = ${commit})`;

/**
 * Step 4, in one batch so it is all or nothing: the expiring runs' failures, excerpts and model calls,
 * then their jobs, then their attempts, smoke rows too; then each compare neither of whose commits is
 * on a remaining job of its repo.
 */
function deletes(q: Db, orgId: number, cutoff: string): Statement[] {
  const runs = q
    .select({ repo: attempts.repo, runId: attempts.runId, runAttempt: attempts.runAttempt })
    .from(attempts)
    .where(and(eq(attempts.orgId, orgId), lt(attempts.createdAt, cutoff)));
  const expiredJobs = q
    .select({ repo: jobs.repo, jobId: jobs.jobId })
    .from(jobs)
    .where(and(eq(jobs.orgId, orgId), inSet([jobs.repo, jobs.runId, jobs.runAttempt], runs)));
  const ofJobs = (table: typeof failures | typeof excerpts | typeof modelCalls) =>
    q
      .delete(table)
      .where(and(eq(table.orgId, orgId), inSet([table.repo, table.jobId], expiredJobs)));
  return [
    ofJobs(failures),
    ofJobs(excerpts),
    ofJobs(modelCalls),
    q
      .delete(jobs)
      .where(and(eq(jobs.orgId, orgId), inSet([jobs.repo, jobs.runId, jobs.runAttempt], runs))),
    q.delete(attempts).where(and(eq(attempts.orgId, orgId), lt(attempts.createdAt, cutoff))),
    q
      .delete(compares)
      .where(
        and(eq(compares.orgId, orgId), not(onAJob(compares.base)), not(onAJob(compares.head))),
      ),
  ];
}

/** Expires one organisation's runs created before UTC midnight `KEEP_DAYS` days before `now`. */
export async function expireOrg(
  db: BatchDb,
  orgId: number,
  now: string,
  log: (line: string) => void,
): Promise<ExpireResult> {
  const cutoff = cutoffOf(now);
  const held = await readHeld(db, orgId);
  const expiring = expiringRuns(held, cutoff);
  const records = expiring.size === 0 ? 0 : await writeRecords(db, held, expiring);
  const days = expiring.size === 0 ? 0 : await writeTotals(db, held, expiring);
  await runBatch(db, deletes(db, orgId, cutoff));
  log(
    `expired organisation ${orgId}'s runs before ${cutoff}: ${records} flake records, ${days} days totalled`,
  );
  return { cutoff, records, days };
}
