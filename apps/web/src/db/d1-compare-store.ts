/** The compare methods of `d1Store`: GitHub's answer for a pair of commits, kept so a pair is asked once. */
import { and, eq } from "drizzle-orm";
import type { Store } from "@hackcove/flakeslash-engine";
import { upsertAll, type Scope } from "./d1-store-shared.ts";
import { compareFromRow } from "./rows.ts";
import { compares } from "./schema.ts";

export function compareMethods(scope: Scope): Pick<Store, "readCompare" | "writeCompare"> {
  const { q, orgId, own } = scope;
  return {
    async readCompare(repo, base, head) {
      const [row] = await q
        .select({ files: compares.files })
        .from(compares)
        .where(
          and(
            eq(compares.orgId, orgId),
            eq(compares.repo, repo),
            eq(compares.base, base),
            eq(compares.head, head),
          ),
        );
      return row === undefined ? null : compareFromRow(row);
    },
    async writeCompare(repo, base, head, result) {
      // A rate limit did not answer the question, so it is never stored.
      if (result.status === "rate-limited") return;
      const files = result.status === "ok" ? JSON.stringify(result.files) : null;
      await upsertAll(
        scope,
        compares,
        [compares.orgId, compares.repo, compares.base, compares.head],
        [{ ...own, repo, base, head, files }],
      );
    },
  };
}
