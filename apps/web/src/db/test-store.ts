/** Fixtures for the `d1Store` tests: rows as the CLI store's tests write them, and two organisations. */
import type { Failure, Issue, JobExcerpt, JobRecord } from "@hackcove/flakeslash-engine";
import type { BatchDb } from "./d1-store.ts";
import { organisations } from "./schema.ts";
import { testDb } from "./test-db.ts";

export const ACME = 101;
export const GLOBEX = 202;
export const REPO = "madangryscientist/pixelslash";
export const OTHER = "madangryscientist/other";

export function job(overrides: Partial<JobRecord> = {}): JobRecord {
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

export const issue = (id: string): Issue => ({
  id,
  name: id,
  kind: "other",
  status: "potential",
  signatures: [{ type: "key", key: id }],
  explanation: null,
  edited: false,
});

export const kept = (overrides: Partial<JobExcerpt> = {}): JobExcerpt => ({
  repo: REPO,
  jobId: 1,
  url: "https://github.com/madangryscientist/pixelslash/actions/runs/10/job/1",
  status: "kept",
  excerpt: "Error: expected 1 to be 2",
  ...overrides,
});

export const failure = (jobId: number, issueId: string): Failure => ({
  repo: REPO,
  jobId,
  url: `u${jobId}`,
  signature: `s${jobId}`,
  issueId,
  file: null,
  title: null,
  location: null,
  errorLine: "",
});

/** A database with both organisations in it: foreign keys are on, so their rows come first. */
export async function withOrgs(db: BatchDb = testDb()): Promise<BatchDb> {
  await db.insert(organisations).values([
    { id: ACME, login: "acme", type: "Organization", createdAt: "2026-11-15T00:00:00Z" },
    { id: GLOBEX, login: "globex", type: "User", createdAt: "2026-11-15T00:00:00Z" },
  ]);
  return db;
}
