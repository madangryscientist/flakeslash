import type { RunCoverage } from "@hackcove/flakeslash-engine";

const count = (n: number): string => n.toLocaleString("en-US");

/**
 * The runs of a repo's window in one line, for the summary and the report:
 * `runs in the window: 5 read, 2 listed no jobs (2 cancelled), 1 still running`.
 */
export function coverageLine(coverage: RunCoverage): string {
  const by = Object.entries(coverage.noJobsByConclusion)
    .map(([conclusion, n]) => `${count(n)} ${conclusion}`)
    .join(", ");
  const none = `${count(coverage.noJobs)} listed no jobs${by === "" ? "" : ` (${by})`}`;
  return `runs in the window: ${count(coverage.read)} read, ${none}, ${count(coverage.stillRunning)} still running`;
}
