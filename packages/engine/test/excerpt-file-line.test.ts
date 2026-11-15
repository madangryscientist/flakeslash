import { describe, expect, it } from "vitest";
import { cutLog, signatures } from "../src/index.ts";

const JOB = { repo: "madangryscientist/flakeslash", workflow: "ci", jobName: "gate" };

/** Moon's right-aligned `<target> | ` prefix on a task line. */
const moonPrefix = (target: string) => `${target.padStart(20)} | `;

/** A line another moon target printed, interleaved with the failing one's. */
const other = (text: string) => `${moonPrefix("cli-coord:test")}${text}`;

describe("cutLog keeps the file line a moon failure belongs to", () => {
  const groupLine = `${moonPrefix("cli-core:test")}::group::test/a.test.ts:`;
  const failLine = `${moonPrefix("cli-core:test")}(fail) a test`;
  const quiet = Array.from({ length: 20 }, (_, i) => `${moonPrefix("cli-core:test")}quiet ${i}`);

  function moonStep(between: string[]): string {
    return [
      "##[group]Run moon run :test",
      groupLine,
      ...between,
      failLine,
      "  × Task cli-core:test failed to run.",
      "##[error]Process completed with exit code 1.",
    ].join("\n");
  }

  it("puts the dropped group line after the gap and before the failure's window", () => {
    const lines = cutLog(moonStep(quiet)).split("\n");

    const gap = lines.indexOf("…");
    expect(gap).toBeGreaterThanOrEqual(0);
    expect(lines[gap + 1]).toBe(groupLine);
    expect(lines.indexOf(failLine)).toBeGreaterThan(gap + 1);
    expect(lines.filter((line) => line === groupLine)).toHaveLength(1);
  });

  it("does not bring back a group line that a group end closed", () => {
    const between = [
      ...quiet.slice(0, 5),
      `${moonPrefix("cli-core:test")}::endgroup::`,
      ...quiet.slice(5),
    ];

    const out = cutLog(moonStep(between));

    expect(out).not.toContain("::group::test/a.test.ts:");
    expect(out).toContain(failLine);
  });

  it("keeps a group line already inside the window once", () => {
    const lines = cutLog(moonStep(quiet.slice(0, 3))).split("\n");

    expect(lines.filter((line) => line === groupLine)).toHaveLength(1);
    expect(lines.indexOf(groupLine)).toBeLessThan(lines.indexOf(failLine));
  });

  it("passes over another moon target's file line and group end", () => {
    const between = [
      ...quiet.slice(0, 10),
      other("::group::test/b.test.ts:"),
      other("quiet b"),
      other("::endgroup::"),
      ...quiet.slice(10),
    ];

    const lines = cutLog(moonStep(between)).split("\n");

    expect(lines[lines.indexOf("…") + 1]).toBe(groupLine);
    expect(lines.join("\n")).not.toContain("test/b.test.ts");
  });

  it("heads one window with the file line of each target that fails in it", () => {
    const log = [
      "##[group]Run moon run :test",
      groupLine,
      other("::group::test/b.test.ts:"),
      ...quiet,
      other("(fail) b test"),
      failLine,
      "##[error]Process completed with exit code 1.",
    ].join("\n");

    const found = signatures(cutLog(log), JOB);

    const pairs = found.map((s) => [s.file, s.title]);
    expect(pairs).toHaveLength(2);
    expect(pairs).toEqual(
      expect.arrayContaining([
        ["test/a.test.ts", "a test"],
        ["test/b.test.ts", "b test"],
      ]),
    );
  });

  it("heads each failure's window with the file line after every gap", () => {
    const log = [
      "##[group]Run bun test",
      "##[group]test/a.test.ts:",
      "(fail) one",
      ...Array.from({ length: 20 }, (_, i) => `quiet ${i}`),
      "(fail) two",
      "##[error]Process completed with exit code 1.",
    ].join("\n");

    const found = signatures(cutLog(log), JOB);

    expect(found.map((s) => [s.file, s.title])).toEqual([
      ["test/a.test.ts", "one"],
      ["test/a.test.ts", "two"],
    ]);
  });

  it("gives the cut a signature that names the file and the title", () => {
    const found = signatures(cutLog(moonStep(quiet)), JOB);

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ file: "test/a.test.ts", title: "a test" });
  });
});
