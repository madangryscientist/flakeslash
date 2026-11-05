import { describe, expect, it } from "vitest";
import { describeEngine, ENGINE_NAME, ENGINE_VERSION } from "../src/index.ts";

describe("engine", () => {
  it("names itself and its version", () => {
    expect(describeEngine()).toBe(`${ENGINE_NAME} ${ENGINE_VERSION}`);
  });
});
