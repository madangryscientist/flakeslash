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

A small Nx workspace on Bun workspaces:

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
bun run typecheck                 # nx run-many -t typecheck  (tsc, strict)
bun run lint                      # nx run-many -t lint  (oxlint --type-aware --deny-warnings + check-slop)
bun run format:check              # oxfmt --check  (`bun run format` fixes)
bun run test                      # nx run-many -t test  (Vitest under the Bun runtime)
bun run build                     # nx run-many -t build  (cli bundle, web, site)
bun run test:e2e                  # nx run-many -t test:e2e  (Playwright, web and site)
```

One project: `bunx nx test engine`, `bunx nx lint cli`. Nx caches in `.nx/`; add `--skip-nx-cache` to
force a rerun. There is no Nx Cloud here. Lint rules are all errors; fix the code, do not disable a
rule. A TODO carries an issue: `TODO(#123)`. Tests live in `packages/*/test/` and
`apps/*/src/**/*.test.ts` and run with `bun --bun vitest`.

`test:e2e web` builds with the e2e env on a fresh local D1 and leaves that build behind, so run
`bun run build` after it. A change to `apps/web` or `apps/site` also runs the deploy dry runs (from
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
- `nx.json` sets `"useDaemonProcess": false`; the daemon installs `nx@latest` into `/tmp` and does
  not clean it. Do not turn it on and do not run `nx daemon`.
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
4. **A secret is read from the environment, never from the tree.** The site holds none.
5. **Migrations are additive.** `drizzle-kit generate` writes the `.sql` and its `meta/` snapshot
   together (`bun run db:generate` in `apps/web`); never hand-write one.
