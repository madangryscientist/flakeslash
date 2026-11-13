/**
 * One attempt the reader finished reading, whether it listed jobs or none. A run GitHub finished with no
 * jobs (cancelled before a job was queued, or a `startup_failure`) leaves no `JobRecord`, so this is how
 * it is counted and held. An attempt a rate limit cut short is not reported.
 */
export interface ReadAttempt {
  repo: string;
  runId: number;
  runAttempt: number;
  /** The run's `conclusion` when it was read. Null for a run GitHub gave none. */
  conclusion: string | null;
  /** The run's `created_at`; a re-run keeps it. */
  createdAt: string;
  /** The run's latest attempt when this one was read. Higher than `runAttempt` for an earlier attempt. */
  latestAttempt: number;
  /** The jobs the attempt listed. 0 for an attempt with none, and for one whose listing answered 404. */
  jobCount: number;
}

/** A run as the listing gave it: when it was created and its latest attempt number. */
export interface ListedRun {
  createdAt: string;
  runAttempt: number;
}
