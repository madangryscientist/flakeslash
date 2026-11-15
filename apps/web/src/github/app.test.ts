import { describe, expect, it } from "vitest";
import { API, json } from "../../../../packages/engine/test/github-fake.ts";
import { APP } from "#/scan/test-app.ts";
import { createGithubApp, type GithubFetch } from "./app.ts";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  signal: boolean;
}

/** A fetch answering `replies` by URL, recording each call. */
function stub(replies: Record<string, () => Response>) {
  const calls: Call[] = [];
  const fetch: GithubFetch = async (url, init = {}) => {
    calls.push({
      url,
      method: init.method ?? "GET",
      headers: Object.fromEntries(new Headers(init.headers)),
      signal: init.signal instanceof AbortSignal,
    });
    const reply = replies[url];
    if (reply === undefined) throw new Error(`unexpected request: ${url}`);
    return reply();
  };
  return { fetch, calls };
}

const page2 = `${API}/app/installations?per_page=100&page=2`;
const account = (id: number) => ({ id, login: `Org${id}`, type: "Organization" });

describe("the GitHub App client", () => {
  it("lists every page of installations under the App JWT, as flakeslash", async () => {
    const gh = stub({
      [`${API}/app/installations?per_page=100`]: () =>
        json([{ id: 1, account: account(11), suspended_at: null }], {
          headers: { link: `<${page2}>; rel="next"` },
        }),
      [page2]: () => json([{ id: 2, account: account(22), suspended_at: "2026-11-01T00:00:00Z" }]),
    });
    const installations = await createGithubApp(APP, gh.fetch).installations();

    expect(installations).toEqual([
      { id: 1, account: { id: 11, login: "Org11", type: "Organization" }, suspended: false },
      { id: 2, account: { id: 22, login: "Org22", type: "Organization" }, suspended: true },
    ]);
    expect(gh.calls.map((call) => call.headers["user-agent"])).toEqual([
      "flakeslash",
      "flakeslash",
    ]);
    expect(gh.calls[0]?.headers.authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(gh.calls.every((call) => call.signal)).toBe(true);
  });

  it("mints an installation token with a POST, and lists its repos with it", async () => {
    const next = `${API}/installation/repositories?per_page=100&page=2`;
    const gh = stub({
      [`${API}/app/installations/7/access_tokens`]: () =>
        json({ token: "ghs_seven", expires_at: "2026-11-15T13:00:00Z" }, { status: 201 }),
      [`${API}/installation/repositories?per_page=100`]: () =>
        json(
          { total_count: 2, repositories: [{ full_name: "Acme/One" }] },
          { headers: { link: `<${next}>; rel="next"` } },
        ),
      [next]: () => json({ total_count: 2, repositories: [{ full_name: "Acme/Two" }] }),
    });
    const app = createGithubApp(APP, gh.fetch);
    const token = await app.installationToken(7);

    expect(token).toBe("ghs_seven");
    expect(await app.installationRepos(token)).toEqual(["Acme/One", "Acme/Two"]);
    expect(gh.calls.map((call) => call.method)).toEqual(["POST", "GET", "GET"]);
    expect(gh.calls[1]?.headers.authorization).toBe("Bearer ghs_seven");
  });

  it("refuses a next link off the API base, and names a GitHub error", async () => {
    const off = stub({
      [`${API}/installation/repositories?per_page=100`]: () =>
        json(
          { repositories: [] },
          { headers: { link: '<https://evil.test/installation/repositories?page=2>; rel="next"' } },
        ),
    });
    await expect(createGithubApp(APP, off.fetch).installationRepos("t")).rejects.toThrow(
      `GitHub sent a next link off ${API}`,
    );

    const refused = stub({
      [`${API}/app/installations/7/access_tokens`]: () =>
        json({ message: "Not Found" }, { status: 404 }),
    });
    await expect(createGithubApp(APP, refused.fetch).installationToken(7)).rejects.toThrow(
      "GitHub POST /app/installations/7/access_tokens: 404",
    );
  });
});
