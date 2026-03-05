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

  // Navigate to auth page and wait for React to hydrate
  await page.goto("/auth", { waitUntil: "networkidle" });
  // "Manage your scientific paper collections" is only on the auth page, not the dashboard
  await expect(
    page.getByText("Manage your scientific paper collections"),
  ).toBeVisible({ timeout: 15_000 });

  // Fill in sign-in form
  await page.getByPlaceholder("you@example.com").fill(email);
  await page.getByPlaceholder("••••••••").fill(password);

  // Click sign in
  await page.getByRole("button", { name: /sign in/i }).click();

  // Wait for dashboard to fully render (paper count like "8 papers")
  await expect(page.getByText(/\d+\s+paper/i)).toBeVisible({
    timeout: 20_000,
  });

  // Save authenticated state
  await page.context().storageState({ path: AUTH_FILE });
});
