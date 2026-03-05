import { test, expect } from "@playwright/test";

/** Helper: wait for dashboard to fully render after auth */
const waitForDashboard = async (page: import("@playwright/test").Page) => {
  await expect(page.getByText(/\d+\s+paper/i)).toBeVisible({ timeout: 15_000 });
};

test.describe("Authentication", () => {
  test("should display auth page when not logged in", async ({ browser }) => {
    const context = await browser.newContext({ storageState: undefined });
    const page = await context.newPage();

    await page.goto("/", { waitUntil: "networkidle" });
    // Should redirect to auth
    await expect(page).toHaveURL(/\/auth/, { timeout: 10_000 });
    await expect(page.getByText("Manage your scientific paper collections")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByPlaceholder("you@example.com")).toBeVisible();
    await expect(page.getByPlaceholder("••••••••")).toBeVisible();

    await context.close();
  });

  test("should show validation errors for empty form", async ({ browser }) => {
    const context = await browser.newContext({ storageState: undefined });
    const page = await context.newPage();

    await page.goto("/auth", { waitUntil: "networkidle" });
    await expect(page.getByText("Manage your scientific paper collections")).toBeVisible({ timeout: 10_000 });
    await page.getByRole("button", { name: /sign in/i }).click();

    await expect(page.getByText(/valid email/i)).toBeVisible({ timeout: 5_000 });

    await context.close();
  });

  test("should show sign up tab", async ({ browser }) => {
    const context = await browser.newContext({ storageState: undefined });
    const page = await context.newPage();

    await page.goto("/auth", { waitUntil: "networkidle" });
    await expect(page.getByText("Manage your scientific paper collections")).toBeVisible({ timeout: 10_000 });
    await page.getByRole("tab", { name: /sign up/i }).click();

    await expect(
      page.getByRole("button", { name: /create account/i }),
    ).toBeVisible();

    await context.close();
  });

  test("should be signed in and on the dashboard", async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);
  });

  test("should show Add Papers button on dashboard", async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });
    await expect(page.getByRole("button", { name: /add papers/i })).toBeVisible({
      timeout: 15_000,
    });
  });
});
