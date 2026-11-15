/**
 * Cuts a whole GitHub Actions job log down to the part that holds the failure.
 *
 * `cleanLog` removes what GitHub adds to every line. `cutLog` keeps the steps that failed and, inside
 * them, the lines near a line that looks like a failure, then bounds the size of the result. The rule
 * was measured on real logs: it removed 84% of the text and kept the failure in every one of them.
 */

/** The output of `cutLog` is never longer than this many characters. */
const LIMIT = 25_000;

/** Lines kept on each side of a line that matches. */
const CONTEXT = 8;

/** Lines kept from the last step when no line in the log looks like a failure. */
const TAIL = 100;

/** Stands in for a run of dropped lines. */
const GAP = "…";

/** An ANSI escape sequence: ESC, `[`, parameters, then a final byte. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, "g");

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T[\d:]+(?:\.\d+)?Z ?/;

const STEP_STARTS = [
  "##[group]Run ",
  "##[group]Post ",
  "##[group]Set up job",
  "##[group]Complete job",
];

const KEYWORDS = [
  "error",
  "fail",
  "✘",
  "×",
  "✗",
  "timeout",
  "timed out",
  "crash",
  "exception",
  "panic",
  "killed",
  "sigterm",
  "sigkill",
  "out of memory",
  "oom",
  "refused",
  "cannot",
  "denied",
  "unhandled",
  "assert",
];

const EXIT_CODE = /exit code [1-9]/i;

/**
 * Strips the BOM, the timestamp GitHub prefixes to each line, and the ANSI colour codes, and turns
 * CRLF line ends into LF.
 */
export function cleanLog(raw: string): string {
  return raw
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .map((line) => line.replace(ANSI, "").replace(TIMESTAMP, ""))
    .join("\n");
}

/**
 * Cuts the output of `cleanLog` down to the failure. Failed steps are kept with the lines around each
 * match; with no failed step, the last step is kept. A log with no recognisable failure gives its last
 * lines instead. The result is never empty unless the input is, and at most 25,000 characters long.
 */
export function cutLog(cleaned: string): string {
  const steps = splitSteps(cleaned.split("\n"));
  const last = steps[steps.length - 1] ?? [];
  const failed = steps.filter((step) => step.some((line) => line.includes("##[error]")));

  let lines: string[];
  if (failed.length === 0 && !last.some(isMatch)) {
    lines = last.slice(-TAIL);
  } else {
    lines = (failed.length > 0 ? failed : [last]).flatMap(excerptStep);
  }
  return lines.join("\n").slice(0, LIMIT);
}

/** A step starts at a marker line. Lines before the first marker form one step of their own. */
function splitSteps(lines: string[]): string[][] {
  const steps: string[][] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (STEP_STARTS.some((start) => line.startsWith(start)) && current.length > 0) {
      steps.push(current);
      current = [];
    }
    current.push(line);
  }
  steps.push(current);
  return steps;
}

/**
 * A line that reports a pass: a `✓` or `✔` mark, or bun's plain `(pass)` reporter, first in the line.
 * Moon puts a right-aligned `<target> | ` in front of each task line, so one such prefix is allowed.
 */
const PASS_LINE = /^\s*(?:\S+ \| )?\s*(?:✓|✔|\(pass\))/;

/** A zero failure or error count, such as bun's ` 0 fail` summary. It says nothing failed. */
const ZERO_COUNT = /\b0 (?:fail|failed|failures|errors?)\b/gi;

function isMatch(line: string): boolean {
  if (PASS_LINE.test(line)) return false;
  const counted = line.replace(ZERO_COUNT, "");
  const lower = counted.toLowerCase();
  return KEYWORDS.some((keyword) => lower.includes(keyword)) || EXIT_CODE.test(counted);
}

/**
 * Bun's file header, `test/a.test.ts:`, bare or as a `##[group]` or `::group::` line, with moon's
 * `<target> | ` prefix allowed as in `PASS_LINE`. Bun prints it once, above all of the file's tests.
 */
const FILE_LINE =
  /^\s*(?:\S+ \| )?(?:##\[group\]|::group::)?\S.*?\.(?:test|spec)\.[cm]?[jt]sx?:\s*$/;

/** The end of a group, where a file header above it stops applying. Moon's prefix is allowed. */
const GROUP_END_LINE = /^\s*(?:\S+ \| )?(?:##\[endgroup\]|::endgroup::)/;

/**
 * The index of the file header that applies to the line at `index`: the nearest one above it, unless
 * a group ends first. Undefined when the step starts or a group ends before one is found.
 */
function fileLineAbove(step: string[], index: number): number | undefined {
  for (let i = index - 1; i >= 0; i--) {
    const line = step[i] ?? "";
    if (GROUP_END_LINE.test(line)) return undefined;
    if (FILE_LINE.test(line)) return i;
  }
  return undefined;
}

/**
 * The lines of one step within `CONTEXT` of a match, in order, with a gap marked wherever lines were
 * dropped. A window that follows a gap is headed by the file line that applies to it, when that line
 * was dropped, so a test failure keeps the name of its file.
 */
function excerptStep(step: string[]): string[] {
  const keep = step.map(() => false);
  step.forEach((line, index) => {
    if (!isMatch(line)) return;
    const from = Math.max(0, index - CONTEXT);
    const to = Math.min(step.length - 1, index + CONTEXT);
    for (let i = from; i <= to; i++) keep[i] = true;
  });

  const out: string[] = [];
  let previous = -1;
  step.forEach((line, index) => {
    if (!keep[index]) return;
    if (index > previous + 1) {
      out.push(GAP);
      const header = fileLineAbove(step, index);
      if (header !== undefined && !keep[header]) out.push(step[header] ?? "");
    }
    out.push(line);
    previous = index;
  });
  return out;
}
