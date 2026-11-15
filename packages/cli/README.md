# @hackcove/flakeslash

The FlakeSlash command line: find the flaky tests in a GitHub repo from its GitHub Actions history,
with no change to the pipeline.

FlakeSlash is in alpha: it changes fast, and any version may break the flags, the output or the
store format.

## Use it

It needs [Bun](https://bun.sh) 1.4 or newer.

```bash
export GITHUB_TOKEN=<a token that can read the repo's Actions>
bunx @hackcove/flakeslash scan owner/repo
```

`scan` keeps what it reads in a local SQLite store (`.flakeslash/flakeslash.db` by default), so a
second scan fetches only what is new. It prints the jobs that both failed and passed on one commit,
groups each failure into an issue, and writes `report.html` next to the store with the issues
ranked by recent commits.

- `scan <owner/repo>... [--since <date>] [--store <path>] [--json]`: scan one or more repos.
- `issue list`, `issue confirm|dismiss|rename|merge|split`: correct the issue catalogue.
- Explanations from a model are off until you name your own endpoint (`--model-url`) or pass
  `--model-via claude-code`, with a spending cap.
- `flakeslash --help` lists every flag. Exit codes: 0 ok, 1 the run failed, 2 a usage error.

More in [Getting started](https://github.com/madangryscientist/flakeslash/blob/main/docs/getting-started.md).

## Licence

Elastic License 2.0. See `LICENSE` and `NOTICE` in this package.
