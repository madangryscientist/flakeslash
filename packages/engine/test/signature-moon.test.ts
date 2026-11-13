import { describe, expect, it } from "vitest";
import { signatures } from "../src/index.ts";

const JOB = { repo: "madangryscientist/flakeslash", workflow: "ci", jobName: "gate" };

/** One line of a moon task's output: the target, right-aligned, then ` | ` and the line it printed. */
function moon(target: string, text: string, width = 22): string {
  return `${target.padStart(width)} | ${text}`;
}

function only(excerpt: string, job = JOB) {
  const found = signatures(excerpt, job);
  expect(found).toHaveLength(1);
  return found[0]!;
}

/**
 * One bun test that failed inside a moon task, as the task printed it: the `::group::` file header
 * (GitHub only turns it into `##[group]` at the start of a line), the assertion, the `(fail)` line,
 * bun's summary repeat and moon's own end summary. A second target's lines sit between them.
 */
const MOON_FAILURE = [
  moon("cli-core:test", "::group::test/ob-deploy-pin-1534.test.ts:"),
  moon("cli-core:test", "(pass) lock > a holder waits [12.00ms]"),
  moon("slash-site:build", "building page 1 of 3"),
  moon("cli-core:test", "error: expect(received).toBe(expected)"),
  moon("slash-site:build", "building page 2 of 3"),
  moon("cli-core:test", ""),
  moon("cli-core:test", "Expected: true"),
  moon("slash-site:build", "building page 3 of 3"),
  moon("cli-core:test", "Received: false"),
  moon("cli-core:test", "(fail) lock > the holder is waited out [3953.47ms]"),
  moon("cli-core:test", ""),
  moon("cli-core:test", "::endgroup::"),
  moon("cli-core:test", ""),
  moon("cli-core:test", "1 tests failed:"),
  moon("cli-core:test", "(fail) lock > the holder is waited out [3953.47ms]"),
  moon("cli-core:test", ""),
  moon("cli-core:test", " 2164 pass"),
  moon("cli-core:test", " 1 fail"),
  "",
  "task_runner::run_failed",
  "",
  "  × Task cli-core:test failed to run.",
  "  ╰─▶ Process bun failed: exit code 1",
  "",
  "##[error]Process completed with exit code 1.",
];

describe("signatures: moon task output", () => {
  it("names the test a moon task failed, not the job", () => {
    const entry = only(MOON_FAILURE.join("\n"));
    expect(entry).toMatchObject({
      file: "test/ob-deploy-pin-1534.test.ts",
      title: "lock > the holder is waited out",
      location: "test/ob-deploy-pin-1534.test.ts",
      errorLine: "error: expect(received).toBe(expected)",
    });
    expect(entry.signature).not.toBe(only("nothing failed here\n").signature);
  });

  it("a closed group clears the file under moon's ::endgroup:: too", () => {
    const entry = only(
      [
        moon("cli-core:test", "::group::test/lock.test.ts:"),
        moon("cli-core:test", "(pass) lock > a holder waits [1.00ms]"),
        moon("cli-core:test", "::endgroup::"),
        moon("cli-core:test", "(fail) lock > a test cut off from its header [1.00ms]"),
      ].join("\n"),
    );
    expect(entry).toMatchObject({ file: "", title: "lock > a test cut off from its header" });
  });

  it("a closed group ends the open test under moon's ::endgroup:: too", () => {
    const entry = only(
      [
        moon("cli-core:test", "::group::test/lock.test.ts:"),
        moon("cli-core:test", "(fail) lock > a holder waits [1.00ms]"),
        moon("cli-core:test", "::endgroup::"),
        moon("cli-core:test", "SyntaxError: raised after the group closed"),
      ].join("\n"),
    );
    expect(entry.errorLine).toBe("");
  });
});

