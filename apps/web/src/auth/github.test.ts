import { afterEach, describe, expect, test, vi } from "vitest";
import { config, grant, stubGithub } from "#/test/github-fetch.ts";
import { authorizeUrl, exchangeCode, readProfile } from "./github.ts";

afterEach(() => vi.unstubAllGlobals());

const NOW = new Date("2026-11-15T12:00:00Z");

test("the authorize URL asks for no scope: the App's permissions are the token's", () => {
  const url = new URL(authorizeUrl(config, "s1", "https://fs.test/auth/github/callback"));
  expect(url.origin + url.pathname).toBe("https://github.test/login/oauth/authorize");
  expect(url.searchParams.get("scope")).toBeNull();
  expect(url.searchParams.get("state")).toBe("s1");
  expect(url.searchParams.get("client_id")).toBe("Iv1.test");
});

describe("the code grant", () => {
  test("a code becomes an access and a refresh token with their expiries", async () => {
    const calls = stubGithub({ "POST /login/oauth/access_token": () => grant("ghu_a", "ghr_a") });
    const tokens = await exchangeCode(config, "c1", "https://fs.test/cb", NOW);
    expect(tokens).toEqual({
      accessToken: "ghu_a",
      accessExpiresAt: new Date("2026-11-15T20:00:00Z"),
      refreshToken: "ghr_a",
      refreshExpiresAt: new Date(NOW.getTime() + 15_897_600_000),
    });
    expect(calls[0]?.body).toMatchObject({ code: "c1", client_secret: "test-secret" });
  });
});

test("the profile is read with the person's token", async () => {
  const calls = stubGithub({
    "GET /user": () => ({ body: { id: 7, login: "ada", name: "Ada", avatar_url: "https://a" } }),
  });
  expect(await readProfile(config, "ghu_a")).toEqual({
    githubId: 7,
    login: "ada",
    name: "Ada",
    avatarUrl: "https://a",
  });
  expect(calls[0]?.authorization).toBe("Bearer ghu_a");
});
