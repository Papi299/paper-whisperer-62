import { test, expect } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";
import {
  waitForDashboard,
  getPaperCount,
  getVisiblePaperTitles,
  collectConsoleErrors,
} from "./helpers";

/**
 * Test Group — File-based import order regression
 *
 * Verifies that papers imported via file upload (.bib) appear in exact
 * reverse file order in the default table view, and that this order
 * is stable across page refreshes.
 *
 * Fixture: e2e/fixtures/test-import-order.bib (3 BibTeX entries)
 *   1. E2E-TestAlpha ...
 *   2. E2E-TestBravo ...
 *   3. E2E-TestCharlie ...
 *
 * Expected default order (reverse input = last imported first):
 *   1. E2E-TestCharlie  (last in file → first in table)
 *   2. E2E-TestBravo
 *   3. E2E-TestAlpha    (first in file → last in table)
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_PATH = path.resolve(__dirname, "fixtures/test-import-order.bib");

/** Unique prefixes for the 3 test papers, in expected table order (reverse file order). */
const EXPECTED_ORDER = [
  "E2E-TestCharlie", // last in file → first in table
  "E2E-TestBravo",
  "E2E-TestAlpha",   // first in file → last in table
];

/** All test paper prefixes (for cleanup). */
const TEST_PREFIXES = ["E2E-TestAlpha", "E2E-TestBravo", "E2E-TestCharlie"];

/**
 * Helper: delete test papers by selecting their checkboxes and bulk deleting.
 * Returns the number of papers successfully selected.
 */
async function deleteTestPapers(page: import("@playwright/test").Page): Promise<number> {
  let selectedCount = 0;
  for (const prefix of TEST_PREFIXES) {
    const row = page.locator("tbody tr").filter({ hasText: prefix }).first();
    if (await row.isVisible({ timeout: 1_500 }).catch(() => false)) {
      await row.getByRole("checkbox").click();
      selectedCount++;
    }
  }

  if (selectedCount > 0) {
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

  return selectedCount;
}

test.describe("File-based import order regression", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(90_000);

  let initialCount: number;

  test("should clean up any pre-existing test papers", async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);
    await page.waitForTimeout(3_000);
    await deleteTestPapers(page);
  });

  test("should import papers via file upload and verify reverse order", async ({ page }) => {
    const errors = collectConsoleErrors(page);

    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);
    await page.waitForTimeout(2_000);
    initialCount = await getPaperCount(page);

    // Open Add Papers dialog
    await page.getByRole("button", { name: /add papers/i }).click();
    await expect(page.getByRole("dialog")).toBeVisible();

    // Switch to "Import File" tab
    const fileTab = page.getByRole("tab", { name: /file/i });
    await fileTab.click();

    // Upload the BibTeX fixture via the hidden file input
    const fileInput = page.locator("#file-import-input");
    await fileInput.setInputFiles(FIXTURE_PATH);

    // Wait for parse preview — "Found 3 papers"
    await expect(page.getByText(/found 3 paper/i)).toBeVisible({ timeout: 10_000 });

    // Click the "Import 3 Papers" button
    const importBtn = page.getByRole("button", { name: /import 3 paper/i });
    await expect(importBtn).toBeVisible();
    await importBtn.click();

    // Wait for "File Import Results" completion summary
    await expect(page.getByText("File Import Results")).toBeVisible({ timeout: 60_000 });

    // Verify "3 added" appears in the results section (scoped to the results div)
    const resultsSection = page.locator("div").filter({ hasText: "File Import Results" }).last();
    await expect(resultsSection.getByText(/3 added/)).toBeVisible({ timeout: 5_000 });

    // Close the dialog
    const dialog = page.getByRole("dialog");
    for (let attempt = 0; attempt < 5; attempt++) {
      if (!(await dialog.isVisible({ timeout: 500 }).catch(() => false))) break;
      // The button after file import complete is labeled "Close"
      const closeBtn = dialog.getByRole("button", { name: "Close", exact: true });
      if (await closeBtn.isVisible({ timeout: 300 }).catch(() => false)) {
        await closeBtn.click();
      } else {
        await page.keyboard.press("Escape");
      }
      await page.waitForTimeout(500);
    }
    await page.waitForTimeout(2_000);

    // Verify paper count increased by 3
    const newCount = await getPaperCount(page);
    expect(newCount).toBe(initialCount + 3);

    // Verify the top 3 papers are in exact reverse file order
    const titles = await getVisiblePaperTitles(page);
    expect(titles.length).toBeGreaterThanOrEqual(3);

    for (let i = 0; i < EXPECTED_ORDER.length; i++) {
      expect(titles[i]).toContain(EXPECTED_ORDER[i]);
    }

    // No "Load More" button visible (eager-load regression guard)
    await expect(page.getByRole("button", { name: /load more/i })).not.toBeVisible({ timeout: 2_000 });

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
    await page.waitForTimeout(3_000);

    const titles = await getVisiblePaperTitles(page);
    expect(titles.length).toBeGreaterThanOrEqual(3);

    for (let i = 0; i < EXPECTED_ORDER.length; i++) {
      expect(titles[i]).toContain(EXPECTED_ORDER[i]);
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

    for (let i = 0; i < EXPECTED_ORDER.length; i++) {
      expect(titles[i]).toContain(EXPECTED_ORDER[i]);
    }
  });

  test("should clean up test papers", async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);
    await page.waitForTimeout(2_000);

    const deleted = await deleteTestPapers(page);
    expect(deleted).toBe(3);

    // Verify count is back to original
    await page.waitForTimeout(2_000);
    const finalCount = await getPaperCount(page);
    expect(finalCount).toBe(initialCount);
  });
});
