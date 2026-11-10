/**
 * The model's side of an explanation: the prompt that is sent, and the reader of the reply. A
 * reply is data to check, never to trust: anything that is not valid, or a pattern that is not
 * found in the excerpt that was sent, is a reason, never a guess.
 */
import { KINDS, type Kind } from "./starter-signatures.ts";

/** Reasoning models count their thinking as output, so this leaves room for it. */
export const MAX_TOKENS = 2000;
/** A pattern string shorter than this would match far too much. */
const MIN_PATTERN_CHARS = 8;

export const SYSTEM_PROMPT = `You read the log excerpt of one failed CI job and explain what broke. Secrets were removed from the excerpt before you saw it.

Answer with one JSON object and nothing else. Its keys:
- "component": the test that failed, as file:line or its full name, or the CI step or tool that broke.
- "kind": one of ${KINDS.join(", ")}.
- "cause": one or two sentences, grounded in the excerpt. If the excerpt does not show why it failed, write "not visible in the excerpt".
- "evidence": one line copied exactly from the excerpt that shows the failure.
- "pattern": one string, or an array of two strings, copied exactly from the excerpt. Each string is at least ${MIN_PATTERN_CHARS} characters, and together they pick out this same failure in other logs. Leave out run ids, durations, ports, temp paths and any number that changes between runs.

Do not say whether the failure looks flaky.`;

/** What a valid reply carries, with `pattern` as the literal strings that must all appear. */
export interface ParsedExplanation {
  component: string;
  kind: Kind;
  cause: string;
  evidence: string;
  pattern: [string] | [string, string];
}

export type ParseResult = { ok: true; value: ParsedExplanation } | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function kindOf(value: string): Kind {
  return KINDS.find((known) => known === value.trim()) ?? "other";
}

/** The object in a reply: the text from the first `{` to the last `}` (drops a fence or chatter). */
function readObject(
  reply: string,
): { ok: true; value: Record<string, unknown> } | { ok: false; reason: string } {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end < start) return { ok: false, reason: "the reply had no JSON object" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply.slice(start, end + 1));
  } catch {
    return { ok: false, reason: "the reply was not valid JSON" };
  }
  if (!isRecord(parsed)) return { ok: false, reason: "the reply was not a JSON object" };
  return { ok: true, value: parsed };
}

/** The first text field that is missing, as a reason, or null. */
function missingField(object: Record<string, unknown>): string | null {
  if (!nonEmpty(object["component"])) return 'the reply had no "component"';
  if (typeof object["kind"] !== "string") return 'the reply had no "kind"';
  if (!nonEmpty(object["cause"])) return 'the reply had no "cause"';
  if (!nonEmpty(object["evidence"])) return 'the reply had no "evidence"';
  return null;
}

/** One or two literal strings, each long enough and found in `excerpt`; else a reason. */
function readPattern(
  pattern: unknown,
  excerpt: string,
): { ok: true; value: [string] | [string, string] } | { ok: false; reason: string } {
  const parts: unknown[] = Array.isArray(pattern) ? pattern : [pattern];
  const strings: string[] = [];
  for (const part of parts) {
    if (typeof part !== "string") return { ok: false, reason: 'the "pattern" was not text' };
    const trimmed = part.trim();
    if (trimmed.length < MIN_PATTERN_CHARS) {
      return { ok: false, reason: `a "pattern" string was under ${MIN_PATTERN_CHARS} characters` };
    }
    if (!excerpt.includes(trimmed)) {
      return { ok: false, reason: 'a "pattern" string was not found in its own excerpt' };
    }
    strings.push(trimmed);
  }
  const [first, second] = strings;
  if (first === undefined || strings.length > 2) {
    return { ok: false, reason: 'the "pattern" needs one or two strings' };
  }
  return { ok: true, value: second === undefined ? [first] : [first, second] };
}

/**
 * Reads the model's reply. Anything that is not valid, or a pattern that is not found in
 * `excerpt` (the text that was sent), is a reason, never a guess.
 */
export function parseExplanation(reply: string, excerpt: string): ParseResult {
  const object = readObject(reply);
  if (!object.ok) return object;
  const missing = missingField(object.value);
  if (missing !== null) return { ok: false, reason: missing };
  const pattern = readPattern(object.value["pattern"], excerpt);
  if (!pattern.ok) return pattern;
  const text = (key: string): string => String(object.value[key]).trim();
  return {
    ok: true,
    value: {
      component: text("component"),
      kind: kindOf(text("kind")),
      cause: text("cause"),
      evidence: text("evidence"),
      pattern: pattern.value,
    },
  };
}
