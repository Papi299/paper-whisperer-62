import { test, expect, type Page } from "@playwright/test";
import { assertLocalSupabaseUrl, assertOriginsMatch } from "./support/backend-guard";
import { waitForDashboard } from "./helpers";

/**
 * Settings → AI Model (AI-MODEL-SELECTION-001C).
 *
 * Two accounts, because the whole feature turns on one server-controlled flag:
 *
 *   - the deterministic **primary seed user** — Free, `ai_model_selection_enabled`
 *     false — proves the non-entitled state. It is used strictly read-only and
 *     never acquires a preference row.
 *   - a **disposable entitled account** provisioned for this run by
 *     `scripts/e2e-local-model-fixture.mjs`, which grants the capability with a
 *     server-side entitlement write while leaving the plan `free`. That is what
 *     makes the "the flag, not the plan name, is the gate" claim testable.
 *
 * No Gemini request is made anywhere in this file, and no Edge Function is
 * served: the spec exercises preference persistence and the rendered UI only.
 * The entitled test ends by resetting to Paperlume's default, and the lifecycle
 * then proves out-of-band that the preference row is really gone — by signing in
 * as that same disposable account and reading `user_ai_preferences` through its
 * own authenticated SELECT-own path. It is deliberately NOT an elevated read:
 * migration `20260902120000` revokes `service_role` on that table, so the saved
 * model is readable only by its owner, and the fixture honours that rather than
 * working around it.
 */

const CLIENT_MODULE_PATH = "/src/integrations/supabase/client.ts";

const DEFAULT_LABEL = "Paperlume default";
const GEMINI_35_LABEL = "Gemini 3.5 Flash";
const GEMINI_36_LABEL = "Gemini 3.6 Flash";
const GEMINI_37_LABEL = "Gemini 3.7 Flash";
const GEMINI_38_LABEL = "Gemini 3.8 Flash";

/**
 * Exactly what the dropdown must contain after a full local migration replay:
 * the sentinel first, then the four catalog models in `sort_order`. 3.7 and 3.8
 * arrive from migration `20260903120000` (AI-MODEL-SELECTION-001D, C35) with no
 * frontend change — this list is read out of the live local database through the
 * ordinary authenticated catalog SELECT, so it is the end-to-end evidence that a
 * reviewed row is all a new model needs.
 */
const EXPECTED_OPTIONS = [
  DEFAULT_LABEL,
  GEMINI_35_LABEL,
  GEMINI_36_LABEL,
  GEMINI_37_LABEL,
  GEMINI_38_LABEL,
];

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(
      `Missing ${name}. The AI model settings spec runs only through ` +
        "`npm run test:e2e:local`, which provisions an entitled local account.",
    );
  }
  return value;
}

/**
 * The Settings dialog, located by its own heading rather than by `role=dialog`.
 *
 * Below 768px the sidebar collapses into a navigation drawer, which is itself a
 * dialog — so an unscoped `getByRole("dialog")` is ambiguous exactly in the
 * narrow case this spec cares about.
 */
function settingsDialog(page: Page) {
  return page
    .getByRole("dialog")
    .filter({ has: page.getByRole("heading", { name: "Settings", exact: true }) });
}

/**
 * Open Settings and return its dialog. Below 768px the Settings button lives
 * inside the navigation drawer, so it has to be reached through it.
 */
async function openSettings(page: Page, { narrow = false }: { narrow?: boolean } = {}) {
  if (narrow) {
    await page.getByRole("button", { name: "Open navigation menu" }).click();
    const drawer = page.getByRole("dialog", { name: /PaperLume navigation/i });
    await expect(drawer).toBeVisible();
    await drawer.getByRole("button", { name: "Settings", exact: true }).click();
  } else {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
  }
  const dialog = settingsDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "AI Model" })).toBeVisible();
  return dialog;
}

/**
 * Close Settings through its own Close button rather than Escape. Escape is
 * consumed by whatever last handled a key — after a Select interaction the
 * trigger still owns it — so the explicit affordance is the deterministic one.
 */
