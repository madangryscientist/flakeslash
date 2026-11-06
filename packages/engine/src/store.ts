/**
 * The store the scan logic talks to: job records kept between scans, so a second scan reads nothing it
 * already holds. The engine only sees this interface. The CLI implements it on a local SQLite file and
 * the server will implement it over D1, so nothing here may depend on a runtime's own modules.
 */
import type { JobRecord } from "./providers/github-actions.ts";

/** One attempt of one run that the store holds with every job finished (no job has a null conclusion). */
export interface HeldAttempt {
  runId: number;
  runAttempt: number;
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
}
