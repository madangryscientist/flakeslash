# What FlakeSlash is

FlakeSlash reads CI history and builds one catalogue of what breaks: flaky tests, browser crashes,
dead runners, timeouts and out-of-memory errors. For each issue it answers why it happens, how often,
and which commits, PRs and teams it affects. It works across CI systems, so an organisation that runs
GitHub Actions, CircleCI and Jenkins has one view of how reliable its CI is.

It is source-available under the Elastic License 2.0 and self-hostable. This file is the agreed design. Built so far: the engine and the `flakeslash` CLI (local scan, issues and report.html); the server, upload and dashboard are not built yet. A change to the design changes this file in the same pull request.

## How data gets in

- **Scan, the main route.** `flakeslash scan <repo>...` reads a repo's history from its CI provider
  and needs no pipeline change. It reads every run's pass/fail record and the logs of failed jobs
  only. A job is never analysed twice, and a scan stops at its spending cap and reports what it
  covered.
- **The GitHub App, for the dashboard.** Installing the App is enough. There is no webhook: a scan runs
  every hour, finds new installations by itself, records their accounts and repos, and scans them. A
  new failure usually shows up within an hour. That holds while an organisation's repos fit one batch,
  both in count (`SCAN_REPOS_PER_BATCH`) and in GitHub requests (`SCAN_REQUEST_BUDGET`, which every
  scan's re-listing of 90 days of runs draws on). Beyond that, repos take turns, the one scanned
  longest ago first.
  - A new installation's first scan reads back 90 days, which is how long GitHub keeps Actions logs.
    A big backfill fills over several hourly batches: each batch stops at its bounds, and the next one
    carries on from what is already stored.
  - The App asks for every permission it will need now, so an installed organisation never has to
    approve it again: Actions read, Contents read (for `CODEOWNERS` and compares), Checks write (for
    the PR check), Metadata read, and Members read (for sign-in, which an organisation admin approves).
- **Upload.** `flakeslash upload` is how new data arrives and how a CI system without a reader joins
  in. It takes any log or text file. JUnit XML is welcome and gives exact test names, but it is never
  required.
- **Providers.** GitHub Actions comes first. Provider (GitHub Actions, CircleCI, Jenkins) and runner
  (GitHub-hosted, Depot, Blacksmith, self-hosted) are separate fields, so the same test can be compared
  across runners.
- **Timing.** Start and end times are recorded from the first scan. Screens for them come later.

## What decides what

The pass/fail record decides what is a flake, and the model never does. That keeps the flake rate
reproducible, and it stays safe to rerun or swap the model.

- A **flake** passed and failed on the same commit, through a test retry, a CI re-run or a second run.
  The job that failed and passed is always the record, because that is what pass and fail prove. It
  names the tests it can, from the log, and from JUnit once that reader exists. A model's name for a test
  is a label for people to read, never counted. A retry inside one passing job is a test flake, seen only
  through JUnit, since passing jobs' logs are not read.
- A **suspect** matches a looser pattern, such as a test that fails on a PR and passes after an
  unrelated change. It is shown, and it never counts in the flake rate.
- The **flake rate** is flaky commits out of commits that ran the test, over the last 30 days.

The model reads log excerpts as free text. It says which test or component broke, what kind of
failure it was and the likely cause, and it proposes a catalogue entry.

## The catalogue

Every failure is one record with a kind: `test`, `browser-crash`, `runner-died`, `timeout`, `oom` or
another named by the model. Failures group into **issues**, across repos, so one Chromium crash that
hits three repos is one issue.

- An issue holds a name, kind, likely cause, text signatures, the affected tests and jobs, commits and
  PRs, first and last seen, and a status.
- A log that matches a known signature joins that issue with no model call. Only unmatched text goes to
  the model. A small starter set covers known crashes such as `Page crashed` and out-of-memory errors.
- An entry the model writes starts as **potential**. It becomes **confirmed** when pass/fail evidence
  proves a flake or a person confirms it.
- People can rename, merge, split or dismiss entries. A dismissed entry stays dismissed on a rescan.
- Only flake candidates are ranked: an issue with a job that failed and passed on one commit, or a
  suspect. Proven flakes come first, then suspects, each by commits affected in the last 30 days with
  CI minutes lost as a second sort. Other failing issues are counted but not ranked.

## Data and privacy

- Whole logs are read in memory and not stored. Only redacted excerpts around each failure are kept,
  with a link back to the full log on the provider. Excerpts outlive the provider's log expiry.
- Whole-log storage is an opt-in on a self-hosted server.
- The model is the user's own OpenAI-compatible endpoint, on the hosted version too. Nothing is sent
  unless one is named, and only redacted excerpts are sent.
- With no model, a scan still gives pass/fail flakes and starter-signature matches, with no
  explanations.
- A scan stays on the machine unless `--upload` is passed, and then goes only to the server named.
- Detailed rows last 90 days. Flake records and daily totals last indefinitely.
  - The detailed rows are a run's attempts and jobs, and their failures, log excerpts and model
    calls. A compare goes once neither of its commits is on a job still held. The issues are the
    catalogue and are never removed.
  - The expiry runs daily at 03:30 UTC. A run is removed by the first daily run after its creation
    falls before UTC midnight 90 days back. The hourly scan reads only the last 90 days, so a removed
    run is never read again.
  - Before its rows go, each proven job flake with evidence in an expiring run gets a **flake
    record**: the repo, workflow, job and commit, the day of its earliest failed run, links to its
    earliest failed and earliest passed jobs, the issues of its failures, and the failed job's
    provider and runner. It is written while both of its runs are still held, whichever expires first.
  - Each repo's expiring day gets its **daily totals**, one row per provider and runner: jobs, jobs
    on a run's first attempt and how many of those passed, failed jobs, flake records of that day,
    and the seconds the jobs ran. No new run can arrive for a day that old, so a day's totals are
    written once and are final. For a new installation whose first scan never reached its oldest
    days, those days' totals cover only what was read.
  - Smoke rows are removed like the rest and count in no total or record.

## What people see

- **CLI.** `flakeslash scan` writes a local catalogue and report, for one repo or several.
- **Dashboard**, hosted or self-hosted, with GitHub sign-in. A person sees the repos they can read on
  GitHub. Uploads use a project token, so a Jenkins job needs no GitHub login.
  - **Catalogue**, the home page: flake candidates ranked by how much they hurt.
  - **Issue page**: a commit-by-commit timeline, affected PRs, tests and jobs, log excerpts and the
    likely cause.
  - **Reliability overview**: first-attempt pass rate and flake trend by team, repo, provider and
    runner.
  - **PR page**: what is new in this PR against what is already flaking on `main`.
- **PRs** get one GitHub check that never blocks, says "new in this PR" or "already flaking on main",
  and links to the dashboard. There are no PR comments.
- **Teams** come from `CODEOWNERS` on the test's file, then a setting per repo, otherwise "unowned".

## Later

The first version scans GitHub Actions, reads logs with a model and shows the catalogue. These wait
until detection has earned trust: test quarantine, automatic retries, chat alerts, timing screens, a
blocking PR check, and CircleCI and Jenkins readers.
