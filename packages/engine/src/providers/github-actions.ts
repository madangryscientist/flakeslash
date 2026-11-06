/**
 * The GitHub Actions reader: a repo's run history as one plain record per job per attempt. Nothing is
 * stored and no log is read. A run's own `conclusion` is its latest attempt's only (a flaky run reads
 * `success`), so every attempt up to `run_attempt` is read through its own jobs endpoint.
 */
import { API_BASE, createApi, GitHubApiError, type Api, type FetchLike } from "./github-api.ts";
import {
  listJobs,
  listRuns,
  parseAnnotations,
  parseJob,
  parseRun,
  pickPullNumber,
  type ApiJob,
  type ApiRun,
  type JobAnnotation,
  type JobStep,
} from "./github-parse.ts";
import type { Runner } from "./github-runner.ts";

export type { FetchLike } from "./github-api.ts";
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
  records: JobRecord[];
}

const REPO = /^[\w.-]+\/[\w.-]+$/;

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

/** Every attempt of a run, oldest first. Returns "cut" when a rate limit ended it. */
async function readRun(ctx: Ctx, run: ApiRun): Promise<"done" | "cut"> {
  const pr = await pullFor(ctx, run);
  if (pr === "cut") return "cut";
  for (let attempt = 1; attempt <= run.runAttempt; attempt += 1) {
    const records = await readAttempt(ctx, run, attempt, pr);
    if (records === "cut") return "cut";
    ctx.records.push(...records);
  }
  return "done";
}

/**
 * Read a repo's Actions history since a date into job records. The run listing carries no `created`
 * filter (GitHub caps a filtered listing at 1,000 results); it is newest first, so paging stops at the
 * first run older than `since`. A rate limit ends the read and returns what was read, marked cut short;
 * any other failure (a bad token, a 5xx) throws, so it cannot pass for a short history.
 */
export async function readGitHubActions(
  options: ReadGitHubActionsOptions,
): Promise<ReadGitHubActionsResult> {
  if (!REPO.test(options.repo)) throw new Error(`repo must look like owner/name: ${options.repo}`);
  const sinceMs = parseSince(options.since);
  const ctx: Ctx = {
    api: createApi(options.fetch, options.token),
    repo: options.repo,
    pulls: new Map(),
    records: [],
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
