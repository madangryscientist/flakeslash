import type { ModelFetch } from "@hackcove/flakeslash-engine";
import { describe, expect, it } from "vitest";
import { REPO, fakeGitHub } from "../../engine/test/github-fake.ts";
import { openSqliteStore } from "../src/store.ts";
import { MODEL_ARGS, SCAN, echo, err, log, reply, stub } from "./model-stub.ts";
import { SINCE, playwrightLog, routesOf, text, useScan } from "./scan-harness.ts";

const compare = (a: number | string, b: number | string): number => {
  if (a === b) return 0;
  return a < b ? -1 : 1;
};

const OTHER = "madangryscientist/hackcove";

/** The same failing test in both repos, with a marker line the excerpt carries but the error line does not. */
const same = (marker: string) =>
  text(playwrightLog(["uploads", `Error: ship link never appeared\n    ${marker}`]));

const never: ModelFetch = async () => {
  throw new Error("a model call went out");
};

describe("flakeslash scan: explanations", () => {
  const scan = useScan();
  const env = { GITHUB_TOKEN: "ghp_test" };
  const withModel = (
    gh: { fetch: Parameters<typeof scan.exec>[1]["fetch"] },
    model: ModelFetch,
    extra: string[] = [],
  ) => scan.exec([...SCAN, ...MODEL_ARGS, ...extra], gh, env, model);
  it("makes no model call with no endpoint named, and says explanations are off", async () => {
    const gh = fakeGitHub(routesOf([REPO, 1, log(err("a", "Error: ship api failed"))]));
    const result = await scan.exec(SCAN, gh, env, never);
    expect(result.code).toBe(0);
    expect(result.out.trimEnd().endsWith("explanations: off (no model endpoint named)")).toBe(true);
    expect((await scan.issues())[0]?.explanation).toBeNull();

    const asJson = await scan.exec([...SCAN, "--json"], gh, env, never);
    expect(JSON.parse(asJson.out).explanations).toBeNull();
  });

  it("explains an unexplained issue once, and the next matching log joins it with no call", async () => {
    const error = "Error: ship link never appeared: waiting for the ship settings link";
    const first = routesOf([REPO, 1, log(err("uploads a file", error))]);
    const gh = fakeGitHub(first);
    const model = stub(() => ({
      content: reply({
        component: "e2e/upload.spec.ts:141",
        kind: "timeout",
        evidence: error,
        pattern: "waiting for the ship settings link",
      }),
    }));
    const one = await withModel(gh, model.fetch);
    expect(one.code).toBe(0);
    expect(model.seen).toHaveLength(1);
    expect(one.out).toContain("explanations: 1 explained, 0 merged, 0 patterns rejected");

    const [issue] = await scan.issues();
    expect(issue).toMatchObject({
      name: "e2e/upload.spec.ts:141",
      kind: "timeout",
      status: "potential",
      edited: false,
      explanation: {
        component: "e2e/upload.spec.ts:141",
        kind: "timeout",
        cause: "The click timed out; why is not visible in the excerpt.",
        repo: REPO,
        jobId: 10,
        model: "luna-test",
      },
    });
    expect(issue?.signatures).toContainEqual({
      type: "pattern",
      all: ["waiting for the ship settings link"],
    });
    expect(model.seen[0]?.max_tokens).toBe(2000);

    // A new run, a different test, the same error line: it joins by the stored pattern.
    Object.assign(
      gh.routes,
      routesOf(
        [REPO, 1, log(err("uploads a file", error))],
        [REPO, 2, log(err("uploads two", error))],
      ),
    );
    await withModel(gh, model.fetch);
    expect(model.seen).toHaveLength(1);
    expect(await scan.issues()).toHaveLength(1);
    expect(new Set((await scan.failures()).map((failure) => failure.issueId)).size).toBe(1);
    expect(await scan.failures()).toHaveLength(2);
  });

  it("sends a model only the excerpts of the repos the scan names", async () => {
    const gh = fakeGitHub(
      routesOf(
        [REPO, 1, log(err("uploads", "Error: ship api refused: from the named repo"))],
        [OTHER, 2, log(err("publishes", "Error: ship api refused: from the other repo"))],
      ),
    );
    await scan.exec(["scan", REPO, OTHER, "--since", SINCE], gh, env);

    const model = stub(echo);
    const result = await withModel(gh, model.fetch);
    expect(result.code).toBe(0);
    expect(model.seen).toHaveLength(1);
    for (const body of model.seen) {
      const sent = JSON.stringify(body);
      expect(sent).toContain("from the named repo");
      expect(sent).not.toContain("from the other repo");
    }
    expect(result.out).toContain("1 explained");

    const issues = await scan.issues();
    const named = issues.find((issue) => issue.explanation !== null);
    const other = issues.find((issue) => issue.explanation === null);
    expect(named?.explanation?.repo).toBe(REPO);
    expect(other).toBeDefined();
    expect(result.out).toContain("0 with no excerpt");
  });

  it("explains a cross-repo issue from the named repo's excerpt, not the newer one in another repo", async () => {
    const gh = fakeGitHub(
      routesOf(
        [REPO, 1, same("excerpt from the named repo")],
        [OTHER, 2, same("excerpt from the other repo")],
      ),
    );
    await scan.exec(["scan", REPO, OTHER, "--since", SINCE], gh, env);
    expect(await scan.issues()).toHaveLength(1);

    const model = stub(echo);
    const result = await withModel(gh, model.fetch);
    expect(result.code).toBe(0);
    expect(model.seen).toHaveLength(1);
    const sent = JSON.stringify(model.seen[0]);
    expect(sent).toContain("excerpt from the named repo");
    expect(sent).not.toContain("excerpt from the other repo");
    const [issue] = await scan.issues();
    expect(issue?.explanation?.repo).toBe(REPO);
    expect(result.out).toContain("1 explained");
  });

  it("makes no call for a known crash", async () => {
    const gh = fakeGitHub(routesOf([REPO, 1, log(err("opens", "Error: page.goto: Page crashed"))]));
    const model = stub(echo);
    const result = await withModel(gh, model.fetch);
    expect(result.code).toBe(0);
    expect(model.seen).toHaveLength(0);
    expect(result.out).toContain("explanations: 0 explained");
  });

  it("merges unexplained issues a proposed pattern also matches: two repos, one call", async () => {
    const gh = fakeGitHub(
      routesOf(
        [REPO, 1, log(err("uploads", "Error: ship api refused connection: ECONNREFUSED"))],
        [OTHER, 2, log(err("publishes", "Error: ship api refused connection: ECONNRESET"))],
      ),
    );
    const model = stub(() => ({
      content: reply({ pattern: ["ship api refused connection"], evidence: "Error: ship api" }),
    }));
    const result = await scan.exec(
      ["scan", REPO, OTHER, "--since", SINCE, ...MODEL_ARGS],
      gh,
      env,
      model.fetch,
    );
    expect(result.code).toBe(0);
    expect(model.seen).toHaveLength(1);
    expect(result.out).toContain("1 explained, 1 merged, 0 patterns rejected");

    const issues = await scan.issues();
    expect(issues).toHaveLength(1);
    // The pattern and both old keys, so a log with an old key still finds the issue.
    expect(issues[0]?.signatures).toHaveLength(3);
    const failures = await scan.failures();
    expect(failures.map((failure) => failure.repo).toSorted(compare)).toEqual([OTHER, REPO]);
    expect(new Set(failures.map((failure) => failure.issueId))).toEqual(new Set([issues[0]?.id]));
  });

  it("rejects a pattern that also matches an explained issue, and leaves both where they are", async () => {
    const first = log(err("a", "Error: ship api failed: timeout"));
    const gh = fakeGitHub(routesOf([REPO, 1, first]));
    const model = stub((user) => ({
      content: reply(
        user.includes("failed: timeout")
          ? { pattern: ["ship api failed: timeout"], component: "first" }
          : { pattern: ["ship api failed"], component: "second" },
      ),
    }));
    await withModel(gh, model.fetch);

    Object.assign(
      gh.routes,
      routesOf([REPO, 1, first], [REPO, 2, log(err("b", "Error: ship api failed: reset"))]),
    );
    const result = await withModel(gh, model.fetch);
    expect(result.out).toContain("1 explained, 0 merged, 1 patterns rejected");

    const issues = await scan.issues();
    expect(issues.map((issue) => issue.explanation?.component ?? "").toSorted(compare)).toEqual([
      "first",
      "second",
    ]);
    const second = issues.find((issue) => issue.explanation?.component === "second");
    expect(second?.signatures.every((sig) => sig.type === "key")).toBe(true);
    const failures = await scan.failures();
    expect(failures.map((failure) => failure.jobId).toSorted(compare)).toEqual([10, 20]);
    expect(new Set(failures.map((failure) => failure.issueId)).size).toBe(2);
  });

  it("keeps the explanation but no pattern when the pattern is not in the text later logs are matched on", async () => {
    const gh = fakeGitHub(routesOf([REPO, 1, log(err("uploads", "Error: ship link missing"))]));
    // Found in the excerpt (it is in the test's heading line), but a test is matched on its error line only.
    const model = stub(() => ({
      content: reply({
        pattern: ["e2e/upload.spec.ts:141:1"],
        evidence: "Error: ship link missing",
      }),
    }));
    const result = await withModel(gh, model.fetch);
    expect(result.out).toContain("1 explained, 0 merged, 1 patterns rejected");
    const [issue] = await scan.issues();
    expect(issue?.explanation).not.toBeNull();
    expect(issue?.signatures.every((sig) => sig.type === "key")).toBe(true);
  });

  it("rejects a pattern that matches a person-edited issue", async () => {
    const gh = fakeGitHub(
      routesOf(
        [REPO, 1, log(err("a", "Error: ship api failed: timeout"))],
        [REPO, 2, log(err("b", "Error: ship api failed: reset"))],
      ),
    );
    await scan.exec(SCAN, gh, env);
    const store = openSqliteStore(scan.storePath());
    try {
      const edited = (await store.readIssues()).find((issue) => issue.name.endsWith(": a"));
      await store.writeIssue({ ...edited!, name: "renamed by a person", edited: true });
    } finally {
      store.close();
    }

    const model = stub(() => ({ content: reply({ pattern: ["ship api failed"] }) }));
    const result = await withModel(gh, model.fetch);
    // The edited issue is never sent; only the other one is.
    expect(model.seen).toHaveLength(1);
    expect(result.out).toContain("1 explained, 0 merged, 1 patterns rejected");
    const issues = await scan.issues();
    expect(issues).toHaveLength(2);
    expect(issues.find((issue) => issue.edited)).toMatchObject({
      name: "renamed by a person",
      explanation: null,
    });
  });
});
