import { defineConfig, devices } from "@playwright/test";

const PORT = 4320;
// The GitHub stand-in (e2e/github-stub.ts); vite.config.ts points the e2e build at it.
const STUB_PORT = "4321";
// Set only for the post-deploy smoke: it runs against the deployed host and starts no local server.
const SMOKE_BASE_URL = process.env["SMOKE_BASE_URL"];

// Happy paths only, against a local test build on a fresh local D1 (`.wrangler/e2e`) seeded by
// `e2e/seed.ts`, signing in through a GitHub stand-in. With SMOKE_BASE_URL the config runs only the
// `smoke` project (e2e/smoke.spec.ts) against that host.
export default defineConfig({
  testDir: "./e2e",
  globalSetup: "../../scripts/test-tmp-scope.ts",
  forbidOnly: !!process.env["CI"],
  reporter: "list",
  // One local D1 holds every spec's rows: concurrent writers fail with SQLITE_BUSY.
  workers: 1,
  use: { baseURL: `http://localhost:${PORT}`, trace: "on-first-retry" },
  projects: SMOKE_BASE_URL
    ? [{ name: "smoke", testMatch: /smoke\.spec\.ts/, use: { baseURL: SMOKE_BASE_URL } }]
    : [{ name: "chromium", use: { ...devices["Desktop Chrome"] }, testIgnore: /smoke\.spec\.ts/ }],
  ...(SMOKE_BASE_URL
    ? {}
    : {
        webServer: [
          {
            command: "bun e2e/github-stub.ts",
            env: { FLAKESLASH_E2E_STUB_PORT: STUB_PORT },
            url: `http://localhost:${STUB_PORT}/health`,
            reuseExistingServer: false,
          },
          {
            command: [
              "rm -rf .wrangler/e2e",
              "mkdir -p .wrangler/e2e/tmp",
              "bun run build",
              "wrangler d1 migrations apply DB --local --env e2e --persist-to .wrangler/e2e",
              "bun e2e/seed.ts .wrangler/e2e/seed.sql",
              "wrangler d1 execute DB --local --env e2e --persist-to .wrangler/e2e --file .wrangler/e2e/seed.sql",
              `vite preview --port ${PORT} --strictPort`,
            ].join(" && "),
            env: {
              FLAKESLASH_E2E: "1",
              FLAKESLASH_E2E_STUB_PORT: STUB_PORT,
              CLOUDFLARE_ENV: "e2e",
              // The web server starts before `globalSetup` scopes TMPDIR, so it gets its own under
              // .wrangler/e2e, which the next run clears: miniflare and wrangler leave nothing in /tmp.
              TMPDIR: ".wrangler/e2e/tmp",
            },
            url: `http://localhost:${PORT}`,
            reuseExistingServer: false,
            timeout: 300_000,
          },
        ],
      }),
});
