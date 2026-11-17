import { expect, test } from "@playwright/test";
import { buildCommit } from "../src/build-commit.ts";

// The e2e build runs from this same checkout, so the commit the test computes is the one the build named.
// `-dirty` is kept: a dirty tree builds and tests with the same suffix.
const commit = buildCommit();
const sha = commit.replace(/-dirty$/, "");

// The home page, and a path with no route: the root layout (and its head) renders for both.
for (const path of ["/", "/no-such-page"]) {
  test(`${path} names the built commit in its head and shows no sha`, async ({ page }) => {
    await page.goto(path);
    const metas = page.locator("head meta[name='build-commit']");
    await expect(metas).toHaveCount(1);
    await expect(metas).toHaveAttribute("content", commit);
    const visible = await page.locator("body").innerText();
    expect(visible).not.toContain(sha);
  });
}
