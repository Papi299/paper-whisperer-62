import { test as setup, expect } from "@playwright/test";
import { assertLocalSupabaseUrl, assertOriginsMatch } from "./support/backend-guard";

const AUTH_FILE = "e2e/.auth/user.json";

// Runtime string path to the Vite-served Supabase client module. Kept in a
// variable so the browser performs a genuine runtime dynamic import of the
// actual transformed frontend module (not a Node-side copy of process.env).
const CLIENT_MODULE_PATH = "/src/integrations/supabase/client.ts";

/**
 * Global setup: proves the browser is talking to the approved local backend,
 * then signs in once and saves the authenticated browser state so subsequent
 * tests reuse the session.
 *
 * Layer 2 — browser-runtime guard. AFTER navigating to the Auth page but
 * BEFORE any credential is read, filled, or submitted, we read the Supabase
 * origin the Vite-served client actually loaded and validate it (loopback +
 * exact match to the expected local origin). The test credentials
 * (TEST_USER_EMAIL / TEST_USER_PASSWORD) are not read from the environment until
 * the guard (and the Auth-UI check) have passed. Only the public origin ever
 * leaves the browser — never a key, password, or token.
 */
setup("authenticate", async ({ page }) => {
  // Only the expected backend origin is needed for the Layer 2 guard. The test
  // credentials (TEST_USER_EMAIL / TEST_USER_PASSWORD) are NOT read here — they
  // are read further below, strictly AFTER the browser-observed backend guard
  // (and the Auth-UI check) have passed, and are never copied into a variable
  // before that point.
  const expectedOrigin = process.env.E2E_EXPECTED_SUPABASE_URL;
  if (!expectedOrigin) {
    throw new Error(
      "Missing E2E_EXPECTED_SUPABASE_URL. Run `npm run test:e2e:local`.",
    );
  }

  // Navigate first so the Vite module graph (and import.meta.env) is available.
  await page.goto("/auth", { waitUntil: "networkidle" });

  // Layer 2 guard: read the ACTUAL Supabase origin the browser-loaded client
  // points at. Only the public origin string is returned to the test process.
  const browserOrigin = await page.evaluate(async (modPath) => {
    const mod = await import(modPath);
    const client = (mod as { supabase?: Record<string, unknown> }).supabase ?? {};
    // Prefer the raw configured URL; fall back to service-URL origins. Never
    // read or return any key/token — only the origin.
    const candidates = [client["supabaseUrl"], client["authUrl"], client["realtimeUrl"]];
    for (const candidate of candidates) {
      if (candidate) {
        try {
          return new URL(String(candidate)).origin;
        } catch {
          /* try next candidate */
        }
      }
    }
    return null;
  }, CLIENT_MODULE_PATH);

  if (!browserOrigin) {
    throw new Error(
      "Layer 2 guard could not read the browser-loaded Supabase origin; refusing to continue.",
    );
  }

  // Validate the browser-observed origin: must be a safe local loopback target
  // and must exactly match the approved expected origin. Throws (fails closed)
  // on any Production/remote/mismatch — before any credential is entered.
  assertLocalSupabaseUrl(browserOrigin, "browser-loaded Supabase origin");
  assertOriginsMatch(expectedOrigin, browserOrigin, {
    label: "Supabase origin (expected vs browser-loaded)",
  });

  // Verify the Auth page UI — still before any credential access.
  await expect(
    page.getByText("Manage your scientific paper collections"),
  ).toBeVisible({ timeout: 15_000 });

  // Only NOW read the test credentials — strictly AFTER the Layer 2 backend
  // guard and the Auth-UI check have passed. They are never read or copied into
  // a variable before the browser-observed guard succeeds.
  const email = process.env.TEST_USER_EMAIL;
  const password = process.env.TEST_USER_PASSWORD;
  if (!email || !password) {
    throw new Error(
      "Missing TEST_USER_EMAIL or TEST_USER_PASSWORD. Run `npm run test:e2e:local`.",
    );
  }

  await page.getByPlaceholder("you@example.com").fill(email);
  await page.getByPlaceholder("••••••••").fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();

  // Wait for dashboard to fully render (paper count like "120 papers").
  await expect(page.getByText(/\d+\s+paper/i)).toBeVisible({ timeout: 20_000 });

  await page.context().storageState({ path: AUTH_FILE });
});
