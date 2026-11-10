/**
 * The issue and failure tables of the local store, and the `Store` methods over them. Only the CLI
 * imports this file (through `store.ts`).
 */
import type { Database } from "bun:sqlite";
import {
  KINDS,
  type Failure,
  type Issue,
  type IssueSignature,
  type Store,
} from "@hackcove/flakeslash-engine";

export const CATALOGUE_SCHEMA = `
CREATE TABLE IF NOT EXISTS issues (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  signatures TEXT NOT NULL
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
`;

interface IssueRow {
  id: string;
  name: string;
  kind: string;
  status: string;
  signatures: string;
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
  if (row.status !== "potential" && row.status !== "confirmed") {
    throw new Error(`the store holds an unknown issue status: ${row.status}`);
  }
  const signatures: IssueSignature[] = JSON.parse(row.signatures);
  return { id: row.id, name: row.name, kind, status: row.status, signatures };
}

type CatalogueMethods = Pick<
  Store,
  "readIssues" | "writeIssue" | "writeFailures" | "failureJobIds" | "readFailures"
>;

export function catalogueStore(db: Database): CatalogueMethods {
  const writeIssueRow = db.prepare(
    "INSERT OR REPLACE INTO issues (id, name, kind, status, signatures) VALUES (?, ?, ?, ?, ?)",
  );
  const issuesQuery = db.query<IssueRow, []>(
    "SELECT id, name, kind, status, signatures FROM issues ORDER BY id",
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
    async readIssues(): Promise<Issue[]> {
      return issuesQuery.all().map(issueFromRow);
    },
    async writeIssue(issue: Issue): Promise<void> {
      writeIssueRow.run(
        issue.id,
        issue.name,
        issue.kind,
        issue.status,
        JSON.stringify(issue.signatures),
      );
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