describe("signatures: a moon task that failed with no failed test", () => {
  it("keys on the task moon names, and not on the job", () => {
    const entry = only(
      [
        "task_runner::run_failed",
        "",
        "  × Task cli-core:test failed to run.",
        "  ╰─▶ Process bun failed: exit code 1",
        "##[error]Process completed with exit code 1.",
      ].join("\n"),
    );
    expect(entry).toMatchObject({
      file: null,
      title: null,
      errorLine: "moon task cli-core:test failed with no failed test in its output",
    });
  });

  it("ignores an ##[error] line printed inside a task's output", () => {
    const entry = only(
      [
        moon("cli-core:test", "##[error]the task's own line"),
        "  × Task cli-core:test failed to run.",
      ].join("\n"),
    );
    expect(entry.errorLine).toBe(
      "moon task cli-core:test failed with no failed test in its output",
    );
  });

  it("gives one entry per failed task, each with its own signature", () => {
    const found = signatures(
      [
        "task_runner::run_failed",
        "",
        "  × Task cli-core:test failed to run.",
        "  ╰─▶ Process bun failed: exit code 1",
        "",
        "  × Task slash-site:build failed to run.",
        "  ╰─▶ Process node failed: exit code 1",
        "##[error]Process completed with exit code 1.",
      ].join("\n"),
      JOB,
    );
    expect(found.map((entry) => entry.errorLine)).toEqual([
      "moon task cli-core:test failed with no failed test in its output",
      "moon task slash-site:build failed with no failed test in its output",
    ]);
    expect(found[0]!.signature).not.toBe(found[1]!.signature);
  });

  it("does not let a duplicate failed-task line make a second entry", () => {
    const text = [
      "  × Task cli-core:test failed to run.",
      "  ╰─▶ Process bun failed: exit code 1",
      "",
      "  × Task cli-core:test failed to run.",
      "  ╰─▶ Process bun failed: exit code 1",
    ].join("\n");
    expect(signatures(text, JOB)).toHaveLength(1);
  });

  it("keeps two task names that differ only by digits apart", () => {
    const found = signatures(
      ["  × Task pkg:1 failed to run.", "  × Task pkg:2 failed to run."].join("\n"),
      JOB,
    );
    expect(found.map((entry) => entry.errorLine)).toEqual([
      "moon task pkg:1 failed with no failed test in its output",
      "moon task pkg:2 failed with no failed test in its output",
    ]);
    expect(found[0]!.signature).not.toBe(found[1]!.signature);
  });
});

describe("signatures: moon tasks that interleave", () => {
  /** Two tasks, each with its own bun file and failing test, alternating line for line at a wider pad. */
  const INTERLEAVED = [
    moon("cli-core:test", "::group::test/lock.test.ts:", 32),
    moon("cli-db:test", "::group::test/migrate.test.ts:", 32),
    moon("cli-core:test", "(pass) lock > a holder waits [9.00ms]", 32),
    moon("cli-db:test", "(pass) migrate > applies once [7.00ms]", 32),
    moon("cli-core:test", "error: expect(received).toBe(expected)", 32),
    moon("cli-db:test", "error: expect(received).toBe(4)", 32),
    moon("cli-core:test", "(fail) lock > the holder is waited out [3953.47ms]", 32),
    moon("cli-db:test", "(fail) migrate > a second run reuses the row [12.00ms]", 32),
    moon("cli-core:test", " 1 fail", 32),
    moon("cli-db:test", " 1 fail", 32),
    "",
    "  × Task cli-core:test failed to run.",
    "  × Task cli-db:test failed to run.",
  ].join("\n");

  it("gives two signatures, each naming the file of its own task", () => {
    const found = signatures(INTERLEAVED, JOB);
    expect(found).toHaveLength(2);
    expect(found.map((entry) => [entry.file, entry.title])).toEqual([
      ["test/lock.test.ts", "lock > the holder is waited out"],
      ["test/migrate.test.ts", "migrate > a second run reuses the row"],
    ]);
    expect(found[0]!.signature).not.toBe(found[1]!.signature);
  });

  it("keeps each task's error line with its own test", () => {
    const found = signatures(INTERLEAVED, JOB);
    expect(found.map((entry) => entry.errorLine)).toEqual([
      "error: expect(received).toBe(expected)",
      "error: expect(received).toBe(4)",
    ]);
  });

  it("files two tasks that share a project-relative file and title as one failure", () => {
    const text = [
      moon("red:test", "::group::test/lock.test.ts:"),
      moon("blue:test", "::group::test/lock.test.ts:"),
      moon("red:test", "(fail) lock > the holder is waited out [1.00ms]"),
      moon("blue:test", "(fail) lock > the holder is waited out [2.00ms]"),
    ].join("\n");
    const found = signatures(text, JOB);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      file: "test/lock.test.ts",
      title: "lock > the holder is waited out",
    });
  });
});

