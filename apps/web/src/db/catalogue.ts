import { and, eq } from "drizzle-orm";
import type { SqliteRemoteDatabase } from "drizzle-orm/sqlite-proxy";
import { failures, issues } from "./schema.ts";
import { real } from "./synthetic.ts";

// Every query that reads data a person sees filters by organisation (`org_id`) and by `real()`, so
// one customer never sees another's rows and no smoke row reaches a page, count or bill.

type Db = Pick<SqliteRemoteDatabase, "select">;

/** One organisation's real issues. */
export function readIssues(db: Db, orgId: number) {
  return db
    .select()
    .from(issues)
    .where(and(eq(issues.orgId, orgId), real(issues.isSmoke)));
}

/** One organisation's real failures. */
export function readFailures(db: Db, orgId: number) {
  return db
    .select()
    .from(failures)
    .where(and(eq(failures.orgId, orgId), real(failures.isSmoke)));
}
