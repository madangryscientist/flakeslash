import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import type { GithubConfig } from "#/auth/github.ts";
import { buildKind, githubStubRefusal } from "#/auth/stub-guard.ts";
import type { BatchDb } from "#/db/d1-store.ts";
import * as schema from "#/db/schema.ts";

/** The one place that touches the Worker's bindings; everything below takes plain values. */
export const database = (): BatchDb => drizzle(env.DB, { schema });

/** Seals the GitHub tokens a session keeps. Unset, a session cannot be read or started. */
export const tokenKey = (): string | undefined => env.TOKEN_KEY || undefined;

/** Why this Worker must not serve (a production build pointed off GitHub), or null. */
export const startRefusal = (): string | null => githubStubRefusal(buildKind(), env);

export function githubConfig(): GithubConfig {
  const refused = startRefusal();
  if (refused) throw new Error(refused);
  const clientSecret = env.GITHUB_APP_CLIENT_SECRET;
  if (!env.GITHUB_APP_CLIENT_ID || !clientSecret)
    throw new Error("GITHUB_APP_CLIENT_ID and GITHUB_APP_CLIENT_SECRET must be set");
  return {
    clientId: env.GITHUB_APP_CLIENT_ID,
    clientSecret,
    oauthBase: env.GITHUB_OAUTH_BASE,
    apiBase: env.GITHUB_API_BASE,
  };
}
