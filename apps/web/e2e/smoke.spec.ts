import { expect, test, type APIRequestContext } from "@playwright/test";
import { BUILD_COMMIT_PATTERN } from "../src/build-commit.ts";

/*
 * After a deploy, against the live host (SMOKE_BASE_URL, run with `--project smoke`): the home page names
 * the deployed commit in its build-commit meta. Request-only: no browser, no local server.
 */

const EXPECT_COMMIT = process.env["SMOKE_EXPECT_COMMIT"];
/** How long an edge may keep serving the previous page after the upload before the check fails. */
const COMMIT_WAIT_MS = 120_000;

const buildCommitOf = (html: string): string | undefined =>
  /<meta name="build-commit" content="([^"]*)"/.exec(html)?.[1];

interface HomeAnswer {
  status: number;
  seen: string | undefined;
}

/** The home page's status and build-commit, from a fresh query so no cache answers with an older copy. */
async function homeAnswer(request: APIRequestContext): Promise<HomeAnswer> {
  const response = await request.get(`/?commit-check=${crypto.randomUUID()}`, { timeout: 15_000 });
  return {
    status: response.status(),
    seen: response.ok() ? buildCommitOf(await response.text()) : undefined,
  };
}

/**
 * Asks until the page names `want`, or the wait runs out. Without `want` it asks once. An error answer or a
 * dropped connection while the edge switches over counts as not yet, like an older sha.
 */
async function waitForCommit(request: APIRequestContext, want?: string): Promise<HomeAnswer> {
  const deadline = Date.now() + (want ? COMMIT_WAIT_MS : 0);
  for (;;) {
    let answer: HomeAnswer;
    try {
      answer = await homeAnswer(request);
    } catch (error) {
      if (!want || Date.now() >= deadline) throw error;
      answer = { status: 0, seen: undefined };
    }
    if (!want || answer.seen === want || Date.now() >= deadline) return answer;
    await new Promise((done) => setTimeout(done, 5_000));
  }
}

test("the home page names the commit it was built from", async ({ request }) => {
  test.setTimeout(COMMIT_WAIT_MS + 30_000);
  const { status, seen } = await waitForCommit(request, EXPECT_COMMIT);
  expect(status).toBe(200);
  expect(seen, "the home page has no build-commit meta").toBeDefined();
  expect(seen).toMatch(BUILD_COMMIT_PATTERN);
  if (EXPECT_COMMIT)
    expect(seen, `the live home page names ${seen}, not the deployed ${EXPECT_COMMIT}`).toBe(
      EXPECT_COMMIT,
    );
});
