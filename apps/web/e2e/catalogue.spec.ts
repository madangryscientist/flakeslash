import { type Page, expect, test } from "@playwright/test";

// The catalogue `e2e/seed.ts` writes: e2e-acme holds issues A to D, e2e-empty holds none.
const A = "A: checkout total rounds the wrong way";
const B = "B: search waits on a stale index";
const C = "C: lint rule on unused imports";
const D = "D: build cache misses on the runner";

async function signIn(page: Page) {
  await page.goto("/");
  await page.getByRole("link", { name: "Sign in with GitHub" }).click();
  await expect(page.getByText("Signed in as e2e-octocat")).toBeVisible();
}

const section = (page: Page, login: string) =>
  page.getByRole("region", { name: login, exact: true });

test("each organisation lists its flake candidates in rank order", async ({ page }) => {
  await signIn(page);
  const acme = section(page, "e2e-acme");
  // A row reads its name, then its facts.
  await expect(acme.getByText(/^[A-D]: /)).toHaveText([new RegExp(`^${A}`), new RegExp(`^${B}`)]);
  await expect(acme.getByText("Flaky", { exact: true })).toHaveCount(2);
  await expect(acme.getByText(C)).toBeHidden();
  await expect(acme.getByText(D)).toBeHidden();
  await expect(acme.getByText("1 failing issue is not a flake candidate.")).toBeVisible();

  const empty = section(page, "e2e-empty");
  await expect(empty.getByText("No flake candidates in the last 30 days.")).toBeVisible();
});

test("a dismissed issue is hidden until asked for, then listed by name without a rank", async ({
  page,
}) => {
  await signIn(page);
  const acme = section(page, "e2e-acme");
  await expect(acme.getByText(D)).toBeHidden();
  await acme.getByRole("link", { name: "Show dismissed (1)" }).click();
  await expect(page).toHaveURL("/?dismissed=1");

  const dismissed = acme.getByRole("region", { name: "Dismissed" });
  await expect(dismissed.getByText(D)).toBeVisible();
  await expect(dismissed).not.toContainText(/\b[0-9]\b/);
  await expect(acme.getByRole("link", { name: "Hide dismissed" })).toBeVisible();
});

test("the signed-in page fits a phone's width", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await expect(section(page, "e2e-acme").getByText(A)).toBeVisible();
  const fits = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  expect(fits).toBe(true);
});
