import { expect, test } from "@playwright/test";

test("the home page renders", async ({ page }) => {
  const pageErrors: Error[] = [];
  page.on("pageerror", (error) => pageErrors.push(error));
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await expect(page.locator("h1")).toHaveText("FlakeSlash");
  await expect(page.getByText("Something went wrong")).toBeHidden();
  expect(pageErrors.map((error) => error.message)).toEqual([]);
});
