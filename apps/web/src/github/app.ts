import { importAppKey, signAppJwt } from "./jwt.ts";

/*
 * The FlakeSlash GitHub App, outbound only: it signs its JWT, lists its installations, mints a token
 * per installation and lists the repos each one covers. No webhooks, no Octokit: `fetch` and Web
 * Crypto, so the Worker and the tests run the same code.
 */

/** The deployment's App: its id, its private key (see `pemOf`) and the API base. */
export type GithubAppConfig = { appId: string; privateKey: string; apiBase: string };

/** The one shape of `fetch` the App calls, so a test can stand in for GitHub. */
export type GithubFetch = (input: string, init?: RequestInit) => Promise<Response>;

/** One GitHub call waits this long, then is aborted: a slow GitHub never holds a batch up. */
const GITHUB_TIMEOUT_MS = 5000;

/** A GitHub reply that was not a 2xx; the body is cut short, and never carries a token. */
export class GithubError extends Error {
  readonly status: number;
  constructor(method: string, path: string, status: number, body: string) {
    super(`GitHub ${method} ${path}: ${status} ${body.slice(0, 200)}`);
    this.name = "GithubError";
    this.status = status;
  }
}

/** An installation of the App, on a user or an organisation account. */
export interface Installation {
  id: number;
  account: { id: number; login: string; type: string };
  /** Set when the account suspended the App: then it is not scanned. */
  suspended: boolean;
}

export interface GithubApp {
  /** Every installation of the App, every page. */
  installations(): Promise<Installation[]>;
  /** A token for installation `id`, covering all the repos it was granted. */
  installationToken(id: number): Promise<string>;
  /** The `full_name` of every repo an installation token covers, every page. */
  installationRepos(token: string): Promise<string[]>;
}

/** A field GitHub's reply must have; a reply without it is GitHub's error, named. */
export function field(reply: unknown, name: string): string | number {
  const value = typeof reply === "object" && reply !== null ? Reflect.get(reply, name) : undefined;
  if (typeof value !== "string" && typeof value !== "number")
    throw new Error(`GitHub's reply has no ${name}`);
  return value;
}

function listOf(reply: unknown, name?: string): unknown[] {
  const list = name === undefined ? reply : prop(reply, name);
  if (!Array.isArray(list)) throw new Error(`GitHub's reply has no list${name ? ` ${name}` : ""}`);
  return list;
}

function prop(reply: unknown, name: string): unknown {
  return typeof reply === "object" && reply !== null ? Reflect.get(reply, name) : undefined;
}

function installationOf(item: unknown): Installation {
  const account = prop(item, "account");
  return {
    id: Number(field(item, "id")),
    account: {
      id: Number(field(account, "id")),
      login: String(field(account, "login")),
      type: String(field(account, "type")),
    },
    suspended: prop(item, "suspended_at") != null,
  };
}

const NEXT_LINK = /<([^>]+)>\s*;\s*rel="next"/;

/**
 * The `rel="next"` URL of a Link header. One that leaves the API base throws: following it would send
 * the App's credentials elsewhere, and skipping it would end the listing as if it were complete.
 */
export function nextLink(header: string | null, apiBase: string): string | null {
  const url = header === null ? undefined : NEXT_LINK.exec(header)?.[1];
  if (url === undefined) return null;
  if (!url.startsWith(`${apiBase}/`)) throw new Error(`GitHub sent a next link off ${apiBase}`);
  return url;
}

/** The App's client over `send`. The signing key is imported once, on the first call. */
export function createGithubApp(
  config: GithubAppConfig,
  send: GithubFetch,
  now: () => number = Date.now,
): GithubApp {
  const apiBase = config.apiBase.replace(/\/+$/, "");
  let key: Promise<CryptoKey> | null = null;

  async function call(auth: string, method: string, url: string) {
    const res = await send(url, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${auth}`,
        "user-agent": "flakeslash",
        "x-github-api-version": "2022-11-28",
      },
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
    const path = url.slice(apiBase.length);
    if (!res.ok) throw new GithubError(method, path, res.status, await res.text());
    return { body: await res.json(), next: nextLink(res.headers.get("link"), apiBase) };
  }

  /** Every page from `path` on, each page's items picked by `pick`. */
  async function pages(auth: string, path: string, pick: (body: unknown) => unknown[]) {
    const items: unknown[] = [];
    let url: string | null = `${apiBase}${path}`;
    while (url !== null) {
      const page = await call(auth, "GET", url);
      items.push(...pick(page.body));
      url = page.next;
    }
    return items;
  }

  async function appJwt(): Promise<string> {
    key ??= importAppKey(config.privateKey);
    // A key that failed to import is tried again next time rather than cached as a rejection.
    const signing = await key.catch((error: unknown) => {
      key = null;
      throw error;
    });
    return signAppJwt(config.appId, signing, Math.floor(now() / 1000));
  }

  return {
    async installations() {
      const items = await pages(await appJwt(), "/app/installations?per_page=100", (body) =>
        listOf(body),
      );
      return items.map(installationOf);
    },
    async installationToken(id) {
      const minted = await call(
        await appJwt(),
        "POST",
        `${apiBase}/app/installations/${id}/access_tokens`,
      );
      return String(field(minted.body, "token"));
    },
    async installationRepos(token) {
      const items = await pages(token, "/installation/repositories?per_page=100", (body) =>
        listOf(body, "repositories"),
      );
      return items.map((item) => String(field(item, "full_name")));
    },
  };
}
