import { test, expect } from "@playwright/test";
import {
  waitForDashboard,
  getPaperCount,
  getVisiblePaperTitles,
  importPapersByIds,
  collectConsoleErrors,
} from "./helpers";

/**
 * Test Group 2 — Batch import order regression
 *
 * Verifies that papers imported in a known order appear in exact
 * reverse input order in the default table view, and that this
 * order is stable across page refreshes.
 *
 * Uses 3 PMIDs with known, distinct titles:
 *   39140285 → "Analysis of the immunomodulatory properties..."
 *   39140286 → "Better and Healthier Together?..."
 *   39140287 → "Harnessing a silicon carbide nanowire..."
 *
 * Expected default order (reverse input = last imported first):
 *   1. 39140287 — "Harnessing..."
 *   2. 39140286 — "Better..."
 *   3. 39140285 — "Analysis..."
 */

const TEST_PMIDS = ["39140285", "39140286", "39140287"];
const EXPECTED_TITLE_PREFIXES = [
  "Harnessing a silicon carbide", // 39140287 — last input, first in table
  "Better and Healthier Together", // 39140286
  "Analysis of the immunomodulatory", // 39140285 — first input, last in table
];

test.describe("Batch import order regression", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(60_000); // Import involves network calls to PubMed

  let initialCount: number;

  test("should clean up pre-existing test papers if any", async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);
    await page.waitForTimeout(3_000);

    // Check if any of our test papers already exist and delete them
    let found = false;
    for (const prefix of EXPECTED_TITLE_PREFIXES) {
      const row = page.locator("tbody tr").filter({ hasText: prefix }).first();
      if (await row.isVisible({ timeout: 1_000 }).catch(() => false)) {
        await row.getByRole("checkbox").click();
        found = true;
      }
    }

    if (found) {
      const selectedText = page.getByText(/\d+\s+selected/i);
      if (await selectedText.isVisible({ timeout: 2_000 }).catch(() => false)) {
        const toolbar = selectedText.locator("xpath=ancestor::div[1]");
        await toolbar.getByRole("button", { name: /delete/i }).click();
        const confirmDialog = page.getByRole("dialog").filter({ hasText: /cannot be undone/i });
        await expect(confirmDialog).toBeVisible({ timeout: 3_000 });
        await confirmDialog.getByRole("button", { name: /^delete$/i }).click();
        await page.waitForTimeout(2_000);
      }
    }
  });

  test("should import papers and verify reverse input order in table", async ({ page }) => {
    const errors = collectConsoleErrors(page);

    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);
    await page.waitForTimeout(2_000);
    initialCount = await getPaperCount(page);

    // Import the test papers
    await importPapersByIds(page, TEST_PMIDS, { timeout: 60_000 });

    // Wait for import to settle and UI to update
    await page.waitForTimeout(3_000);

    // Verify count increased by 3
    const newCount = await getPaperCount(page);
    expect(newCount).toBe(initialCount + 3);

    // Check the order of the first 3 papers (should be reverse input order)
    const titles = await getVisiblePaperTitles(page);
    expect(titles.length).toBeGreaterThanOrEqual(3);

    for (let i = 0; i < EXPECTED_TITLE_PREFIXES.length; i++) {
      expect(titles[i]).toContain(EXPECTED_TITLE_PREFIXES[i]);
    }

    // No critical console errors
    const criticalErrors = errors.filter(
      (e) =>
        !e.includes("favicon") &&
        !e.includes("net::ERR") &&
        !e.includes("[vite]") &&
        !e.includes("CORS"),
    );
    expect(criticalErrors).toHaveLength(0);
  });

  test("should maintain exact order after first page refresh", async ({ page }) => {
    const errors = collectConsoleErrors(page);

    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);

    // Wait for eager load to complete
    await page.waitForTimeout(3_000);

    const titles = await getVisiblePaperTitles(page);
    expect(titles.length).toBeGreaterThanOrEqual(3);

    for (let i = 0; i < EXPECTED_TITLE_PREFIXES.length; i++) {
      expect(titles[i]).toContain(EXPECTED_TITLE_PREFIXES[i]);
    }

    const criticalErrors = errors.filter(
      (e) =>
        !e.includes("favicon") &&
        !e.includes("net::ERR") &&
        !e.includes("[vite]") &&
        !e.includes("CORS"),
    );
    expect(criticalErrors).toHaveLength(0);
  });

  test("should maintain exact order after second page refresh", async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);

    await page.waitForTimeout(3_000);

    const titles = await getVisiblePaperTitles(page);
    expect(titles.length).toBeGreaterThanOrEqual(3);

    for (let i = 0; i < EXPECTED_TITLE_PREFIXES.length; i++) {
      expect(titles[i]).toContain(EXPECTED_TITLE_PREFIXES[i]);
    }
  });

  test("should clean up test papers", async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);
    await page.waitForTimeout(2_000);

    // Select the 3 test papers by clicking their row checkboxes
    for (const prefix of EXPECTED_TITLE_PREFIXES) {
      const row = page.locator("tbody tr").filter({ hasText: prefix }).first();
      if (await row.isVisible().catch(() => false)) {
        await row.getByRole("checkbox").click();
      }
    }

    // Wait for selection toolbar
    await expect(page.getByText(/\d+\s+selected/i)).toBeVisible({ timeout: 3_000 });

    // Click delete in the bulk actions bar
    // The bulk toolbar is near the "N selected" text
    const selectedBar = page.getByText(/\d+\s+selected/i).locator("xpath=ancestor::div[1]");
    await selectedBar.getByRole("button", { name: /delete/i }).click();

    // Confirm deletion
    const confirmDialog = page.getByRole("dialog").filter({ hasText: /cannot be undone/i });
    await expect(confirmDialog).toBeVisible({ timeout: 3_000 });
    await confirmDialog.getByRole("button", { name: /^delete$/i }).click();

    // Verify count is back to original
    await page.waitForTimeout(2_000);
    const finalCount = await getPaperCount(page);
    expect(finalCount).toBe(initialCount);
  });
});
