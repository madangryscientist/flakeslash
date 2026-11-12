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
