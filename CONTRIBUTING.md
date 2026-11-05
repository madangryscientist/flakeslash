# Contributing to FlakeSlash

Thanks for helping. This page is the short version of [`AGENTS.md`](AGENTS.md), the full operating
agreement for people and coding agents working here. Read it before a large change.

By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). A security problem goes to
[`SECURITY.md`](SECURITY.md), not to a public issue. Your contribution is licensed under MIT, as the
rest of the repo is (see [`LICENSE`](LICENSE)); there is no CLA.

## Start with an issue

For a bug, open an issue with the version and the steps. For anything bigger than a fix, open an
issue first so we can agree on it before you build it.

## The gate

A change is ready when all of these pass from a fresh checkout:

```bash
bun install
bun run typecheck       # tsc, strict, on every project
bun run lint            # oxlint (type-aware, --deny-warnings) and check-slop
bun run format:check    # oxfmt; `bun run format` fixes it
bun run test            # Vitest under Bun
bun run build           # the CLI bundle, the dashboard, the site
bun run test:e2e        # Playwright against the dashboard and the site
```

Playwright needs its browser once per machine: `(cd apps/web && bunx playwright install chromium-headless-shell)`.

Lint rules are errors: fix the code, do not disable a rule.

## Pull requests

- Branch from `main`, keep the change small, and rebase on `origin/main` before you push.
- Write the commit subject as a [Conventional Commit](https://www.conventionalcommits.org/)
  (`feat(scope): …`, `fix(scope): …`; `docs`, `chore`, `refactor`, `test`, `perf`, `build`, `ci`,
  `style`, `revert`). The scope is the area (`cli`, `engine`, `web`, `site`, `ci`) and the issue goes
  at the end: `fix(engine): handle an empty rule list (#12)`. The squash keeps your subject.
- Stage files by name. Never commit straight to `main`.
- No AI attribution trailers are required or expected.
