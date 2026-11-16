/**
 * The scan, a batch every 10 minutes. Installing the App is enough: there is no webhook. Each run finds the App's
 * installations, records their repos, and scans the repos that waited longest, within a bound on GitHub
 * requests and on repos. The store is the cursor: a scan fetches only what the store does not hold, so a
 * new installation's 90 days of history fill over several batches, and later ones pick up new failures.
 */
import { scanRepo } from "@hackcove/flakeslash-engine";
import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { d1Store, type BatchDb } from "#/db/d1-store.ts";
import type { Db } from "#/db/db.ts";
import * as schema from "#/db/schema.ts";
import { createGithubApp, type GithubAppConfig, type GithubFetch } from "#/github/app.ts";
import { log as workerLog } from "#/server/log.ts";
import { budgeted, type Budgeted } from "./budget.ts";
import { capStatements, d1CapOf, isCapReached } from "./d1-cap.ts";
import { discover } from "./discover.ts";

const { repos } = schema;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** GitHub keeps Actions logs this long, so a scan reads this far back: that window is the backfill. */
export const WINDOW_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface BatchDeps {
  db: BatchDb;
  fetch: GithubFetch;
  /** Null when the App is not configured: then the batch calls nothing. */
  app: GithubAppConfig | null;
  /** GitHub requests the whole batch may make: discovery, tokens, listings, logs, compares. */
  budget: number;
  /** Repos the batch scans at most, which bounds its D1 statements. */
  reposPerBatch: number;
  now: Date;
  log: (line: string) => void;
}

/** Why the batch stopped scanning. */
export type Stop =
  | "not-configured"
  | "no-installations"
  | "all-scanned"
  | "budget"
  | "rate-limit"
  | "repos"
  | "d1-cap";

export interface BatchResult {
  stop: Stop;
  /** The repos scanned, in order, as `org_id` and name. */
  scanned: { orgId: number; name: string }[];
  /** GitHub requests made. */
  requests: number;
}

interface Turn {
  orgId: number;
  name: string;
  token: string;
}

/**
 * The repos to scan this batch: only those whose organisation has a token this batch, oldest
 * `scanned_at` first with never-scanned ones before all (SQLite sorts NULL first ascending), then by
 * organisation and name. The token filter runs before the cap, so a dead installation takes no slot.
 */
interface Picked {
  todo: Turn[];
  /** True when more repos were due than the cap let in. */
  more: boolean;
}

async function turns(db: BatchDb, tokens: Map<number, string>, cap: number): Promise<Picked> {
  const q: Db = db;
  const rows = await q
    .select({ orgId: repos.orgId, name: repos.name })
    .from(repos)
    .orderBy(asc(repos.scannedAt), asc(repos.orgId), asc(repos.name));
  const due: Turn[] = [];
  for (const row of rows) {
    const token = tokens.get(row.orgId);
    if (token !== undefined) due.push({ ...row, token });
    if (due.length > cap) break;
  }
  return { todo: due.slice(0, cap), more: due.length > cap };
}

/**
 * Scans one repo: "cut" when a rate limit (real or the budget's) cut it short, "cap" when D1's statement
 * cap stopped it ("cap-before-turn" when that was before the turn was taken, so nothing was read), else
 * "done". Any other throw is logged. The
 * repo takes its turn (goes to the back of the rotation) before the scan, so a scan that ends the
 * invocation, as D1's statement cap does, has still had it, and one repo never starves the rest.
 */
async function scanTurn(
  deps: BatchDeps,
  github: Budgeted,
  turn: Turn,
  since: string,
): Promise<"done" | "cut" | "cap" | "cap-before-turn"> {
  const q: Db = deps.db;
  let turnTaken = false;
  try {
    await q
      .update(repos)
      .set({ scannedAt: deps.now.toISOString() })
      .where(and(eq(repos.orgId, turn.orgId), eq(repos.name, turn.name)));
    turnTaken = true;
    const scan = await scanRepo({
      repo: turn.name,
      since,
      fetch: github.fetch,
      token: turn.token,
      store: d1Store(deps.db, turn.orgId),
    });
    return scan.cutShort ? "cut" : "done";
  } catch (error) {
    if (isCapReached(error)) return turnTaken ? "cap" : "cap-before-turn";
    // Any other failure to take the turn is D1's, and ends the batch (`scheduled` logs it).
    if (!turnTaken) throw error;
    deps.log(`scan of ${turn.name} failed: ${message(error)}`);
    return "done";
  }
}

