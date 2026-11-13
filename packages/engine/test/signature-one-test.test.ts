import { describe, expect, it } from "vitest";
import { signatures } from "../src/index.ts";

const JOB = { repo: "madangryscientist/pixelslash", workflow: "ci", jobName: "e2e" };

function only(excerpt: string, job = JOB) {
  const found = signatures(excerpt, job);
  expect(found).toHaveLength(1);
  return found[0]!;
}

/** One numbered Playwright block, as the runner prints it. */
function block(n: number, at: string, title: string, error: string): string {
  return [`  ${n}) [chromium] › ${at}:1 › ${title} `, "", `    ${error}`, "    Call log:", ""].join(
    "\n",
  );
}

/** One Vitest failure: its `FAIL` header and its error line. */
function vitest(header: string, error: string): string {
  return [`  ${header}`, "", error, ""].join("\n");
}

describe("signatures: one test is one issue", () => {
  it("gives one signature to a timeout and an assertion on one Playwright test", () => {
    const timeout = only(
      block(
        1,
        "e2e/upload.spec.ts:141",
        "the CLI uploads a snapshot dir; rows and R2 object",
        "Error: locator.click: Test timeout of 30000ms exceeded.",
      ),
    );
    const assertion = only(
      block(
        1,
        "e2e/upload.spec.ts:141",
        "the CLI uploads a snapshot dir; rows and R2 object",
        "Error: expect(received).toBe(expected) // Object.is equality",
      ),
    );
    expect(assertion.signature).toBe(timeout.signature);
    expect(timeout.errorLine).toBe("Error: locator.click: Test timeout of 30000ms exceeded.");
    expect(assertion.errorLine).toBe(
      "Error: expect(received).toBe(expected) // Object.is equality",
    );
  });

  it("gives one signature to two small numbers in one Vitest test's assertion", () => {
    const header =
      "FAIL  test/check-coverage.test.ts > coverage of file transformed by multiple plugins";
    const one = only(vitest(header, "AssertionError: expected 1 to be +0"));
    const four = only(vitest(header, "AssertionError: expected 4 to be +0"));
    expect(four.signature).toBe(one.signature);
  });

  it("folds an absolute Windows runner path too, runner root and all", () => {
    const error = "Error: expect(locator).toBeVisible() failed";
    const windows = only(
      block(
        1,
        "C:\\a\\proj\\proj\\test\\ui.spec.ts:217",
        "ui › annotations in the report tab",
        error,
      ),
    );
    const posix = only(
      block(1, "test/ui.spec.ts:217", "ui › annotations in the report tab", error),
    );
    expect(windows.signature).toBe(posix.signature);
    expect(windows.file).toBe("C:\\a\\proj\\proj\\test\\ui.spec.ts");
  });

  it("folds a Windows path into the same file, and keeps each printed location", () => {
    const error = "Error: expect(locator).toBeVisible() failed";
    const windows = only(
      block(1, "test\\ui.spec.ts:217", "ui › annotations in the report tab", error),
    );
    const posix = only(
      block(1, "test/ui.spec.ts:217", "ui › annotations in the report tab", error),
    );
    expect(windows.signature).toBe(posix.signature);
    expect(windows.location).toBe("test\\ui.spec.ts:217");
    expect(posix.location).toBe("test/ui.spec.ts:217");
  });

  it("names the test after a Vitest project label, not the job", () => {
    const entry = only(
      vitest(
        "FAIL   main  test/signal.test.ts:173 > cancelling test run aborts the signal after a concurrent test finished",
        "Error: Test timed out in 90000ms.",
      ),
    );
    expect(entry).toMatchObject({
      file: "test/signal.test.ts",
      title: "cancelling test run aborts the signal after a concurrent test finished",
      location: "test/signal.test.ts:173",
    });
  });

  it("gives the same project-labelled failure one signature across job names", () => {
    const excerpt = vitest(
      "FAIL   main  test/signal.test.ts:173 > cancelling test run aborts the signal after a concurrent test finished",
      "Error: Test timed out in 90000ms.",
    );
    const ubuntu = only(excerpt, { ...JOB, jobName: "Test: e2e, node-24, ubuntu-latest" });
    const macos = only(excerpt, { ...JOB, jobName: "Test: e2e, node-22, macos-latest" });
    expect(macos.signature).toBe(ubuntu.signature);
  });

  it("gives two different tests with the same error two signatures", () => {
    const error = "Error: Test timed out in 90000ms.";
    const found = signatures(
      [
        vitest("FAIL   main  test/signal.test.ts:173 > cancels one run", error),
        vitest("FAIL   main  test/signal.test.ts:190 > cancels another run", error),
      ].join("\n"),
      JOB,
    );
    expect(found).toHaveLength(2);
    expect(found[0]!.signature).not.toBe(found[1]!.signature);
  });
});

describe("signatures: an error with no test named still folds what changes", () => {
  it("gives one signature to an error on another port, runner path and time", () => {
    const a = only(
      "##[error]Error: connect ECONNREFUSED http://localhost:45549/ at /home/runner/work/pixelslash/pixelslash/apps/web/x.ts:25:65 on 2026-11-03T16:00:25.604Z after 30000ms",
    );
    const b = only(
      "##[error]Error: connect ECONNREFUSED http://localhost:36065/ at /home/runner/work/other/other/apps/web/x.ts:25:65 on 2026-11-04T09:12:01Z after 4512ms",
    );
    expect(b.signature).toBe(a.signature);
  });
});
