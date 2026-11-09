/**
 * The FlakeSlash engine: flake detection. It reads a repo's GitHub Actions history, keeps it in a
 * `Store` and decides which jobs are flaky. The CLI, the web app and the site import from here.
 */
export const ENGINE_NAME = "flakeslash-engine";

export const ENGINE_VERSION = "0.0.0";

/** What the engine is, in one line, for `--version` and logs. */
export function describeEngine(): string {
  return `${ENGINE_NAME} ${ENGINE_VERSION}`;
}

export type { HeldAttempt, Store } from "./store.ts";

export {
  isRepoName,
  readGitHubActions,
  readJobLog,
  type FetchLike,
  type JobRecord,
  type LogResult,
  type ReadGitHubActionsOptions,
  type ReadGitHubActionsResult,
  type Runner,
} from "./providers/github-actions.ts";

export { findJobFlakes, type FlakeEvidence, type JobFlake } from "./flakes.ts";

export { GitHubApiError } from "./providers/github-api.ts";

export { scanRepo, type RepoScan, type ScanRepoOptions } from "./pipeline.ts";
