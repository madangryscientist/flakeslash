import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobExcerpt, JobRecord } from "@hackcove/flakeslash-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openSqliteStore, type SqliteStore } from "../src/store.ts";

const REPO = "madangryscientist/pixelslash";
const OTHER = "madangryscientist/other";

function job(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    repo: REPO,
    workflow: "CI",
    jobName: "test",
    jobId: 1,
    url: "https://github.com/madangryscientist/pixelslash/actions/runs/10/job/1",
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
    ...overrides,
  };
}

const kept = (overrides: Partial<JobExcerpt> = {}): JobExcerpt => ({
  repo: REPO,
  jobId: 1,
  url: "https://github.com/madangryscientist/pixelslash/actions/runs/10/job/1",
  status: "kept",
  excerpt: "Error: expected 1 to be 2",
  ...overrides,
});

describe("the SQLite store", () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "flakeslash-store-"));
    store = openSqliteStore(join(dir, "flakeslash.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps one row when the same job is written twice", async () => {
    await store.writeJobs([job(), job({ jobId: 2 })]);
    await store.writeJobs([job(), job({ jobId: 2 })]);

    expect(await store.readJobs(REPO)).toHaveLength(2);
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

  it("keeps its rows when the file is closed and reopened", async () => {
    const path = join(dir, "flakeslash.db");
    const written = [
      job({
        jobId: 7,
        prNumber: null,
        runner: "self-hosted",
        runnerName: "",
        conclusion: "cancelled",
        steps: [
          { name: "Set up job", conclusion: "success" },
          { name: "Build", conclusion: null },
        ],
        annotations: [{ title: "Lost communication", message: "The runner stopped responding." }],
      }),
    ];
    await store.writeJobs(written);
    store.close();

    store = openSqliteStore(path);

    expect(await store.readJobs(REPO)).toEqual(written);
  });

  it("creates a missing parent directory", () => {
    const parent = join(dir, "nested", "deeper");
    expect(existsSync(parent)).toBe(false);

    const opened = openSqliteStore(join(parent, "flakeslash.db"));
    opened.close();

    expect(existsSync(parent)).toBe(true);
  });

  describe("excerpts", () => {
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
  });

  describe("issues and failures", () => {
    it("opens a store file from before these tables and adds them", async () => {
      const path = join(dir, "old.db");
      const old = new Database(path, { create: true });
      old.exec(
        "CREATE TABLE excerpts (repo TEXT NOT NULL, job_id INTEGER NOT NULL, url TEXT NOT NULL, status TEXT NOT NULL, excerpt TEXT, PRIMARY KEY (repo, job_id))",
      );
      old.exec("INSERT INTO excerpts VALUES ('r/x', 1, 'u', 'kept', 'e')");
      old.close();

      const opened = openSqliteStore(path);
      try {
        expect(await opened.readIssues()).toEqual([]);
        expect(await opened.readFailures()).toEqual([]);
        expect(await opened.excerptJobIds("r/x")).toEqual([1]);
      } finally {
        opened.close();
      }
    });
  });
});
