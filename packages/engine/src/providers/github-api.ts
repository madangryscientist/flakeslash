/**
 * The GitHub REST layer under the Actions reader: one GET with a page-follow, and the three ways a
 * call can end that the reader treats differently. It holds no Actions knowledge.
 */

export const API_BASE = "https://api.github.com";

/** The slice of a fetch `Response` the reader uses. */
export interface FetchResponse {
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null; has(name: string): boolean };
  json(): Promise<unknown>;
  text(): Promise<string>;
}

/** The slice of `fetch` the reader uses, so a test (or a proxy) can stand in for it. */
export type FetchLike = (
  url: string,
  init: { headers: Record<string, string>; redirect?: "manual" },
) => Promise<FetchResponse>;

export type ApiResult =
  | { status: "ok"; body: unknown; next: string | null }
  | { status: "rate-limited" }
  | { status: "missing" };

/** A response that is not a rate limit and not a 404 or 422. A bad token ends up here, on purpose. */
export class GitHubApiError extends Error {
  readonly httpStatus: number;
  constructor(httpStatus: number, url: string) {
    super(`GitHub answered ${httpStatus} for ${url}`);
    this.name = "GitHubApiError";
    this.httpStatus = httpStatus;
  }
}

/**
 * GitHub's two rate limits: the primary one answers 403 (or 429) with `x-ratelimit-remaining: 0`,
 * the secondary one answers 403 or 429 with `retry-after`. Any other 403 is a real refusal (a bad or
 * under-scoped token) and must not read as a short history.
 */
export function isRateLimited(res: FetchResponse): boolean {
  if (res.status === 429) return true;
  if (res.status !== 403) return false;
  return res.headers.get("x-ratelimit-remaining") === "0" || res.headers.has("retry-after");
}

const NEXT_LINK = /<([^>]+)>\s*;\s*rel="next"/;

/**
 * The `rel="next"` URL of a Link header. One that leaves the API host throws: following it would send
 * the token elsewhere, and skipping it would end the read as if the history were complete.
 */
export function nextLink(header: string | null): string | null {
  const url = header === null ? undefined : NEXT_LINK.exec(header)?.[1];
  if (url === undefined) return null;
  if (!url.startsWith(`${API_BASE}/`)) throw new Error(`GitHub sent a next link off ${API_BASE}`);
  return url;
}

/**
 * How a log read ended. `gone` is a log GitHub does not have (404, 410: a job that never got a runner,
 * or a log past its retention), which will not come back. `try-later` is any other way a read can fail
 * (a rate limit, a 5xx, a refusal, a dropped connection), which says nothing about whether the log exists.
 */
export type LogResult =
  | { status: "ok"; text: string }
  | { status: "gone" }
  | { status: "try-later" };

export interface Api {
  get(url: string): Promise<ApiResult>;
  /** A job's log, as text in memory. See `LogResult`. */
  getLog(url: string): Promise<LogResult>;
}

/** A 404 or 410 is a log that is gone, a 200 is the log, and anything else is for later. */
async function logFrom(res: FetchResponse): Promise<LogResult> {
  if (res.status === 404 || res.status === 410) return { status: "gone" };
  if (res.status !== 200) return { status: "try-later" };
  try {
    return { status: "ok", text: await res.text() };
  } catch {
    return { status: "try-later" };
  }
}

export function createApi(fetchImpl: FetchLike, token: string | undefined): Api {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "flakeslash",
  };
  if (token !== undefined && token !== "") headers.authorization = `Bearer ${token}`;
  return {
    async get(url) {
      const res = await fetchImpl(url, { headers });
      if (isRateLimited(res)) return { status: "rate-limited" };
      if (res.status === 404 || res.status === 422) return { status: "missing" };
      if (!res.ok) throw new GitHubApiError(res.status, url);
      return { status: "ok", body: await res.json(), next: nextLink(res.headers.get("link")) };
    },
    /**
     * The log URL answers 302 to a signed blob URL. The API request carries the token; the blob request
     * carries no headers at all, so the token never leaves the API host. Nothing returned or thrown holds
     * the blob URL, because its signature grants access to the log.
     */
    async getLog(url) {
      let res: FetchResponse;
      try {
        res = await fetchImpl(url, { headers, redirect: "manual" });
      } catch {
        return { status: "try-later" };
      }
      if (res.status === 401) throw new GitHubApiError(401, url);
      if (res.status < 300 || res.status >= 400) return logFrom(res);

      const location = res.headers.get("location");
      if (location === null) return { status: "try-later" };
      let target: URL;
      try {
        target = new URL(location, url);
      } catch {
        return { status: "try-later" };
      }
      if (target.protocol !== "https:") return { status: "try-later" };
      try {
        return await logFrom(await fetchImpl(target.href, { headers: {} }));
      } catch {
        return { status: "try-later" };
      }
    },
  };
}
