import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { signatures } from "../src/index.ts";

const JOB = { repo: "madangryscientist/pixelslash", workflow: "ci", jobName: "e2e" };

function fixture(id: string): string {
  return readFileSync(new URL(`./fixtures/logs/${id}.log`, import.meta.url), "utf8").replace(
    /\n$/,
    "",
  );
}

/** One numbered Playwright block, as the runner prints it. */
function block(n: number, at: string, title: string, error: string): string {
  return [`  ${n}) [chromium] › ${at}:1 › ${title} `, "", `    ${error}`, "    Call log:", ""].join(
    "\n",
  );
}

/** The same crash, with the parts that change between runs as arguments. */
function crash(port: number, root: string, stamp: string, ms: number): string {
  return block(
    1,
    "e2e/a.spec.ts:10",
    "opens the page",
    `Error: connect ECONNREFUSED http://localhost:${port}/ at ${root}/apps/web/x.ts:25:65 on ${stamp} after ${ms}ms in /tmp/run-${port}/out (id 9dc8915e-616f-41c1-96f1-907c39df2f1b)`,
  );
}

/** A suite whose server did not start: n tests, one error. */
function down(n: number, port: number): string {
  return Array.from({ length: n }, (_, i) =>
    block(
      i + 1,
      `e2e/s${i}.spec.ts:5`,
      `test ${i}`,
      `Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:${port}/`,
    ),
  ).join("\n");
}

function only(excerpt: string, job = JOB) {
  const found = signatures(excerpt, job);
  expect(found).toHaveLength(1);
  return found[0]!;
}

describe("signatures: stability", () => {
  it("gives one signature to the same crash with other ports, paths and timestamps", () => {
    const a = crash(
      45549,
      "/home/runner/work/pixelslash/pixelslash",
      "2026-11-03T16:00:25.604Z",
      30000,
    );
    const b = crash(36065, "/home/runner/work/other/other", "2026-11-04T09:12:01Z", 4512);
    expect(only(a).signature).toBe(only(b).signature);
  });

  it("gives two signatures to two different errors on one test", () => {
    const a = block(
      1,
      "e2e/a.spec.ts:10",
      "opens",
      "Error: locator.click: Test timeout of 30000ms exceeded.",
    );
    const b = block(1, "e2e/a.spec.ts:10", "opens", "Error: page.goto: net::ERR_ABORTED");
    expect(only(a).signature).not.toBe(only(b).signature);
  });

  it("gives two signatures to one error message on two different tests", () => {
    const error = "Error: locator.click: Test timeout of 30000ms exceeded.";
    const found = signatures(
      [
        block(1, "e2e/a.spec.ts:10", "opens", error),
        block(2, "e2e/a.spec.ts:40", "closes", error),
      ].join("\n"),
      JOB,
    );
    expect(found).toHaveLength(2);
    expect(found[0]!.signature).not.toBe(found[1]!.signature);
  });

  it("keeps one signature when the test moves to another line, and reports the new location", () => {
    const error = "Error: expected 1 to be 2";
    const before = only(block(1, "e2e/a.spec.ts:141", "uploads", error));
    const after = only(block(1, "e2e/a.spec.ts:187", "uploads", error));
    expect(after.signature).toBe(before.signature);
    expect(before.location).toBe("e2e/a.spec.ts:141");
    expect(after.location).toBe("e2e/a.spec.ts:187");
  });

  it("gives three entries to three failing tests", () => {
    const found = signatures(
      [
        block(1, "e2e/a.spec.ts:1", "one", "Error: one broke"),
        block(2, "e2e/a.spec.ts:2", "two", "Error: two broke"),
        block(3, "e2e/b.spec.ts:3", "three", "TypeError: three broke"),
      ].join("\n"),
      JOB,
    );
    expect(found.map((f) => f.title)).toEqual(["one", "two", "three"]);
    expect(new Set(found.map((f) => f.signature)).size).toBe(3);
  });

  it("keeps the printed error line, and the file and title, for display", () => {
    const entry = only(
      block(1, "e2e/a.spec.ts:10", "opens", "Error: http://localhost:45549/ is down"),
    );
    expect(entry).toMatchObject({
      file: "e2e/a.spec.ts",
      title: "opens",
      errorLine: "Error: http://localhost:45549/ is down",
    });
  });

  it("with no error line in a block, signs on the file and title alone", () => {
    const text = "  1) [chromium] › e2e/a.spec.ts:10:1 › opens \n\n    no message here\n";
    const entry = only(text);
    expect(entry.errorLine).toBe("");
    expect(entry.title).toBe("opens");
  });
});

