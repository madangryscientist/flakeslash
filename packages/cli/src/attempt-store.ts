/**
 * The attempts of the local store: every attempt the reader finished, jobs or none. An attempt
 * that listed no jobs has no `jobs` row, so this table is what holds it. Only the CLI imports this file
 * (through `store.ts`). A row here is never a job: `readJobs` does not look at it.
 */
import type { Database } from "bun:sqlite";
import type { HeldAttempt, ReadAttempt, Store } from "@hackcove/flakeslash-engine";

export const ATTEMPT_SCHEMA = `
CREATE TABLE IF NOT EXISTS attempts (
  repo TEXT NOT NULL,
  run_id INTEGER NOT NULL,
  run_attempt INTEGER NOT NULL,
  conclusion TEXT,
  created_at TEXT NOT NULL,
  latest_attempt INTEGER NOT NULL,
  job_count INTEGER NOT NULL,
  PRIMARY KEY (repo, run_id, run_attempt)
);
`;

interface AttemptRow {
  repo: string;
  run_id: number;
  run_attempt: number;
  conclusion: string | null;
  created_at: string;
  latest_attempt: number;
  job_count: number;
}

/** The attempt methods of `Store` over the attempts table. */
export function attemptStore(
  db: Database,
): Pick<Store, "writeAttempts" | "readAttempts" | "heldAttempts"> {
  const writeRow = db.prepare(
    `INSERT OR REPLACE INTO attempts
       (repo, run_id, run_attempt, conclusion, created_at, latest_attempt, job_count)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const writeAll = db.transaction((attempts: ReadAttempt[]) => {
    for (const a of attempts) {
      writeRow.run(
        a.repo,
        a.runId,
        a.runAttempt,
        a.conclusion,
        a.createdAt,
        a.latestAttempt,
        a.jobCount,
      );
    }
  });
  const readRows = db.query<AttemptRow, [string]>(
    `SELECT repo, run_id, run_attempt, conclusion, created_at, latest_attempt, job_count
     FROM attempts WHERE repo = ? ORDER BY run_id, run_attempt`,
  );
  // An attempt read with no jobs has no jobs row, so it is held by its attempts row.
  const heldRows = db.query<{ run_id: number; run_attempt: number }, [string, string]>(
    `SELECT run_id, run_attempt FROM jobs WHERE repo = ?
     GROUP BY run_id, run_attempt
     HAVING SUM(conclusion IS NULL) = 0
     UNION
     SELECT run_id, run_attempt FROM attempts WHERE repo = ? AND job_count = 0
     ORDER BY run_id, run_attempt`,
  );
  return {
    async heldAttempts(repo): Promise<HeldAttempt[]> {
      return heldRows
        .all(repo, repo)
        .map((row) => ({ runId: row.run_id, runAttempt: row.run_attempt }));
    },
    async writeAttempts(attempts) {
      writeAll(attempts);
    },
    async readAttempts(repo) {
      return readRows.all(repo).map((row) => ({
        repo: row.repo,
        runId: row.run_id,
        runAttempt: row.run_attempt,
        conclusion: row.conclusion,
        createdAt: row.created_at,
        latestAttempt: row.latest_attempt,
        jobCount: row.job_count,
      }));
    },
  };
}
