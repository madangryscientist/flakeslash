import { afterEach, describe, expect, test, vi } from "vitest";
import type { Viewer } from "#/auth/viewer.ts";
import { compares, failures, issues, jobs, organisations, sessions } from "#/db/schema.ts";
import { testDb } from "#/db/test-db.ts";
import { isRedirect } from "@tanstack/react-router";
import { createSession, sessionUser, signInGithubUser } from "#/db/users.ts";
import { compareRow, jobRow } from "#/test/catalogue-rows.ts";
import { TEST_TOKEN_KEY, config, stubGithub, tokens } from "#/test/github-fetch.ts";
import { access, catalogueFor, issuesFor, orgsFor } from "./access.ts";

afterEach(() => vi.unstubAllGlobals());

const ADA = 7;
const ACME = 101;
const ADA_ORG = ADA;
const NOW = "2026-11-15T00:00:00Z";

const perms = (pull: boolean, push: boolean, admin = false) => ({
  body: { permissions: { pull, push, admin } },
});
const notFound = () => ({ status: 404, body: { message: "Not Found" } });

async function viewer(): Promise<Viewer> {
  const db = testDb();
  await db.insert(organisations).values([
    { id: ACME, login: "acme", type: "Organization", createdAt: NOW },
    { id: ADA_ORG, login: "ada", type: "User", createdAt: NOW },
  ]);
  const user = await signInGithubUser(db, {
    githubId: ADA,
    login: "ada",
    name: null,
    avatarUrl: null,
  });
  const store = { db, tokenKey: TEST_TOKEN_KEY };
  const cookie = await createSession(store, ADA, tokens(new Date(), 8 * 60 * 60 * 1000));
  const session = await sessionUser(store, cookie);
  if (!session) throw new Error("no session");
  return { user, db, sessionId: session.id, apiBase: config.apiBase, accessToken: "ghu_ada" };
}

function failure(repo: string, jobId: number, issueId = "key:boom") {
  return {
    orgId: ACME,
    repo,
    jobId,
    url: `https://ci/${repo}/${jobId}`,
    signature: "boom",
    issueId,
    errorLine: "Error: boom",
  };
}

const issue = (id: string) => ({
  orgId: ACME,
  id,
  name: id,
  kind: "test",
  status: "open",
  signatures: "[]",
});

