/**
 * Hashing, random tokens, and sealing a secret at rest.
 *
 * A sealed value is AES-256-GCM under `TOKEN_KEY` (base64 of 32 bytes), stored as
 * `v1:<iv b64>:<ciphertext b64>`. A stored value that is not sealed is refused, never used as it
 * is. No message here carries a token, the key, or a stored value.
 */

const PREFIX = "v1:";
const IV_BYTES = 12;

/** 32 random bytes as base64url, behind a readable prefix (`fss_` for a session). */
export function randomToken(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return prefix + b64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** `TOKEN_KEY` is missing or unusable. A deployment sets it with `wrangler secret put`. */
export class TokenKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenKeyError";
  }
}

/** A stored value this key cannot open: not sealed, a wrong key, or a value that was altered. */
export class SealedUnreadableError extends Error {
  constructor() {
    super("a stored token cannot be opened with this TOKEN_KEY");
    this.name = "SealedUnreadableError";
  }
}

const b64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
const unb64 = (text: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

async function importKey(secret: string | undefined): Promise<CryptoKey> {
  if (!secret) throw new TokenKeyError("TOKEN_KEY is not set");
  let raw: Uint8Array<ArrayBuffer> | null = null;
  try {
    raw = unb64(secret);
  } catch {
    // Not echoed: the key must not reach an error or a log.
  }
  if (raw?.length !== 32) throw new TokenKeyError("TOKEN_KEY must be base64 of 32 bytes");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** The stored form of `plain`; throws `TokenKeyError` when there is no usable key. */
export async function seal(secret: string | undefined, plain: string): Promise<string> {
  const key = await importKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plain),
  );
  return `${PREFIX}${b64(iv)}:${b64(new Uint8Array(sealed))}`;
}

/** What a sealed value holds; `SealedUnreadableError` for anything this key did not seal. */
export async function unseal(secret: string | undefined, stored: string): Promise<string> {
  const key = await importKey(secret);
  if (!stored.startsWith(PREFIX)) throw new SealedUnreadableError();
  try {
    const [iv, sealed, extra] = stored.slice(PREFIX.length).split(":");
    if (!iv || !sealed || extra !== undefined) throw new Error("malformed");
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64(iv) },
      key,
      unb64(sealed),
    );
    return new TextDecoder().decode(plain);
  } catch {
    throw new SealedUnreadableError();
  }
}
