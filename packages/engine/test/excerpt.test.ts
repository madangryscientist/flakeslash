import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cleanLog, cutLog } from "../src/index.ts";

/** A line from a passing step. It holds no keyword, so it must never reach an excerpt. */
const PASSING_MARKER = "zz-passing-marker";

function fixture(id: string): string {
  const text = readFileSync(new URL(`./fixtures/logs/${id}.log`, import.meta.url), "utf8");
  return text.replace(/\n$/, "");
}

function passingStep(name: string, lines: number): string[] {
  return [
    `##[group]Run ${name}`,
    ...Array.from({ length: lines }, (_, i) => `${PASSING_MARKER} ${name} ${i} all good`),
  ];
}

/** A whole job log: passing steps before and after, and the fixture as the step that failed. */
function wholeLog(failingStepLines: string[]): string {
  return [
    "##[group]Set up job",
    ...Array.from({ length: 30 }, (_, i) => `Current runner version ${i}`),
    ...passingStep("npm ci", 200),
    "##[group]Run npm run test",
    ...failingStepLines,
    ...passingStep("actions/upload-artifact", 200),
    "##[group]Complete job",
    "Cleaning up orphan processes",
  ].join("\n");
}

const FIXTURES = [
  {
    id: "125833669365",
    what: "a Playwright failure",
    strings: ["Error: locator.click: Test timeout of 30000ms exceeded."],
  },
  {
    id: "126029167526",
    what: "a Vitest failure",
    strings: ["FAIL  test/dev.test.ts", "Error: Test timed out in 90000ms."],
  },
  {
    id: "122931680354",
    what: "a runner that died (the job was stopped by a signal)",
    strings: ["opencode was stopped by SIGTERM"],
  },
  {
    id: "123594006714",
    what: "a whole suite down, the server never came up",
    strings: ["net::ERR_CONNECTION_REFUSED", "e2e/action-row.spec.ts:42:1"],
  },
  {
    id: "127626417545",
    what: "two different failures",
    strings: ["e2e/review.spec.ts:361:1", "e2e/upload.spec.ts:141:1"],
  },
  {
    id: "122347904029",
    what: "a lint failure with no test",
    strings: ["`debugger` statement is not allowed"],
  },
  {
    id: "126034000055",
    what: "an npm publish with only the generic exit line",
    strings: ["Process completed with exit code 1"],
  },
];

describe("cleanLog", () => {
  it("strips the BOM, the timestamps, the ANSI codes and CRLF", () => {
    const raw =
      "﻿2026-11-03T09:28:42.9813641Z \u001b[31mred\u001b[0m line\r\n" +
      "2026-11-03T09:28:43.0000000Z plain\r\n";

    expect(cleanLog(raw)).toBe("red line\nplain\n");
  });
});

describe("cutLog keeps the failure of a real job", () => {
  for (const { id, what, strings } of FIXTURES) {
    it(`for ${what} (${id})`, () => {
      const out = cutLog(cleanLog(wholeLog(fixture(id).split("\n"))));

      for (const text of strings) expect(out).toContain(text);
      expect(out).not.toContain(`${PASSING_MARKER} npm ci 150`);
      expect(out.length).toBeLessThanOrEqual(25_000);
    });
  }
});

describe("cutLog", () => {
  it("returns an empty string for an empty log", () => {
    expect(cutLog("")).toBe("");
  });

  it("gives the end of a log with no recognisable error, not an empty result", () => {
    const lines = [
      "##[group]Run npm test",
      ...Array.from({ length: 300 }, (_, i) => `progress line ${i}`),
    ];

    const out = cutLog(lines.join("\n")).split("\n");

    expect(out).toHaveLength(100);
    expect(out[0]).toBe("progress line 200");
    expect(out.at(-1)).toBe("progress line 299");
  });

  it("gives an excerpt for a log with no step markers and no error", () => {
    expect(cutLog("the runner stopped\nnothing after this")).toBe(
      "the runner stopped\nnothing after this",
    );
  });

  it("does not keep a passing step that sits right beside a failed one", () => {
    const log = [
      "##[group]Run npm ci",
      "zz-adjacent-passing installed",
      "zz-adjacent-passing audited",
      "##[group]Run npm test",
      "the suite fails here",
      "##[error]Process completed with exit code 1.",
    ].join("\n");

    const out = cutLog(log);

    expect(out).toContain("the suite fails here");
    expect(out).not.toContain("zz-adjacent-passing");
  });

  it("keeps 8 lines either side of a match and marks the gap with one line", () => {
    const step = [
      "##[group]Run npm test",
      ...Array.from({ length: 100 }, (_, i) => (i === 50 ? "failure here" : `filler ${i}`)),
      "##[error]Process completed with exit code 1.",
    ];

    const out = cutLog(step.join("\n")).split("\n");

    // The match is filler 50, which is step line 51: lines 43 to 59 of the step are kept, filler 42 to 58.
    expect(out[0]).toBe("…");
    expect(out).toContain("filler 42");
    expect(out).not.toContain("filler 41");
    expect(out).toContain("filler 58");
    expect(out).not.toContain("filler 59");
  });

  it("stays at or under 25,000 characters on a generated 10 MB log with one error step", () => {
    const passing = Array.from(
      { length: 120_000 },
      (_, i) => `passing step line ${i} with padding padding`,
    );
    const failing = Array.from(
      { length: 120_000 },
      (_, i) => `failing step line ${i} with padding error`,
    );
    const raw = [
      "##[group]Set up job",
      ...passing,
      "##[group]Run npm test",
      ...failing,
      "##[error]Process completed with exit code 1.",
    ].join("\n");
    expect(raw.length).toBeGreaterThan(9_000_000);

    const out = cutLog(cleanLog(raw));

    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThanOrEqual(25_000);
  });

  it("stays at or under 25,000 characters on a generated 10 MB log with one single huge line", () => {
    const huge = `${"x".repeat(10_000_000)} error`;
    const raw = ["##[group]Run build", huge, "##[error]boom"].join("\n");

    const out = cutLog(raw);

    expect(out.length).toBeLessThanOrEqual(25_000);
    expect(out.startsWith("##[group]Run build\n")).toBe(true);
  });
});
