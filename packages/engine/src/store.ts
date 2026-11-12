/**
 * The store the scan logic talks to: job records kept between scans, so a second scan reads nothing it
 * already holds. The engine only sees this interface. The CLI implements it on a local SQLite file and
 * the server will implement it over D1, so nothing here may depend on a runtime's own modules.
 */
import type { Failure, Issue } from "./catalogue.ts";
import type { CompareResult, JobRecord } from "./providers/github-actions.ts";

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

/** One job sent to the model. A job with a row here is never sent again. */
export interface ModelCall {
  /** Lower case, as the jobs table holds it. */
  repo: string;
  jobId: number;
  /** The issue the excerpt was sent for. */
  issueId: string;
  /** `explained` stored an explanation; `invalid` got a reply that could not be used. */
  outcome: "explained" | "invalid";
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
  /** Stores the call. It replaces any row for that job. */
  writeModelCall(call: ModelCall): Promise<void>;
  /** Every job ever sent to the model. */
  readModelCalls(): Promise<ModelCall[]>;
  /** The compare stored for this pair of commits, or null when none is. */
  readCompare(repo: string, base: string, head: string): Promise<CompareResult | null>;
  /**
   * Stores an `ok` or `missing` compare; it replaces any row for the pair. A `rate-limited` one is never
   * stored, so the next scan asks again.
   */
  writeCompare(repo: string, base: string, head: string, result: CompareResult): Promise<void>;
  /**
   * In one transaction: stores `survivor`, points every failure (and model call) of `mergedIds` at
   * it, and deletes the merged issues. The caller has put their signatures on `survivor` already.
   */
  mergeIssues(survivor: Issue, mergedIds: string[]): Promise<void>;
}
