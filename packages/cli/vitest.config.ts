import { defineConfig } from "vitest/config";

// Runs under the Bun runtime (`bun --bun vitest`): the code and the tests use Bun APIs.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    globalSetup: ["../../scripts/test-tmp-scope.ts"],
  },
});
