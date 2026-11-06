# FlakeSlash

Open source flaky-test detection you can run yourself. MIT licensed.

> **Status: skeleton.** The repo has its structure, gate and CI, and no product features yet.

## Layout

| Path | What it is |
| --- | --- |
| `packages/engine` | flake detection (stub) |
| `packages/cli` | the `flakeslash` command |
| `apps/web` | the dashboard: TanStack Start on Cloudflare Workers, D1 via Drizzle |
| `apps/site` | the public site, prerendered |

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

MIT, see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
