import { test, expect } from "@playwright/test";

test.describe("Paper Import", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /papers/i })).toBeVisible();
  });

  test("should open add paper dialog", async ({ page }) => {
    await page.getByRole("button", { name: /add papers/i }).click();

    // Dialog should be visible with tabs
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByText(/import by identifier/i)).toBeVisible();
  });

  test("should show manual entry tab", async ({ page }) => {
    await page.getByRole("button", { name: /add papers/i }).click();
    await expect(page.getByRole("dialog")).toBeVisible();

    // Click on manual entry tab
    await page.getByRole("tab", { name: /manual entry/i }).click();

    // Should show manual form fields
    await expect(page.getByLabel(/title/i)).toBeVisible();
  });

  test("should show bulk import tab", async ({ page }) => {
    await page.getByRole("button", { name: /add papers/i }).click();
    await expect(page.getByRole("dialog")).toBeVisible();

    // Click on bulk import tab
    await page.getByRole("tab", { name: /bulk import/i }).click();

    // Should show textarea for bulk identifiers
    await expect(
      page.getByPlaceholder(/enter.*identifiers/i).or(page.locator("textarea")),
    ).toBeVisible();
  });

  test("should validate empty identifier submission", async ({ page }) => {
    await page.getByRole("button", { name: /add papers/i }).click();
    await expect(page.getByRole("dialog")).toBeVisible();

    // Try to submit without entering an identifier
    const submitButton = page.getByRole("button", { name: /import|add|fetch/i }).last();
    if (await submitButton.isVisible()) {
      await submitButton.click();
      // Should remain on dialog or show a warning
      await expect(page.getByRole("dialog")).toBeVisible();
    }
  });

  test("should close add paper dialog", async ({ page }) => {
    await page.getByRole("button", { name: /add papers/i }).click();
    await expect(page.getByRole("dialog")).toBeVisible();

    // Press Escape to close
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).not.toBeVisible();
  });
});
