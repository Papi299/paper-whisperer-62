import { test, expect, type Browser, type Page } from "@playwright/test";

/**
 * PAPERLUME-PRIVACY-001B — `/privacy` is a public route.
 *
 * The property under test is reachability, not wording: the unit suite
 * (`src/pages/__tests__/Privacy.test.tsx`) owns the approved-copy guard. What a
 * real browser is needed for is everything a component render cannot see —
 * that a signed-out visitor is not bounced to `/auth`, that the SPA rewrite
 * serves the route on direct entry and on a refresh (a client-side route with
 * no server rewrite would 404 there), and that the link on the auth page
 * actually resolves.
 *
 * The Playwright project signs every test in through `storageState`, so the
 * signed-out cases build their own context with no stored session rather than
 * signing out — a shared sign-out would race the other specs.
 */

const POLICY_HEADING = "PaperLume Privacy Policy";
const CANONICAL_URL = "https://app.paperlume.app/privacy";

/** A context with no PaperLume session at all. */
async function signedOutPage(browser: Browser) {
  const context = await browser.newContext({ storageState: undefined });
  const page = await context.newPage();
  return { context, page };
}

/** The assertions that must hold on the rendered policy, signed in or out. */
async function expectPolicyRendered(page: Page) {
  await expect(page.getByRole("heading", { level: 1, name: POLICY_HEADING })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page).toHaveURL(/\/privacy$/);
}

test.describe("Public privacy policy", () => {
  test("renders for a signed-out visitor entering the URL directly", async ({ browser }) => {
    const { context, page } = await signedOutPage(browser);

    await page.goto("/privacy", { waitUntil: "networkidle" });

    await expectPolicyRendered(page);
    // The auth guard on `/` sends a signed-out visitor to `/auth`. This route
    // must not do that, so assert on the URL rather than only on the content.
    await expect(page).not.toHaveURL(/\/auth/);
    await expect(page.getByPlaceholder("you@example.com")).toHaveCount(0);

    await context.close();
  });

  test("survives a browser refresh on /privacy", async ({ browser }) => {
    const { context, page } = await signedOutPage(browser);

    await page.goto("/privacy", { waitUntil: "networkidle" });
    await expectPolicyRendered(page);

    await page.reload({ waitUntil: "networkidle" });
    await expectPolicyRendered(page);

    await context.close();
  });

  test("is reachable by in-app navigation from the auth page", async ({ browser }) => {
    const { context, page } = await signedOutPage(browser);

    await page.goto("/auth", { waitUntil: "networkidle" });
    await expect(page.getByText("Manage your scientific paper collections")).toBeVisible({
      timeout: 10_000,
    });

    const link = page.getByRole("link", { name: "Privacy Policy" });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", "/privacy");

    await link.click();
    await expectPolicyRendered(page);

    await context.close();
  });

  test("sets the policy title and canonical reference, and gives them back on leaving", async ({
    browser,
  }) => {
    const { context, page } = await signedOutPage(browser);

    await page.goto("/privacy", { waitUntil: "networkidle" });
    await expectPolicyRendered(page);

    await expect(page).toHaveTitle(POLICY_HEADING);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", CANONICAL_URL);

    // Client-side navigation away must not leave the canonical URL of the
    // privacy policy attached to another route.
    await page.getByRole("banner").getByRole("link", { name: "PaperLume", exact: true }).click();
    await expect(page).toHaveURL(/\/auth/, { timeout: 10_000 });
    await expect(page).toHaveTitle("PaperLume");
    await expect(page.locator('link[rel="canonical"]')).toHaveCount(0);

    await context.close();
  });

  test("carries the sentinel approved disclosures", async ({ browser }) => {
    const { context, page } = await signedOutPage(browser);

    await page.goto("/privacy", { waitUntil: "networkidle" });
    await expectPolicyRendered(page);

    const article = page.locator("article");
    for (const sentinel of [
      "Maor Pichadza",
      "MutriSport",
      "Free / Unpaid tier of the Google Gemini API",
      "opted out of Vercel's optional use of Hobby-plan customer content for AI or model-training purposes",
      "18 years of age or older",
    ]) {
      await expect(article.getByText(sentinel, { exact: false }).first()).toBeVisible();
    }

    await expect(
      page.getByRole("link", { name: "mutrisport@gmail.com" }).first(),
    ).toHaveAttribute("href", "mailto:mutrisport@gmail.com");

    await context.close();
  });

  test("renders for an authenticated user too", async ({ page }) => {
    await page.goto("/privacy", { waitUntil: "networkidle" });

    await expectPolicyRendered(page);
    // A signed-in visitor is not redirected into the dashboard either.
    await expect(page).not.toHaveURL(/\/dashboard/);
  });
});
