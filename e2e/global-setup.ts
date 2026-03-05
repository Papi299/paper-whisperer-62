import { test as setup, expect } from "@playwright/test";

const AUTH_FILE = "e2e/.auth/user.json";

/**
 * Global setup: signs in once and saves the authenticated browser state
 * so that all subsequent tests re-use the session without re-authenticating.
 */
setup("authenticate", async ({ page }) => {
  const email = process.env.TEST_USER_EMAIL;
  const password = process.env.TEST_USER_PASSWORD;

  if (!email || !password) {
    throw new Error(
      "Missing TEST_USER_EMAIL or TEST_USER_PASSWORD env vars. " +
        "Create a .env.test file or set them in your CI environment.",
    );
  }

  // Navigate to auth page
  await page.goto("/auth");
  await expect(page.getByRole("heading", { name: /paper index/i })).toBeVisible();

  // Fill in sign-in form
  await page.getByPlaceholder("you@example.com").fill(email);
  await page.getByPlaceholder("••••••••").fill(password);

  // Click sign in
  await page.getByRole("button", { name: /sign in/i }).click();

  // Wait for redirect to dashboard
  await expect(page.getByRole("heading", { name: /papers/i })).toBeVisible({
    timeout: 15_000,
  });

  // Save authenticated state
  await page.context().storageState({ path: AUTH_FILE });
});
