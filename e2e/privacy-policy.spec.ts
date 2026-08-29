import { test, expect, type Browser, type Page } from "@playwright/test";
import { openAccountMenu, waitForDashboard } from "./helpers";

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
 *
 * PAPERLUME-PRIVACY-001C added the authenticated half of that reachability:
 * Account menu → Privacy Policy, on both the desktop rail and the narrow-screen
 * drawer. The signed-out `/auth` link is unchanged and still covered above.
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

test.describe("Authenticated privacy entry point (Account menu)", () => {
  test("reaches /privacy from the Account menu without signing the user out", async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);

    const menu = await openAccountMenu(page);
    const item = menu.getByRole("menuitem", { name: "Privacy Policy" });
    // An in-app route, not the canonical absolute URL: the same control has to
    // resolve on localhost, on a Vercel Preview and in Production.
    await expect(item).toHaveAttribute("href", "/privacy");

    await item.click();
    await expectPolicyRendered(page);

    // Still signed in — the session survived the navigation, and going back to
    // the dashboard needs no new sign-in.
    await page.goto("/dashboard", { waitUntil: "networkidle" });
    await waitForDashboard(page);
  });

  test("is keyboard-operable end to end", async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);

    const trigger = page.getByRole("button", { name: /^Account menu for / });
    await trigger.focus();
    await expect(trigger).toBeFocused();
    await page.keyboard.press("Enter");

    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();

    const item = menu.getByRole("menuitem", { name: "Privacy Policy" });
    await item.focus();
    await expect(item).toBeFocused();
    await page.keyboard.press("Enter");

    await expectPolicyRendered(page);
  });

  test("reaches /privacy cleanly from the narrow-screen drawer", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);

    const navTrigger = page.getByRole("button", { name: "Open navigation menu" });
    await navTrigger.click();
    const drawer = page.getByRole("dialog", { name: /PaperLume navigation/i });
    await expect(drawer).toBeVisible();

    await drawer.getByRole("button", { name: /^Account menu for / }).click();
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    await menu.getByRole("menuitem", { name: "Privacy Policy" }).click();

    await expectPolicyRendered(page);

    // Nothing modal survived the trip: no drawer, no menu, and — the failure
    // this guards — no `pointer-events: none` left on <body> by a layer that
    // was torn down mid-navigation instead of dismissed.
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("menu")).toHaveCount(0);
    expect(
      await page.evaluate(() => getComputedStyle(document.body).pointerEvents),
    ).not.toBe("none");

    // And the page is genuinely interactive: a link on it responds.
    await page.getByRole("banner").getByRole("link", { name: "PaperLume", exact: true }).click();
    await expect(page).not.toHaveURL(/\/privacy$/);
  });
});
