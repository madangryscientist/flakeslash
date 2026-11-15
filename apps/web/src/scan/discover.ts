/**
 * Discovery: the App's installations become `organisations` rows, the repos each one covers become
 * `repos` rows, and each live installation gets a token for this batch.
 */
import type { BatchDb } from "#/db/d1-store.ts";
import { runBatch as runStatements, type Statement } from "#/db/d1-store-shared.ts";
import type { Db } from "#/db/db.ts";
import { organisations, repos } from "#/db/schema.ts";
import type { GithubApp, Installation } from "#/github/app.ts";

/** D1 refuses a statement with more bound parameters than 100; a repos row binds 4. */
const REPOS_PER_INSERT = 20;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function accountType(type: string): "User" | "Organization" | null {
  return type === "User" || type === "Organization" ? type : null;
}

/**
 * The statements that record one installation: its account, its login refreshed when it was renamed and
 * `created_at` kept from first sight, then each repo not yet held. A repo that left the installation is
 * not deleted.
 */
function installationStatements(
  db: Db,
  account: { id: number; login: string; type: "User" | "Organization" },
  names: string[],
  at: string,
): Statement[] {
  const { id: orgId, type } = account;
  const login = account.login.toLowerCase();
  const rows = names.map((name) => ({ orgId, name: name.toLowerCase(), addedAt: at }));
  const statements: Statement[] = [
    db
      .insert(organisations)
      .values({ id: orgId, login, type, createdAt: at })
      .onConflictDoUpdate({ target: organisations.id, set: { login, type } }),
  ];
  for (let from = 0; from < rows.length; from += REPOS_PER_INSERT) {
    statements.push(
      db
        .insert(repos)
        .values(rows.slice(from, from + REPOS_PER_INSERT))
        .onConflictDoNothing({ target: [repos.orgId, repos.name] }),
    );
  }
  return statements;
}

/**
 * Mints a token for one installation, lists its repos, and writes the account and the repos as one
 * batch. Returns the token, or null when the installation is skipped this batch (each skip is logged).
 */
async function discoverOne(
  db: BatchDb,
  app: GithubApp,
  installation: Installation,
  { at, log }: { at: string; log: (line: string) => void },
): Promise<string | null> {
  const { login } = installation.account;
  if (installation.suspended) {
    log(`skipped installation ${installation.id} (${login}): suspended`);
    return null;
  }
  const type = accountType(installation.account.type);
  if (type === null) {
    log(`skipped installation ${installation.id} (${login}): a ${installation.account.type}`);
    return null;
  }
  try {
    const token = await app.installationToken(installation.id);
    const names = await app.installationRepos(token);
    const q: Db = db;
    const account = { ...installation.account, type };
    await runStatements(db, installationStatements(q, account, names, at));
    return token;
  } catch (error) {
    log(`skipped installation ${installation.id} (${login}): ${message(error)}`);
    return null;
  }
}

/**
 * Walks every installation of the App: a token per live one, keyed by its account's id (the
 * organisation's id). Null when the installations could not be listed: the batch then ends.
 */
export async function discover(
  db: BatchDb,
  app: GithubApp,
  options: { at: string; log: (line: string) => void },
): Promise<Map<number, string> | null> {
  let installations: Installation[];
  try {
    installations = await app.installations();
  } catch (error) {
    options.log(`could not list the App's installations: ${message(error)}`);
    return null;
  }
  const tokens = new Map<number, string>();
  for (const installation of installations) {
    const token = await discoverOne(db, app, installation, options);
    if (token !== null) tokens.set(installation.account.id, token);
  }
  return tokens;
}

export { message };
