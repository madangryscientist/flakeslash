/**
 * A client for the user's own OpenAI-compatible endpoint, with a spending cap it cannot pass.
 * Spend is the token usage a response reports times the prices the user gave; nothing is assumed
 * about any provider. There is no prompt text here: callers bring their own messages.
 */
import { redact } from "./redact.ts";
import type { FetchResponse } from "./providers/github-api.ts";

/** The slice of a POST `fetch` the client uses, so a test (or a proxy) can stand in for it. */
export type ModelFetch = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string },
) => Promise<FetchResponse>;

export interface ModelMessage {
  role: string;
  content: string;
}

export interface ModelClientOptions {
  /** The endpoint's base URL; `/chat/completions` is added to it. */
  url: string;
  /** Sent as a bearer token. Undefined for an endpoint that needs none. */
  key: string | undefined;
  model: string;
  /** The most the client may spend, in USD. */
  capUsd: number;
  /** USD per million prompt tokens. */
  priceIn: number;
  /** USD per million completion tokens. */
  priceOut: number;
  /** Extra headers, applied after the defaults; a repeated name (any case) replaces the earlier one. */
  headers: Readonly<Record<string, string>>;
  userAgent: string;
  fetch: ModelFetch;
}

export type ModelResult =
  | { ok: true; text: string; costUsd: number }
  | { ok: false; reason: "cap" | "stopped" | "failed"; error: string };

export interface ModelClient {
  complete(messages: readonly ModelMessage[], options: { maxTokens: number }): Promise<ModelResult>;
  /** USD spent so far, as far as it can be known. Calls are meant to be made one at a time. */
  readonly spentUsd: number;
  /** Null while calls may go out; otherwise why every later call is refused. */
  readonly stopped: string | null;
}

const MILLION = 1e6;
/** A refused credential or an exhausted allowance: the next call would fail the same way. */
const STOPPING_STATUSES: ReadonlySet<number> = new Set([401, 402, 403]);
const ERROR_BODY_CHARS = 200;

const encoder = new TextEncoder();

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** The first choice's text, or undefined when the body does not carry a string there. */
function contentOf(body: unknown): string | undefined {
  const choices = isRecord(body) ? body.choices : undefined;
  const first: unknown = Array.isArray(choices) ? choices[0] : undefined;
  const message = isRecord(first) ? first.message : undefined;
  const content = isRecord(message) ? message.content : undefined;
  return typeof content === "string" ? content : undefined;
}

/** The USD a body's usage figures come to, or undefined when either count is missing or unusable. */
function costOf(body: unknown, priceIn: number, priceOut: number): number | undefined {
  const usage = isRecord(body) ? body.usage : undefined;
  if (!isRecord(usage)) return undefined;
  const { prompt_tokens: promptTokens, completion_tokens: completionTokens } = usage;
  if (!isCount(promptTokens) || !isCount(completionTokens)) return undefined;
  return (promptTokens * priceIn) / MILLION + (completionTokens * priceOut) / MILLION;
}

function failed(error: string): ModelResult {
  return { ok: false, reason: "failed", error };
}

/** The headers of one request: the defaults, then the extras, a repeated name (any case) replacing. */
function requestHeaders(options: ModelClientOptions): Record<string, string> {
  const byName = new Map<string, [string, string]>();
  const put = (name: string, value: string): void => {
    byName.set(name.toLowerCase(), [name, value]);
  };
  put("content-type", "application/json");
  put("user-agent", options.userAgent);
  if (options.key !== undefined) put("authorization", `Bearer ${options.key}`);
  for (const [name, value] of Object.entries(options.headers)) put(name, value);
  return Object.fromEntries(byName.values());
}

/** Error text for a caller: the key removed, then secret-shaped values redacted. */
function clean(text: string, key: string | undefined): string {
  const withoutKey = key === undefined || key === "" ? text : text.split(key).join("[redacted]");
  return redact(withoutKey);
}

async function bodyText(res: FetchResponse): Promise<string> {
  try {
    return await res.text();
  } catch {
    // The status is what matters; an unreadable body leaves the detail empty.
    return "";
  }
}

/** The most a call can cost. A token is at least one byte, so this is never under the real cost. */
function boundOf(options: ModelClientOptions, body: string, maxTokens: number): number {
  return (
    (encoder.encode(body).length * options.priceIn) / MILLION +
    (maxTokens * options.priceOut) / MILLION
  );
}

export function createModelClient(options: ModelClientOptions): ModelClient {
  const endpoint = `${options.url.replace(/\/+$/, "")}/chat/completions`;
  let spentUsd = 0;
  let stopped: string | null = null;

  /** Turns a 2xx response into a result, counting what it cost. */
  const settle = async (res: FetchResponse, bound: number): Promise<ModelResult> => {
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      parsed = undefined;
    }
    const text = contentOf(parsed);
    const cost = costOf(parsed, options.priceIn, options.priceOut);
    let costUsd: number;
    if (cost === undefined) {
      // The endpoint answered, so it may have billed, and spend can no longer be known: count the
      // worst case and refuse every later call.
      costUsd = bound;
      stopped = "the response reported no token usage, so spend cannot be known";
    } else {
      // The provider bills what it reports, even for an answer we cannot use.
      costUsd = cost;
      // The bound assumed max_tokens was kept; an endpoint that ignores it can overrun the cap.
      if (cost > bound) stopped = "the endpoint spent more than max_tokens allows";
    }
    spentUsd += costUsd;
    if (text === undefined) return failed("the response had no choices[0].message.content");
    return { ok: true, text, costUsd };
  };

  const complete: ModelClient["complete"] = async (messages, { maxTokens }) => {
    if (stopped !== null) return { ok: false, reason: "stopped", error: stopped };
    if (!(maxTokens > 0 && Number.isFinite(maxTokens))) return failed("maxTokens must be above 0");

    const body = JSON.stringify({ model: options.model, messages, max_tokens: maxTokens });
    const bound = boundOf(options, body, maxTokens);
    // Written so that a bound which is not a number refuses the call.
    if (!(spentUsd + bound <= options.capUsd)) {
      return {
        ok: false,
        reason: "cap",
        error: `the call could cost up to $${bound} and the cap is $${options.capUsd} with $${spentUsd} spent`,
      };
    }

    let res: FetchResponse;
    try {
      const headers = requestHeaders(options);
      res = await options.fetch(endpoint, { method: "POST", headers, body });
    } catch (error) {
      return failed(clean(error instanceof Error ? error.message : String(error), options.key));
    }
    if (res.ok) return settle(res, bound);

    if (STOPPING_STATUSES.has(res.status)) stopped = `the endpoint answered HTTP ${res.status}`;
    const detail = clean(await bodyText(res), options.key).slice(0, ERROR_BODY_CHARS);
    return failed(`HTTP ${res.status}: ${detail}`);
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
