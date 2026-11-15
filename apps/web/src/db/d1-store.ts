/**
 * The engine's `Store` over D1, for one organisation: the server's counterpart of the CLI's SQLite file
 * (`packages/cli/src/store.ts`). Rows are encoded as the CLI encodes them (JSON text columns, booleans),
 * and every read and write is scoped to `org_id`.
 */
import { and, asc, eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { SqliteRemoteDatabase } from "drizzle-orm/sqlite-proxy";
import type { JobRecord, Store } from "@hackcove/flakeslash-engine";
import { attemptMethods } from "./d1-attempt-store.ts";
import { catalogueMethods } from "./d1-catalogue-store.ts";
import { compareMethods } from "./d1-compare-store.ts";
import { upsertAll, type Scope } from "./d1-store-shared.ts";
import { jobFromRow, statusOf } from "./rows.ts";
import * as schema from "./schema.ts";

const { excerpts, jobs } = schema;

/** A Drizzle handle with `batch`: D1 in production, the `testDb()` proxy in tests. */
export type BatchDb = SqliteRemoteDatabase<typeof schema> | DrizzleD1Database<typeof schema>;

function jobRow(own: Scope["own"], job: JobRecord): typeof jobs.$inferInsert {
  return {
    ...own,
    provider: job.provider,
    repo: job.repo,
    runId: job.runId,
    runAttempt: job.runAttempt,
    jobId: job.jobId,
    workflow: job.workflow,
    jobName: job.jobName,
    url: job.url,
    commitSha: job.commit,
    branch: job.branch,
    prNumber: job.prNumber,
    runner: job.runner,
    runnerName: job.runnerName,
    conclusion: job.conclusion,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    steps: JSON.stringify(job.steps),
    annotations: JSON.stringify(job.annotations),
  };
}

function jobMethods(scope: Scope): Pick<Store, "writeJobs" | "readJobs"> {
  const { q, orgId, own } = scope;
  return {
    async writeJobs(records) {
      await upsertAll(
        scope,
        jobs,
        [jobs.orgId, jobs.provider, jobs.repo, jobs.runId, jobs.runAttempt, jobs.jobId],
        records.map((job) => jobRow(own, job)),
      );
    },
    async readJobs(repo) {
      const rows = await q
        .select()
        .from(jobs)
        .where(and(eq(jobs.orgId, orgId), eq(jobs.repo, repo)))
        .orderBy(asc(jobs.runId), asc(jobs.runAttempt), asc(jobs.jobId));
      return rows.map(jobFromRow);
    },
  };
}

function excerptMethods(
  scope: Scope,
): Pick<Store, "writeExcerpt" | "excerptJobIds" | "readExcerpts"> {
  const { q, orgId, own } = scope;
  const ofRepo = (repo: string) => and(eq(excerpts.orgId, orgId), eq(excerpts.repo, repo));
  return {
    async writeExcerpt(excerpt) {
      await upsertAll(
        scope,
        excerpts,
        [excerpts.orgId, excerpts.repo, excerpts.jobId],
        [{ ...own, ...excerpt }],
      );
    },
    async excerptJobIds(repo) {
      const rows = await q
        .select({ jobId: excerpts.jobId })
        .from(excerpts)
        .where(ofRepo(repo))
        .orderBy(asc(excerpts.jobId));
      return rows.map((row) => row.jobId);
    },
    async readExcerpts(repo) {
      const rows = await q.select().from(excerpts).where(ofRepo(repo)).orderBy(asc(excerpts.jobId));
      return rows.map((row) => ({
        repo: row.repo,
        jobId: row.jobId,
        url: row.url,
        status: statusOf(row.status),
        excerpt: row.excerpt,
      }));
    },
  };
}

/**
 * The engine's `Store` for organisation `orgId`. Every write sets `org_id` and `is_smoke = smoke`;
 * every read filters on `org_id` alone, so a smoke organisation's scan sees its own rows (smoke rows
 * never share an organisation with real ones). What people read filters `real()` instead (`catalogue.ts`).
 */
export function d1Store(db: BatchDb, orgId: number, { smoke = false } = {}): Store {
  const scope: Scope = { db, q: db, orgId, own: { orgId, isSmoke: smoke } };
  return {
    ...jobMethods(scope),
    ...attemptMethods(scope),
    ...excerptMethods(scope),
    ...catalogueMethods(scope),
    ...compareMethods(scope),
  };
}
