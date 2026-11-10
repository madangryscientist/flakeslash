/**
 * The issue and failure tables of the local store, and the `Store` methods over them. Only the CLI
 * imports this file (through `store.ts`).
 */
import type { Database } from "bun:sqlite";
import {
  KINDS,
  type Explanation,
  type Failure,
  type Issue,
  type IssueSignature,
  type ModelCall,
  type Store,
} from "@hackcove/flakeslash-engine";

export const CATALOGUE_SCHEMA = `
CREATE TABLE IF NOT EXISTS issues (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  signatures TEXT NOT NULL,
  explanation TEXT,
  edited INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS failures (
  repo TEXT NOT NULL,
  job_id INTEGER NOT NULL,
  url TEXT NOT NULL,
  signature TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  file TEXT,
  title TEXT,
  location TEXT,
  error_line TEXT NOT NULL,
  PRIMARY KEY (repo, job_id, signature)
);
CREATE INDEX IF NOT EXISTS failures_by_issue ON failures (issue_id);
CREATE TABLE IF NOT EXISTS model_calls (
  repo TEXT NOT NULL,
  job_id INTEGER NOT NULL,
  issue_id TEXT NOT NULL,
  outcome TEXT NOT NULL,
  PRIMARY KEY (repo, job_id)
);
`;

/** Columns added to `issues` after the first release of its table, for stores made before them. */
const ISSUE_COLUMNS: readonly [string, string][] = [
  ["explanation", "TEXT"],
  ["edited", "INTEGER NOT NULL DEFAULT 0"],
];

/** Opens a store made by an earlier version: adds the `issues` columns it lacks. Additive only. */
export function migrateCatalogue(db: Database): void {
  const held = new Set(
    db
      .query<{ name: string }, []>("PRAGMA table_info(issues)")
      .all()
      .map((column) => column.name),
  );
  for (const [name, definition] of ISSUE_COLUMNS) {
    if (!held.has(name)) db.exec(`ALTER TABLE issues ADD COLUMN ${name} ${definition}`);
  }
}

interface IssueRow {
  id: string;
  name: string;
  kind: string;
  status: string;
  signatures: string;
  explanation: string | null;
  edited: number;
}

interface FailureRow {
  repo: string;
  job_id: number;
  url: string;
  signature: string;
  issue_id: string;
  file: string | null;
  title: string | null;
  location: string | null;
  error_line: string;
}

function issueFromRow(row: IssueRow): Issue {
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
    edited: row.edited === 1,
  };
}

type CatalogueMethods = Pick<
  Store,
  | "readIssues"
  | "writeIssue"
  | "writeFailures"
  | "failureJobIds"
  | "readFailures"
  | "writeModelCall"
  | "readModelCalls"
  | "mergeIssues"
>;

function outcomeOf(value: string): ModelCall["outcome"] {
  if (value !== "explained" && value !== "invalid") {
    throw new Error(`the store holds an unknown model call outcome: ${value}`);
  }
  return value;
}

const WRITE_ISSUE = `INSERT OR REPLACE INTO issues (id, name, kind, status, signatures, explanation, edited)
     VALUES (?, ?, ?, ?, ?, ?, ?)`;

/** The values of one issue's row, in column order. */
function issueValues(issue: Issue): (string | number | null)[] {
  return [
    issue.id,
    issue.name,
    issue.kind,
    issue.status,
    JSON.stringify(issue.signatures),
    issue.explanation === null ? null : JSON.stringify(issue.explanation),
    issue.edited ? 1 : 0,
  ];
}

/** Model calls and the merge of issues, which moves model calls along with failures. */
function modelCallMethods(
  db: Database,
): Pick<CatalogueMethods, "writeModelCall" | "readModelCalls" | "mergeIssues"> {
  const writeIssueRow = db.prepare(WRITE_ISSUE);
  const writeCallRow = db.prepare(
    "INSERT OR REPLACE INTO model_calls (repo, job_id, issue_id, outcome) VALUES (?, ?, ?, ?)",
  );
  const callsQuery = db.query<
    { repo: string; job_id: number; issue_id: string; outcome: string },
    []
  >("SELECT repo, job_id, issue_id, outcome FROM model_calls ORDER BY repo, job_id");
  const moveFailures = db.prepare("UPDATE failures SET issue_id = ? WHERE issue_id = ?");
  const moveCalls = db.prepare("UPDATE model_calls SET issue_id = ? WHERE issue_id = ?");
  const deleteIssue = db.prepare("DELETE FROM issues WHERE id = ?");
  const mergeAll = db.transaction((survivor: Issue, mergedIds: string[]) => {
    writeIssueRow.run(...issueValues(survivor));
    for (const id of mergedIds) {
      moveFailures.run(survivor.id, id);
      moveCalls.run(survivor.id, id);
      deleteIssue.run(id);
    }
  });

  return {
    async writeModelCall(call: ModelCall): Promise<void> {
      writeCallRow.run(call.repo, call.jobId, call.issueId, call.outcome);
    },
    async readModelCalls(): Promise<ModelCall[]> {
      return callsQuery.all().map((row) => ({
        repo: row.repo,
        jobId: row.job_id,
        issueId: row.issue_id,
        outcome: outcomeOf(row.outcome),
      }));
    },
    async mergeIssues(survivor: Issue, mergedIds: string[]): Promise<void> {
      mergeAll(survivor, mergedIds);
    },
  };
}

export function catalogueStore(db: Database): CatalogueMethods {
  const writeIssueRow = db.prepare(WRITE_ISSUE);
  const issuesQuery = db.query<IssueRow, []>(
    "SELECT id, name, kind, status, signatures, explanation, edited FROM issues ORDER BY id",
  );
  const writeFailureRow = db.prepare(
    `INSERT OR REPLACE INTO failures
       (repo, job_id, url, signature, issue_id, file, title, location, error_line)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const writeFailuresAll = db.transaction((failures: Failure[]) => {
    for (const f of failures) {
      writeFailureRow.run(
        f.repo,
        f.jobId,
        f.url,
        f.signature,
        f.issueId,
        f.file,
        f.title,
        f.location,
        f.errorLine,
      );
    }
  });
  const failureIdsQuery = db.query<{ job_id: number }, [string]>(
    "SELECT DISTINCT job_id FROM failures WHERE repo = ? ORDER BY job_id",
  );
  const failuresQuery = db.query<FailureRow, []>(
    `SELECT repo, job_id, url, signature, issue_id, file, title, location, error_line
     FROM failures ORDER BY repo, job_id, signature`,
  );

  return {
    ...modelCallMethods(db),
    async readIssues(): Promise<Issue[]> {
      return issuesQuery.all().map(issueFromRow);
    },
    async writeIssue(issue: Issue): Promise<void> {
      writeIssueRow.run(...issueValues(issue));
    },
    async writeFailures(failures: Failure[]): Promise<void> {
      writeFailuresAll(failures);
    },
    async failureJobIds(repo: string): Promise<number[]> {
      return failureIdsQuery.all(repo).map((row) => row.job_id);
    },
    async readFailures(): Promise<Failure[]> {
      return failuresQuery.all().map((row) => ({
        repo: row.repo,
        jobId: row.job_id,
        url: row.url,
        signature: row.signature,
        issueId: row.issue_id,
        file: row.file,
        title: row.title,
        location: row.location,
        errorLine: row.error_line,
      }));
    },
  };
}
