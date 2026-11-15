/** Fixtures for the expiry tests: whole runs written through the D1 store, and every table read back. */
import type { JobRecord, ReadAttempt } from "@hackcove/flakeslash-engine";
import { d1Store, type BatchDb } from "#/db/d1-store.ts";
import type { Db } from "#/db/db.ts";
import * as schema from "#/db/schema.ts";
import { ACME, REPO, failure, issue, job, kept } from "#/db/test-store.ts";

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

/**
 * Writes the run's jobs with no `attempts` row: an orphan run, as the scan leaves one whose attempt it
 * did not finish writing. Its failures are written by the caller, as for `seedRun`.
 */
export async function seedOrphan(
  db: BatchDb,
  orgId: number,
  run: Run,
  { smoke = false } = {},
): Promise<void> {
  await d1Store(db, orgId, { smoke }).writeJobs(recordsOf(run).jobs);
}

export const C1 = "c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1";
export const C2 = "c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2";
export const url = (runId: number, jobId: number) =>
  `https://github.com/${REPO}/actions/runs/${runId}/job/${jobId}`;

/**
 * Run 10, 91 days old (on `day`, 2026-08-16 by default). Attempt 1: `test` fails on C1 (5 min 30 s)
 * with a failure on issue `key:a`, an excerpt and a model call; `lint` passes (60.5 s). Attempt 2:
 * `test` passes on C1 (4 min). A self-hosted `build` fails on attempt 1 with no end time. With
 * `orphan`, attempt 1's jobs are written without its `attempts` row.
 */
export async function seedOld(
  db: BatchDb,
  orgId = ACME,
  { orphan = false, day = "2026-08-16" } = {},
) {
  const first: Run = {
    runId: 10,
    createdAt: `${day}T10:00:00Z`,
    jobs: [
      {
        jobId: 1,
        commit: C1,
        conclusion: "failure",
        startedAt: `${day}T10:00:00Z`,
        completedAt: `${day}T10:05:30Z`,
      },
      {
        jobId: 2,
        jobName: "lint",
        commit: C1,
        startedAt: `${day}T10:00:00Z`,
        completedAt: `${day}T10:01:00.500Z`,
      },
      {
        jobId: 4,
        jobName: "build",
        commit: C1,
        runner: "self-hosted",
        conclusion: "failure",
        startedAt: `${day}T10:00:00Z`,
        completedAt: null,
      },
    ],
  };
  await (orphan ? seedOrphan(db, orgId, first) : seedRun(db, orgId, first));
  await seedRun(db, orgId, {
    runId: 10,
    runAttempt: 2,
    createdAt: `${day}T10:00:00Z`,
    jobs: [
      {
        jobId: 3,
        commit: C1,
        startedAt: `${day}T11:00:00Z`,
        completedAt: `${day}T11:04:00Z`,
      },
    ],
  });
  const store = d1Store(db, orgId);
  await store.writeIssue(issue("key:a"));
  await store.writeFailures([{ ...failure(1, "key:a"), title: "adds" }]);
  await store.writeExcerpt(kept({ jobId: 1, url: url(10, 1) }));
  await store.writeModelCall({ repo: REPO, jobId: 1, issueId: "key:a", outcome: "explained" });
}

export const OLD_TEST_RECORD = {
  orgId: ACME,
  repo: REPO,
  workflow: "CI",
  jobName: "test",
  commitSha: C1,
  day: "2026-08-16",
  failedUrl: url(10, 1),
  passedUrl: url(10, 3),
  issueIds: '["key:a"]',
  provider: "github-actions",
  runner: "github-hosted",
  isSmoke: false,
};

const OLD_DAY = { orgId: ACME, repo: REPO, day: "2026-08-16", isSmoke: false };
export const OLD_TOTALS = [
  {
    ...OLD_DAY,
    provider: "github-actions",
    runner: "github-hosted",
    // jobs 1, 2 and 3; 1 and 2 on attempt 1, of which 2 passed; 1 failed.
    jobs: 3,
    firstAttemptJobs: 2,
    firstAttemptPassed: 1,
    failedJobs: 1,
    flakes: 1,
    // 330 + 60 (60.5 floored) + 240.
    seconds: 630,
  },
  {
    ...OLD_DAY,
    provider: "github-actions",
    runner: "self-hosted",
    jobs: 1,
    firstAttemptJobs: 1,
    firstAttemptPassed: 0,
    failedJobs: 1,
    flakes: 0,
    seconds: 0,
  },
];

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
