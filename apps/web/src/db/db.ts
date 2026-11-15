import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";

/** Any async SQLite handle: D1 in production, the `testDb()` proxy in tests. */
export type Db = BaseSQLiteDatabase<"async", unknown>;
