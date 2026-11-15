import { expect, test } from "@playwright/test";

// Signs in through the GitHub stand-in (e2e/github-stub.ts), which answers as e2e-octocat.
test("sign in with GitHub, then sign out", async ({ page }) => {
  const pageErrors: Error[] = [];
  page.on("pageerror", (error) => pageErrors.push(error));
  // The home page has no sign-in link yet, so the run starts the flow where a link would.
  await page.goto("/auth/github");
  await expect(page).toHaveURL("/");
  await expect(page.getByText("Signed in as e2e-octocat")).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.locator("h1")).toHaveText("FlakeSlash");
  await expect(page.getByText("Signed in as")).toBeHidden();
  expect(pageErrors.map((error) => error.message)).toEqual([]);
});
