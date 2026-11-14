/** Narrowing of GitHub's JSON into the few fields the reader needs. A missing id or sha is an error. */
import { runnerFromLabels, type Runner } from "./github-runner.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`GitHub sent a ${what} that is not an object`);
  return value;
}

function list(value: unknown, key: string): unknown[] {
  const items = record(value, "page")[key];
  if (!Array.isArray(items)) throw new Error(`GitHub sent a page without a "${key}" array`);
  return items;
}

export function listRuns(body: unknown): unknown[] {
  return list(body, "workflow_runs");
}

export function listJobs(body: unknown): unknown[] {
  return list(body, "jobs");
}

export interface ApiRun {
  id: number;
  name: string;
  headSha: string;
  headBranch: string | null;
  runAttempt: number;
  createdAt: string;
  /** GitHub's run `status`: `completed` once the latest attempt has ended, otherwise it may still gain jobs. */
  status: string;
  /** GitHub's run `conclusion` (the latest attempt's), null until the run has one. */
  conclusion: string | null;
}

export function parseRun(value: unknown): ApiRun {
  const run = record(value, "run");
  const id = num(run.id);
  const headSha = str(run.head_sha);
  const createdAt = str(run.created_at);
  const status = str(run.status);
  if (id === null || headSha === null || createdAt === null || status === null) {
    throw new Error("GitHub sent a run without an id, head_sha, created_at or status");
  }
  return {
    id,
    name: str(run.name) ?? "",
    headSha,
    headBranch: str(run.head_branch),
    runAttempt: num(run.run_attempt) ?? 1,
    createdAt,
    status,
    conclusion: str(run.conclusion),
  };
}

export interface JobStep {
  name: string;
  conclusion: string | null;
}

export interface ApiJob {
  id: number;
  name: string;
  workflow: string | null;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
  runner: Runner;
  runnerName: string;
  url: string;
  steps: JobStep[];
}

function parseStep(value: unknown): JobStep {
  const step = record(value, "step");
  return { name: str(step.name) ?? "", conclusion: str(step.conclusion) };
}

export function parseJob(value: unknown): ApiJob {
  const job = record(value, "job");
  const id = num(job.id);
  if (id === null) throw new Error("GitHub sent a job without an id");
  const labels = Array.isArray(job.labels) ? job.labels.filter((l) => typeof l === "string") : [];
  return {
    id,
    name: str(job.name) ?? "",
    workflow: str(job.workflow_name),
    conclusion: str(job.conclusion),
    startedAt: str(job.started_at),
    completedAt: str(job.completed_at),
    runner: runnerFromLabels(labels),
    // Empty (or null) for jobs that never got a runner. The job is kept all the same.
    runnerName: str(job.runner_name) ?? "",
    url: str(job.html_url) ?? "",
    steps: Array.isArray(job.steps) ? job.steps.map(parseStep) : [],
  };
}

export interface JobAnnotation {
  title: string;
  message: string;
}

export function parseAnnotations(body: unknown): JobAnnotation[] {
  if (!Array.isArray(body)) throw new Error("GitHub sent annotations that are not a list");
  return body.map((value) => {
    const annotation = record(value, "annotation");
    return { title: str(annotation.title) ?? "", message: str(annotation.message) ?? "" };
  });
}

/** The pull request number for a commit: the one headed by the run's branch if there is one, else the first. */
export function pickPullNumber(body: unknown, branch: string | null): number | null {
  if (!Array.isArray(body)) throw new Error("GitHub sent pull requests that are not a list");
  const pulls = body.map((value) => record(value, "pull request"));
  const same = pulls.find((pull) => str(record(pull.head ?? {}, "head").ref) === branch);
  return num((same ?? pulls[0])?.number);
}

/**
 * The filenames of a compare answer, as GitHub gave them. Null when `files` is absent, not a list, or an
 * entry has no string `filename`: the answer cannot say what changed, so it is not a usable compare.
 */
export function parseCompareFiles(body: unknown): string[] | null {
  if (!isRecord(body) || !Array.isArray(body.files)) return null;
  const names: string[] = [];
  for (const entry of body.files) {
    if (!isRecord(entry) || typeof entry.filename !== "string") return null;
    names.push(entry.filename);
  }
  return names;
}
