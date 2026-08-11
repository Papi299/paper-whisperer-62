import { test, expect } from "@playwright/test";
import { assertLocalSupabaseUrl, assertOriginsMatch } from "./support/backend-guard";

/**
 * Settings → Danger zone: self-service account deletion (PFA-C04).
 *
 * The only destructive spec in the suite. It signs in as a **disposable**
 * local-only account provisioned for this run alone
 * (`scripts/e2e-local-delete-fixture.mjs`) and permanently deletes it through
 * the real UI, which invokes the real local `delete-account` Edge Function —
 * nothing here is mocked or stubbed.
 *
 * It never touches the deterministic primary/secondary fixture users: it
 * discards the stored primary session entirely (`storageState` below) and signs
 * in with credentials the lifecycle generated for the disposable account.
 *
 * Division of proof:
 *   - this spec owns everything a browser can observe — the confirmation gate,
 *     the redirect, the cleared session, and the fact that the deleted
 *     credentials no longer authenticate;
 *   - the lifecycle owns the privileged half — that the Auth user, its rows and
 *     its Storage binaries are really gone — because that needs the local
 *     elevated key, which deliberately stays in the lifecycle process.
 */

const CONFIRMATION = "DELETE MY ACCOUNT";
const CLIENT_MODULE_PATH = "/src/integrations/supabase/client.ts";

// Start from a clean browser: no stored session, so the primary fixture user's
// authenticated state can never be the account this spec deletes.
test.use({ storageState: { cookies: [], origins: [] } });

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(
      `Missing ${name}. The destructive account-deletion spec runs only through ` +
        "`npm run test:e2e:local`, which provisions a disposable local account.",
    );
  }
  return value;
}

test.describe("Account deletion (destructive, disposable local account)", () => {
  test("permanently deletes the signed-in account and its data", async ({ page }) => {
    const expectedOrigin = requireEnv("E2E_EXPECTED_SUPABASE_URL");

    await page.goto("/auth", { waitUntil: "networkidle" });

    // Fail-closed backend guard, re-asserted here rather than inherited: this is
    // the one spec that destroys an account, so it re-reads the Supabase origin
    // the browser actually loaded and refuses to continue against anything but
    // the approved loopback stack — BEFORE any credential is read or entered.
    const browserOrigin = await page.evaluate(async (modPath) => {
      const mod = await import(modPath);
      const client = (mod as { supabase?: Record<string, unknown> }).supabase ?? {};
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
        "Account-deletion spec could not read the browser-loaded Supabase origin; refusing to continue.",
      );
    }
    assertLocalSupabaseUrl(browserOrigin, "browser-loaded Supabase origin");
    assertOriginsMatch(expectedOrigin, browserOrigin, {
      label: "Supabase origin (expected vs browser-loaded)",
    });

    // Only now are the disposable credentials read.
    const email = requireEnv("E2E_DELETE_USER_EMAIL");
    const password = requireEnv("E2E_DELETE_USER_PASSWORD");

    await page.getByPlaceholder("you@example.com").fill(email);
    await page.getByPlaceholder("••••••••").fill(password);
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page.getByText(/\d+\s+paper/i)).toBeVisible({ timeout: 20_000 });

    // ── Danger zone ─────────────────────────────────────────────────────────
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const settings = page.getByRole("dialog");
    await expect(settings).toBeVisible();
    await expect(settings.getByRole("heading", { name: "Danger zone" })).toBeVisible();
    await expect(settings.getByText(/cannot be undone/i).first()).toBeVisible();
    // The export-before-delete path is still offered next to it.
    await expect(settings.getByRole("button", { name: "Export account data" })).toBeEnabled();

    await settings.getByRole("button", { name: "Delete account" }).click();

    // ── Confirmation gate ───────────────────────────────────────────────────
    const confirm = page.getByRole("alertdialog");
    await expect(confirm).toBeVisible();
    await expect(confirm.getByRole("heading", { name: /delete your account\?/i })).toBeVisible();

    const finalButton = confirm.getByRole("button", { name: "Delete my account" });
    await expect(finalButton).toBeDisabled();

    // A near-miss must not arm the destructive action.
    const phrase = confirm.getByRole("textbox");
    await phrase.fill("delete my account");
    await expect(finalButton).toBeDisabled();
    await phrase.fill("DELETE");
    await expect(finalButton).toBeDisabled();

    await phrase.fill(CONFIRMATION);
    await expect(finalButton).toBeEnabled();

    // ── The deletion ────────────────────────────────────────────────────────
    await finalButton.click();

    // A hard navigation back to /auth is the success signal — not a toast.
    await page.waitForURL(/\/auth$/, { timeout: 60_000 });
    await expect(page.getByText("Manage your scientific paper collections")).toBeVisible({
      timeout: 15_000,
    });

    // The browser retains no authenticated Paperlume session.
    const residualSession = await page.evaluate(() => {
      const keys: string[] = [];
      for (let i = 0; i < window.localStorage.length; i++) {
        const key = window.localStorage.key(i);
        if (!key) continue;
        if (/^sb-.*-auth-token$/.test(key) && window.localStorage.getItem(key)) keys.push(key);
      }
      return keys;
    });
    expect(residualSession, "no Supabase session may remain in localStorage").toEqual([]);

    // Returning to the app must not restore a dashboard for the deleted user.
    await page.goto("/dashboard", { waitUntil: "networkidle" });
    await expect(page).toHaveURL(/\/auth$/, { timeout: 15_000 });

    // ── The deleted credentials no longer work ──────────────────────────────
    await page.getByPlaceholder("you@example.com").fill(email);
    await page.getByPlaceholder("••••••••").fill(password);
    await page.getByRole("button", { name: /sign in/i }).click();

    // Still on /auth, and no dashboard ever renders.
    await expect(page.getByText(/\d+\s+paper/i)).toHaveCount(0, { timeout: 10_000 });
    await expect(page).toHaveURL(/\/auth$/);
  });
});
