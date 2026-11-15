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
import { type GithubConfig, type GithubTokens, refreshTokens } from "./github.ts";

/**
 * The signed-in person for one request. It holds their GitHub access token, so it stays on the
 * server: a route returns what a page shows (the login), never this.
 */
export type Viewer = { user: User; db: Db; apiBase: string; accessToken: string };

export type ViewerDeps = SessionStore & { config: () => GithubConfig; now?: Date };

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
    apiBase: config.apiBase,
    accessToken: tokens.accessToken,
  };
}

/** The session's refreshed tokens, written back; a failed refresh ends the session (null). */
async function refreshed(
  deps: ViewerDeps,
  session: Session,
  now: Date,
): Promise<GithubTokens | null> {
  if (session.tokens.refreshExpiresAt > now) {
    try {
      const tokens = await refreshTokens(deps.config(), session.tokens.refreshToken, now);
      await saveTokens(deps, session.id, tokens);
      return tokens;
    } catch {
      // GitHub rotates the refresh token, so a request that raced this one and refreshed first
      // has spent ours. Its tokens are in the row now: use them rather than sign the person out.
      const again = await sessionById(deps, session.id, now);
      if (
        again &&
        again.tokens.refreshToken !== session.tokens.refreshToken &&
        fresh(again.tokens, now)
      )
        return again.tokens;
    }
  }
  await endSessionById(deps.db, session.id);
  return null;
}

/** For a signed-in page or action: no viewer sends the browser to sign in. */
export function signedIn(viewer: Viewer | null): Viewer {
  if (!viewer) throw redirect({ href: "/auth/github", reloadDocument: true });
  return viewer;
}
