import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/sqlite-proxy";

const MIGRATIONS = new URL("../../drizzle/", import.meta.url);

/**
 * An in-memory SQLite with the real migrations applied, behind the same async Drizzle API
 * D1 gives in production. Tests only: no network, no Cloudflare account. Runs under Bun (`bun --bun vitest`).
 */
export function testDb() {
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
  return drizzle(async (query, params, method) => {
    const stmt = sqlite.prepare(query);
    // Arrays, not objects: a join selecting two `id` columns must keep both.
    stmt.setReturnArrays(true);
    if (method === "run") {
      stmt.run(...params);
      return { rows: [] };
    }
    const rows = stmt.all(...params).map((r) => Object.values(r));
    return { rows: method === "get" ? (rows[0] ?? []) : rows };
  });
}
