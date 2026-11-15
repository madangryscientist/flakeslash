import type { Store } from "@hackcove/flakeslash-engine";
import { beforeEach, describe, expect, it } from "vitest";
import { d1Store, type BatchDb } from "./d1-store.ts";
import { testDb } from "./test-db.ts";
import { ACME, OTHER, REPO, failure, issue, withOrgs } from "./test-store.ts";

let db: BatchDb;
let store: Store;

beforeEach(async () => {
  db = await withOrgs();
  store = d1Store(db, ACME);
});

describe("the D1 store: issues and failures", () => {
  it("lists each job with a failure once, for its repo only", async () => {
    await store.writeFailures([
      failure(2, "key:a"),
      { ...failure(2, "key:a"), signature: "other" },
      failure(1, "key:a"),
      { ...failure(5, "key:a"), repo: OTHER },
    ]);

    expect(await store.failureJobIds(REPO)).toEqual([1, 2]);
    expect(await store.failureJobIds(OTHER)).toEqual([5]);
  });

  it("reads an issue back with its explanation and edit", async () => {
    const explanation = {
      component: "upload.spec.ts:141",
      kind: "timeout" as const,
      cause: "not visible in the excerpt",
      evidence: "Test timeout of 30000ms exceeded.",
      repo: REPO,
      jobId: 1,
      model: "m",
    };
    await store.writeIssue(issue("key:abc"));
    await store.writeIssue({ ...issue("key:abc"), explanation, edited: true });

    expect(await store.readIssues()).toEqual([{ ...issue("key:abc"), explanation, edited: true }]);
  });

  it("merges issues in one step: failures and model calls move, the merged issue goes", async () => {
    for (const id of ["key:a", "key:b", "key:c"]) await store.writeIssue(issue(id));
    await store.writeFailures([failure(1, "key:a"), failure(2, "key:b"), failure(3, "key:c")]);
    await store.writeModelCall({ repo: REPO, jobId: 2, issueId: "key:b", outcome: "invalid" });

    const survivor = { ...issue("key:a"), status: "confirmed" as const };
    await store.mergeIssues(survivor, ["key:b"]);

    expect((await store.readIssues()).map((held) => held.id)).toEqual(["key:a", "key:c"]);
    expect((await store.readIssues())[0]?.status).toBe("confirmed");
    expect((await store.readFailures()).map((held) => held.issueId)).toEqual([
      "key:a",
      "key:a",
      "key:c",
    ]);
    expect(await store.readModelCalls()).toEqual([
      { repo: REPO, jobId: 2, issueId: "key:a", outcome: "invalid" },
    ]);
  });

  it("merges all or nothing: a batch that fails partway leaves both issues and their failures as they were", async () => {
    // The merge of one issue is four statements: the survivor, the two moves and the delete.
    const failing = await withOrgs(testDb({ failBatchAt: 3 }));
    const broken = d1Store(failing, ACME);
    await broken.writeIssue(issue("key:a"));
    await broken.writeIssue(issue("key:b"));
    await broken.writeFailures([failure(1, "key:a"), failure(2, "key:b")]);

    await expect(
      broken.mergeIssues({ ...issue("key:a"), status: "confirmed" }, ["key:b"]),
    ).rejects.toThrow("the batch failed at statement 3");

    expect(await broken.readIssues()).toEqual([issue("key:a"), issue("key:b")]);
    expect(await broken.readFailures()).toEqual([failure(1, "key:a"), failure(2, "key:b")]);
  });
});
