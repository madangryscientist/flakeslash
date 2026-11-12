import { describe, expect, it } from "vitest";
import { signatures } from "../src/index.ts";

const JOB = { repo: "madangryscientist/pixelslash", workflow: "ci", jobName: "e2e" };

function only(excerpt: string, job = JOB) {
  const found = signatures(excerpt, job);
  expect(found).toHaveLength(1);
  return found[0]!;
}

describe("signatures: a gap in bun output, and Nx's failed tasks", () => {
  it("a gap clears the file header, so a failure after it is not filed under that file", () => {
    const text = [
      "##[group]test/spinoff-tier.test.ts:",
      "…",
      "✗ other > fails after the gap [12.00ms]",
      "  ^ this test timed out after 5000ms.",
      "##[endgroup]",
      "1 tests failed:",
      "(fail) other > fails after the gap [12.00ms]",
    ].join("\n");
    const entry = only(text);
    expect(entry).toMatchObject({
      file: "",
      title: "other > fails after the gap",
      location: "",
      errorLine: "this test timed out after 5000ms.",
    });
  });

  it("an Nx block with a passing line and the generic exit gives one entry naming the task", () => {
    const entry = only(
      [
        "✓ core > passes [1.00ms]",
        " NX   Running targets test for 1 projects failed",
        "",
        "Failed tasks:",
        "",
        "- core:test",
        "",
        "##[error]Process completed with exit code 1.",
      ].join("\n"),
    );
    expect(entry).toMatchObject({
      file: null,
      title: null,
      location: null,
      errorLine: "nx task core:test failed with no failed test in its output",
    });
  });

  it("gives one entry per failed task, each with its own signature", () => {
    const found = signatures(
      ["Failed tasks:", "", "- cli-core:test", "- slash-site:build", ""].join("\n"),
      JOB,
    );
    expect(found.map((entry) => entry.errorLine)).toEqual([
      "nx task cli-core:test failed with no failed test in its output",
      "nx task slash-site:build failed with no failed test in its output",
    ]);
    expect(found[0]!.signature).not.toBe(found[1]!.signature);
  });

  it("gives the same task in two excerpts the same signature, on any repo", () => {
    const excerpt = ["Failed tasks:", "", "- cli-core:test"].join("\n");
    const a = only(excerpt, JOB);
    const b = only(excerpt, { ...JOB, repo: "madangryscientist/other", jobName: "gate" });
    expect(a.signature).toBe(b.signature);
  });

  it("a real ##[error] line still wins over the failed tasks list", () => {
    const entry = only(
      ["Failed tasks:", "", "- cli-core:test", "##[error]Error: the server refused the token"].join(
        "\n",
      ),
    );
    expect(entry.errorLine).toBe("Error: the server refused the token");
    expect(entry.file).toBeNull();
  });

  it("an excerpt with a named test and the failed tasks list gives only the test", () => {
    const entry = only(
      [
        "##[group]test/a.test.ts:",
        "✗ a > breaks [3.00ms]",
        "error: expect(received).toBe(expected)",
        "##[endgroup]",
        "",
        "Failed tasks:",
        "",
        "- cli-core:test",
      ].join("\n"),
    );
    expect(entry).toMatchObject({ file: "test/a.test.ts", title: "a > breaks" });
  });
});
