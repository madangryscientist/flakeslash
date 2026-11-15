import { randomToken } from "#/lib/crypto.ts";
import type { GithubConfig, GithubProfile, GithubTokens } from "./github.ts";
import { authorizeUrl } from "./github.ts";

export const OAUTH_STATE_COOKIE = "fs_oauth_state";
const STATE_PATH = "/auth/github";

export type CookieOptions = {
  httpOnly: boolean;
  secure: boolean;
  sameSite: "lax";
  path: string;
  maxAge: number;
};

/** What the GitHub sign-in routes need from the server, passed in so a test can stand in for it. */
export type GithubStartDeps = {
  config: () => GithubConfig;
  setCookie: (name: string, value: string, options: CookieOptions) => void;
};

export type GithubCallbackDeps = {
  config: () => GithubConfig;
  getCookie: (name: string) => string | undefined;
  deleteCookie: (name: string, options: { path: string }) => void;
  exchangeCode: (config: GithubConfig, code: string, callback: string) => Promise<GithubTokens>;
  readProfile: (config: GithubConfig, accessToken: string) => Promise<GithubProfile>;
  /** Saves the profile and answers the user's id. */
  signInUser: (profile: GithubProfile) => Promise<number>;
  startSession: (userId: number, tokens: GithubTokens) => Promise<void>;
};

/** `/auth/github`: remember a fresh `state` in a cookie and send the browser to GitHub. */
export function githubStart(request: Request, deps: GithubStartDeps): Response {
  const url = new URL(request.url);
  const state = randomToken("");
  deps.setCookie(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    secure: url.protocol === "https:",
    sameSite: "lax",
    path: STATE_PATH,
    maxAge: 600,
  });
  const callback = new URL("/auth/github/callback", url).toString();
  const location = authorizeUrl(deps.config(), state, callback);
  return new Response(null, { status: 302, headers: { location } });
}

/** `/auth/github/callback`: the `state` must come back as the cookie said, then the session starts. */
export async function githubCallback(
  request: Request,
  deps: GithubCallbackDeps,
): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = deps.getCookie(OAUTH_STATE_COOKIE);
  deps.deleteCookie(OAUTH_STATE_COOKIE, { path: STATE_PATH });
  if (!code || !state || url.searchParams.get("state") !== state)
    return new Response("Sign-in expired or was tampered with. Try again.", { status: 400 });
  const config = deps.config();
  const callback = new URL(url.pathname, url).toString();
  const tokens = await deps.exchangeCode(config, code, callback);
  const profile = await deps.readProfile(config, tokens.accessToken);
  await deps.startSession(await deps.signInUser(profile), tokens);
  return new Response(null, { status: 302, headers: { location: "/" } });
}
