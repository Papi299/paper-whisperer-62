import { test, expect } from "@playwright/test";
import { waitForDashboard } from "./helpers";

/**
 * Branding smoke coverage.
 *
 * The product presents a single visible name, `PaperLume`, on every reachable
 * surface — before and after authentication — and in the browser tab. These
 * assertions also pin the absence of the legacy `Paper Whisperer` / `Paper Index`
 * labels so a regression cannot silently reintroduce a second product name.
 */

const PRODUCT_NAME = "PaperLume";
const LEGACY_NAMES = [/Paper Whisperer/i, /Paper Index/i];

test.describe("Product branding", () => {
  test("auth page shows PaperLume and no legacy name", async ({ browser }) => {
    const context = await browser.newContext({ storageState: undefined });
    const page = await context.newPage();

    await page.goto("/auth", { waitUntil: "networkidle" });
    await expect(
      page.getByText("Manage your scientific paper collections"),
    ).toBeVisible({ timeout: 10_000 });

    await expect(
      page.getByRole("heading", { name: PRODUCT_NAME, exact: true }),
    ).toBeVisible();
    await expect(page).toHaveTitle(PRODUCT_NAME);

    for (const legacy of LEGACY_NAMES) {
      await expect(page.getByText(legacy)).toHaveCount(0);
    }

    await context.close();
  });

  test("dashboard sidebar shows PaperLume and no legacy name", async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);

    await expect(
      page.getByRole("complementary").getByText(PRODUCT_NAME, { exact: true }),
    ).toBeVisible();
    await expect(page).toHaveTitle(PRODUCT_NAME);

    for (const legacy of LEGACY_NAMES) {
      await expect(page.getByText(legacy)).toHaveCount(0);
    }
  });
});
