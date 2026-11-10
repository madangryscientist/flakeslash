import type { ModelFetch } from "@hackcove/flakeslash-engine";
import { REPO } from "../../engine/test/github-fake.ts";
import { SINCE, playwrightLog, text } from "./scan-harness.ts";

export const MODEL_ARGS = [
  "--model-url",
  "https://llm.example/v1",
  "--model",
  "luna-test",
  "--cap-usd",
  "1",
  "--price-in",
  "0",
  "--price-out",
  "0",
];
export const SCAN = ["scan", REPO, "--since", SINCE];

export interface Sent {
  messages: { role: string; content: string }[];
  max_tokens: number;
}

export interface Answer {
  status?: number;
  content?: string;
  /** Completion tokens reported as used. */
  tokens?: number;
}

/** A stub endpoint: `answer` gets the user message and the call number (from 1). */
export function stub(answer: (user: string, call: number) => Answer) {
  const seen: Sent[] = [];
  const fetch: ModelFetch = async (_url, init) => {
    const body: Sent = JSON.parse(init.body);
    seen.push(body);
    const {
      status = 200,
      content = "",
      tokens = 0,
    } = answer(body.messages[1]?.content ?? "", seen.length);
    const payload =
      status === 200
        ? JSON.stringify({
            choices: [{ message: { role: "assistant", content } }],
            usage: { prompt_tokens: 0, completion_tokens: tokens },
          })
        : content;
    return {
      status,
      ok: status === 200,
      headers: { get: () => null, has: () => false },
      json: async () => JSON.parse(payload),
      text: async () => payload,
    };
  };
  return { fetch, seen };
}

export const reply = (over: Record<string, unknown>): string =>
  JSON.stringify({
    component: "e2e/upload.spec.ts:141",
    kind: "timeout",
    cause: "The click timed out; why is not visible in the excerpt.",
    evidence: "Error: something",
    pattern: ["Error: something"],
    ...over,
  });

/** Answers with the excerpt's own `Error:` line as component and pattern. */
export const echo = (user: string): Answer => {
  const line = /Error: [^\n]+/.exec(user)?.[0] ?? "no error line";
  return { content: reply({ component: line, evidence: line, pattern: [line] }) };
};

export const err = (title: string, line: string): [string, string] => [title, line];
export const log = (...tests: [string, string][]) => text(playwrightLog(...tests));
