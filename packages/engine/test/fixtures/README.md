# Fixtures for the GitHub Actions reader

Recorded with `gh api` from `madangryscientist/pixelslash` and trimmed to the fields the reader
uses (real field names, real values):

- `runs-41676366416.json`: the run. `run_attempt` 3, `conclusion` `success`, `pull_requests` empty.
- `jobs-41676366416-attempt-{1,2,3}.json`: that run's jobs per attempt. Attempt 1 has two failed jobs.
- `pulls-865de40.json`: `commits/{sha}/pulls` for the run's commit, PR 84.

Not recorded: `jobs-lost-runner.json` and `annotations-lost-runner.json`. The pixelslash and hackcove
history holds no job killed by a lost runner (searched 2026-11-06: every cancelled job was a concurrency
cancel), so these follow GitHub's documented shape: a `cancelled` job whose running step reads
`cancelled`, the steps after it `skipped`, and check-run annotations carrying "The runner has
received a shutdown signal". Replace them with a recording when one turns up.
