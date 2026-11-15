/** The attempt methods of `d1Store`: every attempt the reader finished, jobs or none. */
import { and, asc, eq, exists, sql } from "drizzle-orm";
import type { Store } from "@hackcove/flakeslash-engine";
import { upsertAll, type Scope } from "./d1-store-shared.ts";
import { attempts, jobs } from "./schema.ts";

export function attemptMethods(
  scope: Scope,
): Pick<Store, "writeAttempts" | "readAttempts" | "heldAttempts"> {
  const { q, orgId, own } = scope;
  return {
    async writeAttempts(read) {
      await upsertAll(
        scope,
        attempts,
        [attempts.orgId, attempts.repo, attempts.runId, attempts.runAttempt],
        read.map((attempt) => ({ ...own, ...attempt })),
      );
    },
    async readAttempts(repo) {
      const rows = await q
        .select()
        .from(attempts)
        .where(and(eq(attempts.orgId, orgId), eq(attempts.repo, repo)))
        .orderBy(asc(attempts.runId), asc(attempts.runAttempt));
      return rows.map((row) => ({
        repo: row.repo,
        runId: row.runId,
        runAttempt: row.runAttempt,
        conclusion: row.conclusion,
        createdAt: row.createdAt,
        latestAttempt: row.latestAttempt,
        jobCount: row.jobCount,
      }));
    },
    async heldAttempts(repo) {
      // An attempt with jobs is held when none is unfinished and its attempts row is written (a write
      // stopped between the two leaves jobs alone); one read with no jobs is held by its attempts row.
      const finished = q
        .select({ runId: jobs.runId, runAttempt: jobs.runAttempt })
        .from(jobs)
        .where(
          and(
            eq(jobs.orgId, orgId),
            eq(jobs.repo, repo),
            exists(
              q
                .select({ one: sql`1` })
                .from(attempts)
                .where(
                  and(
                    eq(attempts.orgId, jobs.orgId),
                    eq(attempts.repo, jobs.repo),
                    eq(attempts.runId, jobs.runId),
                    eq(attempts.runAttempt, jobs.runAttempt),
                  ),
                ),
            ),
          ),
        )
        .groupBy(jobs.runId, jobs.runAttempt)
        .having(sql`SUM(${jobs.conclusion} IS NULL) = 0`);
      const empty = q
        .select({ runId: attempts.runId, runAttempt: attempts.runAttempt })
        .from(attempts)
        .where(and(eq(attempts.orgId, orgId), eq(attempts.repo, repo), eq(attempts.jobCount, 0)));
      return finished.union(empty).orderBy(asc(sql`1`), asc(sql`2`));
    },
  };
}
