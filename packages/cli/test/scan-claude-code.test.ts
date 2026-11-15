import type { ClaudeRun } from "@hackcove/flakeslash-engine";
import { describe, expect, it } from "vitest";
import { REPO, fakeGitHub } from "../../engine/test/github-fake.ts";
import { SCAN, err, log, reply } from "./model-stub.ts";
import { routesOf, useScan } from "./scan-harness.ts";

describe("flakeslash scan --model-via claude-code", () => {
  const scan = useScan();
  const env = { GITHUB_TOKEN: "ghp_test" };
  const VIA = ["--model-via", "claude-code", "--model", "claude-test", "--cap-usd", "1"];

  it("explains an unexplained issue through the claude runner", async () => {
    const error = "Error: ship link never appeared: waiting for the ship settings link";
    const gh = fakeGitHub(routesOf([REPO, 1, log(err("uploads a file", error))]));
    const seen: { args: readonly string[]; stdin: string }[] = [];
    const claudeRun: ClaudeRun = async (args, stdin) => {
      seen.push({ args, stdin });
      const result = reply({ evidence: error, pattern: ["waiting for the ship settings link"] });
      return {
        code: 0,
        stdout: JSON.stringify({ is_error: false, result, total_cost_usd: 0.002 }),
        stderr: "",
        timedOut: false,
      };
    };

    const result = await scan.exec([...SCAN, ...VIA], gh, env, { claudeRun });
    expect(result.code).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.args).toContain("claude-test");
    expect(seen[0]?.stdin).toContain("ship link never appeared");
    expect(result.out).toContain("1 explained");
    expect((await scan.issues())[0]?.explanation).toMatchObject({ model: "claude-test" });
  });
});
