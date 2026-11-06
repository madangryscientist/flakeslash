/**
 * The FlakeSlash engine: where flake detection will live. It is a skeleton for now. It names the
 * package and its version and nothing else, so the CLI, the web app and the site have one place to
 * import from before there is anything to evaluate.
 */
export const ENGINE_NAME = "flakeslash-engine";

export const ENGINE_VERSION = "0.0.0";

/** What the engine is, in one line, for `--version` and logs. */
export function describeEngine(): string {
  return `${ENGINE_NAME} ${ENGINE_VERSION}`;
}

export type { HeldAttempt, Store } from "./store.ts";

export {
  readGitHubActions,
  type FetchLike,
  type JobRecord,
  type ReadGitHubActionsOptions,
  type ReadGitHubActionsResult,
  type Runner,
} from "./providers/github-actions.ts";

export { findJobFlakes, type FlakeEvidence, type JobFlake } from "./flakes.ts";
