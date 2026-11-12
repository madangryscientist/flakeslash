/**
 * The compare table of the local store: GitHub's answer for a pair of commits, kept so a pair is asked
 * once. Only the CLI imports this file (through `store.ts`).
 */
import type { Database } from "bun:sqlite";
import type { CompareResult, Store } from "@hackcove/flakeslash-engine";

export const COMPARE_SCHEMA = `
CREATE TABLE IF NOT EXISTS compares (
  repo TEXT NOT NULL,
  base TEXT NOT NULL,
  head TEXT NOT NULL,
  files TEXT,
  PRIMARY KEY (repo, base, head)
);
`;

interface CompareRow {
  files: string | null;
}

function isNames(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((name) => typeof name === "string");
}

/** The compare methods of `Store` over the compares table. A NULL list is a commit GitHub no longer has. */
export function compareStore(db: Database): Pick<Store, "readCompare" | "writeCompare"> {
  const writeRow = db.prepare(
    "INSERT OR REPLACE INTO compares (repo, base, head, files) VALUES (?, ?, ?, ?)",
  );
  const readRow = db.query<CompareRow, [string, string, string]>(
    "SELECT files FROM compares WHERE repo = ? AND base = ? AND head = ?",
  );
  return {
    async readCompare(repo, base, head) {
      const row = readRow.get(repo, base, head);
      if (row === null) return null;
      if (row.files === null) return { status: "missing" };
      const parsed: unknown = JSON.parse(row.files);
      if (!isNames(parsed))
        throw new Error("the store holds a compare that is not a list of files");
      return { status: "ok", files: parsed };
    },
    async writeCompare(repo, base, head, result: CompareResult) {
      // A rate limit did not answer the question, so it is never stored.
      if (result.status === "rate-limited") return;
      const files = result.status === "ok" ? JSON.stringify(result.files) : null;
      writeRow.run(repo, base, head, files);
    },
  };
}