describe("repo access", () => {
  test("a person without read access to a repo gets no data for it", async () => {
    const v = await viewer();
    await v.db.insert(issues).values(issue("key:boom"));
    await v.db.insert(failures).values(failure("acme/secret", 1));
    const calls = stubGithub({ "GET /repos/acme/secret": notFound });
    expect(await access(v, ACME, ["acme/secret"], "view")).toEqual([]);
    expect(await issuesFor(v, ACME)).toEqual([]);
    expect(calls.every((c) => c.authorization === "Bearer ghu_ada")).toBe(true);
  });

  test("an issue across two repos shows only the failures of the repo the person reads", async () => {
    const v = await viewer();
    await v.db.insert(issues).values([issue("key:boom"), issue("key:hidden")]);
    await v.db
      .insert(failures)
      .values([
        failure("acme/app", 1),
        failure("acme/secret", 2),
        failure("acme/secret", 3, "key:hidden"),
      ]);
    stubGithub({
      "GET /repos/acme/app": () => perms(true, false),
      "GET /repos/acme/secret": notFound,
    });
    const seen = await issuesFor(v, ACME);
    expect(seen.map((i) => i.id)).toEqual(["key:boom"]);
    expect(seen[0]?.failures.map((f) => f.repo)).toEqual(["acme/app"]);
  });

  test("read on a public repo is view only: refused at write and admin", async () => {
    const v = await viewer();
    stubGithub({
      "GET /repos/acme/public": () => perms(true, false),
      "GET /user/memberships/orgs/acme": notFound,
    });
    expect(await access(v, ACME, ["acme/public"], "view")).toEqual(["acme/public"]);
    expect(await access(v, ACME, ["acme/public"], "write")).toEqual([]);
    expect(await access(v, ACME, ["acme/public"], "admin")).toEqual([]);
  });

  test("write on one repo is write there only, and not admin", async () => {
    const v = await viewer();
    stubGithub({
      "GET /repos/acme/app": () => perms(true, true),
      "GET /repos/acme/docs": () => perms(true, false),
      "GET /user/memberships/orgs/acme": () => ({ body: { role: "member", state: "active" } }),
    });
    expect(await access(v, ACME, ["acme/app", "acme/docs"], "write")).toEqual(["acme/app"]);
    expect(await access(v, ACME, ["acme/app"], "admin")).toEqual([]);
  });

  test("a repo of another owner is refused at every level, admin included", async () => {
    const v = await viewer();
    const calls = stubGithub({});
    for (const level of ["view", "write", "admin"] as const)
      expect(await access(v, ADA_ORG, ["acme/secret"], level)).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("a token GitHub no longer takes ends the session and sends the person to sign in", async () => {
    const v = await viewer();
    stubGithub({
      "GET /repos/acme/app": () => ({ status: 401, body: { message: "Bad credentials" } }),
    });
    const thrown = await access(v, ACME, ["acme/app"], "view").catch((error: unknown) => error);
    expect(isRedirect(thrown)).toBe(true);
    const [row] = await v.db.select().from(sessions);
    expect(row).toBeUndefined();
  });

  test.each([
    { name: "with its headers", headers: { "x-ratelimit-remaining": "0" } },
    { name: "with neither header (a secondary limit)", headers: {} },
  ])("a spent rate limit $name is an error, not a repo the person cannot see", async (c) => {
    const v = await viewer();
    stubGithub({
      "GET /repos/acme/app": () => ({
        status: 403,
        body: { message: "You have exceeded a secondary rate limit." },
        headers: c.headers,
      }),
    });
    await expect(access(v, ACME, ["acme/app"], "view")).rejects.toThrow("answered 403");
  });

  test("GitHub is asked once per repo in a request", async () => {
    const v = await viewer();
    const calls = stubGithub({ "GET /repos/acme/app": () => perms(true, true) });
    await access(v, ACME, ["acme/app"], "view");
    await access(v, ACME, ["acme/app"], "write");
    expect(calls).toHaveLength(1);
  });
});

describe("admin", () => {
  test("an active admin of the organisation passes", async () => {
    const v = await viewer();
    stubGithub({
      "GET /user/memberships/orgs/acme": () => ({ body: { role: "admin", state: "active" } }),
    });
    expect(await access(v, ACME, ["acme/app"], "admin")).toEqual(["acme/app"]);
  });

  test("an admin whose invitation is still pending does not", async () => {
    const v = await viewer();
    stubGithub({
      "GET /user/memberships/orgs/acme": () => ({ body: { role: "admin", state: "pending" } }),
    });
    expect(await access(v, ACME, ["acme/app"], "admin")).toEqual([]);
  });

  test("the person who is a User organisation owns it, with no call to GitHub", async () => {
    const v = await viewer();
    const calls = stubGithub({});
    expect(await access(v, ADA_ORG, ["ada/site"], "admin")).toEqual(["ada/site"]);
    expect(calls).toEqual([]);
  });

  test("another person's User organisation is refused", async () => {
    const v = await viewer();
    await v.db
      .insert(organisations)
      .values({ id: 999, login: "bob", type: "User", createdAt: NOW });
    expect(await access(v, 999, ["bob/site"], "admin")).toEqual([]);
  });

  test("an organisation with no row is refused", async () => {
    const v = await viewer();
    const calls = stubGithub({});
    expect(await access(v, 555, ["ghost/app"], "admin")).toEqual([]);
    expect(calls).toEqual([]);
  });
});

const openIssue = (id: string) => ({ ...issue(id), status: "potential" });

describe("catalogueFor", () => {
  test("a smoke row never reaches the result", async () => {
    const v = await viewer();
    await v.db
      .insert(issues)
      .values([openIssue("key:boom"), { ...openIssue("key:smoke"), isSmoke: true }]);
    await v.db
      .insert(failures)
      .values([failure("acme/app", 1), { ...failure("acme/app", 2, "key:smoke"), isSmoke: true }]);
    await v.db
      .insert(jobs)
      .values([jobRow(ACME, "acme/app", 1), { ...jobRow(ACME, "acme/app", 2), isSmoke: true }]);
    await v.db
      .insert(compares)
      .values([
        compareRow(ACME, "acme/app"),
        { ...compareRow(ACME, "acme/app"), head: "c3", isSmoke: true },
      ]);
    stubGithub({ "GET /repos/acme/app": () => perms(true, false) });
    const seen = await catalogueFor(v, ACME);
    expect(seen.issues.map((i) => i.id)).toEqual(["key:boom"]);
    expect(seen.failures.map((f) => f.jobId)).toEqual([1]);
    expect(seen.jobs.map((j) => j.jobId)).toEqual([1]);
    expect(seen.compares.map((c) => c.head)).toEqual(["c2"]);
  });

  test("leaves out the rows of a repo the person cannot view, and an issue with no viewable failure", async () => {
    const v = await viewer();
    await v.db.insert(issues).values([openIssue("key:boom"), openIssue("key:hidden")]);
    await v.db
      .insert(failures)
      .values([
        failure("acme/app", 1),
        failure("acme/secret", 2),
        failure("acme/secret", 3, "key:hidden"),
      ]);
    await v.db
      .insert(jobs)
      .values([
        jobRow(ACME, "acme/app", 1),
        jobRow(ACME, "acme/secret", 2),
        jobRow(ACME, "acme/secret", 3),
      ]);
    await v.db
      .insert(compares)
      .values([compareRow(ACME, "acme/app"), compareRow(ACME, "acme/secret")]);
    const calls = stubGithub({
      "GET /repos/acme/app": () => perms(true, false),
      "GET /repos/acme/secret": notFound,
    });
    const seen = await catalogueFor(v, ACME);
    expect(seen.issues.map((i) => i.id)).toEqual(["key:boom"]);
    expect(seen.failures.map((f) => f.repo)).toEqual(["acme/app"]);
    expect(seen.jobs.map((j) => j.repo)).toEqual(["acme/app"]);
    expect(seen.compares).toEqual([
      { repo: "acme/app", base: "c1", head: "c2", result: { status: "ok", files: ["src/a.ts"] } },
    ]);
    // Only the permission checks, one per repo.
    expect(calls.map((c) => c.route).toSorted()).toEqual([
      "GET /repos/acme/app",
      "GET /repos/acme/secret",
    ]);
  });
});

const installation = (id: number, login: string) => ({
  account: { id, login, type: "Organization" },
});

describe("orgsFor", () => {
  test("returns only the organisations the person reaches an installation of, across pages, by login", async () => {
    const v = await viewer();
    await v.db.insert(organisations).values([
      { id: 202, login: "zeta", type: "Organization", createdAt: NOW },
      { id: 303, login: "unreached", type: "Organization", createdAt: NOW },
      { id: 404, login: "smoke", type: "Organization", createdAt: NOW, isSmoke: true },
    ]);
    const calls = stubGithub({
      "GET /user/installations": ({ url }) =>
        url.searchParams.get("page") === "2"
          ? { body: { installations: [installation(ACME, "acme"), installation(999, "nobody")] } }
          : {
              body: { installations: [installation(202, "zeta"), installation(404, "smoke")] },
              headers: {
                link: `<${config.apiBase}/user/installations?per_page=100&page=2>; rel="next", <${config.apiBase}/user/installations?per_page=100&page=2>; rel="last"`,
              },
            },
    });
    expect((await orgsFor(v)).map((o) => o.login)).toEqual(["acme", "zeta"]);
    expect(calls.map((c) => c.url.searchParams.get("page"))).toEqual([null, "2"]);
    expect(calls.every((c) => c.authorization === "Bearer ghu_ada")).toBe(true);
  });

  test("refuses a next page off the API base", async () => {
    const v = await viewer();
    stubGithub({
      "GET /user/installations": () => ({
        body: { installations: [] },
        headers: { link: '<https://elsewhere.test/user/installations?page=2>; rel="next"' },
      }),
    });
    await expect(orgsFor(v)).rejects.toThrow("off the API base");
  });

  test("a token GitHub no longer takes ends the session", async () => {
    const v = await viewer();
    stubGithub({
      "GET /user/installations": () => ({ status: 401, body: { message: "Bad credentials" } }),
    });
    const thrown = await orgsFor(v).catch((error: unknown) => error);
    expect(isRedirect(thrown)).toBe(true);
    const [row] = await v.db.select().from(sessions);
    expect(row).toBeUndefined();
  });
});
