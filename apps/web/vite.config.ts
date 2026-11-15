import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The Playwright run keeps its local D1 apart, so it never touches dev data.
const e2e = process.env["FLAKESLASH_E2E"] === "1";

/**
 * The e2e run signs in through its GitHub stand-in (`e2e/github-stub.ts`) on
 * `FLAKESLASH_E2E_STUB_PORT`, so the build's GitHub bases point there and the sign-in secrets are
 * the fixed test values the stand-in expects. None of them is a real credential.
 */
function pointAtStub(config: { vars?: Record<string, unknown> }) {
  const port = process.env["FLAKESLASH_E2E_STUB_PORT"];
  if (!port) return {};
  const base = `http://localhost:${port}`;
  return {
    vars: {
      ...config.vars,
      GITHUB_OAUTH_BASE: base,
      GITHUB_API_BASE: base,
      // Test values only, matched by the stand-in.
      GITHUB_APP_CLIENT_ID: "e2e-client",
      GITHUB_APP_CLIENT_SECRET: "e2e-secret",
      // A test key, not a real one: base64 of the 32 bytes "flakeslash-e2e-test-key-not-real".
      TOKEN_KEY: "Zmxha2VzbGFzaC1lMmUtdGVzdC1rZXktbm90LXJlYWw=",
    },
  };
}

/**
 * Which build this is (`src/auth/stub-guard.ts`): `vite dev` is dev, a `CLOUDFLARE_ENV=e2e` build
 * is the test build, and any other is production, which refuses to start pointed off GitHub.
 */
function buildKind(command: "serve" | "build"): string {
  if (command === "serve") return "dev";
  return process.env["CLOUDFLARE_ENV"] === "e2e" ? "test" : "production";
}

export default defineConfig(({ command }) => ({
  define: { FLAKESLASH_BUILD_KIND: JSON.stringify(buildKind(command)) },
  resolve: { tsconfigPaths: true },
  plugins: [
    cloudflare({
      viteEnvironment: { name: "ssr" },
      persistState: e2e ? { path: ".wrangler/e2e" } : true,
      // The plugin probes for a free debugger port starting at 9229 and two runs probing at once
      // both get it (EADDRINUSE). Nothing in e2e attaches a debugger.
      ...(e2e ? { inspectorPort: false, config: pointAtStub } : {}),
    }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
}));
