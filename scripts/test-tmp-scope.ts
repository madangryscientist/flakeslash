/**
 * Test `globalSetup` shared by every project (Vitest, and Playwright for `apps/web` and `apps/site`).
 * It points `TMPDIR` at one fresh directory for the run and removes it afterwards, so whatever a
 * test (or the code it drives: Playwright profiles, Chromium) leaves in the temp dir goes with the
 * run, even when a test fails or forgets its own cleanup. /tmp is a quota'd tmpfs on the dev
 * desktop; a leaked dir there fails unrelated tests with "Disk quota exceeded".
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export default function setup(): () => void {
  const scope = mkdtempSync(join(tmpdir(), "flakeslash-test-"));
  process.env.TMPDIR = scope;
  return () => {
    rmSync(scope, { recursive: true, force: true });
  };
}
