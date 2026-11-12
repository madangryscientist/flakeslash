/**
 * The catalogue: failures grouped into issues. Each failed job gives one failure per signature entry,
 * and each failure joins the one issue it belongs to. Matching is plain text, with no model, and tries
 * the starter patterns first, then the patterns of existing issues, then the normalised key. Pure: no
 * I/O. The scan pipeline reads the issues from the `Store`, calls `place`, and writes what changed.
 */
import type { FailureSignature } from "./signature.ts";
import { matchStarter, type Kind } from "./starter-signatures.ts";

/** What an issue is matched by: a normalised failure key, or one or two strings that must all appear. */
export type IssueSignature =
  | { type: "key"; key: string }
  | { type: "pattern"; all: [string] | [string, string] };

/** What the model said about an issue, from one redacted excerpt of one job. */
export interface Explanation {
  /** The test, as file:line or full name, or the CI step or tool that broke. */
  component: string;
  kind: Kind;
  /** One or two sentences, or `not visible in the excerpt`. */
  cause: string;
  /** One line copied from the excerpt. Stored as given, not checked. */
  evidence: string;
  /** The excerpt that was sent: the job's repo (lower case) and id. */
  repo: string;
  jobId: number;
  /** The model name asked for. */
  model: string;
}

export interface Issue {
  /** `starter:<pattern name>` or `key:<entry signature>`. Deterministic, so a rescan cannot make a second one. */
  id: string;
  name: string;
  kind: Kind;
  /**
   * `confirmed` once one of its failures belongs to a proven flake, or a person said so. A scan never
   * moves it back. `dismissed` is a person's: it hides the issue, and a scan leaves it as it is.
   */
  status: "potential" | "confirmed" | "dismissed";
  signatures: IssueSignature[];
  /** Null until the model has explained the issue. */
  explanation: Explanation | null;
  /** True once a person has edited the issue (renamed it, say). The model never touches those. */
  edited: boolean;
}

/** One failure of one job: one signature entry of its excerpt (or of its job record, with no log). */
export interface Failure {
  /** Lower case, as the jobs table holds it. */
  repo: string;
  jobId: number;
  /** The job's page (`JobRecord.url`). Unique per job. */
  url: string;
  /** The entry's signature (`FailureSignature.signature`). */
  signature: string;
  issueId: string;
  file: string | null;
  title: string | null;
  location: string | null;
  errorLine: string;
}

/** The job fields `place` and `failureFrom` read. They are `JobRecord`'s own. */
interface FailedJob {
  repo: string;
  workflow: string;
  jobName: string;
  jobId: number;
  url: string;
  annotations: readonly { message: string }[];
}

const NAME_LENGTH = 120;

/**
 * The text an entry is matched against. An entry that names a test is matched on its own error line,
 * so a crash in one test does not pull the job's other failing tests into the issue. Any other entry
 * is matched on the whole excerpt (empty when the log is gone) and the job's annotation messages.
 */
export function matchText(entry: FailureSignature, excerpt: string, job: FailedJob): string {
  if (entry.file !== null) return entry.errorLine;
  return [excerpt, ...job.annotations.map((annotation) => annotation.message)].join("\n");
}

function nameOfKey(entry: FailureSignature, job: FailedJob): string {
  if (entry.file !== null) {
    const title = entry.title ?? "";
    return entry.location ? `${entry.location}: ${title}` : title;
  }
  if (entry.errorLine) return entry.errorLine.slice(0, NAME_LENGTH);
  return `${job.workflow}: ${job.jobName}`;
}

/** Issue order by id, in code points, so the first match is the same on every machine. */
function byCodePoint(a: Issue, b: Issue): number {
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

export function hasAll(all: readonly string[], text: string): boolean {
  return all.every((part) => text.includes(part));
}

/**
 * The issue an entry belongs to, made when none matches. `issues` is every issue the store holds by
 * id; a new one is added to it. `created` says whether this call made the issue.
 */
export function place(
  entry: FailureSignature,
  text: string,
  job: FailedJob,
  issues: Map<string, Issue>,
): { issue: Issue; created: boolean } {
  const starter = matchStarter(text);
  if (starter) {
    const id = `starter:${starter.name}`;
    const held = issues.get(id);
    if (held) return { issue: held, created: false };
    const issue: Issue = {
      id,
      name: starter.name,
      kind: starter.kind,
      status: "potential",
      signatures: [{ type: "pattern", all: starter.all }],
      explanation: null,
      edited: false,
    };
    issues.set(id, issue);
    return { issue, created: true };
  }

  const byId = [...issues.values()].toSorted(byCodePoint);
  const patterned = byId.find((issue) =>
    issue.signatures.some((sig) => sig.type === "pattern" && hasAll(sig.all, text)),
  );
  if (patterned) return { issue: patterned, created: false };

  const keyed = byId.find((issue) =>
    issue.signatures.some((sig) => sig.type === "key" && sig.key === entry.signature),
  );
  if (keyed) return { issue: keyed, created: false };

  const issue: Issue = {
    id: `key:${entry.signature}`,
    name: nameOfKey(entry, job),
    kind: "other",
    status: "potential",
    signatures: [{ type: "key", key: entry.signature }],
    explanation: null,
    edited: false,
  };
  issues.set(issue.id, issue);
  return { issue, created: true };
}

export function failureFrom(entry: FailureSignature, job: FailedJob, issueId: string): Failure {
  return {
    repo: job.repo,
    jobId: job.jobId,
    url: job.url,
    signature: entry.signature,
    issueId,
    file: entry.file,
    title: entry.title,
    location: entry.location,
    errorLine: entry.errorLine,
  };
}
