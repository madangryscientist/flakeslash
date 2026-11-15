/**
 * Writes the e2e catalogue as SQL for `wrangler d1 execute` (playwright.config.ts runs it after the
 * migrations). Every time is relative to now, so the rows sit in the 30 day window whenever the suite
 * runs. Test values only: no real repo, person or token.
 *
 * `e2e-acme` (7001) holds four issues; `e2e-empty` (7002) holds none:
 * - A fails on three commits of `unit`, two of them flaky (the job failed and passed on that commit);
 * - B fails on one commit of `e2e`, flaky;
 * - C fails on two commits of `lint` and never passes: not a flake candidate;
 * - D is flaky on `build`, and dismissed.
 */
import { writeFileSync } from "node:fs";

const ACME = 7001;
const EMPTY = 7002;
const HOUR = 3_600_000;
const now = Date.now();
const at = (hoursAgo: number) => new Date(now - hoursAgo * HOUR).toISOString();

const sqlText = (value: string) => `'${value.replaceAll("'", "''")}'`;
const sqlValue = (value: string | number | null) => {
  if (value === null) return "NULL";
  return typeof value === "number" ? String(value) : sqlText(value);
};
const insert = (table: string, row: Record<string, string | number | null>) =>
  `INSERT INTO ${table} (${Object.keys(row).join(", ")}) VALUES (${Object.values(row).map(sqlValue).join(", ")});`;

type Run = { issue?: string; job: string; repo: string; commit: string; passed?: boolean };

const ISSUES = [
  { id: "key:a", name: "A: checkout total rounds the wrong way", status: "potential" },
  { id: "key:b", name: "B: search waits on a stale index", status: "potential" },
  { id: "key:c", name: "C: lint rule on unused imports", status: "potential" },
  { id: "key:d", name: "D: build cache misses on the runner", status: "dismissed" },
];

const flaky = (issue: string, job: string, repo: string, commit: string): Run[] => [
  { issue, job, repo, commit },
  { job, repo, commit, passed: true },
];

const RUNS: Run[] = [
  ...flaky("key:a", "unit", "e2e-acme/app", "a1"),
  ...flaky("key:a", "unit", "e2e-acme/app", "a2"),
  { issue: "key:a", job: "unit", repo: "e2e-acme/app", commit: "a3" },
  ...flaky("key:b", "e2e", "e2e-acme/web", "b1"),
  { issue: "key:c", job: "lint", repo: "e2e-acme/app", commit: "c1" },
  { issue: "key:c", job: "lint", repo: "e2e-acme/app", commit: "c2" },
  ...flaky("key:d", "build", "e2e-acme/web", "d1"),
];

function runRows(run: Run, index: number): string[] {
  const jobId = index + 1;
  const url = `https://github.test/${run.repo}/actions/runs/${jobId}/job/${jobId}`;
  const started = 48 + RUNS.length - index;
  const rows = [
    insert("jobs", {
      org_id: ACME,
      provider: "github-actions",
      repo: run.repo,
      run_id: jobId,
      run_attempt: 1,
      job_id: jobId,
      workflow: "CI",
      job_name: run.job,
      url,
      commit_sha: run.commit,
      branch: "main",
      pr_number: null,
      runner: "github-hosted",
      runner_name: "e2e runner",
      conclusion: run.passed ? "success" : "failure",
      started_at: at(started),
      completed_at: at(started - 0.1),
      steps: "[]",
      annotations: "[]",
    }),
  ];
  if (run.issue === undefined) return rows;
  return [
    ...rows,
    insert("failures", {
      org_id: ACME,
      repo: run.repo,
      job_id: jobId,
      url,
      signature: `sig:${run.issue}`,
      issue_id: run.issue,
      file: "test/e2e.test.ts",
      title: "an e2e test",
      location: null,
      error_line: "Error: boom",
    }),
  ];
}

const statements = [
  insert("organisations", {
    id: ACME,
    login: "e2e-acme",
    type: "Organization",
    created_at: at(24 * 40),
  }),
  insert("organisations", {
    id: EMPTY,
    login: "e2e-empty",
    type: "Organization",
    created_at: at(24 * 40),
  }),
  ...["e2e-acme/app", "e2e-acme/web"].map((name) =>
    insert("repos", { org_id: ACME, name, added_at: at(24 * 40), scanned_at: at(1) }),
  ),
  ...ISSUES.map((issue) =>
    insert("issues", { org_id: ACME, ...issue, kind: "test", signatures: "[]", explanation: null }),
  ),
  ...RUNS.flatMap(runRows),
];

const out = process.argv[2];
if (!out) throw new Error("usage: bun e2e/seed.ts <file.sql>");
writeFileSync(out, `${statements.join("\n")}\n`);
