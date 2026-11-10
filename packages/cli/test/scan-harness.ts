/**
 * A harness for driving `flakeslash scan` through `run()`: a fetch over canned GitHub answers (no live
 * network), a temp store, and the CLI's stdout, stderr and exit code captured.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FetchLike } from "@hackcove/flakeslash-engine";
import { afterEach, beforeEach, vi } from "vitest";
import { REPO } from "../../engine/test/github-fake.ts";
import { run } from "../src/cli.ts";
import { openSqliteStore } from "../src/store.ts";

export const SINCE = "2026-11-01";

interface Outcome {
  code: number;
  out: string;
  err: string;
}

/** Sets up a temp dir for the store, and a `scan` that runs the CLI with it. */
export function useScan() {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "flakeslash-scan-"));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });
  const storePath = () => join(dir, "flakeslash.db");

  return {
    storePath,
    /** Runs `flakeslash <args>` against `gh`, with the store flag added unless the args carry one. */
    async exec(
      args: string[],
      gh: { fetch: FetchLike },
      env: Record<string, string | undefined> = { GITHUB_TOKEN: "ghp_test" },
    ): Promise<Outcome> {
      let out = "";
      let err = "";
      vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        out += String(chunk);
        return true;
      });
      vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
        err += String(chunk);
        return true;
      });
      try {
        const withStore = args.includes("--store") ? args : [...args, "--store", storePath()];
        const code = await run(withStore, { fetch: gh.fetch, env });
        return { code, out, err };
      } finally {
        vi.restoreAllMocks();
      }
    },
    /** Every excerpt row the store holds for `repo`. */
    async excerpts(repo = REPO) {
      const store = openSqliteStore(storePath());
      try {
        return await store.readExcerpts(repo);
      } finally {
        store.close();
      }
    },
    /** Every issue the store holds, across repos. */
    async issues() {
      const store = openSqliteStore(storePath());
      try {
        return await store.readIssues();
      } finally {
        store.close();
      }
    },
    /** Every failure the store holds, across repos. */
    async failures() {
      const store = openSqliteStore(storePath());
      try {
        return await store.readFailures();
      } finally {
        store.close();
      }
    },
    /** Every job row the store holds for `repo`. */
    async rows(repo = REPO) {
      const store = openSqliteStore(storePath());
      try {
        return await store.readJobs(repo);
      } finally {
        store.close();
      }
    },
  };
}
