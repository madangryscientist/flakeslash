import { describe, expect, it, vi } from "vitest";
import pkg from "../package.json" with { type: "json" };
import type { FetchLike } from "@hackcove/flakeslash-engine";
import { run } from "../src/cli.ts";
import { parseScanArgs } from "../src/scan-args.ts";

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

const noNetwork: FetchLike = () => Promise.reject(new Error("no network in this test"));

/** Runs scan with a fake fetch that must never be reached, and returns the exit code and stderr. */
async function scan(args: string[], env: Record<string, string> = {}) {
  const chunks: string[] = [];
  const write = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  try {
    const code = await run(["scan", "acme/app", ...args], {
      fetch: noNetwork,
      env: { GITHUB_TOKEN: "t", ...env },
    });
    return { code, stderr: chunks.join("") };
  } finally {
    write.mockRestore();
  }
}

describe("the model flags", () => {
  const ENDPOINT = ["--model-url", "https://llm.example/v1"];
  const COMPLETE = [
    ...ENDPOINT,
    "--model",
    "m",
    "--cap-usd",
    "5",
    "--price-in",
    "1",
    "--price-out",
    "2",
  ];

  const without = (flag: string): string[] => {
    const at = COMPLETE.indexOf(flag);
    return COMPLETE.filter((_, index) => index !== at && index !== at + 1);
  };

  it.each([
    ["--model alone", ["--model", "m"], {}, "--model needs --model-url"],
    ["--cap-usd alone", ["--cap-usd", "5"], {}, "--cap-usd needs --model-url"],
    ["--price-in alone", ["--price-in", "1"], {}, "--price-in needs --model-url"],
    ["--price-out alone", ["--price-out", "1"], {}, "--price-out needs --model-url"],
    ["no --model", without("--model"), {}, "--model is required"],
    ["no --cap-usd", without("--cap-usd"), {}, "--cap-usd is required"],
    ["no --price-in", without("--price-in"), {}, "--price-in is required"],
    ["no --price-out", without("--price-out"), {}, "--price-out is required"],
    [
      "an endpoint from the environment and no cap",
      ["--model", "m", "--price-in", "1", "--price-out", "1"],
      { FLAKESLASH_MODEL_URL: "https://llm.example/v1" },
      "--cap-usd is required",
    ],
    ["a cap of 0", [...COMPLETE.slice(0, 5), "0", ...COMPLETE.slice(6)], {}, "--cap-usd"],
    [
      "a cap that is not a number",
      [...COMPLETE.slice(0, 5), "lots", ...COMPLETE.slice(6)],
      {},
      "--cap-usd",
    ],
    [
      "a negative price-in",
      [...COMPLETE.slice(0, 7), "-1", ...COMPLETE.slice(8)],
      {},
      "--price-in",
    ],
    ["an infinite price-out", [...COMPLETE.slice(0, 9), "Infinity"], {}, "--price-out"],
    ["a url that is not http", ["--model-url", "ftp://x", ...COMPLETE.slice(2)], {}, "--model-url"],
    ["a url that does not parse", ["--model-url", "llm", ...COMPLETE.slice(2)], {}, "--model-url"],
    [
      "a header line with no colon",
      COMPLETE,
      { FLAKESLASH_MODEL_HEADERS: "x-a: 1\n\nhunter2-no-colon" },
      "FLAKESLASH_MODEL_HEADERS line 3",
    ],
    ["a header with no name", COMPLETE, { FLAKESLASH_MODEL_HEADERS: ": value" }, "line 1"],
  ])("exits 2 and names the flag for %s", async (_name, args, env, expected) => {
    const { code, stderr } = await scan(args, env);
    expect(code).toBe(2);
    expect(stderr).toContain(expected);
  });

  it("never prints the text of a bad header line", async () => {
    const { stderr } = await scan(COMPLETE, { FLAKESLASH_MODEL_HEADERS: "hunter2-no-colon" });
    expect(stderr).not.toContain("hunter2");
  });

  it("builds the model options from flags and environment", () => {
    const parsed = parseScanArgs(["acme/app", ...COMPLETE], {
      FLAKESLASH_MODEL_KEY: "k",
      FLAKESLASH_MODEL_HEADERS: "x-opencode-session: abc: def\n\n  X-Other :  v  \r\n",
    });
    expect(parsed.model).toEqual({
      url: "https://llm.example/v1",
      key: "k",
      model: "m",
      capUsd: 5,
      priceIn: 1,
      priceOut: 2,
      headers: { "x-opencode-session": "abc: def", "X-Other": "v" },
      userAgent: `flakeslash/${pkg.version}`,
    });
  });

  it("lets the flag win over the environment, and accepts a price of 0", () => {
    const parsed = parseScanArgs(
      [
        "acme/app",
        ...ENDPOINT,
        "--model",
        "m",
        "--cap-usd",
        "1",
        "--price-in",
        "0",
        "--price-out",
        "0",
      ],
      { FLAKESLASH_MODEL_URL: "https://other.example" },
    );
    expect(parsed.model).toMatchObject({ url: "https://llm.example/v1", priceIn: 0, priceOut: 0 });
    expect(parsed.model?.key).toBeUndefined();
  });

  it("leaves model undefined, as before, when no endpoint is named", () => {
    expect(parseScanArgs(["acme/app"], {}).model).toBeUndefined();
    // A key or headers in the environment mean nothing without an endpoint.
    const env = { FLAKESLASH_MODEL_KEY: "k", FLAKESLASH_MODEL_HEADERS: "no colon here" };
    expect(parseScanArgs(["acme/app"], env).model).toBeUndefined();
  });
});
