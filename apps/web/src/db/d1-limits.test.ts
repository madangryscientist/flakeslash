import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { d1Store, type BatchDb } from "./d1-store.ts";
import { organisations } from "./schema.ts";
import { d1Db } from "./test-d1.ts";
import { REPO, failure, job } from "./test-store.ts";

/**
 * Writes bigger than D1's 100 bound parameters per statement. In-memory SQLite allows far more, so
 * this runs on a local D1 (miniflare), which refuses such a statement as D1 does.
 */

const COUNT = 250;
const ORG = 101;
const ids = Array.from({ length: COUNT }, (_, i) => i + 1);

let held: { db: BatchDb; dispose: () => Promise<void> };

beforeAll(async () => {
  held = await d1Db();
  await held.db
    .insert(organisations)
    .values({ id: ORG, login: "acme", type: "Organization", createdAt: "2026-11-15T00:00:00Z" });
}, 60_000);

afterAll(() => held?.dispose());

describe(`writes of ${COUNT} rows on a local D1`, () => {
  it("writes and reads back every job", async () => {
    const store = d1Store(held.db, ORG);
    await store.writeJobs(ids.map((jobId) => job({ jobId })));

    expect(await store.readJobs(REPO)).toEqual(ids.map((jobId) => job({ jobId })));
  });

  it("writes and reads back every failure", async () => {
    const store = d1Store(held.db, ORG);
    await store.writeFailures(ids.map((jobId) => failure(jobId, "key:boom")));

    expect(await store.readFailures()).toEqual(ids.map((jobId) => failure(jobId, "key:boom")));
  });
});