/** Scans `todo` in order until the budget is spent, a rate limit ends a read, or the list ends. */
async function scanTurns(deps: BatchDeps, github: Budgeted, { todo, more }: Picked) {
  const since = new Date(deps.now.getTime() - WINDOW_DAYS * DAY_MS).toISOString();
  const scanned: BatchResult["scanned"] = [];
  for (const turn of todo) {
    if (github.spent()) return { scanned, stop: "budget" as const };
    const ended = await scanTurn(deps, github, turn, since);
    if (ended === "cap-before-turn") return { scanned, stop: "d1-cap" as const };
    scanned.push({ orgId: turn.orgId, name: turn.name });
    if (ended === "cap") return { scanned, stop: "d1-cap" as const };
    if (ended === "cut") {
      return { scanned, stop: github.spent() ? ("budget" as const) : ("rate-limit" as const) };
    }
  }
  if (github.spent()) return { scanned, stop: "budget" as const };
  return { scanned, stop: more ? ("repos" as const) : ("all-scanned" as const) };
}

/** Runs one batch. Never throws for GitHub's sake; a failed D1 write while scanning does. */
export async function runBatch(deps: BatchDeps): Promise<BatchResult> {
  const { db, log, now } = deps;
  if (deps.app === null) {
    log("the GitHub App is not configured (GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY): no scan");
    return { stop: "not-configured", scanned: [], requests: 0 };
  }
  const github = budgeted(deps.fetch, deps.budget);
  const app = createGithubApp(deps.app, github.fetch, () => now.getTime());
  const tokens = await discover(db, app, { at: now.toISOString(), log });
  let result: BatchResult = { stop: "no-installations", scanned: [], requests: 0 };
  if (tokens !== null && tokens.size > 0) {
    const picked = await turns(db, tokens, deps.reposPerBatch);
    result = { ...(await scanTurns(deps, github, picked)), requests: 0 };
  }
  result.requests = github.used();
  log(
    `scanned ${result.scanned.length} repos with ${result.requests} GitHub requests; stopped: ${result.stop}`,
  );
  return result;
}

/** The Worker's bindings the scan reads. `Env` carries them. */
export interface ScanEnv {
  DB: D1Database;
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_API_BASE: string;
  SCAN_REQUEST_BUDGET: number | string;
  SCAN_REPOS_PER_BATCH: number | string;
  SCAN_D1_CAP?: number | string;
}

/** The App's config, or null when the id or the key is empty. */
export function appConfigOf(env: ScanEnv): GithubAppConfig | null {
  const appId = env.GITHUB_APP_ID?.trim();
  const privateKey = env.GITHUB_APP_PRIVATE_KEY?.trim();
  if (!appId || !privateKey) return null;
  return { appId, privateKey, apiBase: env.GITHUB_API_BASE };
}

/** A positive whole number from a var, or null. */
function countOf(value: number | string): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** The batch's deps from the Worker's `env`, each replaced by the one in `deps` when given. */
function depsOf(env: ScanEnv, deps: Partial<BatchDeps>, log: BatchDeps["log"]): BatchDeps | null {
  const budget = deps.budget ?? countOf(env.SCAN_REQUEST_BUDGET);
  const reposPerBatch = deps.reposPerBatch ?? countOf(env.SCAN_REPOS_PER_BATCH);
  if (budget === null || reposPerBatch === null) return null;
  return {
    db: deps.db ?? drizzle(capStatements(env.DB, d1CapOf(env)), { schema }),
    fetch: deps.fetch ?? ((input, init) => fetch(input, init)),
    app: deps.app === undefined ? appConfigOf(env) : deps.app,
    budget,
    reposPerBatch,
    now: deps.now ?? new Date(),
    log,
  };
}

/**
 * The cron's entry: the batch's deps from the Worker's `env`, any of them replaced by `deps` (a test's).
 * Nothing throws out of it: a failure is one log line.
 */
export async function scheduled(env: ScanEnv, deps: Partial<BatchDeps> = {}): Promise<void> {
  const log = deps.log ?? workerLog;
  const built = depsOf(env, deps, log);
  if (built === null) {
    log("SCAN_REQUEST_BUDGET and SCAN_REPOS_PER_BATCH must be positive whole numbers: no scan");
    return;
  }
  try {
    await runBatch(built);
  } catch (error) {
    log(`the hourly scan failed: ${message(error)}`);
  }
}
