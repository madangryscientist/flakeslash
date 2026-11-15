import { and, eq, gt } from "drizzle-orm";
import type { GithubProfile, GithubTokens } from "#/auth/github.ts";
import { randomToken, seal, sha256Hex, unseal } from "#/lib/crypto.ts";
import type { Db } from "./db.ts";
import { sessions, users } from "./schema.ts";

export type User = typeof users.$inferSelect;

/** The database and the `TOKEN_KEY` that seals the GitHub tokens a session row keeps. */
export type SessionStore = { db: Db; tokenKey: string | undefined };

/** A live session: its row id (the cookie token's hash), its person, and their tokens opened. */
export type Session = { id: string; user: User; tokens: GithubTokens };

const SESSION_MS = 30 * 24 * 60 * 60 * 1000;

/** Create or refresh the person from their GitHub profile; GitHub's id is theirs for good. */
export async function signInGithubUser(
  db: Db,
  profile: GithubProfile,
  now = new Date(),
): Promise<User> {
  const { githubId, login, name, avatarUrl } = profile;
  const [user] = await db
    .insert(users)
    .values({ id: githubId, login, name, avatarUrl, createdAt: now.toISOString() })
    .onConflictDoUpdate({ target: users.id, set: { login, name, avatarUrl } })
    .returning();
  if (!user) throw new Error("user upsert returned nothing");
  return user;
}

async function sealed(store: SessionStore, tokens: GithubTokens) {
  return {
    accessToken: await seal(store.tokenKey, tokens.accessToken),
    accessExpiresAt: tokens.accessExpiresAt.toISOString(),
    refreshToken: await seal(store.tokenKey, tokens.refreshToken),
    refreshExpiresAt: tokens.refreshExpiresAt.toISOString(),
  };
}

/** Returns the cookie value. Only its hash is stored, and the GitHub tokens only sealed. */
export async function createSession(
  store: SessionStore,
  userId: number,
  tokens: GithubTokens,
  now = new Date(),
): Promise<string> {
  const [user] = await store.db
    .select({ isSmoke: users.isSmoke })
    .from(users)
    .where(eq(users.id, userId));
  if (!user) throw new Error("no such user to start a session for");
  const token = randomToken("fss_");
  await store.db.insert(sessions).values({
    id: await sha256Hex(token),
    userId,
    expiresAt: new Date(now.getTime() + SESSION_MS).toISOString(),
    ...(await sealed(store, tokens)),
    isSmoke: user.isSmoke,
  });
  return token;
}

/** The unexpired session a cookie token names, or null. Not `real()`: a smoke user may sign in. */
export async function sessionUser(
  store: SessionStore,
  token: string,
  now = new Date(),
): Promise<Session | null> {
  return sessionById(store, await sha256Hex(token), now);
}

export async function sessionById(
  store: SessionStore,
  id: string,
  now = new Date(),
): Promise<Session | null> {
  const [row] = await store.db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, id), gt(sessions.expiresAt, now.toISOString())));
  if (!row) return null;
  const { session, user } = row;
  return {
    id,
    user,
    tokens: {
      accessToken: await unseal(store.tokenKey, session.accessToken),
      accessExpiresAt: new Date(session.accessExpiresAt),
      refreshToken: await unseal(store.tokenKey, session.refreshToken),
      refreshExpiresAt: new Date(session.refreshExpiresAt),
    },
  };
}

/** Replace a session's GitHub tokens after a refresh. */
export async function saveTokens(
  store: SessionStore,
  id: string,
  tokens: GithubTokens,
): Promise<void> {
  await store.db
    .update(sessions)
    .set(await sealed(store, tokens))
    .where(eq(sessions.id, id));
}

export async function endSession(db: Db, token: string): Promise<void> {
  await endSessionById(db, await sha256Hex(token));
}

export async function endSessionById(db: Db, id: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, id));
}
