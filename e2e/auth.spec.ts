import { test, expect } from "@playwright/test";

test.describe("Authentication", () => {
  test("should display auth page when not logged in", async ({ browser }) => {
    // Use a fresh context without saved auth state
    const context = await browser.newContext({ storageState: undefined });
    const page = await context.newPage();

    await page.goto("/");
    // Should redirect to auth
    await expect(page).toHaveURL(/\/auth/);
    await expect(page.getByRole("heading", { name: /paper index/i })).toBeVisible();
    await expect(page.getByPlaceholder("you@example.com")).toBeVisible();
    await expect(page.getByPlaceholder("••••••••")).toBeVisible();

    await context.close();
  });

  test("should show validation errors for empty form", async ({ browser }) => {
    const context = await browser.newContext({ storageState: undefined });
    const page = await context.newPage();

    await page.goto("/auth");
    await page.getByRole("button", { name: /sign in/i }).click();

    // Expect validation error messages
    await expect(page.getByText(/valid email/i)).toBeVisible();

    await context.close();
  });

  test("should show sign up tab", async ({ browser }) => {
    const context = await browser.newContext({ storageState: undefined });
    const page = await context.newPage();

    await page.goto("/auth");
    await page.getByRole("tab", { name: /sign up/i }).click();

    // Should show the sign up button
    await expect(page.getByRole("button", { name: /sign up/i })).toBeVisible();

    await context.close();
  });

  test("should be signed in and on the dashboard", async ({ page }) => {
    // Uses the saved auth state from global setup
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /papers/i })).toBeVisible();
  });

  test("should show user context on dashboard", async ({ page }) => {
    await page.goto("/");
    // The "Add Papers" button should be visible — proves auth and dashboard loaded
    await expect(page.getByRole("button", { name: /add papers/i })).toBeVisible();
  });
});
