/**
 * The App's side of the stubbed GitHub, for the scan's tests: installations, installation tokens and
 * installation repositories, over the engine's route stub. Nothing is signed with a real key: the key
 * is generated here.
 */
import { generateKeyPairSync } from "node:crypto";
import {
  API,
  fakeGitHub,
  job as apiJob,
  jobsOf,
  jobsPath,
  json,
  logPath,
  pullsPath,
  run as runOf,
  runsOf,
  runsPath,
  shaOf,
  type Reply,
} from "../../../../packages/engine/test/github-fake.ts";
import { d1Store, type BatchDb } from "#/db/d1-store.ts";
import type { Db } from "#/db/db.ts";
import { attempts, excerpts, failures, jobs } from "#/db/schema.ts";
import { testDb } from "#/db/test-db.ts";
import { flakyRoutesOf, playwrightLog, text } from "#/db/test-github.ts";
import type { GithubAppConfig, GithubFetch } from "#/github/app.ts";
import { runBatch, type BatchDeps } from "./hourly.ts";

const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });

/** An App config with a throwaway key, over GitHub's own base (what `fakeGitHub` matches). */
export const APP: GithubAppConfig = {
  appId: "424242",
  privateKey: pair.privateKey.export({ type: "pkcs1", format: "pem" }),
  apiBase: API,
};

export const INSTALLATIONS = "/app/installations?per_page=100";
export const REPOSITORIES = "/installation/repositories?per_page=100";
export const tokenPath = (id: number) => `/app/installations/${id}/access_tokens`;
export const tokenOf = (id: number) => `ghs_installation_${id}`;

/** An installation as GitHub lists it, on account `accountId` (`login`). */
export function installation(
  id: number,
  accountId: number,
  login: string,
  extra: { type?: string; suspended_at?: string | null } = {},
) {
  return {
    id,
    account: { id: accountId, login, type: extra.type ?? "Organization" },
    suspended_at: extra.suspended_at ?? null,
  };
}

/** The App's routes: the installation listing and a token for each installation in it. */
export function appRoutes(installations: { id: number }[]): Record<string, Reply> {
  const routes: Record<string, Reply> = { [INSTALLATIONS]: json(installations) };
  for (const { id } of installations) {
    routes[tokenPath(id)] = json({ token: tokenOf(id), expires_at: "2026-11-15T13:00:00Z" });
  }
  return routes;
}

/**
 * A fetch over `routes`, where `/installation/repositories` answers by the token it carries:
 * `reposByInstallation` maps an installation id to its repos' `full_name`s. `requests()` counts every
 * call made, the App's included.
 */
export function stubGitHub(
  routes: Record<string, Reply>,
  reposByInstallation: Record<number, string[]>,
) {
  const gh = fakeGitHub(routes);
  let requests = 0;
  const fetch: GithubFetch = async (input, init = {}) => {
    requests += 1;
    const headers = Object.fromEntries(new Headers(init.headers));
    if (input === `${API}${REPOSITORIES}`) {
      const id = Object.keys(reposByInstallation).find(
        (key) => headers.authorization === `Bearer ${tokenOf(Number(key))}`,
      );
      if (id === undefined) throw new Error(`unexpected token for ${input}`);
      const names = reposByInstallation[Number(id)] ?? [];
      return json({
        total_count: names.length,
        repositories: names.map((name) => ({ full_name: name })),
      });
    }
    const res = await gh.fetch(input, {
      headers,
      ...(init.redirect === "manual" ? { redirect: "manual" as const } : {}),
    });
    if (!(res instanceof Response)) throw new Error("the GitHub fake answered with no Response");
    return res;
  };
  return { fetch, gh, requests: () => requests };
}

interface History {
  firstRun: number;
  runs: number;
  jobsPerRun: number;
  /** Failed tests in each log, each its own new issue. */
  testsPerLog: number;
}

/**
 * The routes of `runs` failed runs of `repo`, run ids from `firstRun`, each with `jobsPerRun` failed
 * jobs whose logs are kept, every test failing its own way: a backfill at its most D1 writes per
 * GitHub request (each log read writes an excerpt, a new issue per test and the failures).
 */
