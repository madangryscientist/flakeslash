import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO, fakeGitHub, logPath, realRoutes } from "../../engine/test/github-fake.ts";
import type { ModelFetch } from "@hackcove/flakeslash-engine";
import { MODEL_ARGS, SCAN, echo, err, log, reply, stub } from "./model-stub.ts";
import { playwrightLog, routesOf, text, useScan } from "./scan-harness.ts";

const flakes = (out: string): unknown => JSON.parse(out).repos[0].flakes;

describe("flakeslash scan: explanations that go wrong or run out", () => {
  const scan = useScan();
  const env = { GITHUB_TOKEN: "ghp_test" };
  const withModel = (
    gh: { fetch: Parameters<typeof scan.exec>[1]["fetch"] },
    model: ModelFetch,
    extra: string[] = [],
  ) => scan.exec([...SCAN, ...MODEL_ARGS, ...extra], gh, env, model);
  it("exits 0 when model calls fail, and reports the count and the first error", async () => {
    const gh = fakeGitHub(
      routesOf([REPO, 1, log(err("a", "Error: one"))], [REPO, 2, log(err("b", "Error: two"))]),
    );
    const model = stub(() => ({ status: 401, content: "bad key" }));
    const result = await scan.exec([...SCAN, ...MODEL_ARGS, "--json"], gh, env, model.fetch);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out).explanations).toMatchObject({
      explained: 0,
      failedCalls: 1,
      firstError: expect.stringContaining("HTTP 401"),
      notExplained: { failed: 1, stopped: 1, cap: 0, noExcerpt: 0 },
    });

    const again = await withModel(gh, model.fetch);
    expect(again.code).toBe(0);
    expect(again.out).toContain("model calls failed: 1 (first error: HTTP 401");
    // No reply was a reply, so the jobs are tried again by a later scan.
    expect(model.seen).toHaveLength(2);
  });

  it("stores nothing for a reply that is not JSON or a pattern not in its excerpt, and never resends the job", async () => {
    const gh = fakeGitHub(
      routesOf([REPO, 1, log(err("a", "Error: one"))], [REPO, 2, log(err("b", "Error: two"))]),
    );
    const model = stub((_user, call) => ({
      content:
        call === 1 ? "I think this is a timeout." : reply({ pattern: ["not in the log at all"] }),
    }));
    const result = await scan.exec([...SCAN, ...MODEL_ARGS, "--json"], gh, env, model.fetch);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out).explanations).toMatchObject({
      explained: 0,
      failedCalls: 2,
      firstError: "the reply had no JSON object",
    });
    expect((await scan.issues()).map((issue) => issue.explanation)).toEqual([null, null]);

    const again = await scan.exec([...SCAN, ...MODEL_ARGS, "--json"], gh, env, model.fetch);
    expect(model.seen).toHaveLength(2);
    expect(JSON.parse(again.out).explanations.notExplained.noExcerpt).toBe(2);
  });

  it("gives the same flake list with and without the model", async () => {
    const failed = [126063284092, 126063283282, 126058067053, 126057955448];
    const routes = {
      ...realRoutes(),
      ...Object.fromEntries(failed.map((id) => [logPath(id), log(err("x", "Error: boom"))])),
    };
    const gh = fakeGitHub(routes);
    const model = stub(echo);
    const without = await scan.exec([...SCAN, "--json"], gh, env, model.fetch);
    expect(model.seen).toHaveLength(0);
    const other = join(scan.storePath(), "..", "with-model.db");
    const withIt = await scan.exec(
      [...SCAN, ...MODEL_ARGS, "--json", "--store", other],
      gh,
      env,
      model.fetch,
    );
    expect(model.seen.length).toBeGreaterThan(0);
    expect(flakes(withIt.out)).toEqual(flakes(without.out));
    expect(flakes(without.out)).toHaveLength(2);
  });

  it("stops at the cap with exit 0 and says how many it explained and how many it did not", async () => {
    const popular = log(err("a", "Error: popular failure"));
    const gh = fakeGitHub(
      routesOf(
        [REPO, 1, popular],
        [REPO, 2, popular],
        [REPO, 3, log(err("b", "Error: rare one"))],
        [REPO, 4, log(err("c", "Error: rare two"))],
      ),
    );
    // Each call is bounded at $2 (2000 tokens at $1000 per million) and costs $1 when it is made.
    const model = stub((user) => ({ ...echo(user), tokens: 1000 }));
    const result = await scan.exec(
      [
        ...SCAN,
        "--model-url",
        "https://llm.example/v1",
        "--model",
        "luna-test",
        "--cap-usd",
        "2.5",
        "--price-in",
        "0",
        "--price-out",
        "1000",
      ],
      gh,
      env,
      model.fetch,
    );
    expect(result.code).toBe(0);
    expect(model.seen).toHaveLength(1);
    expect(result.out).toContain("1 explained");
    expect(result.out).toContain("2 at the cap");
    expect(result.out).toContain("spent $1 of $2.5");
    // The cap is spent on the issue with the most failures.
    const explained = (await scan.issues()).filter((issue) => issue.explanation !== null);
    expect(explained.map((issue) => issue.explanation?.component)).toEqual([
      "Error: popular failure",
    ]);
  });

  it("sends the stored redacted excerpt and nothing else from the log", async () => {
    const secret = ["ghp_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"].join("");
    const marker = "MARKER-passing-step-7f3a9c1e";
    const raw = [
      "##[group]Run bun install",
      marker,
      "##[endgroup]",
      playwrightLog(err("uploads", `Error: push rejected for token ${secret}`)),
    ].join("\n");
    const gh = fakeGitHub(routesOf([REPO, 1, text(raw)]));
    const model = stub(echo);
    const result = await withModel(gh, model.fetch);
    expect(result.code).toBe(0);

    const [excerpt] = await scan.excerpts();
    expect(excerpt?.excerpt).toContain("[redacted]");
    expect(model.seen).toHaveLength(1);
    expect(model.seen[0]?.messages[1]?.content).toBe(`Job: CI / Gate\n\n${excerpt?.excerpt}`);
    const wire = JSON.stringify(model.seen[0]);
    expect(wire).not.toContain(secret);
    expect(wire).not.toContain(marker);
  });
});
