import { describe, expect, it } from "vitest";
import { appMeta } from "./schema.ts";
import { testDb } from "./test-db.ts";

describe("testDb", () => {
  it("applies the migrations and round-trips a row", async () => {
    const db = testDb();
    await db.insert(appMeta).values({ key: "schema", value: "1" });
    expect(await db.select().from(appMeta)).toEqual([{ key: "schema", value: "1" }]);
  });
});
