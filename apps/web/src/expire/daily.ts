/**
 * The daily expiry: `expireOrg` for every organisation, smoke ones too, through one D1 handle capped at
 * `D1_STATEMENT_CAP`. On the cap it stops and logs; every step is idempotent, so the next day carries on.
 */
import { asc } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { BatchDb } from "#/db/d1-store.ts";
import type { Db } from "#/db/db.ts";
import * as schema from "#/db/schema.ts";
import { capStatements, D1_STATEMENT_CAP, isCapReached } from "#/scan/d1-cap.ts";
import { log as workerLog } from "#/server/log.ts";
import { expireOrg } from "./expire.ts";

export interface ExpireDeps {
  db: BatchDb;
  /** ISO 8601. */
  now: string;
  log: (line: string) => void;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

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
  env: { DB: D1Database },
  deps: Partial<ExpireDeps> = {},
): Promise<void> {
  const log = deps.log ?? workerLog;
  const db = deps.db ?? drizzle(capStatements(env.DB, D1_STATEMENT_CAP), { schema });
  const now = deps.now ?? new Date().toISOString();
  try {
    const q: Db = db;
    const orgs = await q
      .select({ id: schema.organisations.id })
      .from(schema.organisations)
      .orderBy(asc(schema.organisations.id));
    for (const { id } of orgs) await expireOne(db, id, now, log);
  } catch (error) {
    log(
      isCapReached(error)
        ? `the daily expiry stopped at its D1 statement cap; the next run carries on`
        : `the daily expiry failed: ${message(error)}`,
    );
  }
}
