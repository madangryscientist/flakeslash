import { isRedirect } from "@tanstack/react-router";
import { afterEach, describe, expect, test, vi } from "vitest";
import { sessions } from "#/db/schema.ts";
import { testDb } from "#/db/test-db.ts";
import { createSession, sessionUser, signInGithubUser } from "#/db/users.ts";
import { unseal } from "#/lib/crypto.ts";
import { TEST_TOKEN_KEY, config, grant, stubGithub, tokens } from "#/test/github-fetch.ts";
import { loadViewer, signedIn } from "./viewer.ts";

afterEach(() => vi.unstubAllGlobals());

const NOW = new Date("2026-11-15T12:00:00Z");

const NOOP = (): void => undefined;

/** A promise the test opens when it chooses. */
function latch() {
  let open = NOOP;
  const done = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { done, open: () => open() };
}
const MINUTE = 60 * 1000;

/** A wait that takes no time, so a refused refresh polls through its bound at once. */
const NO_WAIT = async (): Promise<void> => undefined;

async function withSession(accessMs: number, refreshMs?: number) {
  const db = testDb();
  const store = { db, tokenKey: TEST_TOKEN_KEY };
  await signInGithubUser(db, { githubId: 7, login: "ada", name: null, avatarUrl: null }, NOW);
  const issued = tokens(NOW, accessMs);
  if (refreshMs !== undefined) issued.refreshExpiresAt = new Date(NOW.getTime() + refreshMs);
  const cookie = await createSession(store, 7, issued, NOW);
  return { db, store, cookie, deps: { ...store, config: () => config, now: NOW, wait: NO_WAIT } };
}

/**
 * Two requests race to refresh: the winner's grant is held until the loser's `waitsBeforeWin`th
 * wait, which lets it through and returns only once the winner has saved its tokens. The loser's
 * refusal answers at once. Waits take no real time.
 */
async function race(waitsBeforeWin: number) {
  const { deps, cookie } = await withSession(4 * MINUTE);
  const winnerAsked = latch();
  const winnerMayAnswer = latch();
  let grants = 0;
  stubGithub({
    "POST /login/oauth/access_token": async () => {
      grants += 1;
      if (grants === 2) return { body: { error: "bad_refresh_token" } };
      winnerAsked.open();
      await winnerMayAnswer.done;
      return grant("ghu_first", "ghr_first");
    },
  });
  const winner = loadViewer(deps, cookie);
  await winnerAsked.done;
  const waits: number[] = [];
  const loser = loadViewer(
    {
      ...deps,
      wait: async (ms) => {
        waits.push(ms);
        if (waits.length === waitsBeforeWin) {
          winnerMayAnswer.open();
          await winner;
        }
      },
    },
    cookie,
  );
  return { winner: await winner, loser: await loser, waits };
}

describe("signing in is required", () => {
  test("a request with no session gets the sign-in redirect", async () => {
    const { deps } = await withSession(8 * 60 * MINUTE);
    const viewer = await loadViewer(deps, undefined);
    expect(viewer).toBeNull();
    let thrown: unknown;
    try {
      signedIn(viewer);
    } catch (error) {
      thrown = error;
    }
    expect(isRedirect(thrown)).toBe(true);
    expect(isRedirect(thrown) && thrown.options.href).toBe("/auth/github");
  });

  test("an unknown cookie is no viewer either", async () => {
    const { deps } = await withSession(8 * 60 * MINUTE);
    expect(await loadViewer(deps, "fss_forged")).toBeNull();
  });
});

