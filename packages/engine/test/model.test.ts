import { describe, expect, it } from "vitest";
import {
  createModelClient,
  type ModelClientOptions,
  type ModelFetch,
  type ModelResult,
} from "../src/index.ts";
import type { FetchResponse } from "../src/providers/github-api.ts";

interface Seen {
  url: string;
  headers: Record<string, string>;
  body: { model: string; messages: unknown; max_tokens: number };
}

/** A stub endpoint: each call takes the next reply from `replies` (the last one repeats). */
function stub(replies: Array<() => Promise<FetchResponse> | FetchResponse>): {
  fetch: ModelFetch;
  seen: Seen[];
} {
  const seen: Seen[] = [];
  const fetch: ModelFetch = async (url, init) => {
    seen.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const next = replies[Math.min(seen.length - 1, replies.length - 1)];
    if (next === undefined) throw new Error("no reply set");
    return next();
  };
  return { fetch, seen };
}

function reply(status: number, body: unknown): () => FetchResponse {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return () => ({
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null, has: () => false },
    json: async () => JSON.parse(text),
    text: async () => text,
  });
}

const answer = (content: string, usage?: unknown): unknown => ({
  choices: [{ message: { role: "assistant", content } }],
  ...(usage === undefined ? {} : { usage }),
});

/** The error text of a result, or "" for one that succeeded. */
function errorOf(result: ModelResult): string {
  return result.ok ? "" : result.error;
}

const MESSAGES = [{ role: "user", content: "hi" }];

// The input price is 0 and the output price is $1 per token, so a call with max_tokens 10 is
// bounded at exactly $10, and a reply of 10 completion tokens costs exactly $10.
function client(fetch: ModelFetch, overrides: Partial<ModelClientOptions> = {}) {
  return createModelClient({
    url: "https://llm.example/v1",
    key: "k-test-key",
    model: "m",
    capUsd: 25,
    priceIn: 0,
    priceOut: 1e6,
    headers: {},
    userAgent: "flakeslash/0.0.0",
    fetch,
    ...overrides,
  });
}

const usage = (completion: number, prompt = 0): unknown => ({
  prompt_tokens: prompt,
  completion_tokens: completion,
});

