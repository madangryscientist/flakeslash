/** Fixtures for the expiry tests: whole runs written through the D1 store, and every table read back. */
import type { JobRecord, ReadAttempt } from "@hackcove/flakeslash-engine";
import { d1Store, type BatchDb } from "#/db/d1-store.ts";
import type { Db } from "#/db/db.ts";
import * as schema from "#/db/schema.ts";
import { REPO, job } from "#/db/test-store.ts";

/** The expiry's clock in the tests: the cutoff is 2026-08-17. */
export const NOW = "2026-11-15T12:00:00Z";
/** 91 days before `NOW`: expires. */
export const OLD = "2026-08-16T10:00:00Z";
/** 89 days before `NOW`: stays. */
export const NEW = "2026-08-18T10:00:00Z";

export interface Run {
  runId: number;
  runAttempt?: number;
  createdAt: string;
  jobs: Partial<JobRecord>[];
  repo?: string;
}

function recordsOf(run: Run): { attempt: ReadAttempt; jobs: JobRecord[] } {
  const repo = run.repo ?? REPO;
  const runAttempt = run.runAttempt ?? 1;
  const attempt = {
    repo,
    runId: run.runId,
    runAttempt,
    conclusion: "failure",
    createdAt: run.createdAt,
    latestAttempt: runAttempt,
    jobCount: run.jobs.length,
  };
  const jobs = run.jobs.map((overrides) =>
    job({
      repo,
      runId: run.runId,
      runAttempt,
      url: `https://github.com/${repo}/actions/runs/${run.runId}/job/${overrides.jobId ?? 1}`,
      ...overrides,
    }),
  );
  return { attempt, jobs };
}

/** Writes the runs' attempts and their jobs (each job's `url` from its id unless given). */
export async function seedRuns(
  db: BatchDb,
  orgId: number,
  runs: Run[],
  { smoke = false } = {},
): Promise<void> {
  const store = d1Store(db, orgId, { smoke });
  const written = runs.map(recordsOf);
  await store.writeAttempts(written.map((run) => run.attempt));
  await store.writeJobs(written.flatMap((run) => run.jobs));
}

/** `seedRuns` for one run. */
export const seedRun = (db: BatchDb, orgId: number, run: Run, options = {}) =>
  seedRuns(db, orgId, [run], options);

const TABLES = {
  jobs: schema.jobs,
  attempts: schema.attempts,
  excerpts: schema.excerpts,
  failures: schema.failures,
  modelCalls: schema.modelCalls,
  compares: schema.compares,
  issues: schema.issues,
  flakeRecords: schema.flakeRecords,
  dailyTotals: schema.dailyTotals,
};

const sorted = (rows: unknown[]) =>
  rows.toSorted((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));

/** Every row of every table the expiry touches, each table's rows in a stable order. One batch. */
export async function tables(db: BatchDb): Promise<Record<string, unknown[]>> {
  const q: Db = db;
  const names = Object.keys(TABLES);
  const [first, ...rest] = Object.values(TABLES).map((table) => q.select().from(table));
  const read: unknown[][] = first === undefined ? [] : await db.batch([first, ...rest]);
  return Object.fromEntries(names.map((name, at) => [name, sorted(read[at] ?? [])]));
}

/** Empties every table the expiry touches, in one batch. */
export async function wipe(db: BatchDb): Promise<void> {
  const q: Db = db;
  const [first, ...rest] = Object.values(TABLES).map((table) => q.delete(table));
  if (first !== undefined) await db.batch([first, ...rest]);
}
