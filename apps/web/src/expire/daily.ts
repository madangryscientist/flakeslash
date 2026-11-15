/**
 * The daily expiry: `expireOrg` for every organisation with a run to expire, smoke ones too, through one D1 handle capped at
 * `SCAN_D1_CAP` (`d1CapOf`). On the cap it stops and logs; every step is idempotent, so the next day carries on.
 */
import { asc, lt, min } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { BatchDb } from "#/db/d1-store.ts";
import type { Db } from "#/db/db.ts";
import * as schema from "#/db/schema.ts";
import { capStatements, d1CapOf, isCapReached } from "#/scan/d1-cap.ts";
import { log as workerLog } from "#/server/log.ts";
import { expireOrg, orphanRuns } from "./expire.ts";
import { cutoffOf } from "./kept.ts";

export interface ExpireDeps {
  db: BatchDb;
  /** ISO 8601. */
  now: string;
  log: (line: string) => void;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The organisations with a run (smoke or not) created before `cutoff`, or an orphan run (`orphanRuns`)
 * dated before it, the one whose oldest such run is oldest first. One statement: the attempts' dates and
 * the orphans' dates in a `UNION ALL`. One the cap stopped the run before is first the next day, and one
 * with nothing to expire costs no statement, so no organisation is left behind for good.
 */
async function dueOrgs(db: BatchDb, cutoff: string): Promise<number[]> {
  const q: Db = db;
  const { attempts } = schema;
  const orphans = orphanRuns(q, () => undefined, cutoff);
  const dated = q
    .select({ orgId: attempts.orgId, createdAt: attempts.createdAt })
    .from(attempts)
    .where(lt(attempts.createdAt, cutoff))
    .unionAll(q.select({ orgId: orphans.orgId, createdAt: orphans.createdAt }).from(orphans))
    .as("dated");
  const rows = await q
    .select({ orgId: dated.orgId })
    .from(dated)
    .groupBy(dated.orgId)
    .orderBy(asc(min(dated.createdAt)), asc(dated.orgId));
  return rows.map((row) => row.orgId);
}

/** `expireOrg`, with a failure other than the cap logged, so the next organisation still runs. */
async function expireOne(db: BatchDb, orgId: number, now: string, log: ExpireDeps["log"]) {
  try {
    await expireOrg(db, orgId, now, log);
  } catch (error) {
    if (isCapReached(error)) throw error;
    log(`the expiry of organisation ${orgId} failed: ${message(error)}`);
  }
}

/** Runs the expiry for every organisation. Nothing throws out of it: a failure is a log line. */
export async function expireAll(
  env: { DB: D1Database; SCAN_D1_CAP?: number | string },
  deps: Partial<ExpireDeps> = {},
): Promise<void> {
  const log = deps.log ?? workerLog;
  const db = deps.db ?? drizzle(capStatements(env.DB, d1CapOf(env)), { schema });
  const now = deps.now ?? new Date().toISOString();
  try {
    for (const id of await dueOrgs(db, cutoffOf(now))) await expireOne(db, id, now, log);
  } catch (error) {
    log(
      isCapReached(error)
        ? `the daily expiry stopped at its D1 statement cap; the next run carries on`
        : `the daily expiry failed: ${message(error)}`,
    );
  }
}