async function closeSettings(page: Page) {
  const dialog = settingsDialog(page);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).toHaveCount(0, { timeout: 5_000 });
}

/** Choose a value from the AI model Select and wait for the write to land. */
async function chooseModel(page: Page, optionName: string) {
  const dialog = settingsDialog(page);
  await dialog.getByRole("combobox", { name: "AI model" }).click();
  await page.getByRole("option", { name: optionName, exact: true }).click();
  // Not optimistic: the trigger only reads back the new value once the mutation
  // has resolved and the authoritative preference has been refetched.
  await expect(dialog.getByRole("combobox", { name: "AI model" })).toHaveText(optionName, {
    timeout: 15_000,
  });
}

test.describe("Settings → AI Model — non-entitled seeded user", () => {
  test("shows a read-only default state with no model selector", async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);
    const dialog = await openSettings(page);

    await expect(dialog.getByText("Paperlume is using its default model.")).toBeVisible();
    await expect(
      dialog.getByText("Model selection is available on eligible plans."),
    ).toBeVisible();

    // No enabled control, and no disabled one either — nothing to tamper with.
    await expect(dialog.getByRole("combobox", { name: "AI model" })).toHaveCount(0);

    // Capability-gated, not commercial: no purchase path is implied.
    await expect(
      dialog.getByRole("button", { name: /upgrade|buy|subscribe|checkout|pricing/i }),
    ).toHaveCount(0);
    await expect(dialog.getByRole("link", { name: /upgrade|buy|subscribe/i })).toHaveCount(0);

    // The pre-existing Settings sections are untouched.
    await expect(dialog.getByLabel("PubMed API Key (NCBI)")).toBeEnabled();
    await expect(dialog.getByRole("heading", { name: "Storage" })).toBeVisible();

    await closeSettings(page);
  });

  test("keeps every Settings control reachable on a narrow viewport", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 640 });
    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);
    const dialog = await openSettings(page, { narrow: true });

    // The bounded scroll container is the thing that must still work. Vertical
    // scrolling is something a user can do; horizontal stranding is not, so the
    // container must not overflow sideways at all.
    const geometry = await dialog.evaluate((node) => {
      const scroller = node.querySelector<HTMLElement>(".overflow-y-auto");
      if (!scroller) return null;
      return {
        scrollWidth: scroller.scrollWidth,
        clientWidth: scroller.clientWidth,
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight,
      };
    });
    expect(geometry).not.toBeNull();
    expect(geometry!.scrollWidth).toBeLessThanOrEqual(geometry!.clientWidth);

    // Every section is reachable by scrolling vertically, and the element at the
    // centre of each really is the one we scrolled to — `toBeVisible()` alone
    // would pass for a control clipped out of reach.
    for (const heading of ["AI Model", "Storage"]) {
      const target = dialog.getByRole("heading", { name: heading });
      await target.scrollIntoViewIfNeeded();
      const hit = await target.evaluate((el) => {
        const rect = el.getBoundingClientRect();
        const found = document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        );
        return { contains: !!found && (el === found || el.contains(found)), width: rect.width };
      });
      expect(hit.width, `${heading} heading has zero width`).toBeGreaterThan(0);
      expect(hit.contains, `${heading} heading is not the element painted at its centre`).toBe(
        true,
      );
    }

    await expect(dialog.getByLabel("PubMed API Key (NCBI)")).toBeEnabled();
    await closeSettings(page);
  });
});

