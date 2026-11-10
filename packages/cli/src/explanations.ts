import type { ExplainResult } from "@hackcove/flakeslash-engine";

/** What the model step did, for the report. */
export interface Explanations {
  /** Whether an endpoint was named. */
  named: boolean;
  /** Null when no endpoint was named, or the scan stopped before the model step. */
  result: ExplainResult | null;
  capUsd: number;
}

function money(usd: number): string {
  return `$${Number(usd.toFixed(6))}`;
}

export function summarizeExplanations(explanations: Explanations): string {
  if (!explanations.named) return "explanations: off (no model endpoint named)\n";
  const { result } = explanations;
  if (result === null) return "explanations: not run (the scan stopped early)\n";
  const left = result.notExplained;
  const lines = [
    `explanations: ${result.explained} explained, ${result.merged} merged, ${result.rejectedPatterns} patterns rejected`,
    `  not explained: ${left.cap} at the cap, ${left.stopped} after the endpoint stopped, ${left.noExcerpt} with no excerpt, ${left.failed} after a failed call`,
  ];
  if (result.failedCalls > 0) {
    lines.push(`  model calls failed: ${result.failedCalls} (first error: ${result.firstError})`);
  }
  lines.push(`  spent ${money(result.spentUsd)} of ${money(explanations.capUsd)}`);
  return `${lines.join("\n")}\n`;
}
