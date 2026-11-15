import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { isSmoke } from "./synthetic.ts";

/**
 * Key/value facts about the deployment itself (for example the schema's own version).
 */
export const appMeta = sqliteTable("app_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

/**
 * A GitHub owner (a user or an organisation), keyed by GitHub's numeric id. Rows come from GitHub,
 * never from a form. Every catalogue row carries an `org_id`, and that id leads its primary key, so
 * one organisation's data never joins another's.
 */
export const organisations = sqliteTable("organisations", {
  id: integer("id").primaryKey(),
  /** Lower case. */
  login: text("login").notNull().unique(),
  type: text("type", { enum: ["User", "Organization"] }).notNull(),
  /** ISO 8601. */
  createdAt: text("created_at").notNull(),
  isSmoke: isSmoke(),
});

const orgId = () =>
  integer("org_id")
    .notNull()
    .references(() => organisations.id);

/** A repository an organisation added. `name` is lower case `owner/name`, as the engine keys a repo. */
export const repos = sqliteTable(
  "repos",
  {
    orgId: orgId(),
    name: text("name").notNull(),
    /** ISO 8601. */
    addedAt: text("added_at").notNull(),
    /**
     * ISO 8601: when the hourly scan last started a turn on this repo (written as the turn starts, so
     * a turn that is cut short or throws still counts). Null until the first one. The scan takes repos oldest first, never-scanned first of all.
     */
    scannedAt: text("scanned_at"),
    isSmoke: isSmoke(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.name] })],
);

// The tables below mirror the CLI's local store (packages/cli/src/*store.ts) column for column, plus
// `org_id` and `is_smoke`, so the engine's `Store` can be implemented over them for one organisation.
// JSON columns stay text, as they are locally.

export const jobs = sqliteTable(
  "jobs",
  {
    orgId: orgId(),
    provider: text("provider").notNull(),
    repo: text("repo").notNull(),
    runId: integer("run_id").notNull(),
    runAttempt: integer("run_attempt").notNull(),
    jobId: integer("job_id").notNull(),
    workflow: text("workflow").notNull(),
    jobName: text("job_name").notNull(),
    url: text("url").notNull(),
    commitSha: text("commit_sha").notNull(),
    branch: text("branch").notNull(),
    prNumber: integer("pr_number"),
    runner: text("runner").notNull(),
    runnerName: text("runner_name").notNull(),
    conclusion: text("conclusion"),
    startedAt: text("started_at"),
    completedAt: text("completed_at"),
    /** JSON. */
    steps: text("steps").notNull(),
    /** JSON. */
    annotations: text("annotations").notNull(),
    isSmoke: isSmoke(),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.provider, t.repo, t.runId, t.runAttempt, t.jobId] }),
    index("jobs_by_repo").on(t.orgId, t.repo),
  ],
);

export const attempts = sqliteTable(
  "attempts",
  {
    orgId: orgId(),
    repo: text("repo").notNull(),
    runId: integer("run_id").notNull(),
    runAttempt: integer("run_attempt").notNull(),
    conclusion: text("conclusion"),
    createdAt: text("created_at").notNull(),
    latestAttempt: integer("latest_attempt").notNull(),
    jobCount: integer("job_count").notNull(),
    isSmoke: isSmoke(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.repo, t.runId, t.runAttempt] })],
);

export const excerpts = sqliteTable(
  "excerpts",
  {
    orgId: orgId(),
    repo: text("repo").notNull(),
    jobId: integer("job_id").notNull(),
    url: text("url").notNull(),
    status: text("status").notNull(),
    excerpt: text("excerpt"),
    isSmoke: isSmoke(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.repo, t.jobId] })],
);

export const compares = sqliteTable(
  "compares",
  {
    orgId: orgId(),
    repo: text("repo").notNull(),
    base: text("base").notNull(),
    head: text("head").notNull(),
    /** JSON list of file names; NULL is a commit GitHub no longer has. */
    files: text("files"),
    isSmoke: isSmoke(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.repo, t.base, t.head] })],
);

/** Ids are deterministic (`key:<signature>`, `starter:<name>`), so the key is `(org_id, id)`. */
export const issues = sqliteTable(
  "issues",
  {
    orgId: orgId(),
    id: text("id").notNull(),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    status: text("status").notNull(),
    /** JSON. */
    signatures: text("signatures").notNull(),
    /** JSON. */
    explanation: text("explanation"),
    edited: integer("edited", { mode: "boolean" }).notNull().default(false),
    isSmoke: isSmoke(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.id] })],
);

export const failures = sqliteTable(
  "failures",
  {
    orgId: orgId(),
    repo: text("repo").notNull(),
    jobId: integer("job_id").notNull(),
    url: text("url").notNull(),
    signature: text("signature").notNull(),
    issueId: text("issue_id").notNull(),
    file: text("file"),
    title: text("title"),
    location: text("location"),
    errorLine: text("error_line").notNull(),
    isSmoke: isSmoke(),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.repo, t.jobId, t.signature] }),
    index("failures_by_issue").on(t.orgId, t.issueId),
  ],
);

export const modelCalls = sqliteTable(
  "model_calls",
  {
    orgId: orgId(),
    repo: text("repo").notNull(),
    jobId: integer("job_id").notNull(),
    issueId: text("issue_id").notNull(),
    outcome: text("outcome").notNull(),
    isSmoke: isSmoke(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.repo, t.jobId] })],
);

/** A person who signed in with GitHub, keyed by their GitHub user id. Refreshed on each sign-in. */
export const users = sqliteTable("users", {
  id: integer("id").primaryKey(),
  login: text("login").notNull(),
  name: text("name"),
  avatarUrl: text("avatar_url"),
  /** ISO 8601. */
  createdAt: text("created_at").notNull(),
  isSmoke: isSmoke(),
});

/**
 * A signed-in browser. `id` is the SHA-256 hex of the cookie's token, never the token. The GitHub
 * App's user tokens are sealed (`src/lib/crypto.ts`): they act for the person on GitHub, so they are
 * never stored or sent anywhere in the clear. Times are ISO 8601.
 */
export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    expiresAt: text("expires_at").notNull(),
    accessToken: text("access_token").notNull(),
    accessExpiresAt: text("access_expires_at").notNull(),
    refreshToken: text("refresh_token").notNull(),
    refreshExpiresAt: text("refresh_expires_at").notNull(),
    isSmoke: isSmoke(),
  },
  (t) => [index("sessions_by_user").on(t.userId)],
);
