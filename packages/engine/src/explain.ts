/**
 * Model analysis of unexplained issues. For each issue nothing has explained yet, one redacted
 * excerpt goes through the model client, so a failure repeated 50 times costs one call. The reply
 * names the broken test or component, the kind of failure and the likely cause, and proposes a
 * literal pattern. The pattern becomes one of the issue's signatures, so later logs that match it
 * join the issue with no call. Nothing here asks whether a failure is flaky: pass and fail decide
 * that, and `findJobFlakes` is not touched.
 */
import { hasAll, matchText, type Failure, type Issue } from "./catalogue.ts";
import {
  MAX_TOKENS,
  SYSTEM_PROMPT,
  parseExplanation,
  type ParsedExplanation,
} from "./explain-reply.ts";
import type { ModelClient, ModelMessage } from "./model.ts";
import type { JobRecord } from "./providers/github-actions.ts";
import type { FailureSignature } from "./signature.ts";
import type { JobExcerpt, Store } from "./store.ts";

export { parseExplanation } from "./explain-reply.ts";
export type { ParseResult, ParsedExplanation } from "./explain-reply.ts";

const NAME_LENGTH = 120;

export interface ExplainResult {
  /** Issues given an explanation by this run. */
  explained: number;
  /** Issues folded into another by a proposed pattern. */
  merged: number;
  /** Patterns not stored because they also matched an explained, edited or starter issue. */
  rejectedPatterns: number;
  /** Issues left without an explanation, by why. */
  notExplained: { cap: number; stopped: number; noExcerpt: number; failed: number };
  /** Calls that failed in the client, or got a reply that could not be used. */
  failedCalls: number;
  /** The first such error's text, or null. */
  firstError: string | null;
  spentUsd: number;
}

export interface ExplainOptions {
  store: Store;
  client: ModelClient;
  /** The model name that was asked for; kept on each explanation. */
  model: string;
  /** The repos this scan names, owner/name. Only their excerpts are ever sent to the model. */
  repos: string[];
}

interface RepoRows {
  jobs: Map<number, JobRecord>;
  excerpts: Map<number, JobExcerpt>;
}

/** What one run holds in memory: the catalogue as read, and what the run has changed in it. */
interface Run {
  store: Store;
  options: ExplainOptions;
  result: ExplainResult;
  /** Issues whose call failed, or whose reply was no use. */
  failed: Set<string>;
  /** Issues with no kept excerpt that was never sent. */
  noExcerpt: Set<string>;
  /** Repos this scan names, lower case. */
  named: Set<string>;
  issues: Map<string, Issue>;
  failuresOf: Map<string, Failure[]>;
  /** `repo:jobId` of every job a reply was already given for. */
  asked: Set<string>;
  repoRows: Map<string, RepoRows>;
}

/** Which repos an excerpt may come from: the ones this scan names, or any the store holds. */
type Scope = "named" | "any";

interface Picked {
  job: JobRecord;
  excerpt: string;
  repo: string;
}