// A clean browser: the entitled cases must never run as the seeded primary user.
test.describe("Settings → AI Model — entitled disposable account", () => {
  test.describe.configure({ mode: "serial" });
  test.use({ storageState: { cookies: [], origins: [] } });

  /**
   * Sign in as the disposable entitled account. The Layer 2 backend guard is
   * re-asserted here rather than inherited: this spec enters credentials of its
   * own, so it re-reads the Supabase origin the browser actually loaded and
   * refuses to continue against anything but the approved loopback stack —
   * BEFORE any credential is read.
   */
  async function signInAsEntitled(page: Page) {
    const expectedOrigin = requireEnv("E2E_EXPECTED_SUPABASE_URL");
    await page.goto("/auth", { waitUntil: "networkidle" });

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
        "AI model settings spec could not read the browser-loaded Supabase origin; refusing to continue.",
      );
    }
    assertLocalSupabaseUrl(browserOrigin, "browser-loaded Supabase origin");
    assertOriginsMatch(expectedOrigin, browserOrigin, {
      label: "Supabase origin (expected vs browser-loaded)",
    });

    // Only now are the entitled fixture credentials read.
    const email = requireEnv("E2E_MODEL_USER_EMAIL");
    const password = requireEnv("E2E_MODEL_USER_PASSWORD");
    await page.getByPlaceholder("you@example.com").fill(email);
    await page.getByPlaceholder("••••••••").fill(password);
    await page.getByRole("button", { name: /sign in/i }).click();
    await waitForDashboard(page);
  }

  test("offers the catalog models and starts on Paperlume default", async ({ page }) => {
    await signInAsEntitled(page);
    const dialog = await openSettings(page);

    const select = dialog.getByRole("combobox", { name: "AI model" });
    await expect(select).toBeEnabled();
    // No preference row exists for this fixture, so the sentinel is selected.
    await expect(select).toHaveText(DEFAULT_LABEL);

    await select.click();
    // The whole listbox, in order — not four independent presence checks. A
    // per-option assertion would still pass if the catalog had grown a model
    // nobody approved, or if the order the user reads had drifted.
    const listbox = page.getByRole("listbox");
    await expect(listbox.getByRole("option")).toHaveText(EXPECTED_OPTIONS);
    await page.keyboard.press("Escape");

    await closeSettings(page);
  });

  test("persists a saved model and a reset across Settings close/reopen", async ({ page }) => {
    await signInAsEntitled(page);
    await openSettings(page);

    // ── Save a model added by 001D, end to end ──────────────────────────────
    // One newly added model is persisted through the real stack — the setter
    // RPC, the FK to the migrated catalog row, and the reopened dialog — because
    // that is the only place the migration, the RPC and the UI are exercised
    // together. The remaining three models are covered by suite 012 and the
    // focused unit tests rather than repeated here.
    await chooseModel(page, GEMINI_38_LABEL);
    await expect(settingsDialog(page)).toBeVisible();
    await closeSettings(page);
    await expect(
      (await openSettings(page)).getByRole("combobox", { name: "AI model" }),
    ).toHaveText(GEMINI_38_LABEL);

    // ── Save an explicit Gemini 3.6 preference ──────────────────────────────
    await chooseModel(page, GEMINI_36_LABEL);
    // Saving must NOT close Settings.
    await expect(settingsDialog(page)).toBeVisible();

    await closeSettings(page);
    let dialog = await openSettings(page);
    await expect(dialog.getByRole("combobox", { name: "AI model" })).toHaveText(GEMINI_36_LABEL);

    // ── Switch to an explicit Gemini 3.5 pin (distinct from the default) ────
    await chooseModel(page, GEMINI_35_LABEL);
    await closeSettings(page);
    dialog = await openSettings(page);
    const select = dialog.getByRole("combobox", { name: "AI model" });
    await expect(select).toHaveText(GEMINI_35_LABEL);
    // An explicit 3.5 pin is not the same thing as "no preference", even though
    // both currently route to the same provider model.
    await expect(select).not.toHaveText(DEFAULT_LABEL);

    // ── Reset to Paperlume default ─────────────────────────────────────────
    await chooseModel(page, DEFAULT_LABEL);
    await expect(settingsDialog(page)).toBeVisible();

    await closeSettings(page);
    dialog = await openSettings(page);
    await expect(dialog.getByRole("combobox", { name: "AI model" })).toHaveText(DEFAULT_LABEL);
    await closeSettings(page);

    // The lifecycle re-checks this out-of-band afterwards: that the reset
    // really removed the `user_ai_preferences` row. It reads that row as the
    // account itself, under the SELECT-own policy — not with the elevated key,
    // which 001A revokes on this table.
  });
});
