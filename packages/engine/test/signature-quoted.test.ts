import { describe, expect, it } from "vitest";
import { signatures } from "../src/index.ts";

const JOB = { repo: "madangryscientist/pixelslash", workflow: "ci", jobName: "e2e" };

function only(excerpt: string) {
  const found = signatures(excerpt, JOB);
  expect(found).toHaveLength(1);
  return found[0]!;
}

/** One Vitest failure: its `FAIL` header, then its assertion. */
function vitest(title: string, error: string): string {
  return `FAIL  src/db/limits.test.ts > ${title}\n\n${error}\n`;
}

/** The same assertion with its values in the given quote marks. */
function asserted(open: string, close: string, value: string): string {
  return `AssertionError: expected ${open}${value}${close} to be ${open}changes${close}`;
}

/** An error line with no test around it: the `##[error]` line alone. */
function noTest(value: string) {
  return only(`##[error]${asserted("'", "'", value)}`);
}

describe("signatures: quoted values in a named test's error line", () => {
  it("gives one test with one assertion and two quoted values the same signature", () => {
    const a = only(vitest("a test", asserted("'", "'", "errored")));
    const b = only(vitest("a test", asserted("'", "'", "passed")));
    expect(a.errorLine).toBe("AssertionError: expected 'errored' to be 'changes'");
    expect(a.signature).toBe(b.signature);
  });

  it("gives two different tests with the same quoted error line different signatures", () => {
    const a = only(vitest("a test", asserted("'", "'", "errored")));
    const b = only(vitest("another test", asserted("'", "'", "errored")));
    expect(a.signature).not.toBe(b.signature);
  });

  it("drops double-quoted and backtick-quoted values the same way", () => {
    for (const [open, close] of [
      ['"', '"'],
      ["`", "`"],
    ] as const) {
      const a = only(vitest("a test", asserted(open, close, "errored")));
      const b = only(vitest("a test", asserted(open, close, "passed")));
      expect(a.signature).toBe(b.signature);
    }
  });

  it("keeps different quoted values apart when no test is named", () => {
    expect(noTest("errored").signature).not.toBe(noTest("passed").signature);
  });
});
