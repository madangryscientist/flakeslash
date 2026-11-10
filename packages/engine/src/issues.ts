/**
 * Correcting the catalogue by hand: list the issues, then confirm, rename or dismiss one. Every edit
 * is a plain `writeIssue` over the `Store`, so a later scan keeps it (see `pipeline.ts`, which only
 * moves a `potential` issue, and `explain.ts`, which never touches an `edited` one).
 */
import type { Issue } from "./catalogue.ts";
import type { Store } from "./store.ts";

/** What these functions use of a `Store`. */
export type IssueStore = Pick<Store, "readIssues" | "writeIssue" | "readFailures">;

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
