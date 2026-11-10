/**
 * The kinds of failure a job can have, and the starter patterns that name the crashes we already know.
 * A pattern is literal text, not a regex: a match is every one of its strings appearing in the text,
 * as a plain case-sensitive substring. The model answers from the same `KINDS` list.
 */

export const KINDS = [
  "test",
  "timeout",
  "browser-crash",
  "runner-died",
  "oom",
  "lint",
  "typecheck",
  "build",
  "infra",
  "other",
] as const;

export type Kind = (typeof KINDS)[number];

export interface LiteralPattern {
  /** A short human label, such as `Chromium page crashed`. */
  name: string;
  kind: Kind;
  /** Every string must appear in the text for the pattern to match. */
  all: [string] | [string, string];
}

export const STARTER_SIGNATURES: readonly LiteralPattern[] = [
  { name: "Page crashed", kind: "browser-crash", all: ["Page crashed"] },
  { name: "Chromium target crashed", kind: "browser-crash", all: ["Target crashed"] },
  {
    name: "Browser died at launch",
    kind: "browser-crash",
    all: ["browserType.launch:", "has been closed"],
  },
  { name: "Node heap out of memory", kind: "oom", all: ["JavaScript heap out of memory"] },
  { name: "Kernel OOM killer", kind: "oom", all: ["Out of memory: Killed process"] },
  {
    name: "Runner shutdown signal",
    kind: "runner-died",
    all: ["The runner has received a shutdown signal"],
  },
  {
    name: "Runner lost communication",
    kind: "runner-died",
    all: ["lost communication with the server"],
  },
];

/**
 * The first starter pattern whose every string appears in `text`, or null. Case and whitespace are
 * matched exactly as given.
 */
export function matchStarter(text: string): LiteralPattern | null {
  return (
    STARTER_SIGNATURES.find((pattern) => pattern.all.every((part) => text.includes(part))) ?? null
  );
}