describe("createModelClient", () => {
  it("posts the chat request and returns the first choice's text", async () => {
    const { fetch, seen } = stub([reply(200, answer("hello", usage(10)))]);
    const result = await client(fetch, { url: "https://llm.example/v1/" }).complete(MESSAGES, {
      maxTokens: 10,
    });
    expect(result).toEqual({ ok: true, text: "hello", costUsd: 10 });
    expect(seen[0]?.url).toBe("https://llm.example/v1/chat/completions");
    expect(seen[0]?.body).toEqual({ model: "m", messages: MESSAGES, max_tokens: 10 });
  });

  it("adds up spend from usage and does not make the call that would pass the cap", async () => {
    const { fetch, seen } = stub([reply(200, answer("a", usage(10)))]);
    const model = client(fetch);
    expect((await model.complete(MESSAGES, { maxTokens: 10 })).ok).toBe(true);
    expect((await model.complete(MESSAGES, { maxTokens: 10 })).ok).toBe(true);
    expect(model.spentUsd).toBe(20);
    expect(seen).toHaveLength(2);

    const third = await model.complete(MESSAGES, { maxTokens: 10 });
    expect(third).toMatchObject({ ok: false, reason: "cap" });
    expect(seen).toHaveLength(2);
    expect(model.spentUsd).toBe(20);
    expect(model.stopped).toBeNull();

    // A smaller call that still fits under the cap goes out.
    expect((await model.complete(MESSAGES, { maxTokens: 5 })).ok).toBe(true);
    expect(seen).toHaveLength(3);
  });

  it("bounds the cost by the request's size at the input price", async () => {
    const { fetch, seen } = stub([reply(200, answer("a", usage(0)))]);
    // The body is more than 20 bytes, so at $1 per byte the call cannot fit under $20.
    const model = client(fetch, { priceIn: 1e6, priceOut: 0, capUsd: 20 });
    expect(await model.complete(MESSAGES, { maxTokens: 1 })).toMatchObject({
      ok: false,
      reason: "cap",
    });
    expect(seen).toHaveLength(0);
  });

  it("charges prompt and completion tokens at their own prices", async () => {
    const { fetch } = stub([reply(200, answer("a", usage(3, 2)))]);
    const model = client(fetch, { priceIn: 2e6, priceOut: 5e6, capUsd: 1e9 });
    const result = await model.complete(MESSAGES, { maxTokens: 3 });
    expect(result).toMatchObject({ ok: true, costUsd: 2 * 2 + 3 * 5 });
    expect(model.spentUsd).toBe(19);
  });

  it("stops further calls when a response has no usage figures, counting the worst case", async () => {
    const { fetch, seen } = stub([
      reply(200, answer("no usage")),
      reply(200, answer("never reached", usage(1))),
    ]);
    const model = client(fetch);
    const first = await model.complete(MESSAGES, { maxTokens: 10 });
    expect(first).toEqual({ ok: true, text: "no usage", costUsd: 10 });
    expect(model.spentUsd).toBe(10);
    expect(model.stopped).not.toBeNull();

    expect(await model.complete(MESSAGES, { maxTokens: 1 })).toMatchObject({
      ok: false,
      reason: "stopped",
    });
    expect(seen).toHaveLength(1);
  });

  it.each([
    ["a missing count", { prompt_tokens: 1 }],
    ["a count that is not a number", { prompt_tokens: "1", completion_tokens: 1 }],
    ["a negative count", { prompt_tokens: 1, completion_tokens: -1 }],
    ["usage that is null", null],
  ])("treats %s as no usage", async (_name, badUsage) => {
    const { fetch } = stub([reply(200, answer("x", badUsage))]);
    const model = client(fetch);
    expect((await model.complete(MESSAGES, { maxTokens: 10 })).ok).toBe(true);
    expect(model.stopped).not.toBeNull();
  });

  it("returns a failed result, costs nothing, and carries on after a thrown fetch", async () => {
    const { fetch, seen } = stub([
      () => {
        throw new Error("socket hang up");
      },
      reply(200, answer("back", usage(10))),
    ]);
    const model = client(fetch);
    expect(await model.complete(MESSAGES, { maxTokens: 10 })).toEqual({
      ok: false,
      reason: "failed",
      error: "socket hang up",
    });
    expect(model.spentUsd).toBe(0);
    expect(model.stopped).toBeNull();
    expect((await model.complete(MESSAGES, { maxTokens: 10 })).ok).toBe(true);
    expect(seen).toHaveLength(2);
  });

  it("returns a failed result, costs nothing, and carries on after a 500", async () => {
    const { fetch, seen } = stub([
      reply(500, "upstream broke"),
      reply(200, answer("back", usage(10))),
    ]);
    const model = client(fetch);
    expect(await model.complete(MESSAGES, { maxTokens: 10 })).toEqual({
      ok: false,
      reason: "failed",
      error: "HTTP 500: upstream broke",
    });
    expect(model.spentUsd).toBe(0);
    expect((await model.complete(MESSAGES, { maxTokens: 10 })).ok).toBe(true);
    expect(seen).toHaveLength(2);
  });

  it("fails on a 2xx body that is not JSON, counts the worst case and stops", async () => {
    const { fetch, seen } = stub([reply(200, "<html>gateway</html>")]);
    const model = client(fetch);
    expect(await model.complete(MESSAGES, { maxTokens: 10 })).toMatchObject({
      ok: false,
      reason: "failed",
    });
    expect(model.spentUsd).toBe(10);
    expect(model.stopped).not.toBeNull();
    expect(await model.complete(MESSAGES, { maxTokens: 1 })).toMatchObject({ reason: "stopped" });
    expect(seen).toHaveLength(1);
  });

  it("stops after a 2xx with no content and no usage, since spend is unknown", async () => {
    const { fetch } = stub([reply(200, { choices: [] })]);
    const model = client(fetch);
    expect(await model.complete(MESSAGES, { maxTokens: 10 })).toMatchObject({ reason: "failed" });
    expect(model.spentUsd).toBe(10);
    expect(model.stopped).not.toBeNull();
  });

  it("stops when the endpoint spends more than max_tokens allows", async () => {
    const { fetch } = stub([reply(200, answer("long", usage(30)))]);
    const model = client(fetch, { capUsd: 1000 });
    expect((await model.complete(MESSAGES, { maxTokens: 10 })).ok).toBe(true);
    expect(model.spentUsd).toBe(30);
    expect(model.stopped).not.toBeNull();
  });

  it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses a maxTokens of %s without a call",
    async (maxTokens) => {
      const { fetch, seen } = stub([reply(200, answer("x", usage(1)))]);
      expect(await client(fetch).complete(MESSAGES, { maxTokens })).toMatchObject({
        reason: "failed",
      });
      expect(seen).toHaveLength(0);
    },
  );

  it("fails on a 2xx with no string content, and charges the usage it reported", async () => {
    const { fetch } = stub([
      reply(200, { choices: [{ message: { content: null } }], usage: usage(4) }),
      reply(200, { choices: [], usage: usage(3) }),
    ]);
    const model = client(fetch);
    expect(await model.complete(MESSAGES, { maxTokens: 10 })).toMatchObject({
      ok: false,
      reason: "failed",
    });
    expect(model.spentUsd).toBe(4);
    expect(model.stopped).toBeNull();
    expect(await model.complete(MESSAGES, { maxTokens: 10 })).toMatchObject({ reason: "failed" });
    expect(model.spentUsd).toBe(7);
  });

  it.each([401, 402, 403])("makes no further calls after a %i", async (status) => {
    const { fetch, seen } = stub([
      reply(status, "no allowance"),
      reply(200, answer("x", usage(1))),
    ]);
    const model = client(fetch);
    expect(await model.complete(MESSAGES, { maxTokens: 10 })).toMatchObject({
      ok: false,
      reason: "failed",
    });
    expect(model.stopped).toContain(String(status));
    expect(model.spentUsd).toBe(0);

    expect(await model.complete(MESSAGES, { maxTokens: 10 })).toMatchObject({
      ok: false,
      reason: "stopped",
    });
    expect(seen).toHaveLength(1);
  });

  it("sends the user agent, the bearer key and the extra headers", async () => {
    const { fetch, seen } = stub([reply(200, answer("x", usage(1)))]);
    await client(fetch, {
      headers: { "x-opencode-session": "s-1" },
    }).complete(MESSAGES, { maxTokens: 10 });
    expect(seen[0]?.headers).toEqual({
      "content-type": "application/json",
      "user-agent": "flakeslash/0.0.0",
      authorization: "Bearer k-test-key",
      "x-opencode-session": "s-1",
    });
  });

  it("lets an extra header replace a default of the same name in any case", async () => {
    const { fetch, seen } = stub([reply(200, answer("x", usage(1)))]);
    await client(fetch, { headers: { "User-Agent": "custom/1" } }).complete(MESSAGES, {
      maxTokens: 10,
    });
    const headers = seen[0]?.headers ?? {};
    expect(headers["User-Agent"]).toBe("custom/1");
    expect(Object.keys(headers).filter((name) => name.toLowerCase() === "user-agent")).toHaveLength(
      1,
    );
  });

  it("sends no authorization header when there is no key", async () => {
    const { fetch, seen } = stub([reply(200, answer("x", usage(1)))]);
    await client(fetch, { key: undefined }).complete(MESSAGES, { maxTokens: 10 });
    expect(Object.keys(seen[0]?.headers ?? {})).not.toContain("authorization");
  });

  it("never puts the key in an error, even when the endpoint echoes it", async () => {
    const key = "plain-key-1234";
    const { fetch } = stub([reply(401, `bad credential ${key} and Bearer ${key}`)]);
    const result = await client(fetch, { key }).complete(MESSAGES, { maxTokens: 10 });
    expect(errorOf(result)).toContain("HTTP 401");
    expect(errorOf(result)).not.toContain(key);

    const thrown = stub([
      () => {
        throw new Error(`could not reach host with ${key}`);
      },
    ]);
    const second = await client(thrown.fetch, { key }).complete(MESSAGES, { maxTokens: 10 });
    expect(errorOf(second)).toContain("could not reach host");
    expect(errorOf(second)).not.toContain(key);
  });

  it("keeps only the first 200 characters of an error body", async () => {
    const { fetch } = stub([reply(500, "x".repeat(1000))]);
    const result = await client(fetch).complete(MESSAGES, { maxTokens: 10 });
    expect(errorOf(result)).toBe(`HTTP 500: ${"x".repeat(200)}`);
  });
});
