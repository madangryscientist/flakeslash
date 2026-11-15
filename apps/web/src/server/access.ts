import { and, eq, inArray } from "drizzle-orm";
import { githubHeaders, isRecord } from "#/auth/github.ts";
import { nextLink } from "#/github/app.ts";
import { type Viewer, signedIn } from "#/auth/viewer.ts";
import { readCompares, readFailures, readIssues, readJobs } from "#/db/catalogue.ts";
import { compareFromRow, failureFromRow, issueFromRow, jobFromRow } from "#/db/rows.ts";
import { organisations } from "#/db/schema.ts";
import { real } from "#/db/synthetic.ts";
import { endSessionById } from "#/db/users.ts";
import type { RankRows } from "./rank.ts";

/**
 * The one gate every data query a person reads goes through. Routes import from here, never from
 * `src/db/catalogue.ts`. What a person may see is what GitHub says they may do, asked with their
 * own token and memoised for the request:
 *
 * - `view`: they can read the repo (`permissions.pull`). A public repo is readable by anyone, so
 *   view never grants more than reading.
 * - `write`: they can push to the repo (`permissions.push`).
 * - `admin`: they are the owner: the `User` organisation that is them, or an active admin member of
 *   the `Organization`. It is about the organisation, so it grants all of `repos` or none.
 */
export type Level = "view" | "write" | "admin";

type Permissions = { pull: boolean; push: boolean };

type Org = { id: number; login: string; type: "User" | "Organization" };

type Memo = {
  orgs: Map<number, Promise<Org | null>>;
  repos: Map<string, Promise<Permissions>>;
  admin: Map<number, Promise<boolean>>;
};

/** One memo per viewer, and a viewer is built per request. */
const memos = new WeakMap<Viewer, Memo>();

function memoOf(viewer: Viewer): Memo {
  let memo = memos.get(viewer);
  if (!memo) {
    memo = { orgs: new Map(), repos: new Map(), admin: new Map() };
    memos.set(viewer, memo);
  }
  return memo;
}

function once<K, V>(map: Map<K, Promise<V>>, key: K, load: () => Promise<V>): Promise<V> {
  let value = map.get(key);
  if (!value) {
    value = load();
    map.set(key, value);
  }
  return value;
}

/**
 * GET as the person; null when GitHub says they cannot see it (404, or a 403 that is not a rate
 * limit). A 401 is
 * a token GitHub no longer takes (the person revoked the App): the session ends and they sign in.
 */
async function githubGet(viewer: Viewer, path: string): Promise<unknown> {
  return (await githubFetch(viewer, new URL(path, viewer.apiBase))).body;
}

/** One GET as the person: its body as `githubGet` reads it, and the response for its headers. */
async function githubFetch(viewer: Viewer, url: URL): Promise<{ body: unknown; res: Response }> {
  const path = url.pathname;
  const res = await fetch(url, { headers: githubHeaders(viewer.accessToken) });
  return { body: await bodyOf(viewer, path, res), res };
}

async function bodyOf(viewer: Viewer, path: string, res: Response): Promise<unknown> {
  if (res.status === 401) {
    await endSessionById(viewer.db, viewer.sessionId);
    signedIn(null);
  }
  if (res.status === 404) return null;
  // A 403 for a spent rate limit is an error to show, not a repo the person cannot see. GitHub's
  // secondary limit may send neither header, so its message decides too.
  if (res.status === 403 && !(await rateLimited(res))) return null;
  if (!res.ok) throw new Error(`GitHub ${path} answered ${res.status}`);
  return res.json();
}

/**
 * Every page of a list GET, following the `Link` header's next URL until there is none. A next URL off
 * the API base is refused: the person's token goes nowhere else.
 */
async function githubPages(viewer: Viewer, path: string): Promise<unknown[]> {
  const base = viewer.apiBase.replace(/\/+$/, "");
  const pages: unknown[] = [];
  let url: string | null = `${base}${path}`;
  while (url !== null) {
    const page = await githubFetch(viewer, new URL(url));
    pages.push(page.body);
    url = nextLink(page.res.headers.get("link"), base);
  }
  return pages;
}

async function rateLimited(res: Response): Promise<boolean> {
  if (res.headers.get("x-ratelimit-remaining") === "0" || res.headers.has("retry-after"))
    return true;
  const body: unknown = await res.json().catch(() => null);
  return (
    isRecord(body) && typeof body["message"] === "string" && /rate limit/i.test(body["message"])
  );
}

const NONE: Permissions = { pull: false, push: false };

/** `repo` is lower case `owner/name`, as the catalogue keys it. */
async function repoPermissions(viewer: Viewer, repo: string): Promise<Permissions> {
  const [owner, name, extra] = repo.split("/");
  if (!owner || !name || extra !== undefined) return NONE;
  const body = await githubGet(
    viewer,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
  );
  const permissions = isRecord(body) ? body["permissions"] : null;
  if (!isRecord(permissions)) return NONE;
  return { pull: permissions["pull"] === true, push: permissions["push"] === true };
}

async function orgRow(viewer: Viewer, orgId: number): Promise<Org | null> {
  const [org] = await viewer.db
    .select({ id: organisations.id, login: organisations.login, type: organisations.type })
    .from(organisations)
    .where(eq(organisations.id, orgId));
  return org ?? null;
}

