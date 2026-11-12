/**
 * The flake rate over a window: for each job, and for each test a flake names from a `log` or `junit`
 * source, how many commits that ran it flaked. A commit counts once however many times it ran. A `model`
 * name never makes a row and never changes one. Pure: no clock (the caller gives `now`), no I/O, and the
 * input is not changed.
 */
import { outcomeOf, type JobFlake } from "./flakes.ts";
import type { JobRecord } from "./providers/github-actions.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface FlakeRate {
  repo: string;
  workflow: string;
  jobName: string;
  /** Null for the job's own rate. A test: its name and file, from a `log` or `junit` source only. */
  test: { name: string; file: string | null } | null;
  /** Distinct commits in the window on which this job (or, with no JUnit, the job holding this test) ran. */
  commits: number;
  /** Distinct commits in the window on which it flaked. */
  flakyCommits: number;
  /** flakyCommits / commits, or null when commits is 0. */
  rate: number | null;
  /**
   * How "ran" was decided: `job`, a commit counts as running the test because the job holding it ran.
   * Always `job` until the JUnit reader exists; that ticket widens the type.
   */
  ranBy: "job";
}

interface TestState {
  name: string;
  file: string | null;
  /** The window commits that named the test. */
  commits: Set<string>;
}

interface JobState {
  repo: string;
  workflow: string;
  jobName: string;
  /** Distinct commits in the window on which the job ran (a record with an outcome and a start time). */
  ran: Set<string>;
  /** Distinct window commits on which the job flaked. */
  flaky: Set<string>;
  /** Each test from a `log` or `junit` flake on a window commit. */
  tests: Map<string, TestState>;
}

/**
 * The rate of every job that has a record, and of every test a window flake names. `now` is an ISO time;
 * the window is `now - days * 24h < startedAt <= now`, with `days` defaulting to 30. A record with no
 * start time, or one that does not parse, is not counted. `flakes` are the flakes after `nameFlakeTests`.
 */
export function flakeRates(
  records: JobRecord[],
  flakes: JobFlake[],
  options: { now: string; days?: number },
): FlakeRate[] {
  const { startMs, nowMs } = windowOf(options.now, options.days);

  const jobs = jobsOf(records, startMs, nowMs);
  addFlakes(jobs, flakes);

  const rows: FlakeRate[] = [];
  for (const job of jobs.values()) {
    const commits = job.ran.size;
    rows.push(row(job, null, commits, job.flaky.size));
    for (const test of job.tests.values()) {
      rows.push(row(job, { name: test.name, file: test.file }, commits, test.commits.size));
    }
  }
  return rows.toSorted(compareRows);
}

/** Every job with a record, with the distinct commits in the window on which it ran. */
function jobsOf(records: JobRecord[], startMs: number, nowMs: number): Map<string, JobState> {
  const jobs = new Map<string, JobState>();
  for (const record of records) {
    const key = jobKey(record.repo, record.workflow, record.jobName);
    let job = jobs.get(key);
    if (!job) {
      job = {
        repo: record.repo,
        workflow: record.workflow,
        jobName: record.jobName,
        ran: new Set(),
        flaky: new Set(),
        tests: new Map(),
      };
      jobs.set(key, job);
    }
    if (inWindow(record, startMs, nowMs)) job.ran.add(record.commit);
  }
  return jobs;
}

/**
 * The window `now - days * 24h < startedAt <= now` as epoch milliseconds, `days` defaulting to 30. Throws
 * a RangeError when `now` is not a time. Every window test in the engine goes through this and `inWindow`.
 */
export function windowOf(now: string, days = 30): { startMs: number; nowMs: number } {
  const nowMs = Date.parse(now);
  if (Number.isNaN(nowMs)) throw new RangeError(`now is not a time: ${now}`);
  return { startMs: nowMs - days * DAY_MS, nowMs };
}

/** Whether a record counts as a run in the window: it has an outcome and a start time inside the window. */
export function inWindow(record: JobRecord, startMs: number, nowMs: number): boolean {
  if (outcomeOf(record) === null || record.startedAt === null) return false;
  const startedMs = Date.parse(record.startedAt);
  return startedMs > startMs && startedMs <= nowMs;
}

/** Adds each flake on a window commit to its job: the flaky commit, and the tests it names by source. */
function addFlakes(jobs: Map<string, JobState>, flakes: JobFlake[]): void {
  for (const flake of flakes) {
    const job = jobs.get(jobKey(flake.repo, flake.workflow, flake.jobName));
    if (!job || !job.ran.has(flake.commit)) continue;
    job.flaky.add(flake.commit);
    for (const test of flake.tests) {
      // A `model` name is never a key: it neither makes a row nor changes one.
      if (test.source === "model") continue;
      const key = JSON.stringify([test.name, test.file]);
      let state = job.tests.get(key);
      if (!state) {
        state = { name: test.name, file: test.file, commits: new Set() };
        job.tests.set(key, state);
      }
      state.commits.add(flake.commit);
    }
  }
}

function jobKey(repo: string, workflow: string, jobName: string): string {
  return JSON.stringify([repo, workflow, jobName]);
}

function row(
  job: JobState,
  test: FlakeRate["test"],
  commits: number,
  flakyCommits: number,
): FlakeRate {
  return {
    repo: job.repo,
    workflow: job.workflow,
    jobName: job.jobName,
    test,
    commits,
    flakyCommits,
    rate: commits === 0 ? null : flakyCommits / commits,
    ranBy: "job",
  };
}

function compareText(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Repo, workflow and job name by plain string order; the job's own row first, then its tests. */
function compareRows(a: FlakeRate, b: FlakeRate): number {
  return (
    compareText(a.repo, b.repo) ||
    compareText(a.workflow, b.workflow) ||
    compareText(a.jobName, b.jobName) ||
    compareTests(a.test, b.test)
  );
}

/** The job's own row (null) first, then tests by name, then file with null first. */
function compareTests(a: FlakeRate["test"], b: FlakeRate["test"]): number {
  if (a === null) return b === null ? 0 : -1;
  if (b === null) return 1;
  if (a.name !== b.name) return compareText(a.name, b.name);
  if (a.file === b.file) return 0;
  if (a.file === null) return -1;
  if (b.file === null) return 1;
  return compareText(a.file, b.file);
}
