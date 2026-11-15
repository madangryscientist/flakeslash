import { redirect } from "@tanstack/react-router";
import type { Db } from "#/db/db.ts";
import {
  type Session,
  type SessionStore,
  type User,
  endSessionById,
  saveTokens,
  sessionById,
  sessionUser,
} from "#/db/users.ts";
import {
  type GithubConfig,
  type GithubTokens,
  GrantRefusedError,
  refreshTokens,
} from "./github.ts";

/**
 * The signed-in person for one request. It holds their GitHub access token, so it stays on the
 * server: a route returns what a page shows (the login), never this.
 */
export type Viewer = {
  user: User;
  db: Db;
  sessionId: string;
  apiBase: string;
  accessToken: string;
};

export type ViewerDeps = SessionStore & {
  config: () => GithubConfig;
  now?: Date;
  /** Waits between re-reads of a session whose refresh was refused; a real timer by default. */
  wait?: (ms: number) => Promise<void>;
};

/** An access token this close to its expiry is refreshed before it is used. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

const fresh = (tokens: GithubTokens, now: Date): boolean =>
  tokens.accessExpiresAt.getTime() - now.getTime() > REFRESH_MARGIN_MS;

/** The viewer a session cookie names, with a usable access token; null signs them out. */
export async function loadViewer(
  deps: ViewerDeps,
  cookieToken: string | undefined,
): Promise<Viewer | null> {
  if (!cookieToken) return null;
  const now = deps.now ?? new Date();
  const session = await sessionUser(deps, cookieToken, now);
  if (!session) return null;
  const config = deps.config();
  const tokens = fresh(session.tokens, now) ? session.tokens : await refreshed(deps, session, now);
  if (!tokens) return null;
  return {
    user: session.user,
    db: deps.db,
    sessionId: session.id,
    apiBase: config.apiBase,
    accessToken: tokens.accessToken,
  };
}

/**
 * A refused refresh re-reads the session this often, and this many times after the first read,
 * for a racing request to write its tokens back: 3 seconds in all.
 */
const RACE_POLL_MS = 50;
const RACE_POLLS = 60;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** The session's refreshed tokens, written back; a refused refresh ends the session (null). */
async function refreshed(
  deps: ViewerDeps,
  session: Session,
  now: Date,
): Promise<GithubTokens | null> {
  if (session.tokens.refreshExpiresAt > now) {
    // Only a refusal ends the session; an outage or a network error throws and keeps it.
    const tokens = await refreshTokens(deps.config(), session.tokens.refreshToken, now).catch(
      (error: unknown) => {
        if (error instanceof GrantRefusedError) return null;
        throw error;
      },
    );
    if (tokens) {
      await saveTokens(deps, session.id, tokens);
      return tokens;
    }
    // GitHub rotates the refresh token, so a request that raced this one and refreshed first has
    // spent ours. Its tokens are in the row, or about to be: use them rather than sign out.
    const wait = deps.wait ?? sleep;
    let winner = await rotated(deps, session, now);
    for (let poll = 0; !winner && poll < RACE_POLLS; poll += 1) {
      await wait(RACE_POLL_MS);
      winner = await rotated(deps, session, now);
    }
    if (winner) return winner;
  }
  await endSessionById(deps.db, session.id);
  return null;
}

/** The row's tokens, when another request has refreshed them since `session` was read. */
async function rotated(
  deps: ViewerDeps,
  session: Session,
  now: Date,
): Promise<GithubTokens | null> {
  const again = await sessionById(deps, session.id, now);
  return again &&
    again.tokens.refreshToken !== session.tokens.refreshToken &&
    fresh(again.tokens, now)
    ? again.tokens
    : null;
}

/** For a signed-in page or action: no viewer sends the browser to sign in. */
export function signedIn(viewer: Viewer | null): Viewer {
  if (!viewer) throw redirect({ href: "/auth/github", reloadDocument: true });
  return viewer;
}
