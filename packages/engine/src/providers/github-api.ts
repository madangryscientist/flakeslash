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
}

/** The slice of `fetch` the reader uses, so a test (or a proxy) can stand in for it. */
export type FetchLike = (
  url: string,
  init: { headers: Record<string, string> },
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

export interface Api {
  get(url: string): Promise<ApiResult>;
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
  };
}
