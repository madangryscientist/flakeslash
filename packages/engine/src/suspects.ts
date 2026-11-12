/**
 * The suspect label: a failure that looks flaky but has no proof. A job failed on a commit naming a test,
 * the same job passed on the next commit of its branch, and the compare between those two commits
 * touches none of the files the failure named. It is not a flake: it never reaches `findJobFlakes`, so
 * it never changes a flake rate. The compare comes in as a function, so this module does no I/O.
 */
import type { Failure } from "./catalogue.ts";
import { outcomeOf } from "./flakes.ts";
import type { CompareResult, JobRecord } from "./providers/github-actions.ts";

/** A failure on one commit, and the pass on the next commit of its branch. */
export interface Suspect {
  kind: "suspect";
  repo: string;
  workflow: string;
  jobName: string;
  branch: string;
  /** The commit it failed on, and the next commit of the branch, where it passed. */
  commit: string;
  nextCommit: string;
  failedUrl: string;
  passedUrl: string;
  /** The files the failure named, none of which the compare touched. */
  files: string[];
}

/** Asks GitHub's compare of two commits. The caller decides whether to store the answer. */
export type Compare = (repo: string, base: string, head: string) => Promise<CompareResult>;

/** A compare that lists this many files or more is treated as touching everything. */
const MAX_COMPARE_FILES = 300;

/** The records of one job on one branch, in the order they were read. */
interface Branch {
  jobKey: string;
  records: JobRecord[];
}

interface Context {
  /** Job and commit pairs with a pass on any branch: a proven flake, never a suspect. */
  passed: Set<string>;
  /** The failure files of each job page, in the order the failures give them. */
  filesByUrl: Map<string, string[]>;
  compare: Compare;
  /** Each commit pair's answer, so the pair is asked once per call. */
  answers: Map<string, Promise<CompareResult>>;
}

function clean(path: string): string {
  return path.startsWith("./") ? path.slice(2) : path;
}

/** Whether a changed file is the failure's file: the same path, or one that ends at the other's own path. */
function touches(changed: string, failed: string): boolean {
  const p = clean(changed);
  const f = clean(failed);
  return p === f || p.endsWith(`/${f}`) || f.endsWith(`/${p}`);
}

function jobKeyOf(record: JobRecord): string {
  return JSON.stringify([record.repo, record.workflow, record.jobName]);
}

/** Each job's records on each branch. A record with no branch is left out of the rule. */
function branchesOf(records: JobRecord[]): Branch[] {
  const byKey = new Map<string, Branch>();
  for (const record of records) {
    if (record.branch === "") continue;
    const jobKey = jobKeyOf(record);
    const key = JSON.stringify([jobKey, record.branch]);
    const branch = byKey.get(key) ?? { jobKey, records: [] };
    branch.records.push(record);
    byKey.set(key, branch);
  }
  return [...byKey.values()];
}

/**
 * The branch's commits, oldest first by the earliest start of its records on each commit. A record with
 * no start time is left out of the order.
 */
function commitOrder(records: JobRecord[]): string[] {
  const earliest = new Map<string, number>();
  for (const record of records) {
    if (record.startedAt === null) continue;
    const at = Date.parse(record.startedAt);
    const known = earliest.get(record.commit);
    if (known === undefined || at < known) earliest.set(record.commit, at);
  }
  return [...earliest.entries()].toSorted((a, b) => a[1] - b[1]).map(([commit]) => commit);
}

/** The record that started first among those with a start time. */
function firstByStart(records: JobRecord[]): JobRecord | undefined {
  return records
    .filter((record) => record.startedAt !== null)
    .toSorted((a, b) => Date.parse(a.startedAt ?? "") - Date.parse(b.startedAt ?? ""))[0];
}

/** The failure files of each job page. A failure with no file names no test to check a compare against. */
function filesByUrlOf(failures: Failure[]): Map<string, string[]> {
  const filesByUrl = new Map<string, string[]>();
  for (const failure of failures) {
    if (failure.file === null || failure.file === "") continue;
    const files = filesByUrl.get(failure.url) ?? [];
    if (!files.includes(failure.file)) files.push(failure.file);
    filesByUrl.set(failure.url, files);
  }
  return filesByUrl;
}

/** The compare of a pair, asked once; a second call for the same pair gets the same answer. */
function answerFor(context: Context, repo: string, base: string, head: string) {
  const key = JSON.stringify([repo, base, head]);
  let answer = context.answers.get(key);
  if (answer === undefined) {
    answer = context.compare(repo, base, head);
    context.answers.set(key, answer);
  }
  return answer;
}

/** Whether a compare answer leaves every failure file alone. Anything but an `ok` list is not quiet. */
function leavesFiles(result: CompareResult, files: string[]): boolean {
  if (result.status !== "ok" || result.files.length >= MAX_COMPARE_FILES) return false;
  return !result.files.some((changed) => files.some((file) => touches(changed, file)));
}

/** The suspect at this commit of a branch, when the next commit passed and the compare leaves its files alone. */
async function suspectAt(
  context: Context,
  branch: Branch,
  commit: string,
  next: string,
): Promise<Suspect | null> {
  const onCommit = branch.records.filter((record) => record.commit === commit);
  const failed = firstByStart(
    onCommit.filter(
      (record) => outcomeOf(record) === "failed" && context.filesByUrl.has(record.url),
    ),
  );
  if (failed === undefined) return null;
  const passed = firstByStart(
    branch.records.filter((record) => record.commit === next && outcomeOf(record) === "passed"),
  );
  if (passed === undefined) return null;

  const files = context.filesByUrl.get(failed.url) ?? [];
  const result = await answerFor(context, failed.repo, commit, next);
  if (!leavesFiles(result, files)) return null;
  return {
    kind: "suspect",
    repo: failed.repo,
    workflow: failed.workflow,
    jobName: failed.jobName,
    branch: failed.branch,
    commit,
    nextCommit: next,
    failedUrl: failed.url,
    passedUrl: passed.url,
    files: [...files],
  };
}

/**
 * The suspects among the records. `failures` are the store's failures; only those with a file count.
 * Compares run one after another, and each commit pair is asked at most once per call.
 */
export async function findSuspects(
  records: JobRecord[],
  failures: Failure[],
  compare: Compare,
): Promise<Suspect[]> {
  const context: Context = {
    passed: new Set(
      records
        .filter((record) => outcomeOf(record) === "passed")
        .map((record) => JSON.stringify([jobKeyOf(record), record.commit])),
    ),
    filesByUrl: filesByUrlOf(failures),
    compare,
    answers: new Map(),
  };
  const suspects: Suspect[] = [];
  const seen = new Set<string>();

  for (const branch of branchesOf(records)) {
    const order = commitOrder(branch.records);
    for (const [index, commit] of order.entries()) {
      const next = order[index + 1];
      if (next === undefined) break;
      const pair = JSON.stringify([branch.jobKey, commit]);
      if (context.passed.has(pair) || seen.has(pair)) continue;
      const suspect = await suspectAt(context, branch, commit, next);
      if (suspect === null) continue;
      seen.add(pair);
      suspects.push(suspect);
    }
  }
  return suspects;
}
