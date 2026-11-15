import { scanRepo, type Store } from "@hackcove/flakeslash-engine";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  fakeGitHub,
  job as apiJob,
  jobsOf,
  jobsPath,
  json,
  pullsPath,
  run,
  runsOf,
  runsPath,
  shaOf,
  since,
} from "../../../../packages/engine/test/github-fake.ts";
import { d1Store, type BatchDb } from "./d1-store.ts";
import type { Db } from "./db.ts";
import { failures as failureRows, jobs as jobRows } from "./schema.ts";
import { flakyRoutesOf, playwrightLog, text } from "./test-github.ts";
import { ACME, GLOBEX, REPO, failure, issue, job, kept, withOrgs } from "./test-store.ts";

let db: BatchDb;
let store: Store;

beforeEach(async () => {
  db = await withOrgs();
  store = d1Store(db, ACME);
});

describe("the D1 store: organisations", () => {
  it("keeps two organisations on one database apart", async () => {
    const globex = d1Store(db, GLOBEX);
    await store.writeJobs([job()]);
    await store.writeIssue(issue("key:a"));
    await store.writeFailures([failure(1, "key:a")]);
    await store.writeExcerpt(kept());
    await store.writeModelCall({ repo: REPO, jobId: 1, issueId: "key:a", outcome: "explained" });
    await store.writeCompare(REPO, "a", "b", { status: "missing" });
    await globex.writeIssue({ ...issue("key:a"), name: "globex's" });

    expect(await globex.readJobs(REPO)).toEqual([]);
    expect(await globex.heldAttempts(REPO)).toEqual([]);
    expect(await globex.readFailures()).toEqual([]);
    expect(await globex.failureJobIds(REPO)).toEqual([]);
    expect(await globex.readExcerpts(REPO)).toEqual([]);
    expect(await globex.excerptJobIds(REPO)).toEqual([]);
    expect(await globex.readModelCalls()).toEqual([]);
    expect(await globex.readCompare(REPO, "a", "b")).toBeNull();
    expect((await globex.readIssues()).map((held) => held.name)).toEqual(["globex's"]);
    expect((await store.readIssues()).map((held) => held.name)).toEqual(["key:a"]);

    // A merge in one organisation moves nothing of the other's.
    await globex.writeIssue(issue("key:b"));
    await globex.mergeIssues(issue("key:b"), ["key:a"]);
    expect((await store.readIssues()).map((held) => held.id)).toEqual(["key:a"]);
    expect((await store.readFailures()).map((held) => held.issueId)).toEqual(["key:a"]);
  });

  it("marks a smoke organisation's rows as smoke, and reads them back", async () => {
    const smoke = d1Store(db, GLOBEX, { smoke: true });
    await smoke.writeJobs([job()]);
    await smoke.writeFailures([failure(1, "key:a")]);
    await store.writeJobs([job()]);

    expect(await smoke.readJobs(REPO)).toEqual([job()]);
    expect(await smoke.readFailures()).toEqual([failure(1, "key:a")]);
    const read: Db = db;
    const flags = await read
      .select({ orgId: jobRows.orgId, isSmoke: jobRows.isSmoke })
      .from(jobRows)
      .orderBy(jobRows.orgId);
    expect(flags).toEqual([
      { orgId: ACME, isSmoke: false },
      { orgId: GLOBEX, isSmoke: true },
    ]);
    expect(
      await read
        .select({ isSmoke: failureRows.isSmoke })
        .from(failureRows)
        .where(eq(failureRows.orgId, GLOBEX)),
    ).toEqual([{ isSmoke: true }]);
  });
});

describe("the D1 store under scanRepo", () => {
  it("fills the store with a flake, and a second scan writes nothing new", async () => {
    const gh = fakeGitHub(
      flakyRoutesOf(
        [[REPO, 1, text(playwrightLog(["uploads a file", "Error: expected 1 to be 2"]))]],
        [[REPO, 1]],
      ),
    );

    const first = await scanRepo({ repo: REPO, since, fetch: gh.fetch, store });
    expect(first.flakes).toHaveLength(1);
    expect(first.flakes[0]).toMatchObject({ repo: REPO, jobName: "Gate" });
    expect(await store.readJobs(REPO)).toHaveLength(2);
    expect(await store.readExcerpts(REPO)).toHaveLength(1);
    const failures = await store.readFailures();
    expect(failures).toHaveLength(1);
    expect((await store.readIssues()).map((held) => held.status)).toEqual(["confirmed"]);

    const second = await scanRepo({ repo: REPO, since, fetch: gh.fetch, store });
    expect(second.newJobs).toBe(0);
    expect(second.newFailures).toBe(0);
    expect(second.logsKept).toBe(0);
    expect(second.flakes).toEqual(first.flakes);
    expect(await store.readJobs(REPO)).toHaveLength(2);
    expect(await store.readExcerpts(REPO)).toHaveLength(1);
    expect(await store.readFailures()).toEqual(failures);
  });
});

/** One repo with one passing run, its one job finished. */
const passingRun = () =>
  fakeGitHub({
    [runsPath()]: runsOf(run(1, "2026-11-04T00:00:00Z")),
    [pullsPath(shaOf(1))]: json([]),
    [jobsPath(1, 1)]: jobsOf(apiJob(10, 1)),
  });
const jobsRequests = (paths: string[]) => paths.filter((path) => path.includes("/jobs?"));

describe("the D1 store: a run's jobs written without its attempts row", () => {
  it("fetches that attempt again on the next scan and leaves its jobs and its attempts row", async () => {
    // A write stopped between the two leaves the jobs alone.
    await store.writeJobs([job({ jobId: 10, runId: 1, jobName: "Gate", commit: shaOf(1) })]);
    expect(await store.heldAttempts(REPO)).toEqual([]);

    const gh = passingRun();
    await scanRepo({ repo: REPO, since, fetch: gh.fetch, store });
    expect(jobsRequests(gh.paths)).toEqual([jobsPath(1, 1)]);
    expect(await store.readJobs(REPO)).toEqual([expect.objectContaining({ jobId: 10, runId: 1 })]);
    expect(await store.readAttempts(REPO)).toEqual([
      expect.objectContaining({ runId: 1, runAttempt: 1, jobCount: 1 }),
    ]);
    expect(await store.heldAttempts(REPO)).toEqual([{ runId: 1, runAttempt: 1 }]);
  });

  it("does not fetch again a finished run whose attempts row is written", async () => {
    const gh = passingRun();
    await scanRepo({ repo: REPO, since, fetch: gh.fetch, store });
    expect(await store.readAttempts(REPO)).toHaveLength(1);

    gh.paths.length = 0;
    await scanRepo({ repo: REPO, since, fetch: gh.fetch, store });
    expect(gh.paths).toEqual([runsPath()]);
  });
});
