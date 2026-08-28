import { defineConfig } from "@playwright/test";

/**
 * Playwright configuration for the real unpacked-MV3 extension lane.
 *
 * Deliberately a second config rather than a project inside
 * `playwright.config.ts`. That config is the local application E2E lane, and it
 * fails closed at module load unless a complete local Supabase backend contract
 * is present — `E2E_BACKEND_MODE=local`, seeded credentials, a loopback
 * Supabase origin — because every spec it runs signs in and writes rows.
 *
 * This lane needs none of that and must not require it. It drives a browser
 * extension, has no application server, signs nobody in, and reaches no
 * backend at all. Folding it into the guarded config would mean either
 * weakening a guard that exists to keep tests off Production, or making an
 * extension test refuse to run without a Docker Supabase stack. Both are worse
 * than a second file.
 *
 * ## Network
 *
 * Every context this lane launches black-holes DNS for anything that is not
 * loopback (see `e2e-extension/support/extensionHarness.ts`), so no spec here
 * can reach `app.paperlume.app` — or anywhere else — however it is written.
 * That is what makes it safe to press the real handoff button: the extension
 * really calls `chrome.tabs.create`, a real tab really opens, and the
 * navigation dies at the resolver.
 */
export default defineConfig({
  testDir: "./e2e-extension",
  // Support code holds the harness, not specs.
  testIgnore: ["**/support/**"],
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // One worker: each test launches its own persistent Chromium with its own
  // profile directory, and serialising them keeps peak resource use flat and
  // failures attributable.
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  timeout: 60_000,
  use: {
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
});
