import { deleteCookie, getCookie, getRequestUrl, setCookie } from "@tanstack/react-start/server";
import type { GithubTokens } from "#/auth/github.ts";
import { type Viewer, loadViewer, signedIn } from "#/auth/viewer.ts";
import { createSession, endSession } from "#/db/users.ts";
import { database, githubConfig, tokenKey } from "./env.ts";

const COOKIE = "fs_session";

const store = () => ({ db: database(), tokenKey: tokenKey() });

/** The signed-in person, their access token refreshed when it is close to expiry; or null. */
export function viewer(): Promise<Viewer | null> {
  return loadViewer({ ...store(), config: githubConfig }, getCookie(COOKIE));
}

/** For a signed-in page or action: no session sends the browser to sign in with GitHub. */
export async function requireViewer(): Promise<Viewer> {
  return signedIn(await viewer());
}

export async function startSession(userId: number, tokens: GithubTokens): Promise<void> {
  setCookie(COOKIE, await createSession(store(), userId, tokens), {
    httpOnly: true,
    secure: getRequestUrl().protocol === "https:",
    sameSite: "lax",
    path: "/",
    maxAge: 30 * 24 * 60 * 60,
  });
}

export async function stopSession(): Promise<void> {
  const token = getCookie(COOKIE);
  if (token) await endSession(database(), token);
  deleteCookie(COOKIE, { path: "/" });
}
