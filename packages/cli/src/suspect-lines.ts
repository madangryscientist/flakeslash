/**
 * The summary lines of the suspects: failures that look flaky with no proof. Nothing when there are none.
 */
import type { Suspect } from "@hackcove/flakeslash-engine";

export function suspectLines(suspects: readonly Suspect[]): string[] {
  if (suspects.length === 0) return [];
  const count = suspects.length;
  const lines = [`  ${count} ${count === 1 ? "suspect" : "suspects"} (likely flaky, no proof):`];
  for (const suspect of suspects) {
    const range = `${suspect.commit.slice(0, 8)}..${suspect.nextCommit.slice(0, 8)}`;
    lines.push(`  ${suspect.workflow} / ${suspect.jobName}  ${range}  ${suspect.files.join(", ")}`);
  }
  return lines;
}
