import { describe, expect, it } from "vitest";
import { place, type Issue } from "../src/catalogue.ts";

const JOB = {
  repo: "madangryscientist/pixelslash",
  workflow: "ci",
  jobName: "test",
  jobId: 1,
  url: "https://example.test/jobs/1",
  annotations: [],
};

describe("catalogue: the name of an issue", () => {
  it("names a bun failure with no file by its title alone, with no leading colon", () => {
    const issues = new Map<string, Issue>();
    const { issue } = place(
      {
        file: "",
        title: "cost > acquiring a database connection",
        location: "",
        errorLine: "this test timed out after 5000ms.",
        signature: "a".repeat(64),
      },
      "this test timed out after 5000ms.",
      JOB,
      issues,
    );
    expect(issue.name).toBe("cost > acquiring a database connection");
  });
});

describe("catalogue: where a new failure goes once a person has split or merged", () => {
  const ENTRY = {
    file: "",
    title: "",
    location: "",
    errorLine: "Error: Page crashed",
    signature: "b".repeat(64),
  };

  it("a split issue takes the failure ahead of a starter that also matches", () => {
    const issues = new Map<string, Issue>([
      [
        "split:abc",
        {
          id: "split:abc",
          name: "Page crashed",
          kind: "other",
          status: "potential",
          signatures: [{ type: "pattern", all: ["Page crashed"] }],
          explanation: null,
          edited: true,
        },
      ],
    ]);
    const { issue, created } = place(ENTRY, "Error: Page crashed", JOB, issues);
    expect(issue.id).toBe("split:abc");
    expect(created).toBe(false);
    expect([...issues.keys()]).toEqual(["split:abc"]);
  });

  it("a starter failure joins the issue that holds the starter pattern, when the starter issue was merged away", () => {
    const issues = new Map<string, Issue>([
      [
        "key:xyz",
        {
          id: "key:xyz",
          name: "merged",
          kind: "browser-crash",
          status: "potential",
          signatures: [
            { type: "key", key: "c".repeat(64) },
            { type: "pattern", all: ["Page crashed"] },
          ],
          explanation: null,
          edited: false,
        },
      ],
    ]);
    const { issue, created } = place(ENTRY, "Error: Page crashed", JOB, issues);
    expect(issue.id).toBe("key:xyz");
    expect(created).toBe(false);
    expect([...issues.keys()]).toEqual(["key:xyz"]);
  });
});
