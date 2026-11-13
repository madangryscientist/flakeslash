/**
 * The local store: job records in one SQLite file, so a later scan knows what an earlier one already
 * read. It implements the engine's `Store` on `bun:sqlite`. Only the CLI imports this file; the server
 * gets its own implementation over D1.
 */
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { CATALOGUE_SCHEMA, catalogueStore, migrateCatalogue } from "./catalogue-store.ts";
import { COMPARE_SCHEMA, compareStore } from "./compare-store.ts";
import {
  isRunner,
  type HeldAttempt,
  type JobExcerpt,
  type JobRecord,
  type Runner,
  type Store,
} from "@hackcove/flakeslash-engine";

export const DEFAULT_STORE_PATH = ".flakeslash/flakeslash.db";

export interface SqliteStore extends Store {
  /** Closes the file. Not on `Store`: a D1 store has nothing to close. */
  close(): void;
}

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
CREATE TABLE IF NOT EXISTS excerpts (
  repo TEXT NOT NULL,
  job_id INTEGER NOT NULL,
  url TEXT NOT NULL,
  status TEXT NOT NULL,
  excerpt TEXT,
  PRIMARY KEY (repo, job_id)
);
${COMPARE_SCHEMA}${CATALOGUE_SCHEMA}
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

interface ExcerptRow {
  repo: string;
  job_id: number;
  url: string;
  status: string;
  excerpt: string | null;
}

function statusOf(value: string): JobExcerpt["status"] {
  if (value !== "kept" && value !== "gone") {
    throw new Error(`the store holds an unknown excerpt status: ${value}`);
  }
  return value;
}

function runnerOf(value: string): Runner {
  if (!isRunner(value)) throw new Error(`the store holds an unknown runner: ${value}`);
  return value;
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
export function openSqliteStore(
  path: string = DEFAULT_STORE_PATH,
  { durable = true }: { durable?: boolean | undefined } = {},
): SqliteStore {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  // A first open converts an old rollback-journal file to WAL, which needs a lock another command may hold.
  db.exec("PRAGMA busy_timeout = 5000");
  const wal =
    db.query<{ journal_mode: string }, []>("PRAGMA journal_mode = WAL").get()?.journal_mode ===
    "wal";
  // WAL with `synchronous = NORMAL` drops the fsync per commit. A crash cannot corrupt the file; a
  // power cut mid-command can lose that command's last commits, which a rerun repeats. When it is the
  // last connection to the file, `close()` checkpoints into the main file and syncs it, so a command
  // that returned has its writes on disk; while another command still has the file open, they wait for
  // that one to close. Where WAL is refused the file keeps SQLite's default (`FULL`).
  // `durable: false` is for a throwaway store, such as a test's: no write waits for the disk at all.
  if (!durable) db.exec("PRAGMA synchronous = OFF");
  else if (wal) db.exec("PRAGMA synchronous = NORMAL");
  // One transaction for the whole schema: a fresh file costs one commit, not one per statement. It
  // starts as a write, so two commands opening an old file at once wait on busy_timeout, not fail.
  db.transaction(() => {
    db.exec(SCHEMA);
    migrateCatalogue(db);
  }).immediate();

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

  const writeExcerptRow = db.prepare(
    "INSERT OR REPLACE INTO excerpts (repo, job_id, url, status, excerpt) VALUES (?, ?, ?, ?, ?)",
  );
  const excerptIdsQuery = db.query<{ job_id: number }, [string]>(
    "SELECT job_id FROM excerpts WHERE repo = ? ORDER BY job_id",
  );
  const excerptsQuery = db.query<ExcerptRow, [string]>(
    "SELECT repo, job_id, url, status, excerpt FROM excerpts WHERE repo = ? ORDER BY job_id",
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
    async writeExcerpt(excerpt: JobExcerpt): Promise<void> {
      writeExcerptRow.run(
        excerpt.repo,
        excerpt.jobId,
        excerpt.url,
        excerpt.status,
        excerpt.excerpt,
      );
    },
    async excerptJobIds(repo: string): Promise<number[]> {
      return excerptIdsQuery.all(repo).map((row) => row.job_id);
    },
    async readExcerpts(repo: string): Promise<JobExcerpt[]> {
      return excerptsQuery.all(repo).map((row) => ({
        repo: row.repo,
        jobId: row.job_id,
        url: row.url,
        status: statusOf(row.status),
        excerpt: row.excerpt,
      }));
    },
    ...catalogueStore(db),
    ...compareStore(db),
    close(): void {
      // `true` finalizes the open statements, so the connection really closes and the log is folded back.
      db.close(true);
    },
  };
}
