import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import * as schema from "./schema.ts";

const MIGRATIONS = new URL("../../drizzle/", import.meta.url);

type Method = "run" | "all" | "values" | "get";

export interface TestDbOptions {
  /**
   * Makes `db.batch` throw when it reaches this statement (counting from 0), after running the ones
   * before it. The batch's transaction then rolls back, so a test can see that a batch is all or nothing.
   */
  failBatchAt?: number;
}

/**
 * An in-memory SQLite with the real migrations applied, behind the same async Drizzle API
 * D1 gives in production, `db.batch` included: a batch runs in one transaction, all or nothing as on D1.
 * Tests only: no network, no Cloudflare account. Runs under Bun (`bun --bun vitest`).
 */
export function testDb({ failBatchAt }: TestDbOptions = {}) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const file of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .toSorted()) {
    for (const stmt of readFileSync(new URL(file, MIGRATIONS), "utf8").split(
      "--> statement-breakpoint",
    )) {
      sqlite.exec(stmt);
    }
  }
  const exec = (query: string, params: SQLInputValue[], method: Method) => {
    const stmt = sqlite.prepare(query);
    // Arrays, not objects: a join selecting two `id` columns must keep both.
    stmt.setReturnArrays(true);
    if (method === "run") {
      stmt.run(...params);
      return { rows: [] };
    }
    const rows = stmt.all(...params).map((r) => Object.values(r));
    return { rows: method === "get" ? (rows[0] ?? []) : rows };
  };
  return drizzle(
    async (query, params, method) => exec(query, params, method),
    async (queries) => {
      sqlite.exec("BEGIN");
      try {
        const results = queries.map(({ sql, params, method }, at) => {
          if (at === failBatchAt) throw new Error(`the batch failed at statement ${at}`);
          return exec(sql, params, method);
        });
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
    { schema },
  );
}
