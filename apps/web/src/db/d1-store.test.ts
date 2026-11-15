import type { Store } from "@hackcove/flakeslash-engine";
import { beforeEach, describe, expect, it } from "vitest";
import { d1Store, type BatchDb } from "./d1-store.ts";
import { ACME, OTHER, REPO, job, kept, withOrgs } from "./test-store.ts";

let db: BatchDb;
let store: Store;

beforeEach(async () => {
  db = await withOrgs();
  store = d1Store(db, ACME);
});

const attempt = (runId: number, jobCount: number) => ({
  repo: REPO,
  runId,
  runAttempt: 1,
  conclusion: "success",
  createdAt: "2026-11-05T10:00:00Z",
  latestAttempt: 1,
  jobCount,
});

describe("the D1 store: jobs", () => {
  it("keeps one row when the same job is written twice", async () => {
    await store.writeJobs([job(), job({ jobId: 2 })]);
    await store.writeJobs([job(), job({ jobId: 2 })]);

    expect(await store.readJobs(REPO)).toHaveLength(2);
  });

  it("reads a job back as it was written", async () => {
    const written = job({
      jobId: 7,
      prNumber: 12,
      runner: "self-hosted",
      runnerName: "",
      conclusion: "cancelled",
      steps: [
        { name: "Set up job", conclusion: "success" },
        { name: "Build", conclusion: null },
      ],
      annotations: [{ title: "Lost communication", message: "The runner stopped responding." }],
    });
    await store.writeJobs([written]);

    expect(await store.readJobs(REPO)).toEqual([written]);
  });

  it("holds an attempt written with its jobs finished", async () => {
    await store.writeJobs([job({ runId: 10, runAttempt: 1 })]);

    expect(await store.heldAttempts(REPO)).toEqual([{ runId: 10, runAttempt: 1 }]);
  });

  it("holds attempt 1 of a run and not attempt 2 while attempt 2 is unfinished", async () => {
    await store.writeJobs([
      job({ runId: 10, runAttempt: 1 }),
      job({ runId: 10, runAttempt: 2, conclusion: null, completedAt: null }),
    ]);

    expect(await store.heldAttempts(REPO)).toEqual([{ runId: 10, runAttempt: 1 }]);
  });

  it("does not hold an attempt with a job whose conclusion is null, and holds it once written finished", async () => {
    await store.writeJobs([job({ conclusion: null, completedAt: null })]);
    expect(await store.heldAttempts(REPO)).toEqual([]);

    await store.writeJobs([job({ conclusion: "success" })]);
    expect(await store.heldAttempts(REPO)).toEqual([{ runId: 10, runAttempt: 1 }]);
    expect(await store.readJobs(REPO)).toHaveLength(1);
  });

  it("does not return another repo's rows", async () => {
    await store.writeJobs([job({ runId: 10 }), job({ repo: OTHER, runId: 20 })]);

    expect(await store.heldAttempts(REPO)).toEqual([{ runId: 10, runAttempt: 1 }]);
    expect(await store.readJobs(REPO)).toEqual([job({ runId: 10 })]);
    expect(await store.heldAttempts(OTHER)).toEqual([{ runId: 20, runAttempt: 1 }]);
  });
});

describe("the D1 store: attempts", () => {
  it("reads attempts back, replaces one written again, and holds an attempt read with no jobs", async () => {
    await store.writeAttempts([attempt(10, 1), attempt(20, 0)]);
    await store.writeAttempts([{ ...attempt(10, 1), conclusion: "failure" }]);

    expect(await store.readAttempts(REPO)).toEqual([
      { ...attempt(10, 1), conclusion: "failure" },
      attempt(20, 0),
    ]);
    // Run 10 lists a job the store does not hold yet, so only the empty run 20 is held.
    expect(await store.heldAttempts(REPO)).toEqual([{ runId: 20, runAttempt: 1 }]);

    await store.writeJobs([job({ runId: 10 })]);
    expect(await store.heldAttempts(REPO)).toEqual([
      { runId: 10, runAttempt: 1 },
      { runId: 20, runAttempt: 1 },
    ]);
    expect(await store.readJobs(REPO)).toHaveLength(1);
  });
});

describe("the D1 store: excerpts", () => {
  it("reads back what was written, a gone row with a null excerpt", async () => {
    await store.writeExcerpt(kept());
    await store.writeExcerpt(kept({ jobId: 2, status: "gone", excerpt: null }));

    expect(await store.readExcerpts(REPO)).toEqual([
      kept(),
      kept({ jobId: 2, status: "gone", excerpt: null }),
    ]);
    expect(await store.excerptJobIds(REPO)).toEqual([1, 2]);
  });

  it("replaces the row of a job written again", async () => {
    await store.writeExcerpt(kept({ status: "gone", excerpt: null }));
    await store.writeExcerpt(kept({ excerpt: "second" }));

    expect(await store.readExcerpts(REPO)).toEqual([kept({ excerpt: "second" })]);
  });

  it("keeps one repo's excerpts apart from another's", async () => {
    await store.writeExcerpt(kept());
    await store.writeExcerpt(kept({ repo: OTHER }));

    expect(await store.excerptJobIds(OTHER)).toEqual([1]);
    expect((await store.readExcerpts(OTHER)).map((row) => row.repo)).toEqual([OTHER]);
    expect(await store.excerptJobIds("madangryscientist/none")).toEqual([]);
  });

  it("lists each job with an excerpt once, in job order", async () => {
    await store.writeExcerpt(kept({ jobId: 3 }));
    await store.writeExcerpt(kept({ jobId: 1, status: "gone", excerpt: null }));
    await store.writeExcerpt(kept({ jobId: 3, excerpt: "again" }));

    expect(await store.excerptJobIds(REPO)).toEqual([1, 3]);
  });
});

describe("the D1 store: compares", () => {
  it("reads back an ok and a missing answer, and holds none for a pair never written", async () => {
    await store.writeCompare(REPO, "a", "b", { status: "ok", files: ["src/x.ts", "src/y.ts"] });
    await store.writeCompare(REPO, "a", "c", { status: "missing" });

    expect(await store.readCompare(REPO, "a", "b")).toEqual({
      status: "ok",
      files: ["src/x.ts", "src/y.ts"],
    });
    expect(await store.readCompare(REPO, "a", "c")).toEqual({ status: "missing" });
    expect(await store.readCompare(REPO, "b", "a")).toBeNull();
  });

  it("never stores a rate-limited answer", async () => {
    await store.writeCompare(REPO, "a", "b", { status: "rate-limited" });

    expect(await store.readCompare(REPO, "a", "b")).toBeNull();
  });
});
