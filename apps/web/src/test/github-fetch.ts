import { vi } from "vitest";
import type { GithubConfig, GithubTokens } from "#/auth/github.ts";

export const TEST_TOKEN_KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";

export const config: GithubConfig = {
  clientId: "Iv1.test",
  clientSecret: "test-secret",
  oauthBase: "https://github.test",
  apiBase: "https://api.github.test",
};

type Answer = { status?: number; body?: unknown };
type Route = (call: { body: unknown; authorization: string | null }) => Answer | Promise<Answer>;

/**
 * Stands in for GitHub by replacing `fetch`: each route is `METHOD path` on either base, and
 * anything else fails the test. No network. Returns every call made, in order.
 */
export function stubGithub(routes: Record<string, Route>) {
  const calls: { route: string; body: unknown; authorization: string | null }[] = [];
  vi.stubGlobal("fetch", async (input: URL | string, init: RequestInit = {}) => {
    const url = new URL(input);
    const route = `${init.method ?? "GET"} ${url.pathname}`;
    const headers = new Headers(init.headers);
    const call = {
      route,
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      authorization: headers.get("authorization"),
    };
    calls.push(call);
    const handler = routes[route];
    if (!handler) throw new Error(`unexpected GitHub call: ${route}`);
    const answer = await handler(call);
    return new Response(JSON.stringify(answer.body ?? {}), {
      status: answer.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });
  return calls;
}

/** GitHub's answer to a code or refresh grant. */
export const grant = (accessToken: string, refreshToken: string): Answer => ({
  body: {
    access_token: accessToken,
    expires_in: 28_800,
    refresh_token: refreshToken,
    refresh_token_expires_in: 15_897_600,
    token_type: "bearer",
    scope: "",
  },
});

export function tokens(now: Date, accessMs: number, accessToken = "ghu_old"): GithubTokens {
  return {
    accessToken,
    accessExpiresAt: new Date(now.getTime() + accessMs),
    refreshToken: "ghr_old",
    refreshExpiresAt: new Date(now.getTime() + 180 * 24 * 60 * 60 * 1000),
  };
}
