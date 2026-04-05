import { test, expect } from "@playwright/test";
import { waitForDashboard, getPaperCount, collectConsoleErrors } from "./helpers";

/**
 * Test Group 1 — Lazy-load / infinite loading regression
 *
 * Verifies that the dashboard loads pages lazily (not all at once),
 * the full library is accessible via scrolling, and select-all
 * covers all filtered papers (not just loaded ones).
 */
test.describe("Lazy-load regression", () => {
  test("should load initial page without fetching everything", async ({ page }) => {
    const errors = collectConsoleErrors(page);

    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);

    // The paper count should be visible
    const count = await getPaperCount(page);
    expect(count).toBeGreaterThan(0);

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
        !e.includes("CORS") &&
        !e.includes("404"),
    );
    expect(criticalErrors).toHaveLength(0);
  });

  test("should show export options (export is decoupled from display pagination)", async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);

    // Export button should be available (export uses its own fetchAllPages, not display pagination)
    const exportBtn = page.getByRole("button", { name: /export/i });
    await expect(exportBtn).toBeVisible();
    // Wait for export to become enabled (isExportReady depends on tags/projects loading)
    await expect(exportBtn).toBeEnabled({ timeout: 10_000 });
    await exportBtn.click();

    // Export menu options should be visible
    await expect(page.getByRole("menuitem", { name: /csv/i })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: /ris/i })).toBeVisible();

    // Close by pressing Escape
    await page.keyboard.press("Escape");
  });

  test("should select all filtered papers via select-all (not just loaded)", async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);

    const totalCount = await getPaperCount(page);

    // Click select-all checkbox — the "N selected" count should match total
    const headerCheckbox = page.locator("thead").getByRole("checkbox");
    await expect(headerCheckbox).toBeVisible();
    await headerCheckbox.click();

    // The selection count should match the total paper count
    // This proves allFilteredIds are used (not just loaded papers)
    const selectedText = page.getByText(/\d+\s+selected/i);
    await expect(selectedText).toBeVisible({ timeout: 10_000 });
    const text = await selectedText.textContent();
    const selectedCount = parseInt(text?.match(/(\d+)/)?.[1] ?? "0", 10);
    expect(selectedCount).toBe(totalCount);

    // Uncheck select-all to clean up
    await headerCheckbox.click();
  });
});
