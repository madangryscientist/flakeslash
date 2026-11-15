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

describe("the cron triggers", () => {
  it.each([
    ["30 3 * * *", "expire"],
    ["0 * * * *", "scan"],
  ])("runs the right job on %s", async (cron, chosen) => {
    const ran: string[] = [];
    await onCron(cron, env(), {
      scan: async () => void ran.push("scan"),
      expire: async () => void ran.push("expire"),
    });
    expect(ran).toEqual([chosen]);
  });

  it("expires on the daily cron string wrangler.jsonc declares", () => {
    expect(EXPIRE_CRON).toBe("30 3 * * *");
  });
});
