/**
 * The GitHub Actions reader: a repo's run history as one plain record per job per attempt. Nothing is
 * stored, and `readGitHubActions` reads no log (`readJobLog` reads one). A run's own `conclusion` is its
 * latest attempt's only (a flaky run reads `success`), so every attempt up to `run_attempt` is read
 * through its own jobs endpoint.
 */
import { outcomeOf } from "../flakes.ts";
import {
  API_BASE,
  createApi,
  GitHubApiError,
  type Api,
  type FetchLike,
  type LogResult,
  type Wait,
} from "./github-api.ts";
import {
  listJobs,
  listRuns,
  parseAnnotations,
  parseCompareFiles,
  parseJob,
  parseRun,
  pickPullNumber,
  type ApiJob,
  type ApiRun,
  type JobAnnotation,
  type JobStep,
} from "./github-parse.ts";
import type { HeldAttempt } from "../store.ts";
import type { Runner } from "./github-runner.ts";

export type { FetchLike, LogResult } from "./github-api.ts";
export type { Runner } from "./github-runner.ts";

export interface JobRecord {
  repo: string;
  workflow: string;
  jobName: string;
  jobId: number;
  /** The job's page on GitHub. */
  url: string;
  commit: string;
  branch: string;
  /** The pull request for the commit, or null when GitHub knows none. */
  prNumber: number | null;
  provider: "github-actions";
  runner: Runner;
  /** GitHub's `runner_name`. Empty for a job that never got a runner; the job is kept. */
  runnerName: string;
  runId: number;
  runAttempt: number;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
  steps: JobStep[];
  /** Check-run annotations, read only for a `cancelled` job (a lost runner explains itself there). */
  annotations: JobAnnotation[];
}

export interface ReadGitHubActionsOptions {
  /** `owner/name`. */
  repo: string;
  /** An ISO date. Runs created before it are not read. A re-run keeps its run's `created_at`. */
  since: string;
  fetch: FetchLike;
  /** Optional: public repos read without one, at a lower rate limit. */
  token?: string;
  /** Attempts already held. They are not fetched again. */
  held?: readonly HeldAttempt[];
  /**
   * Awaited after each run with the records read for that run, when there are any, so a read that
   * later fails has still handed over everything before the failure. `records` in the result still
   * holds all of them.
   */
  onRecords?: (records: JobRecord[]) => Promise<void>;
  /** Waits between retried GitHub 5xx answers. Defaults to a real timer; a test passes its own. */
  wait?: Wait;
}

export interface ReadGitHubActionsResult {
  records: JobRecord[];
  /** True when a rate limit ended the read early. `records` is then what was read, not everything. */
  cutShort: boolean;
}

interface Ctx {
  api: Api;
  repo: string;
  /** commit sha to its pull request number (null: none). One lookup per commit per read. */
  pulls: Map<string, number | null>;
  /** run id to the attempts of it already held. */
  held: Map<number, Set<number>>;
  records: JobRecord[];
  onRecords: (records: JobRecord[]) => Promise<void>;
}

const REPO = /^[\w.-]+\/[\w.-]+$/;

/** Whether `repo` is shaped `owner/name`. */
export function isRepoName(repo: string): boolean {
  return REPO.test(repo);
}

function parseSince(since: string): number {
  const ms = Date.parse(since);
  if (Number.isNaN(ms)) throw new Error(`since is not a date: ${since}`);
  return ms;
}

/** Follow `next` links from `first`, handing each page's items to `onPage`; `false` stops early. */
async function eachPage(
  api: Api,
  first: string,
  pick: (body: unknown) => unknown[],
  onPage: (items: unknown[]) => Promise<boolean>,
): Promise<"done" | "cut" | "gone"> {
  let url: string | null = first;
  while (url !== null) {
    const res = await api.get(url);
    if (res.status === "rate-limited") return "cut";
    if (res.status === "missing") return "gone";
    if (!(await onPage(pick(res.body)))) return "done";
    url = res.next;
  }
  return "done";
}

