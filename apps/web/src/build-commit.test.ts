import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { buildCommit } from "./build-commit";

const SHA = "0123456789abcdef0123456789abcdef01234567";

const temps: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "build-commit-"));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A one-commit repo in a temp dir, with git's identity given on the command line. */
function repo(): { dir: string; head: string } {
  const dir = tempDir();
  const run = (...args: string[]): string =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
      cwd: dir,
      encoding: "utf8",
    }).trim();
  run("init", "-q");
  writeFileSync(join(dir, "a.txt"), "a\n");
  run("add", "a.txt");
  run("commit", "-q", "-m", "a");
  return { dir, head: run("rev-parse", "HEAD") };
}

describe("buildCommit", () => {
  test("BUILD_COMMIT wins over git", () => {
    const { dir } = repo();
    expect(buildCommit({ env: { BUILD_COMMIT: SHA }, cwd: dir })).toBe(SHA);
  });

  test("BUILD_COMMIT that is not a sha fails", () => {
    expect(() => buildCommit({ env: { BUILD_COMMIT: "main" }, cwd: tempDir() })).toThrow(
      /BUILD_COMMIT/,
    );
  });

  test("a clean tree gives HEAD", () => {
    const { dir, head } = repo();
    expect(buildCommit({ env: {}, cwd: dir })).toBe(head);
  });

  test("a dirty tree gives HEAD with -dirty", () => {
    const { dir, head } = repo();
    writeFileSync(join(dir, "b.txt"), "b\n");
    expect(buildCommit({ env: {}, cwd: dir })).toBe(`${head}-dirty`);
  });

  test("neither source fails, naming both", () => {
    // GIT_CEILING_DIRECTORIES keeps git from finding a repo above the temp dir.
    const dir = tempDir();
    const saved = process.env["GIT_CEILING_DIRECTORIES"];
    process.env["GIT_CEILING_DIRECTORIES"] = tmpdir();
    try {
      expect(() => buildCommit({ env: {}, cwd: dir })).toThrow(
        /BUILD_COMMIT is unset and `git rev-parse HEAD`/,
      );
    } finally {
      if (saved === undefined) delete process.env["GIT_CEILING_DIRECTORIES"];
      else process.env["GIT_CEILING_DIRECTORIES"] = saved;
    }
  });
});
