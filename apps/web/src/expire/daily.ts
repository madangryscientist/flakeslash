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
import { expireOrg } from "./expire.ts";
import { cutoffOf } from "./kept.ts";

export interface ExpireDeps {
  db: BatchDb;
  /** ISO 8601. */
  now: string;
  log: (line: string) => void;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The organisations with a run (smoke or not) before `cutoff`, the one whose oldest such run is oldest
 * first. One the cap stopped the run before is first the next day, and one with nothing to expire costs
 * no statement, so no organisation is left behind for good.
 */
async function dueOrgs(db: BatchDb, cutoff: string): Promise<number[]> {
  const q: Db = db;
  const { attempts } = schema;
  const oldest = min(attempts.createdAt);
  const rows = await q
    .select({ orgId: attempts.orgId })
    .from(attempts)
    .where(lt(attempts.createdAt, cutoff))
    .groupBy(attempts.orgId)
    .orderBy(asc(oldest), asc(attempts.orgId));
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
