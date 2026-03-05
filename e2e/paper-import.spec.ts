import { test, expect } from "@playwright/test";

test.describe("Paper Import", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });
    await expect(page.getByText(/\d+\s+paper/i)).toBeVisible({ timeout: 15_000 });
  });

  test("should open add paper dialog", async ({ page }) => {
    await page.getByRole("button", { name: /add papers/i }).click();

    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByText(/import by identifier/i)).toBeVisible();
  });

  test("should show manual entry tab", async ({ page }) => {
    await page.getByRole("button", { name: /add papers/i }).click();
    await expect(page.getByRole("dialog")).toBeVisible();

    // Tab is labeled "Manual" in the UI
    await page.getByRole("tab", { name: /manual/i }).click();

    await expect(page.getByLabel(/title/i)).toBeVisible();
  });

  test("should show bulk import tab", async ({ page }) => {
    await page.getByRole("button", { name: /add papers/i }).click();
    await expect(page.getByRole("dialog")).toBeVisible();

    // The "Import" tab is the default tab; ensure the textarea is visible
    await expect(page.locator("textarea")).toBeVisible();
  });

  test("should validate empty identifier submission", async ({ page }) => {
    await page.getByRole("button", { name: /add papers/i }).click();
    await expect(page.getByRole("dialog")).toBeVisible();

    // The "Import Papers" button should be disabled when the textarea is empty
    const submitButton = page.getByRole("button", { name: /import papers/i });
    await expect(submitButton).toBeVisible();
    await expect(submitButton).toBeDisabled();
  });

  test("should close add paper dialog", async ({ page }) => {
    await page.getByRole("button", { name: /add papers/i }).click();
    await expect(page.getByRole("dialog")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).not.toBeVisible();
  });
});
