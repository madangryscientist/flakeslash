import { describe, expect, test } from "vitest";
import { config, tokens } from "#/test/github-fetch.ts";
import {
  type CookieOptions,
  type GithubCallbackDeps,
  OAUTH_STATE_COOKIE,
  githubCallback,
  githubStart,
} from "./sign-in-github.ts";

const request = (path: string) => new Request(new URL(path, "https://fs.test"));

function callbackDeps(cookies: Record<string, string>) {
  const deleted: { name: string; options: { path: string } }[] = [];
  const calls = { exchangeCode: 0, startSession: [] as number[] };
  const deps: GithubCallbackDeps = {
    config: () => config,
    getCookie: (name) => cookies[name],
    deleteCookie: (name, options) => deleted.push({ name, options }),
    exchangeCode: async () => {
      calls.exchangeCode += 1;
      return tokens(new Date(), 8 * 60 * 60 * 1000);
    },
    readProfile: async () => ({ githubId: 7, login: "ada", name: null, avatarUrl: null }),
    signInUser: async (profile) => profile.githubId,
    startSession: async (id) => {
      calls.startSession.push(id);
    },
  };
  return { deps, deleted, calls };
}

describe("github callback: the state check", () => {
  test.each([
    { name: "a missing code", cookie: "s1", url: "/auth/github/callback?state=s1" },
    {
      name: "a missing state cookie",
      cookie: undefined,
      url: "/auth/github/callback?code=c&state=s1",
    },
    { name: "a missing query state", cookie: "s1", url: "/auth/github/callback?code=c" },
    { name: "a mismatched state", cookie: "s1", url: "/auth/github/callback?code=c&state=s2" },
  ])("$name is a 400 and starts no session", async (c) => {
    const { deps, deleted, calls } = callbackDeps(
      c.cookie ? { [OAUTH_STATE_COOKIE]: c.cookie } : {},
    );
    const res = await githubCallback(request(c.url), deps);
    expect(res.status).toBe(400);
    expect(calls).toEqual({ exchangeCode: 0, startSession: [] });
    expect(deleted).toEqual([{ name: OAUTH_STATE_COOKIE, options: { path: "/auth/github" } }]);
  });

  test("a matching state trades the code, starts the session and goes home", async () => {
    const { deps, calls } = callbackDeps({ [OAUTH_STATE_COOKIE]: "s1" });
    const res = await githubCallback(request("/auth/github/callback?code=c&state=s1"), deps);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    expect(calls.startSession).toEqual([7]);
  });
});

test("the start sets a short-lived state cookie and sends the browser to GitHub with it", () => {
  const set: { name: string; value: string; options: CookieOptions }[] = [];
  const res = githubStart(request("/auth/github"), {
    config: () => config,
    setCookie: (name, value, options) => set.push({ name, value, options }),
  });
  expect(set).toHaveLength(1);
  expect(set[0]).toMatchObject({
    name: OAUTH_STATE_COOKIE,
    options: { httpOnly: true, secure: true, sameSite: "lax", path: "/auth/github", maxAge: 600 },
  });
  const location = new URL(res.headers.get("location") ?? "");
  expect(location.searchParams.get("state")).toBe(set[0]?.value);
  expect(location.searchParams.get("redirect_uri")).toBe("https://fs.test/auth/github/callback");
});
