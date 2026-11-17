import { execFileSync } from "node:child_process";

/**
 * The commit a build was made from, for the hidden `<meta name="build-commit">` in every page's head, so
 * anyone can read which commit is live: `curl -s https://flakeslash.slashslash.build/ | grep build-commit`.
 *
 * `BUILD_COMMIT` wins when set, for a build made outside a git checkout. Otherwise it is `git rev-parse HEAD`,
 * with `-dirty` when `git status --porcelain` lists anything. The moon `build` task lists BUILD_COMMIT as an input,
 * so a build that sets it does not reuse a cached dist/; CI does not set it yet, so a cache hit on main can still
 * restore a dist naming an older sha. The deploy runs `bun run build` and `bunx wrangler deploy`
 * from a clean checkout (docs/deploying.md), so the sha is that checkout's HEAD and no moon cache is in that path.
 */

/** A full sha, with `-dirty` when the tree had uncommitted changes. */
export const BUILD_COMMIT_PATTERN = /^[0-9a-f]{40}(-dirty)?$/;

interface Sources {
  env?: Record<string, string | undefined>;
  /** Where git runs; the build's working directory by default. */
  cwd?: string;
}

function git(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined;
  }
}

/** The sha from git in `cwd`, with `-dirty` when the tree has changes. Throws when git gives no sha. */
function fromGit(cwd: string): string {
  const head = git(cwd, ["rev-parse", "HEAD"])?.trim();
  const status = git(cwd, ["status", "--porcelain"]);
  if (!head || !/^[0-9a-f]{40}$/.test(head) || status === undefined)
    throw new Error(
      `No build commit: BUILD_COMMIT is unset and \`git rev-parse HEAD\` gave no sha in ${cwd}. Set BUILD_COMMIT or build inside the git checkout.`,
    );
  return status.trim() === "" ? head : `${head}-dirty`;
}

export function buildCommit({ env = process.env, cwd = process.cwd() }: Sources = {}): string {
  const given = env["BUILD_COMMIT"]?.trim();
  if (!given) return fromGit(cwd);
  if (!BUILD_COMMIT_PATTERN.test(given))
    throw new Error(
      `BUILD_COMMIT is "${given}", not a 40-character hex sha (optionally ending -dirty).`,
    );
  return given;
}