function byCodePoint(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function isCandidate(issue: Issue): boolean {
  return issue.explanation === null && !issue.edited && !issue.id.startsWith("starter:");
}

function isProtected(issue: Issue): boolean {
  return issue.explanation !== null || issue.edited || issue.id.startsWith("starter:");
}

function sameSignature(a: Issue["signatures"][number], b: Issue["signatures"][number]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function loadRun(options: ExplainOptions): Promise<Run> {
  const { store } = options;
  const named = new Set(options.repos.map((repo) => repo.toLowerCase()));
  const failuresOf = new Map<string, Failure[]>();
  for (const failure of await store.readFailures()) {
    failuresOf.set(failure.issueId, [...(failuresOf.get(failure.issueId) ?? []), failure]);
  }
  return {
    store,
    options,
    result: newResult(),
    failed: new Set(),
    noExcerpt: new Set(),
    named,
    issues: new Map((await store.readIssues()).map((issue) => [issue.id, issue])),
    failuresOf,
    asked: new Set((await store.readModelCalls()).map((call) => `${call.repo}:${call.jobId}`)),
    repoRows: new Map(),
  };
}

async function rowsOf(run: Run, repo: string): Promise<RepoRows> {
  const held = run.repoRows.get(repo);
  if (held) return held;
  const rows: RepoRows = {
    jobs: new Map((await run.store.readJobs(repo)).map((job) => [job.jobId, job])),
    excerpts: new Map((await run.store.readExcerpts(repo)).map((row) => [row.jobId, row])),
  };
  run.repoRows.set(repo, rows);
  return rows;
}

/**
 * The issue's newest failed job with a kept excerpt that was never sent. Under "named" only a repo
 * this scan names is looked at, so no other repo's excerpt is ever chosen to go to the model.
 */
async function pickJob(run: Run, issue: Issue, scope: Scope): Promise<Picked | null> {
  const failures = (run.failuresOf.get(issue.id) ?? []).toSorted(
    (a, b) => b.jobId - a.jobId || byCodePoint(a.repo, b.repo),
  );
  for (const failure of failures) {
    if (scope === "named" && !run.named.has(failure.repo)) continue;
    if (run.asked.has(`${failure.repo}:${failure.jobId}`)) continue;
    const rows = await rowsOf(run, failure.repo);
    const held = rows.excerpts.get(failure.jobId);
    const job = rows.jobs.get(failure.jobId);
    if (held?.status !== "kept" || held.excerpt === null || job === undefined) continue;
    return { job, excerpt: held.excerpt, repo: failure.repo };
  }
  return null;
}

/** The text one failure is matched on, as `place` would have matched it. */
async function textOf(run: Run, failure: Failure): Promise<string> {
  const rows = await rowsOf(run, failure.repo);
  const job = rows.jobs.get(failure.jobId);
  if (job === undefined) return failure.errorLine;
  const entry: FailureSignature = {
    file: failure.file,
    title: failure.title,
    location: failure.location,
    errorLine: failure.errorLine,
    signature: failure.signature,
  };
  return matchText(entry, rows.excerpts.get(failure.jobId)?.excerpt ?? "", job);
}

async function issueMatches(run: Run, issue: Issue, all: readonly string[]): Promise<boolean> {
  for (const failure of run.failuresOf.get(issue.id) ?? []) {
    const text = await textOf(run, failure);
    if (hasAll(all, text)) return true;
  }
  return false;
}

/** Every issue other than `issue` with a failure that contains all the strings. */
async function hitsOf(run: Run, issue: Issue, all: readonly string[]): Promise<Issue[]> {
  const hits: Issue[] = [];
  for (const other of run.issues.values()) {
    if (other.id !== issue.id && (await issueMatches(run, other, all))) hits.push(other);
  }
  return hits;
}

/** Folds `hits` into `issue`: their signatures, their status, and (in the store) their failures. */
async function mergeHits(run: Run, issue: Issue, hits: Issue[]): Promise<void> {
  for (const hit of hits) {
    for (const signature of hit.signatures) {
      if (!issue.signatures.some((held) => sameSignature(held, signature))) {
        issue.signatures.push(signature);
      }
    }
    if (hit.status === "confirmed") issue.status = "confirmed";
  }
  await run.store.mergeIssues(
    issue,
    hits.map((hit) => hit.id),
  );
  for (const hit of hits) {
    run.issues.delete(hit.id);
    const moved = (run.failuresOf.get(hit.id) ?? []).map((failure) => ({
      ...failure,
      issueId: issue.id,
    }));
    run.failuresOf.set(issue.id, [...(run.failuresOf.get(issue.id) ?? []), ...moved]);
    run.failuresOf.delete(hit.id);
  }
}

function userMessage(picked: Picked): ModelMessage[] {
  return [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: `Job: ${picked.job.workflow} / ${picked.job.jobName}\n\n${picked.excerpt}`,
    },
  ];
}

/** Stores the explanation on `issue`, then its pattern: kept, merged in, or rejected. */
async function applyExplanation(
  run: Run,
  issue: Issue,
  picked: Picked,
  value: ParsedExplanation,
): Promise<void> {
  const { result } = run;
  issue.explanation = {
    component: value.component,
    kind: value.kind,
    cause: value.cause,
    evidence: value.evidence,
    repo: picked.repo,
    jobId: picked.job.jobId,
    model: run.options.model,
  };
  issue.name = value.component.slice(0, NAME_LENGTH);
  issue.kind = value.kind;
  result.explained += 1;

  // A pattern must match the text `place` reads from this issue's own failures, or a later log
  // could never join by it. The explanation is kept either way.
  const hits = await hitsOf(run, issue, value.pattern);
  if (hits.some(isProtected) || !(await issueMatches(run, issue, value.pattern))) {
    result.rejectedPatterns += 1;
    await run.store.writeIssue(issue);
    return;
  }
  issue.signatures.push({ type: "pattern", all: value.pattern });
  if (hits.length === 0) {
    await run.store.writeIssue(issue);
    return;
  }
  await mergeHits(run, issue, hits);
  result.merged += hits.length;
}

function newResult(): ExplainResult {
  return {
    explained: 0,
    merged: 0,
    rejectedPatterns: 0,
    notExplained: { cap: 0, stopped: 0, noExcerpt: 0, failed: 0 },
    failedCalls: 0,
    firstError: null,
    spentUsd: 0,
  };
}

/** Counts a failed call, or a reply that was no use. */
function fail(run: Run, issue: Issue, error: string): void {
  run.result.failedCalls += 1;
  run.result.firstError ??= error;
  run.failed.add(issue.id);
}

/** Asks about one issue. Returns false when the client refused for good and the run must stop. */
async function explainOne(run: Run, candidates: Issue[], at: number): Promise<boolean> {
  const issue = candidates[at];
  // A pattern from an earlier reply may have merged this issue away.
  if (issue === undefined || run.issues.get(issue.id) !== issue) return true;
  const picked = await pickJob(run, issue, "named");
  if (picked === null) {
    await leftOut(run, issue);
    return true;
  }
  const reply = await run.options.client.complete(userMessage(picked), { maxTokens: MAX_TOKENS });
  if (!reply.ok && (reply.reason === "cap" || reply.reason === "stopped")) {
    await refuseRest(run, candidates.slice(at), reply.reason);
    return false;
  }
  if (!reply.ok) {
    fail(run, issue, reply.error);
    return true;
  }

  // A reply was given, valid or not, so this job is never sent again.
  run.asked.add(`${picked.repo}:${picked.job.jobId}`);
  const parsed = parseExplanation(reply.text, picked.excerpt);
  const call = { repo: picked.repo, jobId: picked.job.jobId, issueId: issue.id };
  if (!parsed.ok) {
    await run.store.writeModelCall({ ...call, outcome: "invalid" });
    fail(run, issue, parsed.reason);
    return true;
  }
  await run.store.writeModelCall({ ...call, outcome: "explained" });
  await applyExplanation(run, issue, picked, parsed.value);
  return true;
}

/**
 * An issue with no excerpt in the named repos. If another repo holds one, it is left for a later
 * scan that names that repo and counted nowhere; if no repo holds one, it is `noExcerpt`.
 */
async function leftOut(run: Run, issue: Issue): Promise<void> {
  if ((await pickJob(run, issue, "any")) === null) run.noExcerpt.add(issue.id);
}

/** Everything still unexplained when a call is refused for good counts under `reason`. */
async function refuseRest(run: Run, rest: Issue[], reason: "cap" | "stopped"): Promise<void> {
  for (const issue of rest) {
    if (run.issues.get(issue.id) !== issue || issue.explanation !== null) continue;
    if (run.noExcerpt.has(issue.id)) continue;
    const picked = await pickJob(run, issue, "named");
    if (picked !== null) {
      run.result.notExplained[reason] += 1;
    } else {
      await leftOut(run, issue);
    }
  }
}

export async function explainIssues(options: ExplainOptions): Promise<ExplainResult> {
  const run = await loadRun(options);
  const candidates = [...run.issues.values()]
    .filter(isCandidate)
    .toSorted(
      (a, b) =>
        (run.failuresOf.get(b.id)?.length ?? 0) - (run.failuresOf.get(a.id)?.length ?? 0) ||
        byCodePoint(a.id, b.id),
    );
  for (let at = 0; at < candidates.length; at += 1) {
    if (!(await explainOne(run, candidates, at))) break;
  }
  const { result } = run;
  for (const id of run.failed) {
    if (run.issues.get(id)?.explanation === null) result.notExplained.failed += 1;
  }
  result.notExplained.noExcerpt = [...run.noExcerpt].filter((id) => run.issues.has(id)).length;
  result.spentUsd = options.client.spentUsd;
  return result;
}
