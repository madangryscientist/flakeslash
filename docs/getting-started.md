# Getting started

FlakeSlash is a skeleton: there is nothing to detect yet ([the design](product.md) says what is coming). What you can do today:

```bash
bun install
bun run flakeslash --version     # flakeslash-engine 0.0.0
bun run flakeslash --help
```

The dashboard (`apps/web`) and the site (`apps/site`) each have a `dev` script: run `bun run dev` in the app's directory.

## Explanations from a model

A failure that no signature recognises can be explained by a model. The model names the test or component, the kind of failure and the likely cause, and proposes a literal pattern. The pattern is stored on the issue, so later logs that match it join the issue with no call. One redacted excerpt is sent per unexplained issue, so a failure repeated 50 times costs one call, and a job that got a reply is never sent again (a call that failed is tried again by a later scan).

Explanations are off until you name your own endpoint. FlakeSlash includes no model and has no default one, and nothing is sent anywhere unless you pass all five flags:

```bash
export GITHUB_TOKEN=...
export FLAKESLASH_MODEL_KEY=...          # the endpoint's key, if it needs one
flakeslash scan owner/repo \
  --model-url https://your-endpoint.example/v1 \
  --model your-model \
  --cap-usd 1 --price-in 0.2 --price-out 0.8
```

- Only the redacted excerpt of a failed job is sent, with the workflow and job name. Never a whole log.
- A model run sends only excerpts of the repos named on that command. An issue whose only excerpts are in other repos is left for a scan that names them.
- The cap is a hard stop. At the cap the scan still exits 0 and the summary says how many issues were explained and how many were not. A failed call also exits 0; the summary gives the count and the first error.
- Explanations never change which jobs are reported as flaky. Only passing and failing runs decide that.
- A pattern is kept only if it matches the text that later logs are matched on, in the issue's own failures. Otherwise the explanation is kept and the pattern is dropped.
- A pattern that also matches an issue that is already explained, or one a person edited, is dropped, and the failures stay where they are. A pattern that matches other unexplained issues merges them into the explained one.

One pick that was tested is `gpt-6-luna` on the opencode-go endpoint, at about $0.0004 per explained issue. That is advice, not a default. That endpoint needs a header, set with `FLAKESLASH_MODEL_HEADERS` (one `Name: value` per line):

```bash
export FLAKESLASH_MODEL_HEADERS='x-opencode-session: any-id-you-like'
```

## Correcting the catalogue

A scan groups failures into issues by itself. When it gets one wrong, you correct that one entry, and the correction survives every later scan:

```bash
flakeslash issue list                  # id, status, kind, failures and name, most failures first
flakeslash issue confirm <id>          # you say it is a real flake
flakeslash issue rename <id> "Ship API is down"
flakeslash issue dismiss <id>          # hide it: not a flake, or not worth tracking
flakeslash issue list --all            # include dismissed issues; --json gives full ids
```

- `list` shows the first 16 characters of each id. `<id>` is the full id or any prefix of 8 or more characters that matches exactly one issue; a prefix that matches none or several is refused (exit 2) and nothing is changed.
- Rename and dismiss mark the issue as edited, so a model never renames or merges it. Confirm is a verdict, not an edit: a model may still explain a confirmed issue (one you also renamed or dismissed stays protected).
- A new failure that matches a dismissed issue still joins it, and a scan never brings it back, even when one of its failures is part of a proven flake. `confirm` on a dismissed issue does.
- These commands read the same store as `scan` (`--store`, default `.flakeslash/flakeslash.db`) and never create one: with no store they say to run `flakeslash scan` first.

