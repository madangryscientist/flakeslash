# Testing

Tests have layers; a behaviour is proved at the lowest layer that can prove it.

| Layer | Where | Runs with |
| --- | --- | --- |
| Unit | `packages/*/test/`, `apps/*/src/**/*.test.ts` | `bun run test` (Vitest under Bun) |
| Integration | `apps/web/src/db/test-db.test.ts`: the real migrations on an in-memory SQLite | `bun run test` |
| e2e / smoke | `apps/*/e2e/` (Playwright, against the production build in workerd) | `bunx moon run web:test-e2e`, `bunx moon run site:test-e2e` |

Every project's tests go through `scripts/test-tmp-scope.ts`, so a run cannot fill `/tmp`.
No test uses the live network or a real Cloudflare account.
