# What FlakeSlash is

FlakeSlash reads CI history and builds one catalogue of what breaks: flaky tests, browser crashes,
dead runners, timeouts and out-of-memory errors. For each issue it answers why it happens, how often,
and which commits, PRs and teams it affects. It works across CI systems, so an organisation that runs
GitHub Actions, CircleCI and Jenkins has one view of how reliable its CI is.

It is open source and self-hostable. This file is the agreed design; none of it is built yet except
the skeleton. A change to the design changes this file in the same pull request.

## How data gets in

- **Scan, the main route.** `flakeslash scan <repo>...` reads a repo's history from its CI provider
  and needs no pipeline change. It reads every run's pass/fail record and the logs of failed jobs
  only. A job is never analysed twice, and a scan stops at its spending cap and reports what it
  covered.
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
  It is recorded at test level when the test is named, and at job level when it is not, as when a
  runner dies or a browser crashes before any results are written.
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
- Issues rank by commits affected in the last 30 days, with CI minutes lost as a second sort.

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

## What people see

- **CLI.** `flakeslash scan` writes a local catalogue and report, for one repo or several.
- **Dashboard**, hosted or self-hosted, with GitHub sign-in. A person sees the repos they can read on
  GitHub. Uploads use a project token, so a Jenkins job needs no GitHub login.
  - **Catalogue**, the home page: issues ranked by how much they hurt.
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