describe("the access token", () => {
  test("a token with time left is used as it is, with no call to GitHub", async () => {
    const { deps, cookie } = await withSession(6 * MINUTE);
    const calls = stubGithub({});
    const viewer = await loadViewer(deps, cookie);
    expect(viewer?.accessToken).toBe("ghu_old");
    expect(viewer?.user.login).toBe("ada");
    expect(calls).toEqual([]);
  });

  test("a token within 5 minutes of expiry is refreshed and written back", async () => {
    const { deps, cookie, store, db } = await withSession(4 * MINUTE);
    const calls = stubGithub({
      "POST /login/oauth/access_token": () => grant("ghu_new", "ghr_new"),
    });
    const viewer = await loadViewer(deps, cookie);
    expect(viewer?.accessToken).toBe("ghu_new");
    expect(calls.map((c) => c.body)).toEqual([
      expect.objectContaining({ grant_type: "refresh_token", refresh_token: "ghr_old" }),
    ]);
    const saved = await sessionUser(store, cookie, NOW);
    expect(saved?.tokens).toMatchObject({ accessToken: "ghu_new", refreshToken: "ghr_new" });
    expect(saved?.tokens.accessExpiresAt).toEqual(new Date("2026-11-15T20:00:00Z"));
    const [row] = await db.select().from(sessions);
    expect(row?.refreshToken).not.toContain("ghr_new");
    expect(await unseal(TEST_TOKEN_KEY, row?.refreshToken ?? "")).toBe("ghr_new");
  });

  test("a refused refresh that no other request answers ends the session after 3 seconds", async () => {
    const { deps, cookie, store } = await withSession(4 * MINUTE);
    stubGithub({
      "POST /login/oauth/access_token": () => ({ body: { error: "bad_refresh_token" } }),
    });
    const waits: number[] = [];
    const wait = async (ms: number): Promise<void> => {
      waits.push(ms);
    };
    expect(await loadViewer({ ...deps, wait }, cookie)).toBeNull();
    expect(waits).toEqual(Array.from({ length: 60 }, () => 50));
    expect(await sessionUser(store, cookie, NOW)).toBeNull();
  });

  test("GitHub being down is an error that keeps the session, not a refusal", async () => {
    const { deps, cookie, store } = await withSession(4 * MINUTE);
    stubGithub({ "POST /login/oauth/access_token": () => ({ status: 502 }) });
    await expect(loadViewer(deps, cookie)).rejects.toThrow("unavailable (502)");
    expect(await sessionUser(store, cookie, NOW)).not.toBeNull();
  });

  test("a refresh token past its expiry ends the session without asking GitHub", async () => {
    const { deps, cookie, store } = await withSession(4 * MINUTE, 0);
    const calls = stubGithub({});
    expect(await loadViewer(deps, cookie)).toBeNull();
    expect(calls).toEqual([]);
    expect(await sessionUser(store, cookie, NOW)).toBeNull();
  });

  test("a refresh refused before the winner has written back still waits for its tokens", async () => {
    const { winner, loser, waits } = await race(1);
    expect(winner?.accessToken).toBe("ghu_first");
    expect(loser?.accessToken).toBe("ghu_first");
    expect(waits).toEqual([50]);
  });

  test("a winner slow to write back still hands the loser its tokens", async () => {
    const { winner, loser, waits } = await race(5);
    expect(winner?.accessToken).toBe("ghu_first");
    expect(loser?.accessToken).toBe("ghu_first");
    expect(waits).toEqual([50, 50, 50, 50, 50]);
  });

  test("a refresh that lost a race to another request uses that request's tokens", async () => {
    const { deps, cookie } = await withSession(4 * MINUTE);
    const first = latch();
    const firstAsked = latch();
    const secondAsked = latch();
    let grants = 0;
    stubGithub({
      "POST /login/oauth/access_token": async () => {
        grants += 1;
        if (grants === 1) {
          // Both requests read the old tokens before either has a grant.
          firstAsked.open();
          await secondAsked.done;
          return grant("ghu_first", "ghr_first");
        }
        // GitHub rotated the refresh token on the first grant, so the second is refused; it
        // answers once the first request has written its tokens back.
        secondAsked.open();
        await first.done;
        return { body: { error: "bad_refresh_token" } };
      },
    });
    const a = loadViewer(deps, cookie).then((v) => {
      first.open();
      return v;
    });
    // The second request starts once the first has asked GitHub, so the first holds the grant.
    await firstAsked.done;
    const b = loadViewer(deps, cookie);
    const [winner, loser] = await Promise.all([a, b]);
    expect(grants).toBe(2);
    expect(winner?.accessToken).toBe("ghu_first");
    expect(loser?.accessToken).toBe("ghu_first");
  });
});
