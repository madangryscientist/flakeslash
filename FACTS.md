# FlakeSlash facts

Checked against main at 0277e42 on 2026-11-17.

## What it is
FlakeSlash finds the tests in a software project's automated checks that sometimes pass and sometimes fail on the same code, and groups each failure with others like it. It is in alpha (the command line tool is version 0.1.0), so anything may change between versions.

## Today
- `scan-github-actions`: `flakeslash scan` reads the GitHub Actions history of one or more GitHub repos, with a GitHub token and no change to the pipeline, going back 90 days unless told otherwise.
- `flake-same-commit`: a job that failed and passed on the same commit is reported as flaky, and only that pass and fail record decides what is a flake.
- `suspects`: a failure that looks flaky without that proof (a job failed on one commit and passed on the next commit of its branch, which touched none of the files the failure named) is shown as a suspect and never counted as a flake.
- `local-store`: a scan keeps what it reads in a SQLite file on your machine, so the next scan fetches only what is new.
- `redacted-excerpts`: the log of a failed job is read once, cut to the lines around the failure, cleared of secrets and kept with a link to the full log; the whole log is never stored.
- `issue-grouping`: failures are grouped into issues without a model, across repos, and a starter set of patterns names known browser crashes, out of memory errors and lost runners.
- `report-html`: a scan writes `report.html` next to its store, with the flake candidates ranked, proven flakes first and then suspects, each by commits affected in the last 30 days, each with its flake rate, pull requests and a log excerpt.
- `json-output`: `flakeslash scan --json` writes the results as JSON instead of the summary.
- `issue-corrections`: `flakeslash issue` lists issues and lets a person confirm, rename, dismiss, merge or split one, and the correction holds on every later scan.
- `model-explanations`: a scan can explain failures no pattern recognises with a model, off until you name your own OpenAI-compatible endpoint or the local `claude` CLI and a spending cap; only redacted excerpts are sent, and the explanation never decides what is a flake.
- `exit-codes`: `flakeslash` exits 0 on success, 1 when the run failed (an outage, a refused token) and 2 on a usage error or a repo the token cannot see.
- `dashboard-sign-in`: the dashboard signs a person in with GitHub.
- `dashboard-scan`: the dashboard scans the repos its GitHub App is installed on every 10 minutes, with no webhook; a new installation's first scan reads back 90 days and a large history fills over several batches.
- `dashboard-ranking`: the dashboard ranks each organisation's flake candidates, counts its other failing issues, and lists dismissed issues behind a link.
- `dashboard-expiry`: the dashboard removes run, job and log excerpt rows older than 90 days once a day, and keeps a record of each proven flake and each day's totals.
- `cli-not-on-npm`: the command line tool has no release you can install yet; it runs from a checkout of this repo.

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

## Licence
- `licence`: Elastic-2.0, source available under the Elastic License 2.0 (not open source).

## Where it runs
- `cli-from-checkout`: the `flakeslash` command runs from a checkout of this repo with Bun 1.4 or newer (`bun install`, then `bun run flakeslash`).
- `hosted-dashboard`: the dashboard runs at https://flakeslash.slashslash.build.
- `self-hosted-dashboard`: you can deploy your own dashboard as a Cloudflare Worker with a D1 database and your own GitHub App, by `docs/deploying.md`.
