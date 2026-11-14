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

export { type Explanation, type Failure, type Issue, type IssueSignature } from "./catalogue.ts";

export type { HeldAttempt, JobExcerpt, ModelCall, Store } from "./store.ts";

export {
  isRepoName,
  readGitHubActions,
  readCompare,
  readJobLog,
  type CompareResult,
  type FetchLike,
  type JobRecord,
  type LogResult,
  type ReadGitHubActionsOptions,
  type ReadGitHubActionsResult,
  type Runner,
} from "./providers/github-actions.ts";

export {
  findJobFlakes,
  nameFlakeTests,
  type Flake,
  type FlakeTest,
  type JobFlake,
  type TestFlake,
} from "./flakes.ts";

export { flakeRates, type FlakeRate } from "./rate.ts";

export { findSuspects, type Compare, type Suspect } from "./suspects.ts";

export { cleanLog, cutLog } from "./excerpt.ts";

export { redact } from "./redact.ts";

export {
  createModelClient,
  type ModelClient,
  type ModelClientOptions,
  type ModelFetch,
  type ModelMessage,
  type ModelResult,
} from "./model.ts";

export type { ReadAttempt } from "./providers/github-attempt.ts";

export { isRunner } from "./providers/github-runner.ts";

export { GitHubApiError } from "./providers/github-api.ts";

export { runCoverage, type RunCoverage } from "./coverage.ts";

export { scanRepo, type RepoScan } from "./pipeline.ts";

export { signatures, type FailureSignature, type SignatureJob } from "./signature.ts";

export {
  KINDS,
  STARTER_SIGNATURES,
  matchStarter,
  type Kind,
  type LiteralPattern,
} from "./starter-signatures.ts";

export {
  explainIssues,
  parseExplanation,
  type ExplainOptions,
  type ExplainResult,
  type ParseResult,
  type ParsedExplanation,
} from "./explain.ts";

export {
  IssueError,
  confirmIssue,
  dismissIssue,
  findIssue,
  listIssues,
  mergeIssues,
  renameIssue,
  splitIssue,
  type IssueStore,
  type IssueSummary,
} from "./issues.ts";

export { rankIssues, type RankedIssue, type RankInput } from "./catalogue-rank.ts";
