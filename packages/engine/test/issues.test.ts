import { describe, expect, it } from "vitest";
import {
  IssueError,
  confirmIssue,
  dismissIssue,
  findIssue,
  listIssues,
  renameIssue,
  type Failure,
  type Issue,
  type IssueStore,
} from "../src/index.ts";

function issue(id: string, over: Partial<Issue> = {}): Issue {
  return {
    id,
    name: `name of ${id}`,
    kind: "other",
    status: "potential",
    signatures: [],
    explanation: null,
    edited: false,
    ...over,
  };
}

function failure(issueId: string, repo: string, jobId: number): Failure {
  return {
    repo,
    jobId,
    url: `https://github.com/${repo}/actions/runs/1/job/${jobId}`,
    signature: `sig-${jobId}`,
    issueId,
    file: null,
    title: null,
    location: null,
    errorLine: "Error",
  };
}

/** The part of a `Store` the issue edits use, in memory. */
function memory(issues: Issue[], failures: Failure[] = []): IssueStore {
  const held = new Map(issues.map((one) => [one.id, structuredClone(one)]));
  return {
    async readIssues() {
      return [...held.values()].map((one) => structuredClone(one));
    },
    async writeIssue(one) {
      held.set(one.id, structuredClone(one));
    },
    async readFailures() {
      return failures;
    },
    // Merge and split read and write more of the store; these edits are tested through the CLI.
    async readJobs() {
      return [];
    },
    async readExcerpts() {
      return [];
    },
    async writeFailures() {},
    async mergeIssues() {},
  };
}

const A = "key:aaaaaaaa11112222";
const B = "key:aaaaaaaa33334444";
const C = "key:cccccccc55556666";

describe("findIssue", () => {
  it("takes the full id, or a prefix of 8 characters or more that matches one issue", async () => {
    const store = memory([issue(A), issue(C)]);
    expect((await findIssue(store, A)).id).toBe(A);
    expect((await findIssue(store, "key:cccc")).id).toBe(C);
    expect((await findIssue(store, A.slice(0, 16))).id).toBe(A);
  });

  it("prefers an exact id over a longer id it is a prefix of", async () => {
    const store = memory([issue("starter:Page crashed"), issue("starter:Page crashed twice")]);
    expect((await findIssue(store, "starter:Page crashed")).id).toBe("starter:Page crashed");
  });

  it("names a missing id, a prefix that is too short and an ambiguous prefix", async () => {
    const store = memory([issue(A), issue(B)]);
    const problem = async (id: string) => {
      await expect(findIssue(store, id)).rejects.toBeInstanceOf(IssueError);
      return findIssue(store, id).then(
        () => "",
        (error: unknown) => (error instanceof Error ? error.message : ""),
      );
    };
    expect(await problem("key:zzzzzzzz")).toBe("no issue key:zzzzzzzz; run flakeslash issue list");
    expect(await problem("key:")).toContain("a prefix needs 8 characters or more");
    expect(await problem("key:aaaaaaaa")).toBe(
      "key:aaaaaaaa matches 2 issues; give more of it (run flakeslash issue list)",
    );
  });
});

describe("issue edits", () => {
  it("confirm sets the status and leaves edited alone, and brings a dismissed issue back", async () => {
    const store = memory([issue(A), issue(C, { status: "dismissed", edited: true })]);
    expect(await confirmIssue(store, A)).toMatchObject({ status: "confirmed", edited: false });
    expect(await confirmIssue(store, C)).toMatchObject({ status: "confirmed" });
    expect((await store.readIssues()).map((one) => one.status)).toEqual(["confirmed", "confirmed"]);
  });

  it("rename trims the name, marks the issue edited, and keeps its explanation", async () => {
    const explanation = {
      component: "c",
      kind: "timeout" as const,
      cause: "x",
      evidence: "y",
      repo: "o/r",
      jobId: 1,
      model: "m",
    };
    const store = memory([issue(A, { explanation })]);
    const renamed = await renameIssue(store, A, "  Upload times out  ");
    expect(renamed).toMatchObject({ name: "Upload times out", edited: true, explanation });
    expect(await store.readIssues()).toEqual([renamed]);
  });

  it("rename refuses an empty name and writes nothing", async () => {
    const store = memory([issue(A)]);
    await expect(renameIssue(store, A, "   ")).rejects.toThrow("the new name is empty");
    expect((await store.readIssues())[0]).toMatchObject({ name: `name of ${A}`, edited: false });
  });

  it("dismiss sets the status and marks the issue edited", async () => {
    const store = memory([issue(A)]);
    expect(await dismissIssue(store, A)).toMatchObject({ status: "dismissed", edited: true });
    await expect(dismissIssue(store, "key:nothere1")).rejects.toBeInstanceOf(IssueError);
  });
});

describe("listIssues", () => {
  const store = memory(
    [issue(C), issue(A), issue(B, { status: "dismissed", edited: true })],
    [
      failure(A, "o/zed", 1),
      failure(A, "o/alpha", 2),
      failure(A, "o/alpha", 3),
      failure(B, "o/alpha", 4),
      failure(B, "o/alpha", 5),
      failure(B, "o/alpha", 6),
      failure(C, "o/alpha", 7),
    ],
  );

  it("orders by failures then id, counts failures, and sorts distinct repos", async () => {
    expect(await listIssues(store)).toEqual([
      expect.objectContaining({ id: A, failures: 3, repos: ["o/alpha", "o/zed"] }),
      expect.objectContaining({ id: C, failures: 1, repos: ["o/alpha"] }),
    ]);
  });

  it("hides dismissed issues unless all is set", async () => {
    expect((await listIssues(store)).map((row) => row.id)).not.toContain(B);
    expect((await listIssues(store, { all: true })).map((row) => row.id)).toEqual([A, B, C]);
  });

  it("gives an issue with no failures zero and no repos", async () => {
    expect(await listIssues(memory([issue(A)]))).toEqual([
      { id: A, name: `name of ${A}`, kind: "other", status: "potential", failures: 0, repos: [] },
    ]);
  });
});
