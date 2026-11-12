import { describe, expect, it } from "vitest";
import { GitHubApiError, createApi, type FetchLike } from "../src/providers/github-api.ts";
import { readGitHubActions } from "../src/index.ts";
import { API, REPO, RUNS, fakeGitHub, json } from "./github-fake.ts";

const PAGE = `/repos/${REPO}/pulls/1`;
const PAGE_URL = `${API}${PAGE}`;

/** A page route that answers the given statuses in order (the last one repeats). */
function answering(statuses: number[]) {
  let n = 0;
  return fakeGitHub({
    [PAGE]: () => {
      const status = statuses[Math.min(n, statuses.length - 1)] ?? 200;
      n += 1;
      return status === 200 ? json({ ok: true }) : new Response("", { status });
    },
  });
}

/** A wait that records each delay and does not sleep. */
function recordingWait() {
  const waits: number[] = [];
  return { wait: async (ms: number) => void waits.push(ms), waits };
}

describe("createApi.get retries GitHub 5xx", () => {
  it("gives the 200 after two 500s, waiting 1 s then 4 s", async () => {
    const gh = answering([500, 500, 200]);
    const { wait, waits } = recordingWait();
    const result = await createApi(gh.fetch, undefined, wait).get(PAGE_URL);
    expect(result).toEqual({ status: "ok", body: { ok: true }, next: null });
    expect(gh.calls.length).toBe(3);
    expect(waits).toEqual([1_000, 4_000]);
  });

  it.each([502, 503, 504])("retries a %i the same way", async (status) => {
    const gh = answering([status, 200]);
    const { wait, waits } = recordingWait();
    const result = await createApi(gh.fetch, undefined, wait).get(PAGE_URL);
    expect(result.status).toBe("ok");
    expect(gh.calls.length).toBe(2);
    expect(waits).toEqual([1_000]);
  });

  it("throws the same error as today after three 500s, with three calls", async () => {
    const gh = answering([500]);
    const { wait, waits } = recordingWait();
    const attempt = createApi(gh.fetch, undefined, wait).get(PAGE_URL);
    await expect(attempt).rejects.toThrow(GitHubApiError);
    await expect(attempt).rejects.toThrow(`GitHub answered 500 for ${PAGE_URL}`);
    expect(gh.calls.length).toBe(3);
    expect(waits).toEqual([1_000, 4_000]);
  });

  it("does not retry a 404", async () => {
    const gh = answering([404, 200]);
    const { wait, waits } = recordingWait();
    const result = await createApi(gh.fetch, undefined, wait).get(PAGE_URL);
    expect(result).toEqual({ status: "missing" });
    expect(gh.calls.length).toBe(1);
    expect(waits).toEqual([]);
  });

  it("does not retry a 403 refusal", async () => {
    const gh = answering([403, 200]);
    const { wait, waits } = recordingWait();
    await expect(createApi(gh.fetch, undefined, wait).get(PAGE_URL)).rejects.toThrow(
      `GitHub answered 403 for ${PAGE_URL}`,
    );
    expect(gh.calls.length).toBe(1);
    expect(waits).toEqual([]);
  });

  it("does not retry a 429 rate limit", async () => {
    const gh = answering([429, 200]);
    const { wait, waits } = recordingWait();
    const result = await createApi(gh.fetch, undefined, wait).get(PAGE_URL);
    expect(result).toEqual({ status: "rate-limited" });
    expect(gh.calls.length).toBe(1);
    expect(waits).toEqual([]);
  });

  it("does not retry a fetch that rejects", async () => {
    let calls = 0;
    const fetch: FetchLike = async () => {
      calls += 1;
      throw new TypeError("fetch failed");
    };
    const { wait, waits } = recordingWait();
    await expect(createApi(fetch, undefined, wait).get(PAGE_URL)).rejects.toThrow("fetch failed");
    expect(calls).toBe(1);
    expect(waits).toEqual([]);
  });
});

describe("readGitHubActions passes its wait to the page fetch", () => {
  it("retries the runs listing without sleeping, and gives up after three attempts", async () => {
    const gh = fakeGitHub({ [RUNS]: () => new Response("", { status: 500 }) });
    const { wait, waits } = recordingWait();
    await expect(
      readGitHubActions({ repo: REPO, since: "2026-11-01T00:00:00Z", fetch: gh.fetch, wait }),
    ).rejects.toThrow(`GitHub answered 500 for ${API}${RUNS}`);
    expect(gh.calls.length).toBe(3);
    expect(waits).toEqual([1_000, 4_000]);
  });
});
