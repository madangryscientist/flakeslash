/**
 * The e2e GitHub stand-in (`e2e/github-stub.ts`) signs every visitor in as one fixed user, so a
 * deployment pointed at it lets anyone in. Only a dev server and the test build
 * (`CLOUDFLARE_ENV=e2e`) may point anywhere but GitHub; a production build that does refuses to
 * start, naming why.
 */

export type BuildKind = "dev" | "test" | "production";

/** Set by `vite.config.ts` for the build it makes. Unset (vitest) or anything else is production. */
declare const FLAKESLASH_BUILD_KIND: string | undefined;

export function buildKind(): BuildKind {
  const kind = typeof FLAKESLASH_BUILD_KIND === "string" ? FLAKESLASH_BUILD_KIND : "";
  return kind === "dev" || kind === "test" ? kind : "production";
}

const GITHUB_OAUTH_BASE = "https://github.com";
const GITHUB_API_BASE = "https://api.github.com";

type GithubBases = { GITHUB_OAUTH_BASE?: string; GITHUB_API_BASE?: string };

/** Why this build may not run with these GitHub bases, or null when it may. */
export function githubStubRefusal(kind: BuildKind, bases: GithubBases): string | null {
  if (kind !== "production") return null;
  const oauth = bases.GITHUB_OAUTH_BASE ?? "";
  const api = bases.GITHUB_API_BASE ?? "";
  if (oauth === GITHUB_OAUTH_BASE && api === GITHUB_API_BASE) return null;
  return [
    `refusing to start: GITHUB_OAUTH_BASE is ${oauth || "unset"} and GITHUB_API_BASE is ${api || "unset"},`,
    `but a production build signs in only through ${GITHUB_OAUTH_BASE} and ${GITHUB_API_BASE}.`,
    "Any other base is the e2e GitHub stand-in, which signs anyone in; it is for a dev server or",
    "the test build (CLOUDFLARE_ENV=e2e) only.",
  ].join(" ");
}
