# FlakeSlash features

Checked against main at cd29caf on 2026-11-20.

## Command line
- `scan-github-actions`: read the GitHub Actions history of one or more GitHub repos with a GitHub token and no change to the pipeline, going back 90 days unless `--since <date>` names another start. How to reach it: `flakeslash scan <owner/repo>... [--since <date>]` with the token in `GITHUB_TOKEN`. Source: `packages/cli/src/cli.ts`, `packages/cli/src/scan-args.ts`, `packages/engine/src/pipeline.ts`.
- `local-store`: keep what a scan reads in a SQLite file on your machine (default `.flakeslash/flakeslash.db`), so the next scan fetches only what is new. How to reach it: `flakeslash scan <owner/repo>... --store <path>`. Source: `packages/cli/src/store.ts`, `packages/engine/src/store.ts`.
- `flake-same-commit`: see each job that failed and passed on the same commit reported as flaky, with links to the failed and passed runs; only that pass and fail record decides what is a flake. How to reach it: `flakeslash scan <owner/repo>...`. Source: `packages/engine/src/flakes.ts`.
- `suspects`: see a failure that looks flaky without that proof (a job failed on one commit and passed on the next commit of its branch, which touched none of the files the failure named) listed as a suspect and never counted as a flake. How to reach it: `flakeslash scan <owner/repo>...`. Source: `packages/engine/src/suspects.ts`, `packages/cli/src/suspect-lines.ts`.
- `scan-follow-on`: see a failed job that names no test and, in nearly every failure, started after another job in its run had already failed, counted on its own line and left out of the flake count. How to reach it: `flakeslash scan <owner/repo>...`. Source: `packages/engine/src/follow-on.ts`, `packages/engine/src/flakes.ts`, `packages/cli/src/cli.ts`.
- `redacted-excerpts`: have the log of each failed job read once, cut to the lines around the failure, cleared of secrets and kept with a link to the full log; the whole log is never stored. How to reach it: `flakeslash scan <owner/repo>...`. Source: `packages/engine/src/excerpt.ts`, `packages/engine/src/redact.ts`.
- `issue-grouping`: have failures grouped into issues without a model, across repos, with a starter set of patterns that names known browser crashes, out of memory errors and lost runners. How to reach it: `flakeslash scan <owner/repo>...`. Source: `packages/engine/src/issues.ts`, `packages/engine/src/signature.ts`, `packages/engine/src/starter-signatures.ts`.
- `report-html`: open `report.html`, written next to the store when every repo was scanned, with the flake candidates ranked, proven flakes first and then suspects, each by commits affected in the last 30 days, with its flake rate, pull requests and a log excerpt. How to reach it: `flakeslash scan <owner/repo>...`, then open `report.html` in the store's folder. Source: `packages/cli/src/catalogue-output.ts`, `packages/cli/src/report-html.ts`, `packages/engine/src/catalogue-rank.ts`.
- `json-output`: write the scan's results as JSON (`{ "repos", "explanations", "catalogue" }`) instead of the summary. How to reach it: `flakeslash scan <owner/repo>... --json`. Source: `packages/cli/src/cli.ts`, `packages/cli/src/catalogue-output.ts`.
- `model-explanations`: have the failures no pattern recognises explained by your own OpenAI-compatible endpoint, off until you name the endpoint, the model, a spending cap and both prices; one redacted excerpt is sent per unexplained issue, and the explanation never decides what is a flake. How to reach it: `flakeslash scan <owner/repo>... --model-url <url> --model <name> --cap-usd <n> --price-in <n> --price-out <n>`, where the environment variable `FLAKESLASH_MODEL_URL` can stand in for `--model-url` (the flag wins), and the optional `FLAKESLASH_MODEL_KEY` (the endpoint's API key, sent as a bearer token) and `FLAKESLASH_MODEL_HEADERS` (extra request headers, one "Name: value" per line) are added to each request. Source: `packages/cli/src/cli.ts`, `packages/cli/src/scan-args.ts`, `packages/engine/src/model.ts`, `packages/engine/src/explain.ts`.
- `model-via-claude-code`: have those failures explained through the local `claude` CLI as whoever is signed in to it, within a spending cap counted from the cost that CLI reports (the last call can pass the cap). How to reach it: `flakeslash scan <owner/repo>... --model-via claude-code --model <name> --cap-usd <n>`. Source: `packages/cli/src/claude-run.ts`, `packages/engine/src/model-claude-code.ts`.
- `issue-list`: list the issues the store holds, most failures first, with `--all` to include dismissed issues, `--json` to write `{ "issues": [...] }` with full ids, and `--store <path>` to name the store. How to reach it: `flakeslash issue list [--all] [--json] [--store <path>]`. Source: `packages/cli/src/issue.ts`.
- `issue-corrections`: correct one issue, and the correction holds on every later scan: `issue confirm` marks it a real flake, `issue dismiss` hides it, `issue rename` sets its name, `issue merge` folds the second issue into the first, and `issue split` with `--signature <text>` moves the failures that contain the text into a new issue named by it; each takes `--store <path>`. How to reach it: `flakeslash issue confirm|dismiss <id>`, `flakeslash issue rename <id> <name>`, `flakeslash issue merge <id> <id>`, `flakeslash issue split <id> --signature <text>`. Source: `packages/cli/src/issue.ts`, `packages/engine/src/issues.ts`.
- `cli-version`: print the version of the command and its engine. How to reach it: `flakeslash --version` (or `-v`). Source: `packages/cli/src/cli.ts`.
- `cli-help`: print the usage, options, environment variables and exit codes. How to reach it: `flakeslash --help` (or `-h`, or no argument). Source: `packages/cli/src/cli.ts`.
- `exit-codes`: rely on the exit code: 0 on success, 1 when the run failed (an outage, a refused token) and 2 on a usage error or a repo the token cannot see. How to reach it: the exit status of any `flakeslash` command. Source: `packages/cli/src/cli.ts`.
- `cli-not-on-npm`: the command line tool has no release you can install yet; it runs from a checkout of this repo. How to reach it: `bun install`, then `bun run flakeslash`. Source: `FACTS.md`, `package.json`, `packages/cli/src/index.ts`.

## Dashboard
- `hosted-dashboard`: use the dashboard at https://flakeslash.slashslash.build. How to reach it: `https://flakeslash.slashslash.build`. Source: `apps/web/wrangler.jsonc`.
- `dashboard-sign-in`: sign in with GitHub. How to reach it: `/auth/github`, which returns to `/auth/github/callback`. Source: `apps/web/src/routes/auth/github.ts`, `apps/web/src/routes/auth/github.callback.ts`.
- `dashboard-sign-out`: sign out from the button beside your login. How to reach it: `POST /auth/sign-out`. Source: `apps/web/src/routes/auth/sign-out.ts`, `apps/web/src/routes/index.tsx`.
- `dashboard-ranking`: see each organisation's flake candidates ranked, a count of its other failing issues, and its dismissed issues behind a link. How to reach it: `/`, and `/?dismissed=1` for the dismissed issues. Source: `apps/web/src/routes/index.tsx`.

## Scheduled work
- `dashboard-scan`: every 10 minutes (cron `5,15,25,35,45,55 * * * *`), the dashboard finds its GitHub App's installations, records their repos and scans the repos that waited longest, within a bound on GitHub requests, repos and D1 statements, with no webhook; a new installation's first scan reads back 90 days and a large history fills over several batches. How to reach it: install the GitHub App on a repo. Source: `apps/web/wrangler.jsonc`, `apps/web/src/cron.ts`, `apps/web/src/scan/hourly.ts`.
- `dashboard-expiry`: once a day at 03:30 UTC (cron `30 3 * * *`), the dashboard removes run, job and log excerpt rows older than 90 days, organisation by organisation, and first keeps a record of each proven flake and each day's totals. How to reach it: runs on its own. Source: `apps/web/wrangler.jsonc`, `apps/web/src/cron.ts`, `apps/web/src/expire/daily.ts`, `apps/web/src/expire/expire.ts`.

## Self-hosting
- `self-hosted-dashboard`: deploy your own dashboard as a Cloudflare Worker with a D1 database and your own GitHub App. How to reach it: the steps in `docs/deploying.md`. Source: `docs/deploying.md`.

## Packages
- `cli-package`: `packages/cli` (`@hackcove/flakeslash`, bin `flakeslash`) is the command line above. How to reach it: see `cli-not-on-npm`. Source: `packages/cli/package.json`.
- `internal-packages`: `packages/engine` (`@hackcove/flakeslash-engine`, flake detection) and `apps/web` (`@flakeslash/web`, the dashboard's own package) are internal and not installed by users. How to reach it: not reachable on their own; they are used by the command line and the dashboard. Source: `packages/engine/package.json`, `apps/web/package.json`.

## Planned
- `upload`: `flakeslash upload` to send any log or text file to the dashboard, so a CI system without a reader can join in.
- `junit-reader`: reading JUnit XML for exact test names and retries inside one passing job.
- `scan-upload-flag`: `flakeslash scan --upload` to send a scan to a named server; until then a scan stays on the machine.
- `project-tokens`: project tokens for uploads, so a CI job needs no GitHub login.
- `issue-page`: a dashboard page per issue with a commit by commit timeline, affected pull requests, tests and jobs, log excerpts and the likely cause.
- `reliability-overview`: a dashboard view of first attempt pass rate and flake trend by team, repo, provider and runner.
- `pr-page`: a dashboard page per pull request showing what is new in it against what already flakes on `main`.
- `pr-check`: one GitHub check on each pull request that never blocks and links to the dashboard.
- `teams-from-codeowners`: teams taken from `CODEOWNERS`, then a setting per repo, otherwise "unowned".
- `whole-log-storage`: keeping whole logs, as an opt-in on a self-hosted server.
- `later-features`: after detection has earned trust: test quarantine, automatic retries, chat alerts, timing screens, a blocking pull request check, and CircleCI and Jenkins readers.