export function failedHistory(
  repo: string,
  { firstRun, runs, jobsPerRun, testsPerLog }: History,
): Record<string, Reply> {
  const routes: Record<string, Reply> = {};
  const listed: unknown[] = [];
  for (let runId = firstRun; runId < firstRun + runs; runId += 1) {
    listed.push(runOf(runId, "2026-11-04T00:00:00Z", { conclusion: "failure" }));
    routes[pullsPath(shaOf(runId), repo)] = json([]);
    const runJobs: unknown[] = [];
    for (let at = 0; at < jobsPerRun; at += 1) {
      const jobId = runId * 100 + at;
      runJobs.push(
        apiJob(jobId, runId, {
          name: `Gate ${at}`,
          conclusion: "failure",
          html_url: `https://github.com/${repo}/actions/runs/${runId}/job/${jobId}`,
        }),
      );
      const tests = Array.from({ length: testsPerLog }, (_, n): [string, string] => [
        `test ${jobId}.${n}`,
        `Error: expected ${jobId}.${n} to be true`,
      ]);
      routes[logPath(jobId, repo)] = text(playwrightLog(...tests));
    }
    routes[jobsPath(runId, 1, repo)] = jobsOf(...runJobs);
  }
  routes[runsPath(repo)] = runsOf(...listed.toReversed());
  return routes;
}

// The batches the scan tests run: Acme (account 101) installs the App on two repos.

export const ACME = 101;
export const ONE = "acme/one";
export const TWO = "acme/two";
const START = Date.parse("2026-11-15T12:00:00Z");
const HOUR = 60 * 60 * 1000;
export const at = (hours: number) => new Date(START + hours * HOUR);
export const fail = (title: string) => text(playwrightLog([title, `Error: ${title} broke`]));

/** Acme's installation (id 7) with its two repos, listed in GitHub's spelling. */
export function acme(
  routes: Record<string, Reply>,
  extra: Parameters<typeof installation>[3] = {},
) {
  // The same object, so a test may change a route between batches.
  return stubGitHub(Object.assign(routes, appRoutes([installation(7, ACME, "Acme", extra)])), {
    7: ["Acme/One", "Acme/Two"],
  });
}

/** Two flaky runs in each repo, each proven by a passing rerun on its commit. */
export const history = () =>
  flakyRoutesOf(
    [
      [ONE, 1, fail("uploads a file")],
      [ONE, 2, fail("renames a file")],
      [TWO, 3, fail("signs in")],
      [TWO, 4, fail("signs out")],
    ],
    [
      [ONE, 1],
      [ONE, 2],
      [TWO, 3],
      [TWO, 4],
    ],
  );

export function batch(db: BatchDb, fetch: BatchDeps["fetch"], overrides: Partial<BatchDeps> = {}) {
  const lines: string[] = [];
  const done = runBatch({
    db,
    fetch,
    app: APP,
    budget: 1000,
    reposPerBatch: 50,
    now: at(0),
    log: (line) => lines.push(line),
    ...overrides,
  });
  return { done, lines };
}

/** What a reader of the catalogue sees, per `d1Store`. */
export async function catalogue(db: BatchDb, orgId = ACME, names = [ONE, TWO]) {
  const store = d1Store(db, orgId);
  const perRepo = [];
  for (const repo of names) {
    perRepo.push({
      repo,
      jobs: await store.readJobs(repo),
      excerpts: await store.readExcerpts(repo),
      held: await store.heldAttempts(repo),
    });
  }
  return { issues: await store.readIssues(), failures: await store.readFailures(), perRepo };
}

export async function counts(db: BatchDb) {
  const q: Db = db;
  return {
    jobs: (await q.select().from(jobs)).length,
    attempts: (await q.select().from(attempts)).length,
    excerpts: (await q.select().from(excerpts)).length,
    failures: (await q.select().from(failures)).length,
  };
}

/** One uninterrupted scan of `routes`, as the catalogue a stopped-and-resumed one must equal. */
export async function uninterrupted(routes: () => Record<string, Reply>) {
  const db = testDb();
  await batch(db, acme(routes()).fetch).done;
  return catalogue(db);
}
