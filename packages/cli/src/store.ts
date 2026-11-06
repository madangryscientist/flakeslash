/**
 * The local store: job records in one SQLite file, so a later scan knows what an earlier one already
 * read. It implements the engine's `Store` on `bun:sqlite`. Only the CLI imports this file; the server
 * gets its own implementation over D1.
 */
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { HeldAttempt, JobRecord, Runner, Store } from "@hackcove/flakeslash-engine";

const DEFAULT_STORE_PATH = ".flakeslash/flakeslash.db";

export interface SqliteStore extends Store {
  /** Closes the file. Not on `Store`: a D1 store has nothing to close. */
  close(): void;
}

const RUNNERS: Runner[] = ["github-hosted", "depot", "blacksmith", "self-hosted"];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  provider TEXT NOT NULL,
  repo TEXT NOT NULL,
  run_id INTEGER NOT NULL,
  run_attempt INTEGER NOT NULL,
  job_id INTEGER NOT NULL,
  workflow TEXT NOT NULL,
  job_name TEXT NOT NULL,
  url TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  branch TEXT NOT NULL,
  pr_number INTEGER,
  runner TEXT NOT NULL,
  runner_name TEXT NOT NULL,
  conclusion TEXT,
  started_at TEXT,
  completed_at TEXT,
  steps TEXT NOT NULL,
  annotations TEXT NOT NULL,
  PRIMARY KEY (provider, repo, run_id, run_attempt, job_id)
);
CREATE INDEX IF NOT EXISTS jobs_by_repo ON jobs (repo);
`;

const COLUMNS = `provider, repo, run_id, run_attempt, job_id, workflow, job_name, url, commit_sha,
  branch, pr_number, runner, runner_name, conclusion, started_at, completed_at, steps, annotations`;

interface JobRow {
  provider: JobRecord["provider"];
  repo: string;
  run_id: number;
  run_attempt: number;
  job_id: number;
  workflow: string;
  job_name: string;
  url: string;
  commit_sha: string;
  branch: string;
  pr_number: number | null;
  runner: string;
  runner_name: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  steps: string;
  annotations: string;
}

function runnerOf(value: string): Runner {
  const found = RUNNERS.find((runner) => runner === value);
  if (found === undefined) throw new Error(`the store holds an unknown runner: ${value}`);
  return found;
}

function jobFromRow(row: JobRow): JobRecord {
  return {
    repo: row.repo,
    workflow: row.workflow,
    jobName: row.job_name,
    jobId: row.job_id,
    url: row.url,
    commit: row.commit_sha,
    branch: row.branch,
    prNumber: row.pr_number,
    provider: row.provider,
    runner: runnerOf(row.runner),
    runnerName: row.runner_name,
    runId: row.run_id,
    runAttempt: row.run_attempt,
    conclusion: row.conclusion,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    steps: JSON.parse(row.steps),
    annotations: JSON.parse(row.annotations),
  };
}

/** The values of one job's row, in `COLUMNS` order. Steps and annotations are stored as JSON text. */
function rowValues(job: JobRecord): SQLQueryBindings[] {
  return [
    job.provider,
    job.repo,
    job.runId,
    job.runAttempt,
    job.jobId,
    job.workflow,
    job.jobName,
    job.url,
    job.commit,
    job.branch,
    job.prNumber,
    job.runner,
    job.runnerName,
    job.conclusion,
    job.startedAt,
    job.completedAt,
    JSON.stringify(job.steps),
    JSON.stringify(job.annotations),
  ];
}

/**
 * Opens (creating it, and its parent directory, when missing) the SQLite store at `path` and makes sure
 * its table exists. Close it with `close()` when done.
 */
export function openSqliteStore(path: string = DEFAULT_STORE_PATH): SqliteStore {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  db.exec(SCHEMA);

  const upsert = db.prepare(
    `INSERT OR REPLACE INTO jobs (${COLUMNS}) VALUES (${Array(18).fill("?").join(", ")})`,
  );
  const writeAll = db.transaction((jobs: JobRecord[]) => {
    for (const job of jobs) upsert.run(...rowValues(job));
  });
  const heldQuery = db.query<{ run_id: number; run_attempt: number }, [string]>(
    `SELECT run_id, run_attempt FROM jobs WHERE repo = ?
     GROUP BY run_id, run_attempt
     HAVING SUM(conclusion IS NULL) = 0
     ORDER BY run_id, run_attempt`,
  );
  const readQuery = db.query<JobRow, [string]>(
    `SELECT ${COLUMNS} FROM jobs WHERE repo = ? ORDER BY run_id, run_attempt, job_id`,
  );

  return {
    async writeJobs(records: JobRecord[]): Promise<void> {
      writeAll(records);
    },
    async heldAttempts(repo: string): Promise<HeldAttempt[]> {
      return heldQuery.all(repo).map((row) => ({ runId: row.run_id, runAttempt: row.run_attempt }));
    },
    async readJobs(repo: string): Promise<JobRecord[]> {
      return readQuery.all(repo).map(jobFromRow);
    },
    close(): void {
      db.close();
    },
  };
}
