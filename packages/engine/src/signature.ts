/**
 * Failure signatures: one per failing test in a job's excerpt, stable across runs.
 *
 * A signature is a hash of what stays the same when the same failure happens again: the test's file
 * and title and its error line, with ports, timestamps, durations and ids removed. The line number
 * is left out, or every edit above a test would start a new issue. Pure: no I/O.
 */
import { createHash } from "node:crypto";

/** The job fields the no-error-line rule keys on. They are `JobRecord`'s own. */
export interface SignatureJob {
  repo: string;
  workflow: string;
  jobName: string;
}

export interface FailureSignature {
  /** The test file as printed, or null when the failure names no test. */
  file: string | null;
  /** The title as printed, describe path included, or null when the failure names no test. */
  title: string | null;
  /** The printed location for display, such as `e2e/upload.spec.ts:141`. Null with no test. */
  location: string | null;
  /** The error line as printed; empty when the failure had none. */
  errorLine: string;
  /** Stable across reruns, ports, paths, timestamps and line numbers. Compare it, never parse it. */
  signature: string;
}

/** This many tests in one job with one normalised error are one failure: the suite is down. */
const SUITE_DOWN = 5;

/** `  1) [chromium] › e2e/upload.spec.ts:141:1 › the title ───`: a numbered Playwright block. */
const PLAYWRIGHT_HEADER = /^\s*\d+\) (?:\[[^\]]*\] › )?(.+?):(\d+):\d+ › (.+?)[\s─]*$/;

/** `FAIL  test/dev.test.ts > describe > the title` in a Vitest run or its summary. */
const VITEST_HEADER = /^\s*FAIL\s+(\S+?)(?::(\d+)(?::\d+)?)?\s+>\s+(.+?)\s*$/;

