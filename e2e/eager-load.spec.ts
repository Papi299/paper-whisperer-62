import { test, expect } from "@playwright/test";
import { waitForDashboard, getPaperCount, collectConsoleErrors } from "./helpers";

/**
 * Test Group 1 — Whole-library eager-load regression
 *
 * Verifies that the dashboard eager-loads all pages automatically,
 * with no "Load More" button visible, and the full library is available.
 */
test.describe("Eager-load regression", () => {
  test("should load entire library without Load More button", async ({ page }) => {
    const errors = collectConsoleErrors(page);

    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);

    // The paper count should be visible
    const count = await getPaperCount(page);
    expect(count).toBeGreaterThan(0);

    // "Load More" button must NOT be visible — eager loading handles all pages
    await expect(page.getByRole("button", { name: /load more/i })).not.toBeVisible();
    await expect(page.getByText(/load more/i)).not.toBeVisible();

    // Wait a moment for any background page fetches to settle
    await page.waitForTimeout(3_000);

    // Still no "Load More" after settle
    await expect(page.getByRole("button", { name: /load more/i })).not.toBeVisible();

    // The table should have rows
    const rowCount = await page.locator("tbody tr").count();
    expect(rowCount).toBeGreaterThan(0);

    // No critical console errors (filter out noise like favicon, third-party)
    const criticalErrors = errors.filter(
      (e) =>
        !e.includes("favicon") &&
        !e.includes("third-party") &&
        !e.includes("net::ERR") &&
        !e.includes("[vite]") &&
        !e.includes("CORS"),
    );
    expect(criticalErrors).toHaveLength(0);
  });

  test("should show export options after full load", async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);

    // Wait for eager loading to settle
    await page.waitForTimeout(2_000);

    // Export button should be available
    const exportBtn = page.getByRole("button", { name: /export/i });
    await expect(exportBtn).toBeVisible();
    await exportBtn.click();

    // Export menu options should be visible
    await expect(page.getByRole("menuitem", { name: /csv/i })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: /ris/i })).toBeVisible();

    // Close by pressing Escape
    await page.keyboard.press("Escape");
  });

  test("should have all papers available via select-all", async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);

    const totalCount = await getPaperCount(page);

    // Wait for eager loading to settle
    await page.waitForTimeout(3_000);

    // Click select-all checkbox — the "N selected" count should match total
    const headerCheckbox = page.locator("thead").getByRole("checkbox");
    await expect(headerCheckbox).toBeVisible();
    await headerCheckbox.click();

    // The selection count should match the total paper count
    // This proves all pages were loaded (select-all only selects loaded papers)
    const selectedText = page.getByText(/\d+\s+selected/i);
    await expect(selectedText).toBeVisible({ timeout: 5_000 });
    const text = await selectedText.textContent();
    const selectedCount = parseInt(text?.match(/(\d+)/)?.[1] ?? "0", 10);
    expect(selectedCount).toBe(totalCount);

    // Uncheck select-all to clean up
    await headerCheckbox.click();
  });
});
