# FlakeSlash: repo conventions

FlakeSlash is a source-available tool for finding flaky tests: detect them in an engine, work with them
from a CLI and a hosted dashboard. No product domain is chosen yet, so nothing is routed anywhere.

**This repository is a skeleton.** It has the structure, the gate and the CI, and no product
features. The engine exports a name and a version; the dashboard and the site each render one page.
Flake detection, CI readers, storage and the API arrive as their own tickets, and
[`docs/product.md`](docs/product.md) is the design they build to.

This file is the operating agreement for contributors and agents working here: the gate, the landing
rule and the invariants. Keep it accurate.

## The gate

A small moon workspace (moon 2.6.5, pinned in the root `package.json`) on Bun workspaces.
`.moon/workspace.yml` lists the projects, `.moon/tasks/*.yml` holds what they inherit (shared inputs
and the Vitest `test` task), and each project has a `moon.yml`. There is no toolchain file: every task
runs on the system toolchain, so moon never downloads Bun or runs `bun install`. Keep it that way (no
`.moon/toolchains.yml`, `pipeline.installDependencies: false`):

| Project | Path | What it is |
| --- | --- | --- |
| `engine` | `packages/engine` | flake detection (a stub today) |
| `cli` | `packages/cli` | the `flakeslash` bin: argv, stdout and exit codes, over `@hackcove/flakeslash-engine` |
| `web` | `apps/web` | the dashboard: TanStack Start on Cloudflare Workers, D1 via Drizzle (one placeholder table) |
| `site` | `apps/site` | the public site: TanStack Start on a Worker, every page prerendered; no D1, no secrets |
| `scripts` | `scripts` | `check-slop.ts`, `test-tmp-scope.ts` (typecheck + lint only) |

`bunfig.toml` sets `[install] linker = "isolated"` and `globalStore = true`: a package sees its own declared dependencies and
the root's, not another package's. Declare what a package imports in that package's `package.json`.

CI runs these steps on GitHub-hosted runners (`ubuntu-latest`). `scripts/check-workflows.ts` refuses any job on the
self-hosted runner that lacks the same-repo guard.

A change is green when all of these pass **from the worktree**:

```bash
bun install                       # FIRST: a fresh worktree has no node_modules
bun run typecheck                 # moon run :typecheck  (tsc, strict)
bun run lint                      # moon run :lint  (oxlint --type-aware --deny-warnings + check-slop)
bun run format:check              # oxfmt --check  (`bun run format` fixes)
bun run test                      # moon run :test  (Vitest under the Bun runtime)
bun run build                     # moon run :build  (cli bundle, web, site)
bun run test:e2e                  # moon run :test-e2e  (Playwright, web and site)
```

One project: `bunx moon run engine:test`, `bunx moon run cli:lint`. A task id cannot hold a colon, so
the e2e task is `test-e2e` (`bunx moon run web:test-e2e`); the root script keeps the name `test:e2e`.
moon caches in `.moon/cache` (gitignored; it cannot be moved); add `--force` to rerun a cached task.
The root scripts run three tasks at a time (`--concurrency 3`). A shared moon remote cache (bazel-remote
over HTTP, the `remote:` block in `.moon/workspace.yml`) sits behind a bearer token read from
`MOON_REMOTE_TOKEN`. CI runs from this repo read it (a fork's pull request gets no secrets and runs
without it), and only a push to main writes to it (the write token is in the `moon-cache-write`
environment, deployable from `main` only). Locally moon only downloads
(`localReadOnly`): set `MOON_REMOTE_TOKEN` to a read token for remote hits; unset, moon warns about a
401 and runs on the local cache. moon has no
`^default`: every project is tagged `ts`, and `.moon/tasks/ts.yml` makes all of `packages/**` an
input to every task, so a change to the engine re-runs every project's tasks. In CI, `moon run`
diffs against the base branch before it runs anything, so each job that runs moon checks out the
full history and sets `MOON_BASE: origin/main`. Lint rules are all errors; fix the code, do not disable a
rule. A TODO carries an issue: `TODO(#123)`. Tests live in `packages/*/test/` and
`apps/*/src/**/*.test.ts` and run with `bun --bun vitest`.

Both e2e tasks are cached: a repeat run on unchanged code is a hit (locally and from the remote cache
in CI), a failed run is never cached, and `--force` reruns it.

When `web:test-e2e` runs, it builds with the e2e env on a fresh local D1 and leaves that build behind,
so run `bunx moon run web:build --force` after it: a plain `bun run build` is a cache hit (`dist` is
not an input), and moon does not restore the output it cached when the hash matches. CI's apps job
runs `web:build --force` for the same reason. A change to `apps/web` or `apps/site` also runs the deploy dry runs (from
the worktree root; they need no Cloudflare credentials):

```bash
(cd apps/web && bunx wrangler deploy --dry-run --outdir "$TMPDIR/fl-web-dry")
(cd apps/site && bunx wrangler deploy --dry-run --outdir "$TMPDIR/fl-site-dry")
```

First time on a machine: `(cd apps/web && bunx playwright install chromium-headless-shell)`; run it inside a workspace so it takes the repo's Playwright version.

**Generated files are not formatted.** `oxfmt` rewrites what it is given, so anything a tool writes
is excluded in `.oxfmtrc.json`'s `ignorePatterns`: the route tree, `worker-configuration.d.ts` and
the drizzle migrations. Add a pattern when a new generator appears. `**/*.md` is ignored too.

**/tmp is a quota'd tmpfs; do not fill it.**

- Every project's test run goes through `scripts/test-tmp-scope.ts` (a Vitest and Playwright
  `globalSetup`): `TMPDIR` is a fresh dir for the run and is removed after it. A new project's
  `vitest.config.ts` must list the same `globalSetup`.
- Scratch goes under `$TMPDIR`, never a hardcoded `/tmp`.

## Cloudflare, domains and publishing are human steps

The skeleton adds no Worker route and no custom domain: no domain is chosen. The `D1` binding in
`apps/web/wrangler.jsonc` carries a placeholder id. Creating the D1 database, the Worker routes, and
the first npm publish each wait for the maintainer's yes. The site emits no canonical link until a
domain exists.

## Landing

- Code changes land through pull requests; nobody pushes to `main`. Branch, gate, rebase on
  `origin/main`, push, open the PR.
- Commit subjects are Conventional Commits: `<type>(<scope>): <subject>`, with type one of `feat fix
  docs chore refactor test perf build ci style revert`. The squash keeps the subject.
- Stage files by name or `git add -A`; never `git commit -am` (it drops new files).
- No `Co-Authored-By` trailer and no AI attribution line, in a commit or a pull request.

## Invariants

1. **Exit codes are a contract.** `flakeslash` exits 0 on success, 1 when the run failed for a reason that
   is not usage (an outage, a refused token), 2 on a usage error.
2. **The CLI writes through `process.stdout` / `process.stderr`**, not `console` (the lint bans it
   outside `scripts/`).
3. **UI is composed from `@hackcove/ui-react`.** A custom style or component is a flag, not a fix; a
   reusable gap is filed against the hackcove repo. Keep the Catppuccin credit comment in each
   `styles.css`.
   The local `report.html` that `flakeslash scan` writes is a self-contained file with its own inline
   styles; it is outside this invariant, which covers `apps/` only.
4. **A secret is read from the environment, never from the tree.** The site holds none.
5. **Migrations are additive.** `drizzle-kit generate` writes the `.sql` and its `meta/` snapshot
   together (`bun run db:generate` in `apps/web`); never hand-write one.
