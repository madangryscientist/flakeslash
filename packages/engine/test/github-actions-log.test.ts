import { describe, expect, it } from "vitest";
import {
  GitHubApiError,
  readGitHubActions,
  readJobLog,
  type FetchLike,
  type JobRecord,
} from "../src/index.ts";
import { API, REPO, fakeGitHub, realRoutes, since, type Reply } from "./github-fake.ts";

const BLOB_PATH = "https://productionresultssa12.blob.core.windows.net/actions-results/log.txt";
const BLOB = `${BLOB_PATH}?sig=SECRET`;
const TOKEN = "ghp_test_token";

const logPath = (jobId: number) => `/repos/${REPO}/actions/jobs/${jobId}/logs`;
const logUrl = (jobId: number) => `${API}${logPath(jobId)}`;

const apiDown: FetchLike = async () => {
  throw new Error("connection reset");
};

const redirect = (location: string | null, status = 302): Response =>
  new Response(null, { status, headers: location === null ? {} : { location } });
const text = (body: string, status = 200): Reply => new Response(body, { status });

/** The API answers `api`; a redirect to BLOB, when `api` is one, is answered `blob`. */
function logRoutes(jobId: number, api: Reply, blob?: Reply): Record<string, Reply> {
  return blob === undefined ? { [logPath(jobId)]: api } : { [logPath(jobId)]: api, [BLOB]: blob };
}

function record(extra: Partial<JobRecord> = {}): JobRecord {
  return {
    repo: REPO,
    workflow: "CI",
    jobName: "Gate",
    jobId: 4242,
    url: `https://github.com/${REPO}/actions/runs/1/job/4242`,
    commit: "a".repeat(40),
    branch: "main",
    prNumber: null,
    provider: "github-actions",
    runner: "github-hosted",
    runnerName: "GitHub Actions 1",
    runId: 1,
    runAttempt: 1,
    conclusion: "failure",
    startedAt: null,
    completedAt: null,
    steps: [],
    annotations: [],
    ...extra,
  };
}

describe("readJobLog: reading a failed job's log", () => {
  it("follows the redirect and returns the log text", async () => {
    const gh = fakeGitHub(logRoutes(4242, redirect(BLOB), text("line 1\nline 2\n")));
    const result = await readJobLog({ job: record(), fetch: gh.fetch, token: TOKEN });
    expect(result).toEqual({ status: "ok", text: "line 1\nline 2\n" });
    expect(gh.calls).toEqual([logUrl(4242), BLOB]);
  });

  it("takes a 200 straight from the API when there is no redirect", async () => {
    const gh = fakeGitHub(logRoutes(4242, text("direct")));
    expect(await readJobLog({ job: record(), fetch: gh.fetch })).toEqual({
      status: "ok",
      text: "direct",
    });
    expect(gh.calls).toEqual([logUrl(4242)]);
  });

  it("returns attempt 1's log for a failed job of a run whose attempt 2 passed", async () => {
    const read = await readGitHubActions({
      repo: REPO,
      since,
      fetch: fakeGitHub(realRoutes()).fetch,
    });
    const failed = read.records.find((r) => r.jobId === 126057955448);
    expect(failed).toMatchObject({ runAttempt: 1, conclusion: "failure" });
    expect(read.records.some((r) => r.runAttempt === 3 && r.conclusion === "success")).toBe(true);

    const gh = fakeGitHub(logRoutes(126057955448, redirect(BLOB), text("attempt 1 log")));
    const result = await readJobLog({ job: failed!, fetch: gh.fetch });
    expect(result).toEqual({ status: "ok", text: "attempt 1 log" });
    // The job's own endpoint, not the run's.
    expect(gh.calls[0]).toBe(logUrl(126057955448));
  });
});

