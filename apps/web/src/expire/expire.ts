/**
 * The expiry of one organisation's detailed rows: a run goes once its `created_at` is before the UTC
 * midnight 90 days back (`cutoffOf`). A run with jobs and no `attempts` row is dated by `orphanRuns`. What people need over time is written first and stays: a flake record
 * for each proven flake with evidence in an expiring run, and the daily totals of each expiring day.
 * Every step is idempotent, so a run stopped partway (by D1's statement cap) is finished by the next.
 */
import { findJobFlakes, followOnJobs } from "@hackcove/flakeslash-engine";
import { and, eq, isNotNull, lt, not, notExists, or, sql, type SQL } from "drizzle-orm";
import { alias, type SQLiteColumn } from "drizzle-orm/sqlite-core";
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

const orphanJobs = alias(jobs, "orphan_jobs");

/**
 * The orphan runs: each (repo, run_id, run_attempt) with job rows and no `attempts` row, which the scan
 * can no longer complete once the run left its 90-day window or the repo left the installation. Its
 * stand-in `created_at` is `MIN(COALESCE(started_at, completed_at))` over its jobs; `readHeld`, the
 * delete and `dueOrgs` all date an orphan by this one rule, so they agree on what expires.
 *
 * Accepted inaccuracy: a re-run keeps its run's `created_at` while its jobs start later, so a re-run
 * orphan is dated a little late. It is kept a little past 90 days, and its flake record and daily
 * totals land on its jobs' day. That errs toward keeping, and orphans are rare.
 *
 * An orphan with no time on any job has no date and is left out, so it is kept indefinitely. An
 * unfinished attempt is not held, so the scan re-reads it while it is in the window; a finished job
 * with neither time is possible in principle only, as the parser keeps both nullable.
 *
 * `where` filters the jobs (by organisation, by smoke); `before` keeps the orphans dated before it.
 */
export function orphanRuns(
  q: Db,
  where: (orphan: typeof orphanJobs) => SQL | undefined,
  before?: string,
) {
  const orphan = orphanJobs;
  const createdAt = sql<string>`MIN(COALESCE(${orphan.startedAt}, ${orphan.completedAt}))`;
  const attempt = q
    .select({ one: sql`1` })
    .from(attempts)
    .where(
      and(
        eq(attempts.orgId, orphan.orgId),
        eq(attempts.repo, orphan.repo),
        eq(attempts.runId, orphan.runId),
        eq(attempts.runAttempt, orphan.runAttempt),
      ),
    );
  return q
    .select({
      orgId: orphan.orgId,
      repo: orphan.repo,
      runId: orphan.runId,
      runAttempt: orphan.runAttempt,
      createdAt: createdAt.as("created_at"),
    })
    .from(orphan)
    .where(and(where(orphan), notExists(attempt)))
    .groupBy(orphan.orgId, orphan.repo, orphan.runId, orphan.runAttempt)
    .having(before === undefined ? isNotNull(createdAt) : lt(createdAt, before))
    .as("orphan_runs");
}

/** The organisation's real jobs, failures and run times, an orphan run's from `orphanRuns`. */
async function readHeld(q: Db, orgId: number): Promise<Held> {
  const orphans = orphanRuns(q, (j) => and(eq(j.orgId, orgId), real(j.isSmoke)));
  const [jobRows, failureRows, attemptRows, orphanRows] = await Promise.all([
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
    q
      .select({
        repo: orphans.repo,
        runId: orphans.runId,
        runAttempt: orphans.runAttempt,
        createdAt: orphans.createdAt,
      })
      .from(orphans),
  ]);
  const runs = [...attemptRows, ...orphanRows];
  return {
    orgId,
    jobs: jobRows.map(jobFromRow),
    failures: failureRows.map(failureFromRow),
    runs,
    createdAt: new Map(runs.map((a) => [runKey(a.repo, a.runId, a.runAttempt), a.createdAt])),
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

/**
 * Step 2: a record for each flake with evidence in an expiring run that has none yet, chunk by chunk.
 * Returns the records written and the organisation's records as they now are.
 */
async function writeRecords(db: BatchDb, held: Held, expiring: Set<string>) {
  const before = await readRecords(db, held.orgId);
  const flakes = findJobFlakes(held.jobs, followOnJobs(held.jobs, held.failures));
  const rows = flakeRecordRows(held, flakes, expiring, new Set(before.map(flakeKey)));
  for (const statement of inserts(db, flakeRecords, rows)) await runBatch(db, [statement]);
  return { written: rows.length, records: [...before, ...rows] };
}

/** Step 3: each expiring (repo, day) with no totals yet, written whole in one batch. */
async function writeTotals(
  db: BatchDb,
  held: Held,
  expiring: Set<string>,
  records: FlakeRecordRow[],
): Promise<number> {
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
 * on a remaining job of its repo. The expiring runs are the attempts created before the cutoff and the
 * orphan runs (`orphanRuns`) dated before it.
 */
function deletes(q: Db, orgId: number, cutoff: string): Statement[] {
  const runs = q
    .select({ repo: attempts.repo, runId: attempts.runId, runAttempt: attempts.runAttempt })
    .from(attempts)
    .where(and(eq(attempts.orgId, orgId), lt(attempts.createdAt, cutoff)));
  const orphans = orphanRuns(q, (j) => eq(j.orgId, orgId), cutoff);
  const orphanKeys = q
    .select({ repo: orphans.repo, runId: orphans.runId, runAttempt: orphans.runAttempt })
    .from(orphans);
  const runColumns = [jobs.repo, jobs.runId, jobs.runAttempt];
  const expiring = or(inSet(runColumns, runs), inSet(runColumns, orphanKeys));
  const expiredJobs = q
    .select({ repo: jobs.repo, jobId: jobs.jobId })
    .from(jobs)
    .where(and(eq(jobs.orgId, orgId), expiring));
  const ofJobs = (table: typeof failures | typeof excerpts | typeof modelCalls) =>
    q
      .delete(table)
      .where(and(eq(table.orgId, orgId), inSet([table.repo, table.jobId], expiredJobs)));
  return [
    ofJobs(failures),
    ofJobs(excerpts),
    ofJobs(modelCalls),
    q.delete(jobs).where(and(eq(jobs.orgId, orgId), expiring)),
    q.delete(attempts).where(and(eq(attempts.orgId, orgId), lt(attempts.createdAt, cutoff))),
    q
      .delete(compares)
      .where(
        and(eq(compares.orgId, orgId), not(onAJob(compares.base)), not(onAJob(compares.head))),
      ),
  ];
}

/** Expires one organisation's runs created (an orphan's dated) before the cutoff (`cutoffOf(now)`). */
export async function expireOrg(
  db: BatchDb,
  orgId: number,
  now: string,
  log: (line: string) => void,
): Promise<void> {
  const cutoff = cutoffOf(now);
  const held = await readHeld(db, orgId);
  const expiring = expiringRuns(held, cutoff);
  let written = 0;
  let days = 0;
  if (expiring.size > 0) {
    const kept = await writeRecords(db, held, expiring);
    written = kept.written;
    days = await writeTotals(db, held, expiring, kept.records);
  }
  // Smoke rows go too, so this runs with no real run expiring.
  await runBatch(db, deletes(db, orgId, cutoff));
  log(
    `expired organisation ${orgId}'s runs before ${cutoff}: ${written} flake records, ${days} days totalled`,
  );
}
