/**
 * Correcting the catalogue by hand: list the issues, then confirm, rename or dismiss one. Every edit
 * is a plain `writeIssue` over the `Store`, so a later scan keeps it (see `pipeline.ts`, which only
 * moves a `potential` issue, and `explain.ts`, which never touches an `edited` one).
 */
import { createHash } from "node:crypto";
import {
  NAME_LENGTH,
  failureMatchText,
  hasAll,
  sameSignature,
  type Failure,
  type FailedJob,
  type Issue,
} from "./catalogue.ts";
import type { Store } from "./store.ts";

/** What these functions use of a `Store`. */
export type IssueStore = Pick<
  Store,
  | "readIssues"
  | "writeIssue"
  | "readFailures"
  | "writeFailures"
  | "readJobs"
  | "readExcerpts"
  | "mergeIssues"
>;

/** The shortest prefix of an id that `findIssue` accepts. */
const MIN_ID_PREFIX = 8;

/** A person's mistake in naming an issue or a name: the CLI turns it into a usage error. */
export class IssueError extends Error {}

/** One row of `listIssues`. */
export interface IssueSummary {
  id: string;
  name: string;
  kind: Issue["kind"];
  status: Issue["status"];
  /** How many failures belong to the issue, across repos. */
  failures: number;
  /** The repos those failures came from, distinct and sorted. */
  repos: string[];
}

