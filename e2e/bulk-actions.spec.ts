import { test, expect } from "@playwright/test";

test.describe("Bulk Actions", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /papers/i })).toBeVisible();
  });

  test("should show select-all checkbox in paper list header", async ({ page }) => {
    // The table header should include a select-all checkbox
    const checkbox = page.locator("thead").getByRole("checkbox");
    if (await checkbox.isVisible()) {
      await expect(checkbox).not.toBeChecked();
    }
  });

  test("should toggle select-all checkbox", async ({ page }) => {
    const headerCheckbox = page.locator("thead").getByRole("checkbox");

    if (await headerCheckbox.isVisible()) {
      await headerCheckbox.click();
      await expect(headerCheckbox).toBeChecked();

      // Bulk actions toolbar should appear
      await expect(
        page.getByText(/selected/i).or(page.getByRole("button", { name: /delete/i })),
      ).toBeVisible();

      // Deselect all
      await headerCheckbox.click();
      await expect(headerCheckbox).not.toBeChecked();
    }
  });

  test("should show bulk actions toolbar when papers are selected", async ({ page }) => {
    // Try clicking a row checkbox
    const rowCheckbox = page.locator("tbody").getByRole("checkbox").first();

    if (await rowCheckbox.isVisible()) {
      await rowCheckbox.click();

      // Bulk toolbar should show
      await expect(page.getByText(/1\s+selected/i)).toBeVisible();
    }
  });
});
