import { describe, expect, it } from "vitest";
import { budgeted } from "./budget.ts";

describe("the batch's request budget", () => {
  it("counts every request whatever the host, passes it through unchanged, then answers a rate limit", async () => {
    const sent: { url: string; init: RequestInit | undefined }[] = [];
    const budget = budgeted(async (url, init) => {
      sent.push({ url, init });
      return new Response("ok");
    }, 2);
    const init: RequestInit = { headers: { authorization: "Bearer t" }, redirect: "manual" };

    await budget.fetch("https://api.github.com/repos/a/b/actions/jobs/1/logs", init);
    expect(budget.spent()).toBe(false);
    await budget.fetch("https://blob.example.test/signed-log", { headers: {} });
    expect(budget.spent()).toBe(true);
    const refused = await budget.fetch("https://api.github.com/repos/a/b/actions/runs", init);

    expect(sent.map((call) => call.url)).toEqual([
      "https://api.github.com/repos/a/b/actions/jobs/1/logs",
      "https://blob.example.test/signed-log",
    ]);
    expect(sent[0]?.init).toBe(init);
    expect(refused.status).toBe(403);
    expect(refused.headers.get("x-ratelimit-remaining")).toBe("0");
    expect(budget.used()).toBe(2);
  });
});