/** A commit's pull request number, asked once. 404 and 422 (a commit GitHub no longer has) mean none. */
async function pullFor(ctx: Ctx, run: ApiRun): Promise<number | null | "cut"> {
  const known = ctx.pulls.get(run.headSha);
  if (known !== undefined) return known;
  const res = await ctx.api.get(`${API_BASE}/repos/${ctx.repo}/commits/${run.headSha}/pulls`);
  if (res.status === "rate-limited") return "cut";
  const pr = res.status === "ok" ? pickPullNumber(res.body, run.headBranch) : null;
  ctx.pulls.set(run.headSha, pr);
  return pr;
}

/** Annotations of a cancelled job. Its job id is its check-run id. */
async function annotationsFor(ctx: Ctx, job: ApiJob): Promise<JobAnnotation[] | "cut"> {
  const url = `${API_BASE}/repos/${ctx.repo}/check-runs/${job.id}/annotations?per_page=100`;
  const res = await ctx.api.get(url);
  if (res.status === "rate-limited") return "cut";
  return res.status === "ok" ? parseAnnotations(res.body) : [];
}

/** What a job's record takes from the run it belongs to. */
interface Origin {
  repo: string;
  run: ApiRun;
  attempt: number;
  pr: number | null;
}

function toRecord({ repo, run, attempt, pr }: Origin, job: ApiJob): JobRecord {
  return {
    repo,
    workflow: job.workflow ?? run.name,
    jobName: job.name,
    jobId: job.id,
    url: job.url,
    commit: run.headSha,
    branch: run.headBranch ?? "",
    prNumber: pr,
    provider: "github-actions",
    runner: job.runner,
    runnerName: job.runnerName,
    runId: run.id,
    runAttempt: attempt,
    conclusion: job.conclusion,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    steps: job.steps,
    annotations: [],
  };
}

/** One attempt's jobs as records. Nothing of an attempt is kept if a rate limit ends it midway. */
async function readAttempt(
  ctx: Ctx,
  run: ApiRun,
  attempt: number,
  pr: number | null,
): Promise<JobRecord[] | "cut"> {
  const jobs: ApiJob[] = [];
  const url = `${API_BASE}/repos/${ctx.repo}/actions/runs/${run.id}/attempts/${attempt}/jobs?per_page=100`;
  const paged = await eachPage(ctx.api, url, listJobs, async (items) => {
    jobs.push(...items.map(parseJob));
    return true;
  });
  if (paged === "cut") return "cut";
  // The run (or the attempt) was deleted after it was listed: nothing to read, and not a failure.
  if (paged === "gone") return [];
  const records: JobRecord[] = [];
  for (const job of jobs) {
    const record = toRecord({ repo: ctx.repo, run, attempt, pr }, job);
    if (job.conclusion === "cancelled") {
      const annotations = await annotationsFor(ctx, job);
      if (annotations === "cut") return "cut";
      record.annotations = annotations;
    }
    records.push(record);
  }
  return records;
}

/**
 * The attempts of a run still to fetch, oldest first. A held attempt is skipped. The latest attempt of
 * a run that is not `completed` is skipped too: it may still gain jobs (one with a `needs` may not be
 * listed until what it needs has ended), so what it shows now is not all of it.
 */
function attemptsToRead(ctx: Ctx, run: ApiRun): number[] {
  const held = ctx.held.get(run.id);
  const attempts: number[] = [];
  for (let attempt = 1; attempt <= run.runAttempt; attempt += 1) {
    if (held?.has(attempt)) continue;
    if (attempt === run.runAttempt && run.status !== "completed") continue;
    attempts.push(attempt);
  }
  return attempts;
}

/** Every attempt of a run still to read, oldest first. Returns "cut" when a rate limit ended it. */
async function readRun(ctx: Ctx, run: ApiRun): Promise<"done" | "cut"> {
  const attempts = attemptsToRead(ctx, run);
  if (attempts.length === 0) return "done";
  const pr = await pullFor(ctx, run);
  if (pr === "cut") return "cut";
  const records: JobRecord[] = [];
  let result: "done" | "cut" = "done";
  for (const attempt of attempts) {
    const read = await readAttempt(ctx, run, attempt, pr);
    if (read === "cut") {
      result = "cut";
      break;
    }
    records.push(...read);
  }
  // The attempts read before a rate limit are kept: the next read starts after them.
  if (records.length > 0) {
    ctx.records.push(...records);
    await ctx.onRecords(records);
  }
  return result;
}

