import { defineConfig } from "drizzle-kit";

// `bunx drizzle-kit generate` only; migrations apply with `wrangler d1 migrations apply`.
export default defineConfig({
  dialect: "sqlite",
  schema: ["./src/db/schema.ts"],
  out: "./drizzle",
});
