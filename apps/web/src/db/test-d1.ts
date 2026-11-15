import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/d1";
import { getPlatformProxy } from "wrangler";
import type { BatchDb } from "./d1-store.ts";
import * as schema from "./schema.ts";

const MIGRATIONS = new URL("../../drizzle/", import.meta.url);
const CONFIG = fileURLToPath(new URL("../../wrangler.jsonc", import.meta.url));

/**
 * A fresh local D1 (miniflare, through wrangler) with the real migrations applied. Slower than
 * `testDb()`, and only for what in-memory SQLite does not enforce: D1's limits, such as its 100
 * bound parameters per statement. Nothing is persisted; call `dispose` when done.
 */
export async function d1Db(): Promise<{
  db: BatchDb;
  /** The binding itself, as a Worker's `env.DB`. */
  d1: D1Database;
  dispose: () => Promise<void>;
}> {
  const proxy = await getPlatformProxy<{ DB: D1Database }>({ configPath: CONFIG, persist: false });
  for (const file of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .toSorted()) {
    for (const stmt of readFileSync(new URL(file, MIGRATIONS), "utf8").split(
      "--> statement-breakpoint",
    )) {
      if (stmt.trim()) await proxy.env.DB.prepare(stmt).run();
    }
  }
  return {
    db: drizzle(proxy.env.DB, { schema }),
    d1: proxy.env.DB,
    dispose: () => proxy.dispose(),
  };
}