/** `##[group]test/cache.test.ts:` or a bare `test/cache.test.ts:`: the file header of bun's output. */
const BUN_FILE = /^(?:##\[group\])?(\S.*?\.(?:test|spec)\.[cm]?[jt]sx?):\s*$/;

/** `✗ cache > re-pulls a stale copy [5305.18ms]`, or `(fail)` off a TTY. The duration is not the title. */
const BUN_FAILED = /^\s*(?:✗|\(fail\))\s+(.+?)(?:\s+\[[\d.]+\s?m?s\]|\s+\|\s+[\d.]+\s?m?s)?\s*$/;

/** A passing test in bun's output. It ends the error line a failed test would take. */
const BUN_PASSED = /^\s*✓/;

/** Bun's assertion error, lower case, printed above the failed line. Kept from `error:` on. */
const BUN_ERROR = /^\s*(error:\s*.+?)\s*$/;

/** The `N tests failed:` line that opens bun's summary, where each failed line repeats with no file. */
const BUN_SUMMARY = /^\s*\d+ tests? failed:/;

/** Bun's timeout note, printed with a caret under the failed line. */
const TIMED_OUT = /^\s*\^\s*(this test timed out after [\d.]+\s?ms\.?)/;

/** Where a test's block ends when no further header comes first. */
const BLOCK_END =
  /^…$|^\s*\d+ (?:failed|flaky|skipped|did not run|passed)\b|^\s*(?:Test Files|Tests)\s|^##\[(?:group|endgroup)\]/;

/** After whitespace and an optional `##[error]`: `Error:` or `<Name>Error:`. */
const ERROR_LINE = /^\s*(?:##\[error\])?\s*((?:[A-Za-z]\w*)?Error:.*)$/;

const GENERIC_EXIT = /^Process completed with exit code \d+\.?$/;

/**
 * One ordered list of replacements, applied to the error line only. The printed line is what a
 * human sees; this is what the signature is made of.
 */
const NORMALISE: Array<[RegExp, string]> = [
  [
    /(?:\/(?:home|Users)\/runner\/work\/[^/\s]+\/[^/\s]+\/|[A-Za-z]:\\a\\[^\\\s]+\\[^\\\s]+\\)/g,
    "",
  ],
  [/(?:\/tmp|\/var\/folders\/[^/\s]+\/[^/\s]+\/T)\/[^/\s]+/g, "<tmp>"],
  [/\b(https?:\/\/)[^\s/:?#]+(?::\d+)?/g, "$1<host>"],
  [/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, "<time>"],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>"],
  [/\b\d+(?:\.\d+)?\s?ms\b|\b\d+(?:\.\d+)?[smh]\b/g, "<dur>"],
  [/:\d+/g, ":<n>"],
  [/\b(?=[0-9a-f]*\d)[0-9a-f]{7,}\b/gi, "<hex>"],
  [/\b\d{4,}\b/g, "<n>"],
];

function normalise(text: string): string {
  let out = text;
  for (const [pattern, replacement] of NORMALISE) out = out.replace(pattern, replacement);
  return out.replace(/\s+/g, " ").trim();
}

function digest(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}

/** Keeps the three keys apart: a test, an error alone, and a job with neither. */
function testSignature(file: string, title: string, errorLine: string): string {
  return digest("test", normalise(file), title.replace(/\s+/g, " "), normalise(errorLine));
}

function errorSignature(errorLine: string): string {
  return digest("error", normalise(errorLine));
}

function jobSignature(job: SignatureJob): string {
  return digest("job", job.repo, job.workflow, job.jobName);
}

interface TestFailure {
  file: string;
  title: string;
  location: string;
  errorLine: string;
}

/** The file, line and title of a test header line, or null for any other line. */
function parseHeader(line: string): { file: string; lineNo: string; title: string } | null {
  const match = PLAYWRIGHT_HEADER.exec(line) ?? VITEST_HEADER.exec(line);
  if (!match) return null;
  const [, file = "", lineNo = "", title = ""] = match;
  return { file, lineNo, title };
}

function newFailure(header: { file: string; lineNo: string; title: string }): TestFailure {
  const { file, lineNo, title } = header;
  return { file, title, location: lineNo ? `${file}:${lineNo}` : file, errorLine: "" };
}

/**
 * The bun failed line's test. Under a file header it is keyed on that file. In bun's summary, with
 * no file, it joins the failure already found with the same title, or starts one with no file.
 */
function bunTest(
  found: Map<string, TestFailure>,
  file: string | undefined,
  title: string,
  error: string,
): TestFailure {
  const existing =
    file === undefined
      ? [...found.values()].find((test) => test.title === title)
      : found.get(`${file}\n${title}`);
  const test = existing ?? { file: file ?? "", title, location: file ?? "", errorLine: "" };
  if (!test.errorLine) test.errorLine = error;
  found.set(`${test.file}\n${test.title}`, test);
  return test;
}

/** Where the scan stands: the open test, and the bun file and pending error line it reads under. */
interface Cursor {
  found: Map<string, TestFailure>;
  current: TestFailure | undefined;
  bunFile: string | undefined;
  bunError: string;
}

/** Handles the bun lines. True when the line was one of them, so it is not read again. */
function readBunLine(cursor: Cursor, line: string): boolean {
  const bunHeader = BUN_FILE.exec(line);
  if (bunHeader) {
    cursor.bunFile = bunHeader[1];
    cursor.bunError = "";
    cursor.current = undefined;
    return true;
  }
  const bunFailed = BUN_FAILED.exec(line);
  if (bunFailed) {
    cursor.current = bunTest(cursor.found, cursor.bunFile, bunFailed[1] ?? "", cursor.bunError);
    cursor.bunError = "";
    return true;
  }
  if (BUN_PASSED.test(line)) {
    cursor.bunError = "";
    return true;
  }
  if (BUN_SUMMARY.test(line)) {
    cursor.bunFile = undefined;
    cursor.bunError = "";
    cursor.current = undefined;
    return true;
  }
  if (line.startsWith("##[endgroup]") || line === "…") cursor.bunFile = undefined;
  cursor.bunError = BUN_ERROR.exec(line)?.[1] ?? cursor.bunError;
  return false;
}

/** Fills the open test's error line from the first error or timed-out note that follows it. */
function readErrorLine(current: TestFailure | undefined, line: string): void {
  if (!current || current.errorLine) return;
  const text = ERROR_LINE.exec(line)?.[1] ?? TIMED_OUT.exec(line)?.[1];
  current.errorLine = text?.trim() ?? "";
}

/** Finds the failed tests: Playwright's numbered blocks, Vitest's `FAIL` lines and bun's failed lines, one per test. */
function findTests(lines: string[]): TestFailure[] {
  const cursor: Cursor = { found: new Map(), current: undefined, bunFile: undefined, bunError: "" };
  for (const line of lines) {
    const header = parseHeader(line);
    if (header) {
      const key = `${header.file}\n${header.title}`;
      cursor.current = cursor.found.get(key) ?? newFailure(header);
      cursor.found.set(key, cursor.current);
    } else if (readBunLine(cursor, line)) {
      continue;
    } else if (BLOCK_END.test(line)) {
      cursor.current = undefined;
    } else {
      readErrorLine(cursor.current, line);
    }
  }
  return [...cursor.found.values()];
}

/** The `Failed tasks:` header of Nx's summary, which lists the tasks that failed, one `- project:target` each. */
const NX_FAILED_HEADER = /^\s*Failed tasks:\s*$/;

const NX_FAILED_TASK = /^\s*-\s+(\S+:\S+)\s*$/;

/** The tasks Nx lists as failed, in order and once each. Blank lines are skipped; the list ends at any other line. */
function failedTasks(lines: string[]): string[] {
  const at = lines.findIndex((line) => NX_FAILED_HEADER.test(line));
  if (at === -1) return [];
  const tasks = new Set<string>();
  for (const line of lines.slice(at + 1)) {
    if (line.trim() === "") continue;
    const match = NX_FAILED_TASK.exec(line);
    if (!match) break;
    tasks.add(match[1] ?? "");
  }
  return [...tasks];
}

/** The first `##[error]` line that says something. */
function findErrorLine(lines: string[]): string {
  for (const line of lines) {
    const at = line.indexOf("##[error]");
    if (at === -1) continue;
    const text = line.slice(at + "##[error]".length).trim();
    if (text && !GENERIC_EXIT.test(text)) return text;
  }
  return "";
}

/** Counts the tests per normalised error line; a test with no error line counts toward none. */
function countErrors(tests: TestFailure[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const test of tests) {
    if (!test.errorLine) continue;
    const key = normalise(test.errorLine);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function errorEntry(errorLine: string): FailureSignature {
  return {
    file: null,
    title: null,
    location: null,
    errorLine,
    signature: errorSignature(errorLine),
  };
}

/**
 * One entry per failure in an excerpt. A failed test is keyed on its file, title and error line.
 * Five or more tests with one normalised error are one entry keyed on that error. A job that names
 * no test is keyed on its first real `##[error]` line, else on each task Nx lists as failed, else,
 * with neither, on its repo, workflow and job.
 */
export function signatures(excerpt: string, job: SignatureJob): FailureSignature[] {
  const lines = excerpt.split("\n");
  const tests = findTests(lines);

  if (tests.length === 0) {
    const errorLine = findErrorLine(lines);
    if (errorLine) return [errorEntry(errorLine)];
    const tasks = failedTasks(lines);
    if (tasks.length > 0) {
      return tasks.map((task) =>
        errorEntry(`nx task ${task} failed with no failed test in its output`),
      );
    }
    return [{ file: null, title: null, location: null, errorLine, signature: jobSignature(job) }];
  }

  const counts = countErrors(tests);
  const out: FailureSignature[] = [];
  const merged = new Set<string>();
  for (const test of tests) {
    const key = test.errorLine ? normalise(test.errorLine) : "";
    if (!key || (counts.get(key) ?? 0) < SUITE_DOWN) {
      out.push({ ...test, signature: testSignature(test.file, test.title, test.errorLine) });
    } else if (!merged.has(key)) {
      merged.add(key);
      out.push(errorEntry(test.errorLine));
    }
  }
  return out;
}
