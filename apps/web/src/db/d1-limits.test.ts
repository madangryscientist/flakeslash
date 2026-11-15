import type { Failure, JobRecord } from "@hackcove/flakeslash-engine";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { d1Store, type BatchDb } from "./d1-store.ts";
import { organisations } from "./schema.ts";
import { d1Db } from "./test-d1.ts";

/**
 * Writes bigger than D1's 100 bound parameters per statement. In-memory SQLite allows far more, so
 * this runs on a local D1 (miniflare), which refuses such a statement as D1 does.
 */

const COUNT = 250;
const ORG = 101;
const REPO = "acme/app";
const ids = Array.from({ length: COUNT }, (_, i) => i + 1);

const job = (jobId: number): JobRecord => ({
  repo: REPO,
  workflow: "CI",
  jobName: "test",
  jobId,
  url: `https://github.com/acme/app/actions/runs/10/job/${jobId}`,
  commit: "865de4094426ac13811eb7cb2db5d7ccef9ed274",
  branch: "main",
  prNumber: null,
  provider: "github-actions",
  runner: "github-hosted",
  runnerName: "GitHub Actions 2",
  runId: 10,
  runAttempt: 1,
  conclusion: "success",
  startedAt: "2026-11-05T10:00:00Z",
  completedAt: "2026-11-05T10:05:00Z",
  steps: [{ name: "Run tests", conclusion: "success" }],
  annotations: [],
});

const failure = (jobId: number): Failure => ({
  repo: REPO,
  jobId,
  url: `u${jobId}`,
  signature: "boom",
  issueId: "key:boom",
  file: null,
  title: null,
  location: null,
  errorLine: "Error: boom",
});

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
    await store.writeJobs(ids.map(job));

    expect(await store.readJobs(REPO)).toEqual(ids.map(job));
  });

  it("writes and reads back every failure", async () => {
    const store = d1Store(held.db, ORG);
    await store.writeFailures(ids.map(failure));

    expect(await store.readFailures()).toEqual(ids.map(failure));
  });
});
