# FlakeSlash

Source-available flaky-test detection you can run yourself, under the Elastic License 2.0.

Every feature, with where it lives in the source: [FEATURES.md](FEATURES.md).

> **Status: alpha.** Changing fast. Expect breaking changes between versions. The `flakeslash` CLI scans GitHub Actions history on your machine, and the dashboard at https://flakeslash.slashslash.build scans the repos its GitHub App is installed on; upload is not built yet.

## Layout

| Path | What it is |
| --- | --- |
| `packages/engine` | flake detection |
| `packages/cli` | the `flakeslash` command |
| `apps/web` | the dashboard: TanStack Start on Cloudflare Workers, D1 via Drizzle |

The made-up personas that judge the dashboard, the report and the CLI live in [`docs/personas/`](docs/personas).

## Develop

```bash
bun install
bun run flakeslash --version
GITHUB_TOKEN=... bun run flakeslash scan owner/repo   # jobs that failed and passed on one commit
bun run typecheck && bun run lint && bun run format:check && bun run test
bun run build && bun run test:e2e
```

See [`AGENTS.md`](AGENTS.md) for the full gate and [`CONTRIBUTING.md`](CONTRIBUTING.md) for how to
send a change. [`docs/`](docs) has the testing policy and the getting-started page.

## Licence

Elastic License 2.0, see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE). FlakeSlash is a name of Jacobus Langner; the licence does not grant it.
