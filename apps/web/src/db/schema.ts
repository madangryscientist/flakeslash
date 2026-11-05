import { sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * The one table the skeleton has: key/value facts about the deployment itself (for example the
 * schema's own version). There is no product data yet; the product tables arrive with the product.
 */
export const appMeta = sqliteTable("app_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});
