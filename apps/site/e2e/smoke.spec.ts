import { expect, test } from "@playwright/test";
import { PAGES } from "../src/content/pages.ts";

/* Every page, on a desktop and a phone: the nav and the footer are there, there is no canonical link yet, nothing scrolls sideways. */
for (const { to, label } of PAGES) {
  test(`${label} (${to}): nav, footer`, async ({ page }) => {
    const response = await page.goto(to);
    expect(response?.status()).toBe(200);

    const nav = page.getByTestId("site-nav");
    for (const item of PAGES)
      await expect(nav.getByRole("link", { name: item.label, exact: true })).toHaveCount(1);
    await expect(page.getByTestId("footer")).toBeVisible();
    await expect(page.locator('link[rel="canonical"]')).toHaveCount(0);

    const width = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(width, "the page scrolls sideways").toBe(0);
  });
}

test("an unknown page is a 404", async ({ page }) => {
  const response = await page.goto("/no-such-page");
  expect(response?.status()).toBe(404);
});
