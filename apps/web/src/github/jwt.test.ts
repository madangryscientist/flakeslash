import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, test } from "vitest";
import { JWT_LIFETIME_S, JWT_SKEW_S, importAppKey, pemOf, signAppJwt } from "./jwt.ts";

// One key for the file; GitHub hands out PKCS#1 ("BEGIN RSA PRIVATE KEY"), so both forms are tried.
const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PKCS1 = pair.privateKey.export({ type: "pkcs1", format: "pem" });
const PKCS8 = pair.privateKey.export({ type: "pkcs8", format: "pem" });
const NOW = 1_800_000_000;

const fromBase64url = (part: string) => Buffer.from(part, "base64url");
const decode = (part: string): unknown => JSON.parse(fromBase64url(part).toString("utf8"));

/** Checks the JWT's RS256 signature with node:crypto, which shares no code with `signAppJwt`. */
function verified(jwt: string): boolean {
  const [head = "", claims = "", signature = ""] = jwt.split(".");
  return verify(
    "RSA-SHA256",
    Buffer.from(`${head}.${claims}`),
    pair.publicKey,
    fromBase64url(signature),
  );
}

describe("the App JWT", () => {
  test.each([
    ["PKCS#1", PKCS1],
    ["PKCS#8", PKCS8],
  ])("a %s key signs an RS256 JWT with iat backdated and exp under 10 minutes", async (_, pem) => {
    const jwt = await signAppJwt("123456", await importAppKey(pem), NOW);
    const [head = "", claims = ""] = jwt.split(".");

    expect(decode(head)).toEqual({ alg: "RS256", typ: "JWT" });
    expect(decode(claims)).toEqual({ iat: NOW - 60, exp: NOW + 540, iss: "123456" });
    expect(JWT_SKEW_S + JWT_LIFETIME_S).toBeLessThanOrEqual(600);
    expect(verified(jwt)).toBe(true);
  });

  test("the key is read as a PEM, a PEM with \\n for its newlines, or base64 of either", async () => {
    const escaped = PKCS1.trim().replaceAll("\n", "\\n");
    for (const raw of [
      PKCS1,
      escaped,
      Buffer.from(PKCS1).toString("base64"),
      Buffer.from(escaped).toString("base64"),
    ]) {
      expect(pemOf(raw)).toBe(PKCS1.trim());
      expect(verified(await signAppJwt("1", await importAppKey(raw), NOW))).toBe(true);
    }
  });

  test("a value that is not a private key is refused by name", async () => {
    await expect(
      importAppKey("-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----"),
    ).rejects.toThrow("not a PEM private key");
  });
});
