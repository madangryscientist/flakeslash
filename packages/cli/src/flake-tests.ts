/**
 * The test names a flake prints. A test is one line: its name, where it is, and where the name came from.
 * `nameScans` gives each scan's flakes their names again after the model has run, so an explanation
 * made in this run shows in this run's output.
 */
import {
  nameFlakeTests,
  type FlakeTest,
  type RepoScan,
  type Store,
} from "@hackcove/flakeslash-engine";

/** A test as one line: its name, then where it is (at its location, else in its file), then its source. */
export function testText(test: FlakeTest): string {
  let where = "";
  if (test.location !== null) where = ` at ${test.location}`;
  else if (test.file !== null) where = ` in ${test.file}`;
  return `${test.name}${where} (${test.source})`;
}

/** Names the tests of each scan's flakes from the failures and issues the store holds now. */
export async function nameScans(store: Store, scans: RepoScan[]): Promise<void> {
  const failures = await store.readFailures();
  const issues = await store.readIssues();
  for (const scan of scans) scan.flakes = nameFlakeTests(scan.flakes, failures, issues);
}
