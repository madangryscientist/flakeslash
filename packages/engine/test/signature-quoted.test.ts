import { describe, expect, it } from "vitest";
import { signatures } from "../src/index.ts";

const JOB = { repo: "madangryscientist/pixelslash", workflow: "ci", jobName: "e2e" };

function only(excerpt: string) {
  const found = signatures(excerpt, JOB);
  expect(found).toHaveLength(1);
  return found[0]!;
}

/** An error line with no test around it: the `##[error]` line alone. A quoted value is kept. */
function noTest(value: string) {
  return only(`##[error]AssertionError: expected '${value}' to be 'changes'`);
}

describe("signatures: quoted values with no test named", () => {
  it("keeps different quoted values apart when no test is named", () => {
    expect(noTest("errored").signature).not.toBe(noTest("passed").signature);
  });
});
