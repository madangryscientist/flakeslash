/**
 * Rows to engine types: how the store and the pages read a catalogue row, in one place, so both map
 * a row the same way. Each mapper throws on a value the engine does not know.
 */
import {
  KINDS,
  isRunner,
  type CompareResult,
  type Explanation,
  type Failure,
  type Issue,
  type IssueSignature,
  type JobExcerpt,
  type JobRecord,
  type ModelCall,
} from "@hackcove/flakeslash-engine";
import type { compares, failures, issues, jobs } from "./schema.ts";

export function statusOf(value: string): JobExcerpt["status"] {
  if (value !== "kept" && value !== "gone") {
    throw new Error(`the store holds an unknown excerpt status: ${value}`);
  }
  return value;
}

export function providerOf(value: string): JobRecord["provider"] {
  if (value !== "github-actions") throw new Error(`the store holds an unknown provider: ${value}`);
  return value;
}

export function outcomeOf(value: string): ModelCall["outcome"] {
  if (value !== "explained" && value !== "invalid") {
    throw new Error(`the store holds an unknown model call outcome: ${value}`);
  }
  return value;
}

export function jobFromRow(row: typeof jobs.$inferSelect): JobRecord {
  if (!isRunner(row.runner)) throw new Error(`the store holds an unknown runner: ${row.runner}`);
  return {
    repo: row.repo,
    workflow: row.workflow,
    jobName: row.jobName,
    jobId: row.jobId,
    url: row.url,
    commit: row.commitSha,
    branch: row.branch,
    prNumber: row.prNumber,
    provider: providerOf(row.provider),
    runner: row.runner,
    runnerName: row.runnerName,
    runId: row.runId,
    runAttempt: row.runAttempt,
    conclusion: row.conclusion,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    steps: JSON.parse(row.steps),
    annotations: JSON.parse(row.annotations),
  };
}

export function issueFromRow(row: typeof issues.$inferSelect): Issue {
  const kind = KINDS.find((known) => known === row.kind);
  if (kind === undefined) throw new Error(`the store holds an unknown issue kind: ${row.kind}`);
  if (row.status !== "potential" && row.status !== "confirmed" && row.status !== "dismissed") {
    throw new Error(`the store holds an unknown issue status: ${row.status}`);
  }
  const signatures: IssueSignature[] = JSON.parse(row.signatures);
  const explanation: Explanation | null =
    row.explanation === null ? null : JSON.parse(row.explanation);
  return {
    id: row.id,
    name: row.name,
    kind,
    status: row.status,
    signatures,
    explanation,
    edited: row.edited,
  };
}

export function failureFromRow(row: typeof failures.$inferSelect): Failure {
  return {
    repo: row.repo,
    jobId: row.jobId,
    url: row.url,
    signature: row.signature,
    issueId: row.issueId,
    file: row.file,
    title: row.title,
    location: row.location,
    errorLine: row.errorLine,
  };
}

function isNames(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((name) => typeof name === "string");
}

/** A NULL list is a commit GitHub no longer has. */
export function compareFromRow(row: Pick<typeof compares.$inferSelect, "files">): CompareResult {
  if (row.files === null) return { status: "missing" };
  const parsed: unknown = JSON.parse(row.files);
  if (!isNames(parsed)) throw new Error("the store holds a compare that is not a list of files");
  return { status: "ok", files: parsed };
}
