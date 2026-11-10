import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { KINDS, STARTER_SIGNATURES, cleanLog, cutLog, matchStarter, redact } from "../src/index.ts";

function fixtureText(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

/** One real-shaped line for each starter pattern, as the tool prints it. */
const LINES: Array<{ name: string; line: string }> = [
  {
    name: "Page crashed",
    line: "capture failed for iframe.html?id=components-button--primary: goto: Page crashed",
  },
  {
    name: "Chromium target crashed",
    line: "Protocol error (Target.attachToTarget): Target crashed",
  },
  {
    name: "Browser died at launch",
    line: "Error: browserType.launch: Target page, context or browser has been closed",
  },
  {
    name: "Node heap out of memory",
    line: "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory",
  },
  {
    name: "Kernel OOM killer",
    line: "Out of memory: Killed process 4242 (node) total-vm:2098764kB, anon-rss:1482136kB",
  },
  {
    name: "Runner lost communication",
    line: "The runner lost communication with the server.",
  },
];

describe("STARTER_SIGNATURES", () => {
  it.each(LINES)("matches $name on a real-shaped line", ({ name, line }) => {
    expect(matchStarter(line)?.name).toBe(name);
  });

  it("matches the runner shutdown signal in the committed annotation fixture", () => {
    const match = matchStarter(fixtureText("annotations-lost-runner.json"));

    expect(match?.name).toBe("Runner shutdown signal");
    expect(match?.kind).toBe("runner-died");
  });

  it("has one test case for each starter pattern", () => {
    const tested = [...LINES.map((entry) => entry.name), "Runner shutdown signal"];
    expect(tested.toSorted()).toEqual(STARTER_SIGNATURES.map((pattern) => pattern.name).toSorted());
  });

  it("gives every pattern a kind from KINDS", () => {
    for (const pattern of STARTER_SIGNATURES) {
      expect(KINDS).toContain(pattern.kind);
    }
  });
});

describe("matchStarter: no match", () => {
  it("does not match a plain assertion failure", () => {
    expect(matchStarter("AssertionError: expected 'passed' to be 'changes'")).toBeNull();
  });

  it("does not match a test merely named after a crash", () => {
    expect(matchStarter("  ✓ handles a crash 120ms")).toBeNull();
  });

  it("does not match a lower-case crash line from a real failing test", () => {
    const log = redact(cleanLog(fixtureText("logs/127767586349.log")));
    const excerpt = cutLog(log);

    expect(excerpt).toContain("the page crashed during goto");
    expect(matchStarter(excerpt)).toBeNull();
  });

  it("does not match a pattern when only one of its two strings is present", () => {
    expect(matchStarter("browserType.launch: failed to start chromium")).toBeNull();
    expect(matchStarter("the browser has been closed by the user")).toBeNull();
  });

  it("is case-sensitive", () => {
    expect(matchStarter("goto: page crashed")).toBeNull();
  });
});

describe("KINDS", () => {
  it("has no duplicates", () => {
    expect(new Set(KINDS).size).toBe(KINDS.length);
  });
});
