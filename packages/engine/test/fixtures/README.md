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

## Log fixtures (`logs/`)

`logs/<job id>.log` is a real job log after `cleanLog` and then `cutLog` (`src/excerpt.ts`). The raw
logs are not committed: each is fetched with `gh api --allow-escape-sequences` and cut in place, so the
committed file is the excerpt the engine would keep. Each is 1 KB to 17 KB.

- `125833669365`: pixelslash, a Playwright run with one failure among about 36 passing tests.
- `126029167526`: pixelslash, a Vitest run with a test that timed out.
- `123594006714`: pixelslash, a whole suite that went down because the server never came up (8 tests).
- `127626417545`: pixelslash, two different failures in one step.
- `122347904029`: pixelslash, a lint failure and no test.
- `126034000055`: pixelslash, an npm publish with only the generic exit line.
- `122931680354`: hackcove, a step where the process was stopped by SIGTERM (an annotation, no test).
  This is the nearest real thing to a runner that died.

The tests in `excerpt.test.ts` wrap each fixture in generated passing steps and cut that whole log. A
fixture is already an excerpt, so these tests cannot show the rule on a full raw log: the planner runs
`cleanLog` and `cutLog` on the seven raw logs at the gate.