async function isAdmin(viewer: Viewer, org: Org): Promise<boolean> {
  if (org.type === "User") return org.id === viewer.user.id;
  const body = await githubGet(viewer, `/user/memberships/orgs/${encodeURIComponent(org.login)}`);
  return isRecord(body) && body["role"] === "admin" && body["state"] === "active";
}

/**
 * The repos of `repos` the person holds at `level` in the organisation. A repo another owner
 * holds is never the organisation's, so it is refused at every level; so is everything when the
 * organisation has no row.
 */
export async function access(
  viewer: Viewer,
  orgId: number,
  repos: readonly string[],
  level: Level,
): Promise<string[]> {
  const memo = memoOf(viewer);
  const org = await once(memo.orgs, orgId, () => orgRow(viewer, orgId));
  if (!org) return [];
  const own = repos.filter((repo) => repo.startsWith(`${org.login}/`));
  if (level === "admin")
    return (await once(memo.admin, orgId, () => isAdmin(viewer, org))) ? own : [];
  const held = await Promise.all(
    own.map(async (repo) => {
      const p = await once(memo.repos, repo, () => repoPermissions(viewer, repo));
      return level === "view" ? p.pull : p.push;
    }),
  );
  return own.filter((_, i) => held[i]);
}

type IssueRow = Awaited<ReturnType<typeof readIssues>>[number];
type FailureRow = Awaited<ReturnType<typeof readFailures>>[number];

/**
 * The organisation's issues as the person may see them: each with only the failures from repos
 * they can view, and an issue with no such failure left out.
 */
export async function issuesFor(
  viewer: Viewer,
  orgId: number,
): Promise<(IssueRow & { failures: FailureRow[] })[]> {
  const [issues, failures] = await Promise.all([
    readIssues(viewer.db, orgId),
    readFailures(viewer.db, orgId),
  ]);
  const viewable = new Set(
    await access(viewer, orgId, [...new Set(failures.map((f) => f.repo))], "view"),
  );
  const byIssue = new Map<string, FailureRow[]>();
  for (const failure of failures) {
    if (!viewable.has(failure.repo)) continue;
    const list = byIssue.get(failure.issueId);
    if (list) list.push(failure);
    else byIssue.set(failure.issueId, [failure]);
  }
  return issues.flatMap((issue) => {
    const evidence = byIssue.get(issue.id);
    return evidence ? [{ ...issue, failures: evidence }] : [];
  });
}

/** D1 binds at most 100 values a statement; `real()` takes one of them. */
const ORG_IDS_PER_QUERY = 90;

/** The ids of the accounts the person reaches an installation of the App on. */
async function installedAccounts(viewer: Viewer): Promise<number[]> {
  const pages = await githubPages(viewer, "/user/installations?per_page=100");
  return pages.flatMap((page) => {
    const list = isRecord(page) ? page["installations"] : null;
    if (!Array.isArray(list)) return [];
    return list.flatMap((installation: unknown) => {
      const account = isRecord(installation) ? installation["account"] : null;
      return isRecord(account) && typeof account["id"] === "number" ? [account["id"]] : [];
    });
  });
}

/**
 * The organisations the person can reach: those with a row whose id is the account of an installation
 * GitHub lists for them, sorted by login.
 */
export async function orgsFor(viewer: Viewer): Promise<Org[]> {
  const ids = [...new Set(await installedAccounts(viewer))];
  const chunks: number[][] = [];
  for (let at = 0; at < ids.length; at += ORG_IDS_PER_QUERY)
    chunks.push(ids.slice(at, at + ORG_IDS_PER_QUERY));
  const found = await Promise.all(
    chunks.map((chunk) =>
      viewer.db
        .select({ id: organisations.id, login: organisations.login, type: organisations.type })
        .from(organisations)
        .where(and(inArray(organisations.id, chunk), real(organisations.isSmoke))),
    ),
  );
  return found.flat().toSorted((a, b) => (a.login < b.login ? -1 : Number(a.login > b.login)));
}

/**
 * One organisation's catalogue as the person may see it, as engine types: the failures, jobs and
 * compares of the repos they can view (a compare carries a private repo's file list), and the issues
 * with at least one of those failures. GitHub is asked only for the permissions.
 */
export async function catalogueFor(viewer: Viewer, orgId: number): Promise<RankRows> {
  const [issueRows, failureRows, jobRows, compareRows] = await Promise.all([
    readIssues(viewer.db, orgId),
    readFailures(viewer.db, orgId),
    readJobs(viewer.db, orgId),
    readCompares(viewer.db, orgId),
  ]);
  const repos = new Set([...failureRows, ...jobRows, ...compareRows].map((row) => row.repo));
  const viewable = new Set(await access(viewer, orgId, [...repos], "view"));
  const failures = failureRows.filter((row) => viewable.has(row.repo)).map(failureFromRow);
  const evidenced = new Set(failures.map((failure) => failure.issueId));
  return {
    issues: issueRows.filter((row) => evidenced.has(row.id)).map(issueFromRow),
    failures,
    jobs: jobRows.filter((row) => viewable.has(row.repo)).map(jobFromRow),
    compares: compareRows
      .filter((row) => viewable.has(row.repo))
      .map((row) => ({
        repo: row.repo,
        base: row.base,
        head: row.head,
        result: compareFromRow(row),
      })),
  };
}