function heldByRun(held: readonly HeldAttempt[]): Map<number, Set<number>> {
  const byRun = new Map<number, Set<number>>();
  for (const { runId, runAttempt } of held) {
    const attempts = byRun.get(runId) ?? new Set<number>();
    attempts.add(runAttempt);
    byRun.set(runId, attempts);
  }
  return byRun;
}

/**
 * Read a repo's Actions history since a date into job records. The run listing carries no `created`
 * filter (GitHub caps a filtered listing at 1,000 results); it is newest first, so paging stops at the
 * first run older than `since`. Attempts in `held`, and the latest attempt of a run that has not
 * completed, are not fetched. A rate limit ends the read and returns what was read, marked cut short;
 * any other failure (a bad token, a 5xx) throws, so it cannot pass for a short history.
 */
export async function readGitHubActions(
  options: ReadGitHubActionsOptions,
): Promise<ReadGitHubActionsResult> {
  if (!REPO.test(options.repo)) throw new Error(`repo must look like owner/name: ${options.repo}`);
  const sinceMs = parseSince(options.since);
  const ctx: Ctx = {
    api: createApi(options.fetch, options.token, options.wait),
    repo: options.repo,
    pulls: new Map(),
    held: heldByRun(options.held ?? []),
    records: [],
    onRecords: options.onRecords ?? (async () => {}),
  };
  let cutShort = false;
  const listed = await eachPage(
    ctx.api,
    `${API_BASE}/repos/${options.repo}/actions/runs?per_page=100`,
    listRuns,
    async (items) => {
      for (const item of items) {
        const run = parseRun(item);
        if (Date.parse(run.createdAt) < sinceMs) return false;
        if ((await readRun(ctx, run)) === "cut") {
          cutShort = true;
          return false;
        }
      }
      return true;
    },
  );
  // The runs listing itself missing is a wrong repo, not a deleted run.
  if (listed === "gone")
    throw new GitHubApiError(404, `${API_BASE}/repos/${options.repo}/actions/runs`);
  return { records: ctx.records, cutShort: cutShort || listed === "cut" };
}

interface ReadJobLogOptions {
  /** A job from `readGitHubActions`. */
  job: JobRecord;
  fetch: FetchLike;
  /** Optional, as for `readGitHubActions`. */
  token?: string;
}

/**
 * The log of one failed job, as text in memory. It reads the job's own log endpoint, which answers for
 * every attempt, so a failure of attempt 1 of a run that attempt 2 passed is readable; the run-level
 * route is not (`gh run view --log-failed` prints nothing when the latest attempt passed). A job the
 * flake rule does not count as failed is `gone` and makes no request. A bad token throws.
 */
export async function readJobLog(options: ReadJobLogOptions): Promise<LogResult> {
  const { job } = options;
  if (outcomeOf(job) !== "failed") return { status: "gone" };
  const api = createApi(options.fetch, options.token);
  return api.getLog(`${API_BASE}/repos/${job.repo}/actions/jobs/${job.jobId}/logs`);
}

/**
 * What GitHub's compare of two commits says. `ok` lists the files that differ, as GitHub gave them (at
 * most 300: GitHub lists no more in one compare, and this reader does not page). `missing` is a commit
 * GitHub no longer has, or an answer with no file list. `rate-limited` is a read that did not finish.
 */
export type CompareResult =
  | { status: "ok"; files: string[] }
  | { status: "missing" }
  | { status: "rate-limited" };

export interface ReadCompareOptions {
  /** `owner/name`. */
  repo: string;
  /** The older commit, as a SHA. */
  base: string;
  /** The newer commit, as a SHA. */
  head: string;
  fetch: FetchLike;
  /** Optional, as for `readGitHubActions`. */
  token?: string;
}

/** The files that differ between two commits: one compare call. A bad token throws. */
export async function readCompare(options: ReadCompareOptions): Promise<CompareResult> {
  if (!REPO.test(options.repo)) throw new Error(`repo must look like owner/name: ${options.repo}`);
  const api = createApi(options.fetch, options.token);
  const res = await api.get(
    `${API_BASE}/repos/${options.repo}/compare/${options.base}...${options.head}`,
  );
  if (res.status === "rate-limited") return { status: "rate-limited" };
  if (res.status === "missing") return { status: "missing" };
  const files = parseCompareFiles(res.body);
  return files === null ? { status: "missing" } : { status: "ok", files };
}
