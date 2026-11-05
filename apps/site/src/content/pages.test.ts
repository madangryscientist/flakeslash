import { describe, expect, it } from "vitest";
import { PAGES } from "./pages.ts";

describe("PAGES", () => {
  it("lists each page once, with the home page first", () => {
    const paths = PAGES.map((page) => page.to);
    expect(paths[0]).toBe("/");
    expect(new Set(paths).size).toBe(paths.length);
  });
});
