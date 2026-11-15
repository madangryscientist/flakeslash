/**
 * A client that reaches a model through the local `claude` CLI in print mode, so it signs in with
 * whoever is logged in to that CLI. One call is one process: the system message goes in as the
 * system prompt, the user message on stdin, and the reply comes back as one JSON result object.
 * Spend is the `total_cost_usd` the CLI reports, its own estimate at API prices.
 */
import type { ModelClient, ModelMessage, ModelResult } from "./model.ts";
import { redact } from "./redact.ts";

/** Runs `claude` with `args`, writing `stdin`, killed after `timeoutMs`. A test stands in for it. */
export type ClaudeRun = (
  args: readonly string[],
  stdin: string,
  timeoutMs: number,
) => Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>;

export interface ClaudeCodeClientOptions {
  model: string;
  /** The most the client may spend, in USD, as the CLI reports cost. */
  capUsd: number;
  run: ClaudeRun;
  timeoutMs: number;
}

const ERROR_CHARS = 200;
/** A sign-in or an allowance that is gone: the next call would fail the same way. */
const STOPPING = /not logged in|please log in|usage limit|rate limit/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function textOf(messages: readonly ModelMessage[], role: string): string {
  return messages
    .filter((message) => message.role === role)
    .map((message) => message.content)
    .join("\n\n");
}

/** The arguments of one call: print mode, no tools, no session, no MCP, no user settings. */
function argsOf(model: string, system: string): string[] {
  return [
    "-p",
    "--output-format",
    "json",
    "--model",
    model,
    "--tools",
    "",
    "--no-session-persistence",
    "--strict-mcp-config",
    "--setting-sources",
    "project,local",
    "--system-prompt",
    system,
  ];
}

function parse(stdout: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

type RunOut = Awaited<ReturnType<ClaudeRun>>;

/** What a finished process said: its cost, then its text, a refusal to classify, or an error. */
type Reading = { costUsd: number } & ({ text: string } | { refused: string } | { error: string });

/** The cost the CLI reported; a missing or unusable one counts as 0. */
function costOf(body: Record<string, unknown> | undefined): number {
  const reported = body?.total_cost_usd;
  return typeof reported === "number" && Number.isFinite(reported) && reported >= 0 ? reported : 0;
}

/** Why a call the CLI refused failed: stderr, else the result text, else stdout. */
function detailOf(out: RunOut, result: string | undefined): string {
  const said = out.stderr.trim() === "" ? (result ?? out.stdout) : out.stderr;
  return `exit ${out.code ?? "none"}: ${said}`;
}

function readOut(out: RunOut): Reading {
  const body = parse(out.stdout);
  const result = typeof body?.result === "string" ? body.result : undefined;
  // What a call that ran reports it cost counts even when the reply is unusable.
  const costUsd = costOf(body);
  if (out.code !== 0 || body?.is_error === true) {
    return { costUsd, refused: detailOf(out, result) };
  }
  if (body === undefined) return { costUsd, error: "stdout was not JSON" };
  if (result === undefined) return { costUsd, error: "no result text" };
  return { costUsd, text: result };
}

function failed(error: string): ModelResult {
  return { ok: false, reason: "failed", error: redact(error).slice(0, ERROR_CHARS) };
}

export function createClaudeCodeClient(options: ClaudeCodeClientOptions): ModelClient {
  let spentUsd = 0;
  let stopped: string | null = null;

  /** A refused call; one that says the sign-in or allowance is gone stops every later call. */
  const refuse = (detail: string): ModelResult => {
    if (!STOPPING.test(detail)) return failed(detail);
    const error = redact(detail).slice(0, ERROR_CHARS);
    stopped = `the claude CLI refused: ${error}`;
    return { ok: false, reason: "stopped", error };
  };

  const complete: ModelClient["complete"] = async (messages) => {
    if (stopped !== null) return { ok: false, reason: "stopped", error: stopped };
    // Written so that a cap which is not a number refuses the call.
    if (!(spentUsd < options.capUsd)) {
      return {
        ok: false,
        reason: "cap",
        error: `the cap is $${options.capUsd} and $${spentUsd} is spent`,
      };
    }

    const args = argsOf(options.model, textOf(messages, "system"));
    let out: RunOut;
    try {
      out = await options.run(args, textOf(messages, "user"), options.timeoutMs);
    } catch (error) {
      return failed(error instanceof Error ? error.message : String(error));
    }
    if (out.timedOut) return failed(`timed out after ${options.timeoutMs} ms`);

    const read = readOut(out);
    spentUsd += read.costUsd;
    if ("text" in read) return { ok: true, text: read.text, costUsd: read.costUsd };
    if ("refused" in read) return refuse(read.refused);
    return failed(read.error);
  };

  return {
    complete,
    get spentUsd() {
      return spentUsd;
    },
    get stopped() {
      return stopped;
    },
  };
}
