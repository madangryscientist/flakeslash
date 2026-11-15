import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import type { BatchDb } from "#/db/d1-store.ts";
import { organisations } from "#/db/schema.ts";
import { d1Db } from "#/db/test-d1.ts";
import { config, stubGithub } from "#/test/github-fetch.ts";
import { orgsFor } from "./access.ts";

/**
 * More installations than D1's 100 bound parameters per statement. In-memory SQLite allows far
 * more, so this runs on a local D1 (miniflare), which refuses such a statement as D1 does.
 */

const COUNT = 250;
const ids = Array.from({ length: COUNT }, (_, i) => i + 1);
const login = (id: number) => `org-${String(id).padStart(3, "0")}`;

let held: { db: BatchDb; dispose: () => Promise<void> };

beforeAll(async () => {
  held = await d1Db();
  for (let at = 0; at < COUNT; at += 20)
    await held.db.insert(organisations).values(
      ids.slice(at, at + 20).map((id) => ({
        id,
        login: login(id),
        type: "Organization" as const,
        createdAt: "2026-11-15T00:00:00Z",
      })),
    );
}, 60_000);

afterAll(() => held?.dispose());
afterEach(() => vi.unstubAllGlobals());

test(`orgsFor reads ${COUNT} installations on a local D1`, async () => {
  stubGithub({
    "GET /user/installations": () => ({
      body: { installations: ids.map((id) => ({ account: { id, login: login(id) } })) },
    }),
  });
  const viewer = {
    user: { id: 7, login: "ada", name: null, avatarUrl: null, createdAt: "", isSmoke: false },
    db: held.db,
    sessionId: "session",
    apiBase: config.apiBase,
    accessToken: "ghu_ada",
  };
  expect((await orgsFor(viewer)).map((org) => org.id)).toEqual(ids);
});
