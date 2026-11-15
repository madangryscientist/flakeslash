import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXPIRE_CRON, onCron } from "./cron.ts";
import { d1Db } from "./db/test-d1.ts";
import type { ScanEnv } from "./scan/hourly.ts";

let local: Awaited<ReturnType<typeof d1Db>>;
beforeAll(async () => {
  local = await d1Db();
}, 60_000);
afterAll(() => local?.dispose());

const env = (): ScanEnv => ({
  DB: local.d1,
  GITHUB_API_BASE: "https://api.github.com",
  SCAN_REQUEST_BUDGET: 200,
  SCAN_REPOS_PER_BATCH: 20,
});

/** The `triggers.crons` of `wrangler.jsonc`, at its top level (`env.e2e` has no triggers). */
function wranglerCrons(): string[] {
  const config = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  const found = [...config.matchAll(/"triggers": \{ "crons": \[([^\]]*)\] \}/g)];
  expect(found).toHaveLength(1);
  return [...(found[0]?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? "");
}

async function jobOf(cron: string): Promise<string[]> {
  const ran: string[] = [];
  await onCron(cron, env(), {
    scan: async () => void ran.push("scan"),
    expire: async () => void ran.push("expire"),
  });
  return ran;
}

describe("the cron triggers", () => {
  it("are the scan every 10 minutes, offset by 5, and the daily expiry, in wrangler.jsonc", async () => {
    const crons = wranglerCrons();
    expect(crons).toEqual(["5,15,25,35,45,55 * * * *", EXPIRE_CRON]);
    expect(await jobOf(crons[0] ?? "")).toEqual(["scan"]);
    expect(await jobOf(crons[1] ?? "")).toEqual(["expire"]);
  });
});
