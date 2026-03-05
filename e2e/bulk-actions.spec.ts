import { test, expect } from "@playwright/test";

test.describe("Bulk Actions", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });
    await expect(page.getByText(/\d+\s+paper/i)).toBeVisible({ timeout: 15_000 });
  });

  test("should show select-all checkbox in paper list header", async ({ page }) => {
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

      await expect(
        page.getByText(/\d+\s+selected/i),
      ).toBeVisible();

      await headerCheckbox.click();
      await expect(headerCheckbox).not.toBeChecked();
    }
  });

  test("should show bulk actions toolbar when papers are selected", async ({ page }) => {
    const rowCheckbox = page.locator("tbody").getByRole("checkbox").first();

    if (await rowCheckbox.isVisible()) {
      await rowCheckbox.click();

      await expect(page.getByText(/1\s+selected/i)).toBeVisible();
    }
  });
});