function byCodePoint(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * One row per issue, most failures first, then by id. Dismissed issues are left out unless `all`.
 */
export async function listIssues(
  store: IssueStore,
  options: { all?: boolean } = {},
): Promise<IssueSummary[]> {
  const repos = new Map<string, string[]>();
  for (const failure of await store.readFailures()) {
    repos.set(failure.issueId, [...(repos.get(failure.issueId) ?? []), failure.repo]);
  }
  return (await store.readIssues())
    .filter((issue) => options.all === true || issue.status !== "dismissed")
    .map((issue) => {
      const held = repos.get(issue.id) ?? [];
      return {
        id: issue.id,
        name: issue.name,
        kind: issue.kind,
        status: issue.status,
        failures: held.length,
        repos: [...new Set(held)].toSorted(byCodePoint),
      };
    })
    .toSorted((a, b) => b.failures - a.failures || byCodePoint(a.id, b.id));
}

/**
 * The issue with this id: the full id, or any prefix of at least `MIN_ID_PREFIX` characters that
 * matches exactly one issue. Throws `IssueError` naming the problem.
 */
export async function findIssue(store: IssueStore, id: string): Promise<Issue> {
  const issues = await store.readIssues();
  const exact = issues.find((issue) => issue.id === id);
  if (exact) return exact;
  const hits = id.length < MIN_ID_PREFIX ? [] : issues.filter((issue) => issue.id.startsWith(id));
  const [only] = hits;
  if (hits.length === 1 && only) return only;
  if (hits.length === 0) {
    const short =
      id.length < MIN_ID_PREFIX ? ` (a prefix needs ${MIN_ID_PREFIX} characters or more)` : "";
    throw new IssueError(`no issue ${id}${short}; run flakeslash issue list`);
  }
  throw new IssueError(
    `${id} matches ${hits.length} issues; give more of it (run flakeslash issue list)`,
  );
}

/**
 * Confirmed by a person. This is a verdict, not an edit: the model may still explain the issue.
 * Confirming a dismissed issue brings it back.
 */
export async function confirmIssue(store: IssueStore, id: string): Promise<Issue> {
  const issue = await findIssue(store, id);
  issue.status = "confirmed";
  await store.writeIssue(issue);
  return issue;
}

/** Renames the issue. The model never renames it again, and its explanation stays as it is. */
export async function renameIssue(store: IssueStore, id: string, name: string): Promise<Issue> {
  const trimmed = name.trim();
  if (trimmed === "") throw new IssueError("the new name is empty");
  const issue = await findIssue(store, id);
  issue.name = trimmed;
  issue.edited = true;
  await store.writeIssue(issue);
  return issue;
}

/** Hides the issue. New failures still join it, and a scan never brings it back. */
export async function dismissIssue(store: IssueStore, id: string): Promise<Issue> {
  const issue = await findIssue(store, id);
  issue.status = "dismissed";
  issue.edited = true;
  await store.writeIssue(issue);
  return issue;
}

/**
 * Folds `second` into `first`, or the other way round: the survivor keeps its id and gets the other's
 * signatures, and the other's failures and model calls move to it. The second survives only when it
 * is a split and the first is not, so a split keeps its priority (see `place`). The survivor is
 * confirmed when either was, and keeps its own explanation unless it has none.
 */
export async function mergeIssues(
  store: IssueStore,
  first: string,
  second: string,
): Promise<{ survivor: Issue; merged: Issue }> {
  const a = await findIssue(store, first);
  const b = await findIssue(store, second);
  if (a.id === b.id) throw new IssueError("cannot merge an issue with itself");
  const keepSecond = b.id.startsWith("split:") && !a.id.startsWith("split:");
  const survivor = keepSecond ? b : a;
  const merged = keepSecond ? a : b;
  for (const signature of merged.signatures) {
    if (!survivor.signatures.some((held) => sameSignature(held, signature))) {
      survivor.signatures.push(signature);
    }
  }
  if (merged.status === "confirmed") survivor.status = "confirmed";
  survivor.explanation ??= merged.explanation;
  survivor.edited = survivor.edited || merged.edited;
  await store.mergeIssues(survivor, [merged.id]);
  return { survivor, merged };
}

/** The split issue's id: `split:` and the hex SHA-256 of its signature text, so the same text always gives the same id. */
function splitIdOf(text: string): string {
  return `split:${createHash("sha256").update(text).digest("hex")}`;
}

/**
 * Moves the failures of `ref` whose match text contains `signature` into a new issue, whose pattern is
 * that text. The new issue is `edited`, so the model never folds it into another issue. The source keeps
 * its signatures and stays, even with no failures left. Throws `IssueError` when the text is empty, when
 * no failure contains it, or when the split issue already exists.
 */
export async function splitIssue(
  store: IssueStore,
  ref: string,
  signature: string,
): Promise<{ source: Issue; created: Issue; moved: number }> {
  const text = signature.trim();
  if (text === "") throw new IssueError("the split signature is empty");
  const source = await findIssue(store, ref);
  const id = splitIdOf(text);
  if ((await store.readIssues()).some((issue) => issue.id === id)) {
    throw new IssueError(
      `split issue ${id} already exists; run flakeslash issue merge to fold it in`,
    );
  }

  const rows = new Map<
    string,
    { jobs: Map<number, FailedJob>; excerpts: Map<number, string | null> }
  >();
  const rowsOf = async (repo: string) => {
    const held = rows.get(repo);
    if (held) return held;
    const fresh = {
      jobs: new Map((await store.readJobs(repo)).map((job) => [job.jobId, job])),
      excerpts: new Map((await store.readExcerpts(repo)).map((row) => [row.jobId, row.excerpt])),
    };
    rows.set(repo, fresh);
    return fresh;
  };
  const moving: Failure[] = [];
  for (const failure of (await store.readFailures()).filter((one) => one.issueId === source.id)) {
    const held = await rowsOf(failure.repo);
    const matched = failureMatchText(
      failure,
      held.jobs.get(failure.jobId),
      held.excerpts.get(failure.jobId),
    );
    if (hasAll([text], matched)) moving.push({ ...failure, issueId: id });
  }
  if (moving.length === 0) {
    throw new IssueError(`no failure of issue ${source.id} contains "${text}"`);
  }

  const created: Issue = {
    id,
    name: text.slice(0, NAME_LENGTH),
    kind: source.kind,
    status: "potential",
    signatures: [{ type: "pattern", all: [text] }],
    explanation: null,
    edited: true,
  };
  await store.writeIssue(created);
  await store.writeFailures(moving);
  return { source, created, moved: moving.length };
}