describe("readJobLog: the token", () => {
  it("sends the token to the API and no header at all to the redirect target", async () => {
    const gh = fakeGitHub(logRoutes(4242, redirect(BLOB), text("log")));
    await readJobLog({ job: record(), fetch: gh.fetch, token: TOKEN });
    expect(gh.headers[0]?.authorization).toBe(`Bearer ${TOKEN}`);
    expect(gh.redirects[0]).toBe("manual");
    expect(gh.headers[1]).toEqual({});
  });

  it("makes no second request for a redirect to a non-https URL", async () => {
    const gh = fakeGitHub(logRoutes(4242, redirect("http://example.com/log?sig=SECRET")));
    const result = await readJobLog({ job: record(), fetch: gh.fetch, token: TOKEN });
    expect(result).toEqual({ status: "try-later" });
    expect(gh.calls).toEqual([logUrl(4242)]);
  });

  it("is try-later for a redirect with no location", async () => {
    const gh = fakeGitHub(logRoutes(4242, redirect(null)));
    expect(await readJobLog({ job: record(), fetch: gh.fetch })).toEqual({ status: "try-later" });
    expect(gh.calls).toEqual([logUrl(4242)]);
  });

  it("throws on a 401 from the API host", async () => {
    const gh = fakeGitHub(logRoutes(4242, text("bad credentials", 401)));
    const failure = await readJobLog({ job: record(), fetch: gh.fetch, token: TOKEN }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(GitHubApiError);
    expect(failure).toMatchObject({ httpStatus: 401 });
    expect(String(failure)).not.toContain(TOKEN);
  });

  it("is try-later for a 401 from the blob host, and says nothing of its URL", async () => {
    const gh = fakeGitHub(logRoutes(4242, redirect(BLOB), text("", 401)));
    const result = await readJobLog({ job: record(), fetch: gh.fetch, token: TOKEN });
    expect(result).toEqual({ status: "try-later" });
    expect(gh.calls).toEqual([logUrl(4242), BLOB]);
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });
});

describe("readJobLog: a log that is gone", () => {
  it.each([404, 410])("is gone for a %i from the API, and does not throw", async (status) => {
    const gh = fakeGitHub(logRoutes(4242, text("Not Found", status)));
    expect(await readJobLog({ job: record(), fetch: gh.fetch })).toEqual({ status: "gone" });
    expect(gh.calls).toEqual([logUrl(4242)]);
  });

  it("is gone for a blob 404, as a job that never got a runner answers", async () => {
    const gh = fakeGitHub(
      logRoutes(4242, redirect(BLOB), text("The specified blob does not exist", 404)),
    );
    expect(await readJobLog({ job: record(), fetch: gh.fetch })).toEqual({ status: "gone" });
    expect(gh.calls).toEqual([logUrl(4242), BLOB]);
  });
});

describe("readJobLog: a log to try for later", () => {
  it.each([403, 429, 500, 503])("is try-later for a %i from the API", async (status) => {
    const gh = fakeGitHub(logRoutes(4242, text("no", status)));
    expect(await readJobLog({ job: record(), fetch: gh.fetch })).toEqual({ status: "try-later" });
    expect(gh.calls).toEqual([logUrl(4242)]);
  });

  it("is try-later for a blob 5xx", async () => {
    const gh = fakeGitHub(logRoutes(4242, redirect(BLOB), text("no", 503)));
    expect(await readJobLog({ job: record(), fetch: gh.fetch })).toEqual({ status: "try-later" });
    expect(gh.calls).toEqual([logUrl(4242), BLOB]);
  });

  it("is try-later when a fetch throws, at either hop, and says nothing of the blob URL", async () => {
    expect(await readJobLog({ job: record(), fetch: apiDown })).toEqual({ status: "try-later" });

    let calls = 0;
    const blobDown: FetchLike = async () => {
      calls += 1;
      if (calls === 1) return redirect(BLOB);
      throw new Error(`reset while fetching ${BLOB}`);
    };
    const result = await readJobLog({ job: record(), fetch: blobDown });
    expect(result).toEqual({ status: "try-later" });
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });
});

describe("readJobLog: a job that did not fail", () => {
  const lost = { title: "", message: "The runner has received a shutdown signal." };
  const cases: [string, Partial<JobRecord>, boolean][] = [
    ["a success", { conclusion: "success" }, false],
    ["a person's cancel", { conclusion: "cancelled", annotations: [] }, false],
    ["a lost-runner cancel", { conclusion: "cancelled", annotations: [lost] }, true],
  ];

  it.each(cases)("%s: reads the log only when it counts as failed", async (_name, extra, reads) => {
    const gh = fakeGitHub(logRoutes(4242, text("log")));
    const result = await readJobLog({ job: record(extra), fetch: gh.fetch });
    expect(gh.calls).toHaveLength(reads ? 1 : 0);
    expect(result).toEqual(reads ? { status: "ok", text: "log" } : { status: "gone" });
  });
});
