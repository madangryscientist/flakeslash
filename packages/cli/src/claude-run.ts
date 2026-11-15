/**
 * The real `ClaudeRun`: spawns `claude` from PATH in a fresh empty directory under the temp dir, so
 * no repo's CLAUDE.md, hooks or settings load, writes the prompt to stdin and kills it on a timeout.
 * An Anthropic API key in the environment is not passed on: `claude` would bill it instead of the
 * signed-in account.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClaudeRun } from "@hackcove/flakeslash-engine";

const NOT_PASSED = new Set(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]);

/** This process's environment, without an Anthropic API key or auth token. */
export function claudeEnv(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && !NOT_PASSED.has(name)) kept[name] = value;
  }
  return kept;
}

export const CLAUDE_TIMEOUT_MS = 120_000;

export const runClaude: ClaudeRun = async (args, stdin, timeoutMs) => {
  const cwd = mkdtempSync(join(tmpdir(), "flakeslash-claude-"));
  try {
    const child = Bun.spawn(["claude", ...args], {
      cwd,
      env: claudeEnv(process.env),
      stdin: new Blob([stdin]),
      stdout: "pipe",
      stderr: "pipe",
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { code, stdout, stderr, timedOut };
    } finally {
      clearTimeout(timer);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
};
