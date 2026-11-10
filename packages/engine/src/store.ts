/**
 * The store the scan logic talks to: job records kept between scans, so a second scan reads nothing it
 * already holds. The engine only sees this interface. The CLI implements it on a local SQLite file and
 * the server will implement it over D1, so nothing here may depend on a runtime's own modules.
 */
import type { Failure, Issue } from "./catalogue.ts";
import type { JobRecord } from "./providers/github-actions.ts";

/** One attempt of one run that the store holds with every job finished (no job has a null conclusion). */
export interface HeldAttempt {
  runId: number;
  runAttempt: number;
}

/** What the store keeps of one failed job's log: the excerpt and the link to the full log, never the log. */
export interface JobExcerpt {
  /** Lower case, as the jobs table holds it. */
  repo: string;
  /** GitHub job ids are unique across attempts. */
  jobId: number;
  /** The job's page (`JobRecord.url`): the link to the full log. */
  url: string;
  /** `gone` is a log the provider no longer serves. */
  status: "kept" | "gone";
  /** The redacted excerpt when kept, null when gone. */
  excerpt: string | null;
}

export interface Store {
  /** Stores the records. A record whose job is already held replaces that job's row. */
  writeJobs(records: JobRecord[]): Promise<void>;
  /**
   * The attempts of `repo` the store holds in full, as far as its rows show. An attempt with any
   * unfinished job is not held.
   */
  heldAttempts(repo: string): Promise<HeldAttempt[]>;
  /** Every job the store holds for `repo`, as written. */
  readJobs(repo: string): Promise<JobRecord[]>;
  /** Stores the excerpt. It replaces any row for that job. */
  writeExcerpt(excerpt: JobExcerpt): Promise<void>;
  /** The id of every job of `repo` with an excerpt row, kept or gone. */
  excerptJobIds(repo: string): Promise<number[]>;
  /** Every excerpt row of `repo`. */
  readExcerpts(repo: string): Promise<JobExcerpt[]>;
  /** Every issue, across repos. Issues are not per repo. */
  readIssues(): Promise<Issue[]>;
  /** Stores the issue. It replaces the row with that id. */
  writeIssue(issue: Issue): Promise<void>;
  /** Stores the failures. A failure with the same repo, job and signature replaces its row. */
  writeFailures(failures: Failure[]): Promise<void>;
  /** The id of every job of `repo` that has at least one failure. */
  failureJobIds(repo: string): Promise<number[]>;
  /** Every failure, across repos. */
  readFailures(): Promise<Failure[]>;
}