describe("signatures: moon ci, which echoes a failed task again", () => {
  /** `moon ci` prints the task's output, then a REVIEW block repeating it with no prefix, then a SUMMARY. */
  const MOON_CI = [
    moon("red:test", "bun test v1.4.2 (744846f84)"),
    moon("red:test", "red.test.ts:"),
    moon("red:test", "error: expect(received).toBe(expected)"),
    moon("red:test", "(fail) red > waits out a holder [0.15ms]"),
    moon("red:test", " 1 fail"),
    "",
    " REVIEW ",
    "",
    "▮▮▮▮ red:test",
    "bun test v1.4.2 (744846f84)",
    "red.test.ts:",
    "error: expect(received).toBe(expected)",
    "(fail) red > waits out a holder [0.15ms]",
    "",
    " SUMMARY ",
    "",
    "pass RunTask(ok:test) (7ms, 24b77dc0)",
    "fail RunTask(red:test) (20ms, dce10300)",
  ].join("\n");

  it("gives one entry for the test the REVIEW block repeats", () => {
    const entry = only(MOON_CI);
    expect(entry).toMatchObject({
      file: "red.test.ts",
      title: "red > waits out a holder",
      errorLine: "error: expect(received).toBe(expected)",
    });
  });

  it("keys on the task its SUMMARY names when no test failed", () => {
    const found = signatures(
      [
        " SUMMARY ",
        "",
        "pass RunTask(ok:test) (7ms, 24b77dc0)",
        "fail RunTask(red:test) (20ms, dce10300)",
      ].join("\n"),
      JOB,
    );
    expect(found.map((entry) => entry.errorLine)).toEqual([
      "moon task red:test failed with no failed test in its output",
    ]);
  });

  it("ignores a summary a task's own echoed output printed before the real one", () => {
    const found = signatures(
      [
        " REVIEW ",
        "",
        "▮▮▮▮ fake:test",
        " SUMMARY ",
        "",
        "fail RunTask(fake:test) (1ms, abc12345)",
        "",
        " SUMMARY ",
        "",
        "fail RunTask(red:test) (20ms, dce10300)",
      ].join("\n"),
      JOB,
    );
    expect(found.map((entry) => entry.errorLine)).toEqual([
      "moon task red:test failed with no failed test in its output",
    ]);
  });

  it("does not take an ##[error] line in the REVIEW echo for the job's", () => {
    const found = signatures(
      [
        " REVIEW ",
        "",
        "▮▮▮▮ cli-core:test",
        "##[error]printed by the task",
        "",
        " SUMMARY ",
        "",
        "fail RunTask(cli-core:test) (20ms, dce10300)",
      ].join("\n"),
      JOB,
    );
    expect(found.map((entry) => entry.errorLine)).toEqual([
      "moon task cli-core:test failed with no failed test in its output",
    ]);
  });

  it("keeps a task's ##[error] line out of the job's past a summary the task echoed", () => {
    const found = signatures(
      [
        " REVIEW ",
        "▮▮▮▮ cli-core:test",
        " SUMMARY ",
        "##[error]printed by the task",
        " SUMMARY ",
        "fail RunTask(cli-core:test) (20ms, dce10300)",
      ].join("\n"),
      JOB,
    );
    expect(found.map((entry) => entry.errorLine)).toEqual([
      "moon task cli-core:test failed with no failed test in its output",
    ]);
  });

  it("reads a lone REVIEW line as the job's own when no summary follows it", () => {
    const entry = only(["REVIEW", "##[error]Error: the server refused the token"].join("\n"));
    expect(entry.errorLine).toBe("Error: the server refused the token");
  });
});
