import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { sha256Hex, unseal } from "#/lib/crypto.ts";
import { TEST_TOKEN_KEY, tokens } from "#/test/github-fetch.ts";
import { sessions } from "./schema.ts";
import { testDb } from "./test-db.ts";
import { createSession, endSession, sessionUser, signInGithubUser } from "./users.ts";

const NOW = new Date("2026-11-15T12:00:00Z");
const HOUR = 60 * 60 * 1000;
const ada = { githubId: 7, login: "ada", name: "Ada", avatarUrl: null };

async function signedUp() {
  const db = testDb();
  const store = { db, tokenKey: TEST_TOKEN_KEY };
  await signInGithubUser(db, ada, NOW);
  return { db, store };
}

describe("signInGithubUser", () => {
  test("the first sign-in creates the user under their GitHub id; the next refreshes it", async () => {
    const db = testDb();
    expect(await signInGithubUser(db, ada, NOW)).toMatchObject({
      id: 7,
      login: "ada",
      createdAt: NOW.toISOString(),
      isSmoke: false,
    });
    const renamed = await signInGithubUser(db, { ...ada, login: "ada2" }, new Date());
    expect(renamed).toMatchObject({ id: 7, login: "ada2", createdAt: NOW.toISOString() });
  });
});

describe("sessions", () => {
  test("the row keeps the cookie token's hash and the GitHub tokens sealed", async () => {
    const { db, store } = await signedUp();
    const cookie = await createSession(store, 7, tokens(NOW, 8 * HOUR, "ghu_live"), NOW);
    const [row] = await db.select().from(sessions);
    expect(row?.id).toBe(await sha256Hex(cookie));
    expect(JSON.stringify(row)).not.toContain(cookie);
    expect(row?.accessToken).not.toContain("ghu_live");
    expect(row?.refreshToken).not.toContain("ghr_old");
    expect(await unseal(TEST_TOKEN_KEY, row?.accessToken ?? "")).toBe("ghu_live");
    expect(await unseal(TEST_TOKEN_KEY, row?.refreshToken ?? "")).toBe("ghr_old");
    expect(row?.expiresAt).toBe("2026-12-15T12:00:00.000Z");
  });

  test("the cookie names its user and tokens until it expires or is ended", async () => {
    const { store, db } = await signedUp();
    const cookie = await createSession(store, 7, tokens(NOW, 8 * HOUR, "ghu_live"), NOW);
    const session = await sessionUser(store, cookie, NOW);
    expect(session?.user.login).toBe("ada");
    expect(session?.tokens.accessToken).toBe("ghu_live");
    expect(await sessionUser(store, cookie, new Date("2026-12-16T00:00:00Z"))).toBeNull();
    expect(await sessionUser(store, "fss_wrong", NOW)).toBeNull();
    await endSession(db, cookie);
    expect(await sessionUser(store, cookie, NOW)).toBeNull();
  });

  test("a row whose token is not sealed is an error, never used as it is", async () => {
    const { store, db } = await signedUp();
    const cookie = await createSession(store, 7, tokens(NOW, 8 * HOUR), NOW);
    await db
      .update(sessions)
      .set({ accessToken: "ghu_plain" })
      .where(eq(sessions.id, await sha256Hex(cookie)));
    await expect(sessionUser(store, cookie, NOW)).rejects.toThrow("cannot be opened");
  });

  test("a smoke user can sign in, and their session is smoke too", async () => {
    const { store, db } = await signedUp();
    await signInGithubUser(db, { ...ada, githubId: 8, login: "smoke" }, NOW);
    await db.update((await import("./schema.ts")).users).set({ isSmoke: true });
    const cookie = await createSession(store, 8, tokens(NOW, 8 * HOUR), NOW);
    expect((await sessionUser(store, cookie, NOW))?.user.login).toBe("smoke");
    const [row] = await db.select().from(sessions);
    expect(row?.isSmoke).toBe(true);
  });
});
