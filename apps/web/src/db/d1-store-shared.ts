/** What the parts of `d1Store` share: the organisation's scope, batches, chunks and upserts. */
import { getTableColumns, sql, type SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import type { BatchDb } from "./d1-store.ts";
import type { Db } from "./db.ts";

/** D1 refuses a statement with more bound parameters than this. */
const MAX_PARAMS = 100;

export type Statement = BatchItem<"sqlite">;

/** One organisation's view of the database, as each part of `d1Store` takes it. */
export interface Scope {
  /** For `batch`, which only the two concrete handle types have. */
  db: BatchDb;
  /** For building queries: one handle type, where the union of two would not type a call. */
  q: Db;
  orgId: number;
  /** The columns every written row carries. */
  own: { orgId: number; isSmoke: boolean };
}

/** Runs the statements as one batch (one transaction on D1), or nothing when there are none. */
export async function runBatch(db: BatchDb, statements: Statement[]): Promise<void> {
  const [first, ...rest] = statements;
  if (first === undefined) return;
  await db.batch([first, ...rest]);
}

/** Splits `rows` so that no chunk binds more than `MAX_PARAMS` values in a table of this width. */
export function chunks<T>(rows: T[], table: SQLiteTable): T[][] {
  const size = Math.floor(MAX_PARAMS / Object.keys(getTableColumns(table)).length);
  const out: T[][] = [];
  for (let at = 0; at < rows.length; at += size) out.push(rows.slice(at, at + size));
  return out;
}

/**
 * The `set` of an upsert that replaces every column but the key with the row being inserted, so a
 * write replaces the row it collides with, as the CLI's `INSERT OR REPLACE` does.
 */
function replaceAll(table: SQLiteTable, key: SQLiteColumn[]): Record<string, SQL> {
  const keyNames = new Set(key.map((column) => column.name));
  const set: Record<string, SQL> = {};
  for (const [field, column] of Object.entries(getTableColumns(table))) {
    if (!keyNames.has(column.name)) set[field] = sql.raw(`excluded."${column.name}"`);
  }
  return set;
}

/**
 * The statements that write `rows` into `table`, each row replacing any row with its `key`, in chunks of
 * at most `MAX_PARAMS` bound values.
 */
export function upserts<T extends SQLiteTable>(
  q: Db,
  table: T,
  key: SQLiteColumn[],
  rows: T["$inferInsert"][],
): Statement[] {
  const set = replaceAll(table, key);
  return chunks(rows, table).map((chunk) =>
    q.insert(table).values(chunk).onConflictDoUpdate({ target: key, set }),
  );
}

/** `upserts`, run as one batch. */
export async function upsertAll<T extends SQLiteTable>(
  scope: Scope,
  table: T,
  key: SQLiteColumn[],
  rows: T["$inferInsert"][],
): Promise<void> {
  await runBatch(scope.db, upserts(scope.q, table, key, rows));
}
