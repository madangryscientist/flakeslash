import { describe, expect, it } from "vitest";
import { parseExplanation } from "../src/index.ts";

const EXCERPT = [
  "##[group]Run bunx playwright test",
  "  1) [chromium] › e2e/upload.spec.ts:141:1 › the CLI uploads a snapshot dir ───",
  "    Test timeout of 30000ms exceeded.",
  "    waiting for getByRole('link', { name: 'ship settings' })",
  "##[error]Process completed with exit code 1.",
].join("\n");

const REPLY = {
  component: "e2e/upload.spec.ts:141",
  kind: "timeout",
  cause:
    "The click on the ship settings link timed out; why it never appeared is not visible in the excerpt.",
  evidence: "Test timeout of 30000ms exceeded.",
  pattern: ["waiting for getByRole('link', { name: 'ship settings' })"],
};

const parse = (reply: object | string, excerpt = EXCERPT) =>
  parseExplanation(typeof reply === "string" ? reply : JSON.stringify(reply), excerpt);

describe("parseExplanation", () => {
  it("reads a valid reply, and turns a one-string pattern into a list", () => {
    expect(parse(REPLY)).toEqual({
      ok: true,
      value: { ...REPLY, kind: "timeout", pattern: [REPLY.pattern[0]] },
    });
  });

  it("takes the object out of a code fence and chatter around it", () => {
    const fenced = `Here you go:\n\`\`\`json\n${JSON.stringify(REPLY)}\n\`\`\`\nHope that helps.`;
    expect(parse(fenced)).toMatchObject({ ok: true, value: { component: REPLY.component } });
  });

  it("keeps two pattern strings, trimmed, and turns an unknown kind into other", () => {
    const result = parse({
      ...REPLY,
      kind: "flaky",
      pattern: ["  Test timeout of 30000ms exceeded.  ", "waiting for getByRole('link'"],
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        kind: "other",
        pattern: ["Test timeout of 30000ms exceeded.", "waiting for getByRole('link'"],
      },
    });
  });

  it.each([
    ["text with no JSON", "I think this is a timeout."],
    ["JSON that does not parse", "{component: nope}"],
    ["a missing cause", { ...REPLY, cause: undefined }],
    ["no pattern", { ...REPLY, pattern: undefined }],
    [
      "three pattern strings",
      { ...REPLY, pattern: ["exit code 1", "ship settings", "Test timeout"] },
    ],
    ["a pattern string under 8 characters", { ...REPLY, pattern: ["exit 1"] }],
    ["a pattern that is not in the excerpt", { ...REPLY, pattern: ["waiting for the dashboard"] }],
    [
      "one pattern string in two not found",
      { ...REPLY, pattern: ["Test timeout of", "not in the log"] },
    ],
  ])("rejects %s", (_name, reply) => {
    const result = parse(reply);
    expect(result.ok).toBe(false);
  });
});
