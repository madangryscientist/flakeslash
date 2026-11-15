import { eq } from "drizzle-orm";
import { integer, type SQLiteColumn } from "drizzle-orm/sqlite-core";

/**
 * Every table a smoke run can write to carries this column. A smoke account's rows are
 * `is_smoke = 1`; everything a person or a report reads filters them out with `real()`.
 */
export const isSmoke = () => integer("is_smoke", { mode: "boolean" }).notNull().default(false);

/** The WHERE clause for any query that feeds a report, dashboard, count, listing or bill. */
export const real = (column: SQLiteColumn) => eq(column, false);
