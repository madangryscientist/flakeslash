/** Which job a cron trigger runs. Its strings are the `triggers.crons` of `wrangler.jsonc`. */
import { expireAll } from "#/expire/daily.ts";
import { scheduled, type ScanEnv } from "#/scan/hourly.ts";

/** Daily at 03:30 UTC: the expiry of detailed rows past 90 days. */
export const EXPIRE_CRON = "30 3 * * *";

export interface CronDeps {
  scan?: () => Promise<void>;
  expire?: () => Promise<void>;
}

/** Runs the expiry on `EXPIRE_CRON` and the hourly scan on any other cron. */
export async function onCron(cron: string, env: ScanEnv, deps: CronDeps = {}): Promise<void> {
  if (cron === EXPIRE_CRON) await (deps.expire ?? (() => expireAll(env)))();
  else await (deps.scan ?? (() => scheduled(env)))();
}
