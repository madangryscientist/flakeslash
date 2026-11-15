import type { DrizzleD1Database } from "drizzle-orm/d1";
import { describe, expect, expectTypeOf, it } from "vitest";
import { readFailures, readIssues } from "./catalogue.ts";
import { failures, issues, organisations } from "./schema.ts";
import { testDb } from "./test-db.ts";

const ACME = 101;
const GLOBEX = 202;

async function twoOrgs() {
  const db = testDb();
  await db.insert(organisations).values([
    { id: ACME, login: "acme", type: "Organization", createdAt: "2026-11-15T00:00:00Z" },
    { id: GLOBEX, login: "globex", type: "User", createdAt: "2026-11-15T00:00:00Z" },
  ]);
  return db;
}

function issue(orgId: number, name: string) {
  return { orgId, id: "key:boom", name, kind: "test", status: "open", signatures: "[]" };
}

function failure(orgId: number, url: string) {
  return {
    orgId,
    repo: "acme/app",
    jobId: 7,
    url,
    signature: "boom",
    issueId: "key:boom",
    errorLine: "Error: boom",
  };
}

describe("readIssues", () => {
  it("returns only the organisation's own issue when two share an id", async () => {
    const db = await twoOrgs();
    await db.insert(issues).values([issue(ACME, "acme's"), issue(GLOBEX, "globex's")]);
    expect((await readIssues(db, ACME)).map((i) => i.name)).toEqual(["acme's"]);
    expect((await readIssues(db, GLOBEX)).map((i) => i.name)).toEqual(["globex's"]);
  });

  it("leaves out a smoke issue", async () => {
    const db = await twoOrgs();
    await db
      .insert(issues)
      .values([issue(ACME, "real"), { ...issue(ACME, "smoke"), id: "key:smoke", isSmoke: true }]);
    expect((await readIssues(db, ACME)).map((i) => i.name)).toEqual(["real"]);
  });
});

describe("readFailures", () => {
  it("returns only the organisation's own failure when two share a key", async () => {
    const db = await twoOrgs();
    await db.insert(failures).values([failure(ACME, "https://a"), failure(GLOBEX, "https://g")]);
    expect((await readFailures(db, ACME)).map((f) => f.url)).toEqual(["https://a"]);
    expect((await readFailures(db, GLOBEX)).map((f) => f.url)).toEqual(["https://g"]);
  });

  it("leaves out a smoke failure", async () => {
    const db = await twoOrgs();
    await db
      .insert(failures)
      .values([
        failure(ACME, "https://real"),
        { ...failure(ACME, "https://smoke"), jobId: 8, isSmoke: true },
      ]);
    expect((await readFailures(db, ACME)).map((f) => f.url)).toEqual(["https://real"]);
  });
});

describe("the data layer's handle", () => {
  it("takes the D1 database production passes, not only the test proxy", () => {
    expectTypeOf<DrizzleD1Database>().toExtend<Parameters<typeof readIssues>[0]>();
    expectTypeOf<DrizzleD1Database>().toExtend<Parameters<typeof readFailures>[0]>();
  });
});
