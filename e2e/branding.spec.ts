import { test, expect, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

/**
 * The canonical brand-pack masters (assets/brand/brand-spec.md). The in-app
 * mark and the favicon must serve exactly these bytes — not a redrawn or
 * copied logo — so they are compared byte for byte against the files on disk.
 */
const CANONICAL_SYMBOL = readFileSync(
  fileURLToPath(new URL("../assets/brand/svg/paperlume-symbol.svg", import.meta.url)),
);
const CANONICAL_PNG_32 = readFileSync(
  fileURLToPath(new URL("../assets/brand/png/paperlume-32.png", import.meta.url)),
);

/**
 * The single PaperLume mark inside `scope`: loaded, decorative, and serving the
 * canonical symbol's bytes.
 */
async function expectCanonicalMark(page: Page, scope: Locator) {
  const mark = scope.locator("img[src*='paperlume-symbol']");
  await expect(mark).toHaveCount(1);
  await expect(mark).toBeVisible();
  // Decorative: the visible "PaperLume" text beside it already names the brand.
  await expect(mark).toHaveAttribute("alt", "");
  expect(await mark.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(
    true,
  );
  const src = await mark.getAttribute("src");
  const body = await (await page.request.get(src!)).body();
  expect(body.equals(CANONICAL_SYMBOL), "the mark serves the canonical symbol").toBe(true);
}

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
    await expectCanonicalMark(page, page.locator("body"));

    for (const legacy of LEGACY_NAMES) {
      await expect(page.getByText(legacy)).toHaveCount(0);
    }

    await context.close();
  });

  test("favicon is the canonical symbol, with the canonical 32px PNG as fallback", async ({
    browser,
  }) => {
    const context = await browser.newContext({ storageState: undefined });
    const page = await context.newPage();
    await page.goto("/auth", { waitUntil: "networkidle" });

    const svg = page.locator('head link[rel="icon"][type="image/svg+xml"]');
    const png = page.locator('head link[rel="icon"][type="image/png"]');
    await expect(svg).toHaveCount(1);
    await expect(png).toHaveCount(1);
    await expect(png).toHaveAttribute("sizes", "32x32");

    const svgBody = await (await page.request.get((await svg.getAttribute("href"))!)).body();
    const pngBody = await (await page.request.get((await png.getAttribute("href"))!)).body();
    expect(svgBody.equals(CANONICAL_SYMBOL), "SVG favicon is the canonical symbol").toBe(true);
    expect(pngBody.equals(CANONICAL_PNG_32), "PNG favicon is the canonical 32px export").toBe(true);

    await context.close();
  });

  test("dashboard sidebar shows PaperLume and no legacy name", async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);

    await expect(
      page.getByRole("complementary").getByText(PRODUCT_NAME, { exact: true }),
    ).toBeVisible();
    await expect(page).toHaveTitle(PRODUCT_NAME);
    await expectCanonicalMark(page, page.getByRole("complementary"));

    for (const legacy of LEGACY_NAMES) {
      await expect(page.getByText(legacy)).toHaveCount(0);
    }
  });
});