describe("signatures: suites that are down, and jobs with no test", () => {
  it("merges 5 tests that share one error into one entry with no test", () => {
    const entry = only(down(5, 45549));
    expect(entry.file).toBeNull();
    expect(entry.title).toBeNull();
    expect(entry.location).toBeNull();
    expect(entry.errorLine).toContain("ERR_CONNECTION_REFUSED");
  });

  it("keeps 4 tests that share one error apart", () => {
    expect(signatures(down(4, 45549), JOB)).toHaveLength(4);
  });

  it("gives the same merged suite the same signature on another port", () => {
    expect(only(down(8, 45549)).signature).toBe(only(down(5, 33001)).signature);
  });

  it("merges only the shared error and keeps a different failure beside it", () => {
    const text = [
      down(5, 1234),
      block(9, "e2e/z.spec.ts:3", "other", "Error: something else"),
    ].join("\n");
    const found = signatures(text, JOB);
    expect(found).toHaveLength(2);
    expect(found[1]!.title).toBe("other");
  });

  it("signs a no-test error on the error line alone, so two repos share it", () => {
    const text = "##[error]packages/x/src/a.ts:1:37: `debugger` statement is not allowed\n";
    const a = only(text, JOB);
    const b = only(text, { repo: "madangryscientist/hackcove", workflow: "lint", jobName: "lint" });
    expect(a.signature).toBe(b.signature);
    expect(a.file).toBeNull();
  });

  it("signs a merged suite like the same error alone", () => {
    const merged = only(down(5, 1));
    const alone = only(`##[error]${merged.errorLine}\n`);
    expect(merged.signature).toBe(alone.signature);
  });

  it("skips the generic exit line for the error line", () => {
    const entry = only(
      "##[error]Process completed with exit code 1.\n##[error]npm publish failed\n",
    );
    expect(entry.errorLine).toBe("npm publish failed");
  });

  it("with no error line keys on repo, workflow and job, so unrelated jobs do not merge", () => {
    const text = "something failed\n##[error]Process completed with exit code 1.\n";
    const a = only(text, JOB);
    expect(a.errorLine).toBe("");
    expect(only(text, JOB).signature).toBe(a.signature);
    expect(only(text, { ...JOB, repo: "madangryscientist/hackcove" }).signature).not.toBe(
      a.signature,
    );
    expect(only(text, { ...JOB, workflow: "release" }).signature).not.toBe(a.signature);
    expect(only(text, { ...JOB, jobName: "unit" }).signature).not.toBe(a.signature);
  });
});

describe("signatures: real jobs", () => {
  it("125833669365: one entry for upload.spec.ts:141, not one per listed test", () => {
    const entry = only(fixture("125833669365"));
    expect(entry.location).toBe("e2e/upload.spec.ts:141");
    expect(entry.file).toBe("e2e/upload.spec.ts");
    expect(entry.title).toContain("the CLI uploads a snapshot dir");
    expect(entry.errorLine).toBe("Error: locator.click: Test timeout of 30000ms exceeded.");
  });

  it("127626417545: two different failures", () => {
    const found = signatures(fixture("127626417545"), JOB);
    expect(found.map((f) => f.location)).toEqual([
      "e2e/review.spec.ts:361",
      "e2e/upload.spec.ts:141",
    ]);
    expect(found[0]!.errorLine).toMatch(
      /^Error: no project id in http:\/\/localhost:36065\/orgs\?org=/,
    );
    expect(found[0]!.signature).not.toBe(found[1]!.signature);
  });

  it("123594006714: the whole suite is down, one entry with no test name", () => {
    const entry = only(fixture("123594006714"));
    expect(entry.file).toBeNull();
    expect(entry.title).toBeNull();
    expect(entry.errorLine).toBe(
      "Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:45549/",
    );
  });

  it("126029167526: a Vitest failure, with the describe path in the title", () => {
    const entry = only(fixture("126029167526"));
    expect(entry.file).toBe("test/dev.test.ts");
    expect(entry.title).toBe(
      "pixelslash dev > re-runs on a save, and a second dev attaches to the live session",
    );
    expect(entry.errorLine).toBe("Error: Test timed out in 90000ms.");
  });

  it("122347904029: a lint annotation, no test", () => {
    const entry = only(fixture("122347904029"));
    expect(entry.file).toBeNull();
    expect(entry.errorLine).toBe(
      "packages/engine/src/zz-deliberate-lint-error.ts:1:37: `debugger` statement is not allowed",
    );
  });

  it("122931680354: an annotation in another repo, no test", () => {
    const entry = only(fixture("122931680354"), {
      repo: "madangryscientist/hackcove",
      workflow: "review",
      jobName: "review",
    });
    expect(entry.errorLine).toBe(
      "the model review did not run: opencode was stopped by SIGTERM (timeout 600000 ms)",
    );
  });

  it("126034000055: only the generic exit line, so it falls to the repo, workflow and job key", () => {
    const text = fixture("126034000055");
    expect(text).toContain("##[error]Process completed with exit code 1.");
    const a = only(text, JOB);
    expect(a.errorLine).toBe("");
    expect(a.file).toBeNull();
    expect(only(text, { ...JOB, workflow: "release" }).signature).not.toBe(a.signature);
  });
});
