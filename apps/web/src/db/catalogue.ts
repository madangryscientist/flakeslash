import { and, eq } from "drizzle-orm";
import type { Db } from "./db.ts";
import { compares, failures, issues, jobs } from "./schema.ts";
import { real } from "./synthetic.ts";

// Every query that reads data a person sees filters by organisation (`org_id`) and by `real()`, so
// one customer never sees another's rows and no smoke row reaches a page, count or bill.

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

/** One organisation's real jobs. */
export function readJobs(db: Db, orgId: number) {
  return db
    .select()
    .from(jobs)
    .where(and(eq(jobs.orgId, orgId), real(jobs.isSmoke)));
}

/** One organisation's real compares. */
export function readCompares(db: Db, orgId: number) {
  return db
    .select()
    .from(compares)
    .where(and(eq(compares.orgId, orgId), real(compares.isSmoke)));
}
