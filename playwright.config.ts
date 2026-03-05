import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright E2E test configuration for Paper Whisperer.
 *
 * Required env vars (set in .env.test or CI):
 *   TEST_USER_EMAIL    – email for the test account
 *   TEST_USER_PASSWORD – password for the test account
 *   BASE_URL           – app URL (default: http://localhost:8080)
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false, // tests share auth state, run sequentially
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  timeout: 30_000,

  use: {
    baseURL: process.env.BASE_URL || "http://localhost:8080",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    // Re-use authenticated state from the global setup
    storageState: "e2e/.auth/user.json",
  },

  projects: [
    // Auth setup — runs first to create authenticated session
    {
      name: "setup",
      testMatch: /global-setup\.ts/,
      use: { storageState: undefined }, // no existing auth for this project
    },
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      dependencies: ["setup"],
    },
  ],

  // Run the dev server before tests
  webServer: {
    command: "npm run dev",
    port: 8080,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
