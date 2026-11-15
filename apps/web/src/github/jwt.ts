/*
 * The GitHub App's JWT: RS256 over Web Crypto only, so the same code signs in the Worker
 * and under the tests. GitHub hands out the key as PKCS#1 (`BEGIN RSA PRIVATE KEY`), which
 * Web Crypto cannot import; it is wrapped in a PKCS#8 envelope here, with no ASN.1 library.
 */

/** GitHub refuses an `exp` more than 10 minutes out; 9 leaves room for a slow clock. */
export const JWT_LIFETIME_S = 9 * 60;
/** `iat` is backdated by a minute, as GitHub advises, so a clock that runs ahead is not refused. */
export const JWT_SKEW_S = 60;

/** `privateKey` as the deployment's secret holds it: a PEM, with real or `\n` newlines, or base64 of one. */
export function pemOf(raw: string): string {
  const text = raw.trim();
  const pem = text.includes("-----BEGIN") ? text : atob(text.replaceAll(/\s/g, "")).trim();
  return pem.replaceAll("\\n", "\n");
}

function base64Bytes(b64: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function base64url(bytes: Uint8Array): string {
  let text = "";
  for (const b of bytes) text += String.fromCharCode(b);
  return btoa(text).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** A DER length: short form under 128, else the long form's byte count and big-endian bytes. */
function derLength(n: number): number[] {
  if (n < 0x80) return [n];
  const bytes: number[] = [];
  for (let rest = n; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff);
  return [0x80 | bytes.length, ...bytes];
}

const der = (tag: number, body: Uint8Array): Uint8Array<ArrayBuffer> =>
  Uint8Array.from([tag, ...derLength(body.length), ...body]);

/** `SEQUENCE { INTEGER 0, SEQUENCE { rsaEncryption, NULL }, OCTET STRING pkcs1 }`. */
function pkcs8FromPkcs1(pkcs1: Uint8Array): Uint8Array<ArrayBuffer> {
  const version = [0x02, 0x01, 0x00];
  const rsaEncryption = [
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
  ];
  const key = der(0x04, pkcs1);
  return der(0x30, Uint8Array.from([...version, ...rsaEncryption, ...key]));
}

/** Imports a PKCS#1 or PKCS#8 PEM as an RS256 signing key. */
export async function importAppKey(raw: string): Promise<CryptoKey> {
  const pem = pemOf(raw);
  const found = /-----BEGIN (RSA )?PRIVATE KEY-----([\s\S]+?)-----END/.exec(pem);
  if (!found) throw new Error("the GitHub App key is not a PEM private key");
  const body = base64Bytes((found[2] ?? "").replaceAll(/\s/g, ""));
  const pkcs8 = found[1] ? pkcs8FromPkcs1(body) : body;
  return crypto.subtle.importKey(
    "pkcs8",
    pkcs8,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

/** The app's JWT at `nowS` (seconds): `iss` is the app id, `iat` backdated, `exp` under 10 minutes. */
export async function signAppJwt(appId: string, key: CryptoKey, nowS: number): Promise<string> {
  const encode = (value: unknown) => base64url(new TextEncoder().encode(JSON.stringify(value)));
  const head = encode({ alg: "RS256", typ: "JWT" });
  const claims = encode({ iat: nowS - JWT_SKEW_S, exp: nowS + JWT_LIFETIME_S, iss: appId });
  const signing = `${head}.${claims}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signing),
  );
  return `${signing}.${base64url(new Uint8Array(signature))}`;
}
