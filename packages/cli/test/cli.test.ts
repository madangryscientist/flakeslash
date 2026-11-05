import { describe, expect, it, vi } from "vitest";
import pkg from "../package.json" with { type: "json" };
import { run } from "../src/cli.ts";

describe("run", () => {
  it("prints the CLI package version for --version", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      expect(await run(["--version"])).toBe(0);
      expect(String(write.mock.calls[0]?.[0])).toContain(`flakeslash ${pkg.version}`);
    } finally {
      write.mockRestore();
    }
  });

  it("exits 0 for --help and for no arguments", async () => {
    expect(await run(["--help"])).toBe(0);
    expect(await run([])).toBe(0);
  });

  it("exits 2 for an unknown argument", async () => {
    expect(await run(["nope"])).toBe(2);
  });
});
