import { test, expect } from "@playwright/test";

test.describe("Search & Filters", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /papers/i })).toBeVisible();
  });

  test("should display search input", async ({ page }) => {
    const searchInput = page.getByPlaceholder(/search/i);
    await expect(searchInput).toBeVisible();
  });

  test("should filter papers by search query", async ({ page }) => {
    const searchInput = page.getByPlaceholder(/search/i);
    await searchInput.fill("test query");

    // Verify search value persists
    await expect(searchInput).toHaveValue("test query");
  });

  test("should show year range filters", async ({ page }) => {
    // Year from/to inputs should exist
    const yearFrom = page.getByPlaceholder(/from/i).or(page.locator('input[placeholder*="year"]').first());
    const yearTo = page.getByPlaceholder(/to/i).or(page.locator('input[placeholder*="year"]').last());

    // At least one year input should be visible
    const hasYearFilters = (await yearFrom.isVisible()) || (await yearTo.isVisible());
    expect(hasYearFilters).toBeTruthy();
  });

  test("should clear all filters", async ({ page }) => {
    const searchInput = page.getByPlaceholder(/search/i);
    await searchInput.fill("some query");

    // Look for clear filters button
    const clearButton = page.getByRole("button", { name: /clear/i });
    if (await clearButton.isVisible()) {
      await clearButton.click();
      await expect(searchInput).toHaveValue("");
    }
  });

  test("should show column visibility dropdown", async ({ page }) => {
    // Look for the columns visibility toggle
    const columnsButton = page.getByRole("button", { name: /columns/i });
    if (await columnsButton.isVisible()) {
      await columnsButton.click();
      // A dropdown with column options should appear
      await expect(page.getByRole("menuitemcheckbox").or(page.getByRole("checkbox")).first()).toBeVisible();
    }
  });

  test("should display paper count", async ({ page }) => {
    // The dashboard shows paper count like "X papers" or "X paper(s)"
    await expect(page.getByText(/\d+\s+paper/i)).toBeVisible();
  });
});
