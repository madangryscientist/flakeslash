import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { redact } from "../src/index.ts";

// Secret-shaped values are joined from parts, so this file holds no literal a secret scanner flags.
const join = (...parts: string[]): string => parts.join("");

const GITHUB_TOKEN = join("ghp_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8");
const FINE_GRAINED = join("github_pat_", "11ABCDEFG0_abcdefghijklmnopqrstuvwxyz0123456789");
const OPENAI_KEY = join("sk-proj-", "AbCdEf1234567890GhIjKl");
const AWS_KEY_ID = join("AKIA", "IOSFODNN7EXAMPLE");
const BEARER_VALUE = "abc123DEF456ghi789jkl";
const URL_PASSWORD = "hunter2";
const ENV_VALUE = "q8Zr2mVt7Lk4Wx9Pb3Nj";
const AWS_SECRET = "Qz7mWp2Lx9Rt4Vb8Nk1Hs6Jd3Fg5Ya0Cu7Ei2OlP";
const JWT = join(
  "eyJhbGciOiJIUzI1NiJ9",
  ".",
  "eyJzdWIiOiIxMjM0NTY3ODkwIn0",
  ".",
  "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PiWQ3Dn",
);

const MARKER = "[redacted]";

/** Each planted secret, the text it sits in, and the value that must not survive. */
const PLANTED: ReadonlyArray<readonly [string, string, string]> = [
  ["a GitHub token", `token used: ${GITHUB_TOKEN} in step`, GITHUB_TOKEN],
  ["a GitHub fine-grained token", `auth ${FINE_GRAINED} ok`, FINE_GRAINED],
  ["an OpenAI-style key", `key=${OPENAI_KEY}`, OPENAI_KEY],
  ["an AWS access key id", `aws id ${AWS_KEY_ID} end`, AWS_KEY_ID],
  ["a bearer token", `Authorization: Bearer ${BEARER_VALUE}`, BEARER_VALUE],
  ["a password in a URL", `clone https://bob:${URL_PASSWORD}@github.com/x/y.git`, URL_PASSWORD],
  ["a NAME=value secret", `GITHUB_TOKEN=${ENV_VALUE}`, ENV_VALUE],
  ["a 40-character mixed string", `secret access key ${AWS_SECRET} done`, AWS_SECRET],
  ["a JWT", `session ${JWT} issued`, JWT],
];

describe("redact: planted secrets", () => {
  it.each(PLANTED)("removes %s and leaves a marker", (_name, input, secret) => {
    const out = redact(input);
    expect(out).not.toContain(secret);
    expect(out).toContain(MARKER);
  });

  it("keeps the name of a secret assignment", () => {
    expect(redact(`GITHUB_TOKEN=${ENV_VALUE}`)).toMatch(/^GITHUB_TOKEN=/);
  });

  it("keeps the scheme and host of a URL", () => {
    expect(redact(`https://bob:${URL_PASSWORD}@github.com/x/y.git`)).toBe(
      `https://${MARKER}@github.com/x/y.git`,
    );
  });
});

/** Text that must come through exactly as it was written. */
const KEPT: ReadonlyArray<readonly [string, string]> = [
  [
    "a stack frame with a path, line and column",
    "    at Object.<anonymous> (/home/runner/work/app/src/index.ts:42:17)",
  ],
  [
    "a Vitest FAIL line with a test name",
    " FAIL  src/flakes.test.ts > retries the job > keeps the first attempt",
  ],
  ["a hex address", "pointer 0x7ffd5e8c3a10 freed"],
  ["a padded hex address", "pointer 0x00007F3A2B1C4D5E freed"],
  ["a 40-character commit SHA", "commit 0123456789abcdef0123456789abcdef01234567"],
  [
    "a path with a 40-character mixed segment",
    "/tmp/cache/AbCdEf0123456789GhIjKl0123456789MnOpQrSt/index.js",
  ],
  ["an error message", "Error: expected 3 retries, got 2"],
  ["a workflow setting", "persist-credentials: false"],
  ["an authorization header with a short value", "AUTHORIZATION: basic ***"],
];

describe("redact: text that must survive", () => {
  it.each(KEPT)("leaves %s unchanged", (_name, input) => {
    expect(redact(input)).toBe(input);
  });

  it("leaves every real log fixture unchanged", () => {
    const dir = new URL("./fixtures/logs/", import.meta.url);
    const files = readdirSync(dir).filter((name) => name.endsWith(".log"));
    expect(files.length).toBeGreaterThan(0);
    for (const name of files) {
      const text = readFileSync(new URL(name, dir), "utf8");
      expect(redact(text)).toBe(text);
    }
  });
});
