import { describe, expect, test } from "vitest";
import { TEST_TOKEN_KEY } from "#/test/github-fetch.ts";
import { SealedUnreadableError, TokenKeyError, seal, sha256Hex, unseal } from "./crypto.ts";

const OTHER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

describe("seal and unseal", () => {
  test("a sealed value opens to what was sealed, and does not contain it", async () => {
    const stored = await seal(TEST_TOKEN_KEY, "ghu_secret");
    expect(stored).toMatch(/^v1:/);
    expect(stored).not.toContain("ghu_secret");
    expect(await unseal(TEST_TOKEN_KEY, stored)).toBe("ghu_secret");
  });

  test("another key cannot open it", async () => {
    const stored = await seal(TEST_TOKEN_KEY, "ghu_secret");
    await expect(unseal(OTHER_KEY, stored)).rejects.toThrow(SealedUnreadableError);
  });

  test("a missing or short key is a named error that does not echo the key", async () => {
    await expect(seal(undefined, "x")).rejects.toThrow(TokenKeyError);
    await expect(seal("c2hvcnQ=", "x")).rejects.toThrow("TOKEN_KEY must be base64 of 32 bytes");
  });
});

test("sha256Hex is the hex digest", async () => {
  expect(await sha256Hex("abc")).toBe(
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});
