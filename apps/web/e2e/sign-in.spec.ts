import { expect, test } from "@playwright/test";

// Signs in through the GitHub stand-in (e2e/github-stub.ts), which answers as e2e-octocat.
test("sign in with GitHub, then sign out", async ({ page }) => {
  const pageErrors: Error[] = [];
  page.on("pageerror", (error) => pageErrors.push(error));
  await page.goto("/");
  await page.getByRole("link", { name: "Sign in with GitHub" }).click();
  await expect(page).toHaveURL("/");
  await expect(page.getByText("Signed in as e2e-octocat")).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.locator("h1")).toHaveText("FlakeSlash");
  await expect(page.getByText("Signed in as")).toBeHidden();
  await expect(page.getByRole("link", { name: "Sign in with GitHub" })).toBeVisible();
  expect(pageErrors.map((error) => error.message)).toEqual([]);
});
