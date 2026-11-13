/**
 * How much of a repo's window the store covers, run by run. The store holds a run in two places: its
 * `jobs` rows, and its attempt rows (`ReadAttempt`), which also exist for an attempt that listed no
 * jobs. A run is counted once, however many attempts it has.
 */
import type { JobRecord } from "./providers/github-actions.ts";
import type { ListedRun, ReadAttempt } from "./providers/github-attempt.ts";

export interface RunCoverage {
  /**
   * Runs created in the window that are not still running and whose latest attempt was read. A run the
   * listing showed completed but whose latest attempt a rate limit left unread is in neither this nor
   * `stillRunning`. When the runs listing itself was cut, a run is judged by the attempts the store
   * holds: as far as the store knew, not as GitHub has it now.
   */
  read: number;
  /** Of those, the runs none of whose held attempts listed a job. */
  noJobs: number;
  /** `noJobs` by the run's conclusion (`none` for a run GitHub gave no conclusion), most first. */
  noJobsByConclusion: Record<string, number>;
  /** Runs this scan listed whose latest attempt was not completed, so was left unread. */
  stillRunning: number;
}

/** The part of a job record the coverage reads. */
export type JobRun = Pick<JobRecord, "runId" | "runAttempt">;

interface RunSeen {
  /** Null for a run only its jobs show; `listed` dates that one. */
  createdAt: string | null;
  /** The conclusion of the latest attempt row, with that attempt's number. */
  conclusion: { attempt: number; value: string | null } | null;
  /** The run's latest attempt as its attempt rows saw it (0: no attempt row). */
  latest: number;
  hasJobs: boolean;
  /** The highest attempt a jobs row shows (0: none). A store from before attempt rows has these only. */
  jobsLatest: number;
}

type Runs = Map<number, RunSeen>;

function runOf(runs: Runs, runId: number): RunSeen {
  const found = runs.get(runId) ?? {
    createdAt: null,
    conclusion: null,
    latest: 0,
    hasJobs: false,
    jobsLatest: 0,
  };
  runs.set(runId, found);
  return found;
}

function addAttempts(runs: Runs, attempts: readonly ReadAttempt[]): void {
  for (const attempt of attempts) {
    const run = runOf(runs, attempt.runId);
    run.createdAt = attempt.createdAt;
    run.latest = Math.max(run.latest, attempt.latestAttempt);
    if (run.conclusion === null || attempt.runAttempt > run.conclusion.attempt) {
      run.conclusion = { attempt: attempt.runAttempt, value: attempt.conclusion };
    }
    if (attempt.jobCount > 0) run.hasJobs = true;
  }
}

/** Marks the runs that have jobs. */
function addJobs(runs: Runs, jobs: readonly JobRun[]): void {
  for (const job of jobs) {
    const run = runOf(runs, job.runId);
    run.hasJobs = true;
    run.jobsLatest = Math.max(run.jobsLatest, job.runAttempt);
  }
}

/**
 * Whether a run is in the window and fully known: the attempts read (attempt rows or jobs rows) reach
 * its latest attempt, as this scan's listing or its own attempt rows give it. A run whose latest attempt was never read (a rate
 * limit cut the read, or it was a re-run in progress) is not known to have no jobs, so it is left out.
 * A run only its jobs show has no attempt rows and is dated by the listing.
 */
function counted(run: RunSeen, seen: ListedRun | undefined, sinceMs: number): boolean {
  const created = run.createdAt ?? seen?.createdAt;
  if (created === undefined || Date.parse(created) < sinceMs) return false;
  const read = Math.max(run.conclusion?.attempt ?? 0, run.jobsLatest);
  return read >= Math.max(run.latest, seen?.runAttempt ?? 0);
}

export interface CoverageInput {
  attempts: readonly ReadAttempt[];
  jobs: readonly JobRun[];
  /** The runs this scan's listing gave in the window. */
  listed: ReadonlyMap<number, ListedRun>;
  /** An ISO date: runs created before it are outside the window. */
  since: string;
  /** The runs this scan listed whose latest attempt had not completed: counted as running, not read. */
  running: ReadonlySet<number>;
}

/**
 * The coverage of the runs created on or after `since`. A run's created time is on its attempt rows; a
 * run read before attempt rows existed has only jobs, and is dated by `listed`, the runs this scan's
 * listing gave in the window (run id to `created_at`). A run neither has a time for is not counted: when
 * the listing finished, it was created before `since`; when a rate limit cut the listing short, it is
 * older than where the listing stopped, so a cut scan covers the newer part of the window only.
 */
export function runCoverage(input: CoverageInput): RunCoverage {
  const { attempts, jobs, listed, since, running } = input;
  const sinceMs = Date.parse(since);
  const runs: Runs = new Map();
  addAttempts(runs, attempts);
  addJobs(runs, jobs);
  const counts = new Map<string, number>();
  let read = 0;
  let noJobs = 0;
  for (const [runId, run] of runs) {
    if (running.has(runId) || !counted(run, listed.get(runId), sinceMs)) continue;
    read += 1;
    if (run.hasJobs) continue;
    noJobs += 1;
    const name = run.conclusion?.value ?? "none";
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const ordered = [...counts].toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return {
    read,
    noJobs,
    noJobsByConclusion: Object.fromEntries(ordered),
    stillRunning: running.size,
  };
}
