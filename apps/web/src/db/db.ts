import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type * as schema from "./schema.ts";

/** Any async SQLite handle over the schema: D1 in production, the `testDb()` proxy in tests. */
export type Db = BaseSQLiteDatabase<"async", unknown, typeof schema>;
