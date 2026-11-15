import { describe, expect, it } from "vitest";
import { createClaudeCodeClient, type ClaudeRun, type ModelResult } from "../src/index.ts";

type Out = Awaited<ReturnType<ClaudeRun>>;

interface Seen {
  args: readonly string[];
  stdin: string;
  timeoutMs: number;
}

/** A fake `claude`: each call takes the next output from `outs` (the last one repeats). */
function fake(outs: Out[]): { run: ClaudeRun; seen: Seen[] } {
  const seen: Seen[] = [];
  const run: ClaudeRun = async (args, stdin, timeoutMs) => {
    seen.push({ args, stdin, timeoutMs });
    const next = outs[Math.min(seen.length - 1, outs.length - 1)];
    if (next === undefined) throw new Error("no output set");
    return next;
  };
  return { run, seen };
}

const ok = (body: Record<string, unknown>): Out => ({
  code: 0,
  stdout: JSON.stringify({ type: "result", is_error: false, ...body }),
  stderr: "",
  timedOut: false,
});

const MESSAGES = [
  { role: "system", content: "You explain failures." },
  { role: "user", content: "Error: ship api failed" },
];

const client = (run: ClaudeRun, capUsd = 1) =>
  createClaudeCodeClient({ model: "claude-haiku-5-5", capUsd, run, timeoutMs: 5000 });

const call = (c: ReturnType<typeof client>): Promise<ModelResult> =>
  c.complete(MESSAGES, { maxTokens: 2000 });

/** A runner that cannot start `claude`. */
const missing: ClaudeRun = async () => {
  throw new Error("spawn claude ENOENT");
};

describe("createClaudeCodeClient", () => {
  it("runs claude in print mode with no tools, session, MCP or bare mode, the user message on stdin", async () => {
    const { run, seen } = fake([ok({ result: "an answer", total_cost_usd: 0.01 })]);
    const result = await call(client(run));
    expect(result).toEqual({ ok: true, text: "an answer", costUsd: 0.01 });

    const [first] = seen;
    const args = first?.args ?? [];
    const after = (flag: string) => args[args.indexOf(flag) + 1];
    expect(args).toContain("-p");
    expect(after("--output-format")).toBe("json");
    expect(after("--tools")).toBe("");
    expect(args).toContain("--no-session-persistence");
    expect(args).toContain("--strict-mcp-config");
    expect(after("--setting-sources")).toBe("project,local");
    expect(after("--model")).toBe("claude-haiku-5-5");
    expect(after("--system-prompt")).toBe("You explain failures.");
    expect(args).not.toContain("--bare");
    expect(first?.stdin).toBe("Error: ship api failed");
    expect(first?.timeoutMs).toBe(5000);
  });

  it("adds total_cost_usd up in spentUsd, and counts a missing cost as 0", async () => {
    const { run } = fake([
      ok({ result: "a", total_cost_usd: 0.25 }),
      ok({ result: "b", total_cost_usd: 0.5 }),
      ok({ result: "c" }),
    ]);
    const c = client(run);
    await call(c);
    await call(c);
    expect(c.spentUsd).toBe(0.75);
    expect(await call(c)).toEqual({ ok: true, text: "c", costUsd: 0 });
    expect(c.spentUsd).toBe(0.75);
  });

  it("refuses a call at or over the cap without running claude", async () => {
    const { run, seen } = fake([ok({ result: "a", total_cost_usd: 1 })]);
    const c = client(run, 1);
    expect((await call(c)).ok).toBe(true);
    const refused = await call(c);
    expect(refused).toMatchObject({ ok: false, reason: "cap" });
    expect(seen).toHaveLength(1);
  });

  it.each<[string, Out]>([
    [
      "is_error",
      {
        code: 0,
        stdout: JSON.stringify({ is_error: true, result: "API Error: 500 overloaded" }),
        stderr: "",
        timedOut: false,
      },
    ],
    ["a non-zero exit", { code: 1, stdout: "", stderr: "something broke", timedOut: false }],
    ["a timeout", { code: null, stdout: "", stderr: "", timedOut: true }],
    ["bad JSON", { code: 0, stdout: "not json {", stderr: "", timedOut: false }],
  ])("returns failed for %s, and the next call still goes out", async (_name, out) => {
    const { run, seen } = fake([out, ok({ result: "fine" })]);
    const c = client(run);
    expect(await call(c)).toMatchObject({ ok: false, reason: "failed" });
    expect(c.stopped).toBeNull();
    expect((await call(c)).ok).toBe(true);
    expect(seen).toHaveLength(2);
  });

  it("redacts and cuts the error detail", async () => {
    const secret = `ghp_${"a".repeat(36)}`;
    const { run } = fake([
      { code: 1, stdout: "", stderr: `token ${secret} ${"x".repeat(500)}`, timedOut: false },
    ]);
    const result = await call(client(run));
    const error = result.ok ? "" : result.error;
    expect(error).not.toContain(secret);
    expect(error.length).toBeLessThanOrEqual(200);
  });

  it.each([
    ["not logged in", { code: 1, stdout: "", stderr: "Not logged in. Please run /login" }],
    [
      "a usage limit",
      {
        code: 0,
        stdout: JSON.stringify({ is_error: true, result: "Claude usage limit reached" }),
        stderr: "",
      },
    ],
    [
      "a usage limit in the result with a warning on stderr",
      {
        code: 1,
        stdout: JSON.stringify({ is_error: true, result: "Claude usage limit reached" }),
        stderr: "warning: an update is available",
      },
    ],
  ])("returns stopped for %s and refuses the next call without running claude", async (_n, out) => {
    const { run, seen } = fake([{ ...out, timedOut: false }]);
    const c = client(run);
    expect(await call(c)).toMatchObject({ ok: false, reason: "stopped" });
    expect(c.stopped).not.toBeNull();
    expect(await call(c)).toMatchObject({ ok: false, reason: "stopped" });
    expect(seen).toHaveLength(1);
  });

  it("does not stop on a successful reply that mentions a rate limit", async () => {
    const { run } = fake([ok({ result: "the job hit a rate limit", total_cost_usd: 0 })]);
    const c = client(run);
    expect((await call(c)).ok).toBe(true);
    expect(c.stopped).toBeNull();
  });

  it("stops when claude cannot start, and refuses the next call", async () => {
    let runs = 0;
    const counted: ClaudeRun = async (...args) => {
      runs += 1;
      return missing(...args);
    };
    const c = client(counted);
    expect(await call(c)).toMatchObject({
      ok: false,
      reason: "stopped",
      error: "spawn claude ENOENT",
    });
    expect(await call(c)).toMatchObject({ ok: false, reason: "stopped" });
    expect(runs).toBe(1);
  });
});
