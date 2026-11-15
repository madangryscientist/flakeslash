/**
 * Signing in through the GitHub App's user authorization. The App's user access token reaches only
 * repos where the App is installed and the person has access, so no OAuth scope is asked for. The
 * token lasts 8 hours and comes with a refresh token (GitHub's default for an App).
 *
 * The bases are config so tests (and later the e2e build) can point at a stand-in for GitHub.
 */
export type GithubConfig = {
  clientId: string;
  clientSecret: string;
  oauthBase: string;
  apiBase: string;
};

export type GithubProfile = {
  githubId: number;
  login: string;
  name: string | null;
  avatarUrl: string | null;
};

/** A user access token and its refresh token, each with the moment it stops working. */
export type GithubTokens = {
  accessToken: string;
  accessExpiresAt: Date;
  refreshToken: string;
  refreshExpiresAt: Date;
};

export function authorizeUrl(cfg: GithubConfig, state: string, redirectUri: string): string {
  const url = new URL("/login/oauth/authorize", cfg.oauthBase);
  url.search = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: redirectUri,
    state,
  }).toString();
  return url.toString();
}

/** Trade the callback's code for the person's tokens. */
export function exchangeCode(
  cfg: GithubConfig,
  code: string,
  redirectUri: string,
  now = new Date(),
): Promise<GithubTokens> {
  return tokenGrant(cfg, { code, redirect_uri: redirectUri }, now);
}

/** A new access token for a refresh token. GitHub rotates the refresh token, so both come back. */
export function refreshTokens(
  cfg: GithubConfig,
  refreshToken: string,
  now = new Date(),
): Promise<GithubTokens> {
  return tokenGrant(cfg, { grant_type: "refresh_token", refresh_token: refreshToken }, now);
}

/** GitHub refused the grant (a spent or revoked refresh token, a bad code): sign in again. */
export class GrantRefusedError extends Error {
  constructor(status: number) {
    super(`GitHub refused the token grant (${status})`);
    this.name = "GrantRefusedError";
  }
}

async function tokenGrant(
  cfg: GithubConfig,
  grant: Record<string, string>,
  now: Date,
): Promise<GithubTokens> {
  const res = await fetch(new URL("/login/oauth/access_token", cfg.oauthBase), {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ client_id: cfg.clientId, client_secret: cfg.clientSecret, ...grant }),
  });
  // An outage is not a refusal: it throws as itself, and the session is kept.
  if (res.status >= 500) throw new Error(`GitHub token grant unavailable (${res.status})`);
  // GitHub answers a refused grant with 200 and an `error` field, so the body decides.
  const body: unknown = res.ok ? await res.json() : null;
  const tokens = isRecord(body) ? toTokens(body, now) : null;
  if (!tokens) throw new GrantRefusedError(res.status);
  return tokens;
}

function toTokens(body: Record<string, unknown>, now: Date): GithubTokens | null {
  const { access_token, expires_in, refresh_token, refresh_token_expires_in } = body;
  if (
    typeof access_token !== "string" ||
    typeof expires_in !== "number" ||
    typeof refresh_token !== "string" ||
    typeof refresh_token_expires_in !== "number"
  )
    // No expiry or refresh token is an App with user token expiry turned off: not supported.
    return null;
  return {
    accessToken: access_token,
    accessExpiresAt: new Date(now.getTime() + expires_in * 1000),
    refreshToken: refresh_token,
    refreshExpiresAt: new Date(now.getTime() + refresh_token_expires_in * 1000),
  };
}

/** The headers of a REST call made as the person. */
export const githubHeaders = (accessToken: string): Record<string, string> => ({
  accept: "application/vnd.github+json",
  authorization: `Bearer ${accessToken}`,
  "user-agent": "flakeslash",
  "x-github-api-version": "2022-11-28",
});

/** The signed-in person's GitHub profile. */
export async function readProfile(cfg: GithubConfig, accessToken: string): Promise<GithubProfile> {
  const res = await fetch(new URL("/user", cfg.apiBase), { headers: githubHeaders(accessToken) });
  const body: unknown = res.ok ? await res.json() : null;
  if (!isRecord(body) || typeof body["id"] !== "number" || typeof body["login"] !== "string")
    throw new Error(`GitHub /user returned no id and login (${res.status})`);
  return {
    githubId: body["id"],
    login: body["login"],
    name: typeof body["name"] === "string" ? body["name"] : null,
    avatarUrl: typeof body["avatar_url"] === "string" ? body["avatar_url"] : null,
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
