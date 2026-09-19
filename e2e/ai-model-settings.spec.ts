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
 *
 * AI-MULTI-PROVIDER-001C added the Reasoning level control and
 * AI-MANUAL-REASONING-001 (migration `20260919075655`) activated it: every
 * catalog row now has `reasoning_selectable = true`, and
 * `set_current_user_ai_reasoning` is granted to `authenticated`. This spec
 * drives the whole manual path through the real UI, the real RPCs and the real
 * local database — every model's exact level list, a saved level surviving a
 * reopen, Automatic clearing only the level, an incompatible model switch
 * resetting it in the same transaction — and reads the saved row back through
 * the account's own SELECT-own path after each step, so the database state is
 * asserted directly rather than inferred from the rendered control. It also
 * proves the only writes the browser made were the four preference RPCs, and
 * that a direct table write is refused. Everything the level list says comes
 * from the live local catalog; nothing in the frontend names a model's levels.
 * The entitled tests end by resetting to Paperlume's default, and the lifecycle
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
const CLAUDE_SONNET_5_LABEL = "Claude Sonnet 5";
const GPT_56_TERRA_LABEL = "GPT-5.6 Terra";
const AUTOMATIC_REASONING_LABEL = "Automatic (Recommended)";
const REASONING_RESET_TOAST =
  "Reasoning was reset to Automatic because the new model does not support your previous level.";

/**
 * Every model's reasoning dropdown, exactly as the migrated catalog's
 * `reasoning_levels` renders it: Automatic first, then that model's own levels
 * in catalog order. Written out here from the providers' vocabularies — the
 * spec's expectation, not something read back from the thing under test.
 */
const EXPECTED_REASONING_OPTIONS: ReadonlyArray<readonly [string, readonly string[]]> = [
  [GEMINI_35_LABEL, ["Minimal", "Low", "Medium", "High"]],
  [GEMINI_36_LABEL, ["Minimal", "Low", "Medium", "High"]],
  [GEMINI_37_LABEL, ["Low", "Medium", "High"]],
  [GEMINI_38_LABEL, ["Low", "Medium", "High"]],
  [CLAUDE_SONNET_5_LABEL, ["Off", "Low", "Medium", "High", "Extra High", "Max"]],
  [GPT_56_TERRA_LABEL, ["None", "Low", "Medium", "High", "Extra High", "Max"]],
];

/** The four preference RPCs — the only writes the Settings surface may make. */
const PREFERENCE_RPCS = [
  "set_current_user_ai_model",
  "clear_current_user_ai_model",
  "set_current_user_ai_reasoning",
  "clear_current_user_ai_reasoning",
];

/**
 * Exactly what the dropdown must contain after a full local migration replay:
 * the sentinel first, then the six catalog models in `sort_order`. 3.7 and 3.8
 * arrive from migration `20260903120000` (AI-MODEL-SELECTION-001D, C35); Claude
 * Sonnet 5 and GPT-5.6 Terra arrive from `20260917201856` but become offerable
 * only with the Phase 8 activation `20260918210017`
 * (AI-MULTI-PROVIDER-001E, C43). None of them needed a frontend change: this
 * list is read out of the live local database through the ordinary
 * authenticated catalog SELECT, so it is the end-to-end evidence that a
 * reviewed row is all a new model needs.
 *
 * The two paid rows are the strongest case for that claim, because they were
 * present but NOT selectable for a whole phase: the same UI that renders them
 * now was already deployed and deliberately did not offer them.
 */
const EXPECTED_OPTIONS = [
  DEFAULT_LABEL,
  GEMINI_35_LABEL,
  GEMINI_36_LABEL,
  GEMINI_37_LABEL,
  GEMINI_38_LABEL,
  CLAUDE_SONNET_5_LABEL,
  GPT_56_TERRA_LABEL,
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

/**
 * The Reasoning level control and the text it points `aria-describedby` at.
 *
 * Resolved through the attribute rather than by a hard-coded id, so this also
 * proves the accessible relation exists: the explanation a sighted user reads is
 * the same element a screen reader announces with the control.
 */
async function reasoningControl(page: Page) {
  const dialog = settingsDialog(page);
  const trigger = dialog.getByRole("combobox", { name: "Reasoning level" });
  await expect(trigger).toBeVisible();
  const describedBy = await trigger.getAttribute("aria-describedby");
  expect(describedBy, "the reasoning control must be described by visible text").toBeTruthy();
  return { trigger, description: dialog.locator(`[id="${describedBy}"]`) };
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

/**
 * The slice of the app's own Supabase client these probes use, typed
 * structurally so the page-side callbacks need no `any`. The module imported in
 * the browser is the real one the app ships; this only describes the four calls
 * made through it.
 */
interface PageError {
  code?: string;
}
interface PageClientModule {
  supabase: {
    auth: { getUser(): Promise<{ data: { user: { id: string } } }> };
    from(table: string): {
      select(columns: string): {
        eq(
          column: string,
          value: string,
        ): { maybeSingle(): Promise<{ data: Record<string, unknown> | null; error: PageError | null }> };
      };
      update(values: Record<string, unknown>): {
        eq(column: string, value: string): Promise<{ error: PageError | null }>;
      };
      upsert(values: Record<string, unknown>): Promise<{ error: PageError | null }>;
    };
    rpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: PageError | null }>;
  };
}

/** Choose a value from the Reasoning level Select and wait for the write to land. */
async function chooseReasoning(page: Page, optionName: string) {
  const dialog = settingsDialog(page);
  await dialog.getByRole("combobox", { name: "Reasoning level" }).click();
  await page.getByRole("option", { name: optionName, exact: true }).click();
  // Not optimistic here either: the trigger reads back the refetched row.
  await expect(dialog.getByRole("combobox", { name: "Reasoning level" })).toHaveText(optionName, {
    timeout: 15_000,
  });
}

/**
 * The signed-in account's own saved row, read in the browser through the app's
 * own Supabase client and the SELECT-own policy — the same read the Settings
 * hook makes. `null` means no row: PaperLume default AND Automatic.
 */
async function readSavedPreference(page: Page) {
  return page.evaluate(async (modPath) => {
    const mod = (await import(modPath)) as PageClientModule;
    const { data: auth } = await mod.supabase.auth.getUser();
    const { data, error } = await mod.supabase
      .from("user_ai_preferences")
      .select("preferred_model_id, preferred_reasoning_level")
      .eq("user_id", auth.user.id)
      .maybeSingle();
    if (error) throw new Error(`preference read failed: ${error.code ?? "unknown"}`);
    return data
      ? {
          model: data.preferred_model_id as string,
          level: (data.preferred_reasoning_level ?? null) as string | null,
        }
      : null;
  }, CLIENT_MODULE_PATH);
}

/**
 * Call one RPC as the signed-in account, bypassing the UI. Returns only the
 * error code and the setter's bounded `saved`/`reason` fields.
 */
async function callRpcDirectly(page: Page, fn: string, args: Record<string, unknown>) {
  return page.evaluate(
    async ({ modPath, fn, args }) => {
      const mod = (await import(modPath)) as PageClientModule;
      const { data, error } = await mod.supabase.rpc(fn, args);
      const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
      return {
        errorCode: error?.code ?? null,
        saved: (row?.saved as boolean | undefined) ?? null,
        reason: (row?.reason as string | undefined) ?? null,
      };
    },
    { modPath: CLIENT_MODULE_PATH, fn, args },
  );
}

/**
 * Try to write the preference or catalog tables DIRECTLY, bypassing every RPC.
 * Each attempt must come back with an error; the codes are returned so the
 * caller can require a privilege refusal rather than any failure at all.
 */
async function attemptDirectTableWrites(page: Page) {
  return page.evaluate(async (modPath) => {
    const mod = (await import(modPath)) as PageClientModule;
    const { data: auth } = await mod.supabase.auth.getUser();
    const uid = auth.user.id;
    const update = await mod.supabase
      .from("user_ai_preferences")
      .update({ preferred_reasoning_level: "max" })
      .eq("user_id", uid);
    const upsert = await mod.supabase
      .from("user_ai_preferences")
      .upsert({ user_id: uid, preferred_model_id: "openai/gpt-5.6-terra", preferred_reasoning_level: "max" });
    const catalog = await mod.supabase
      .from("ai_model_catalog")
      .update({ reasoning_selectable: false })
      .eq("id", "openai/gpt-5.6-terra");
    return {
      update: update.error?.code ?? null,
      upsert: upsert.error?.code ?? null,
      catalog: catalog.error?.code ?? null,
    };
  }, CLIENT_MODULE_PATH);
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
    // The same for reasoning: stated as text, never offered as a control.
    await expect(dialog.getByRole("combobox", { name: "Reasoning level" })).toHaveCount(0);
    await expect(dialog.getByText(/Reasoning level: Automatic \(Recommended\)/)).toBeVisible();

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

  test("cannot set a reasoning level by calling the RPC directly", async ({ page }) => {
    // The UI offers nothing, so the next thing to try is the RPC itself. It is
    // granted to every signed-in account; what refuses this one is the
    // server's own entitlement check. The refusal writes nothing, so this
    // deterministic fixture stays read-only in effect: it still has no row.
    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);
    expect(await readSavedPreference(page)).toBeNull();
    expect(
      await callRpcDirectly(page, "set_current_user_ai_reasoning", { p_reasoning_level: "high" }),
    ).toEqual({ errorCode: null, saved: false, reason: "not_entitled" });
    expect(await readSavedPreference(page)).toBeNull();
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

    // ── Reasoning on PaperLume default — AI-MULTI-PROVIDER-001C ─────────────
    // Automatic, not changeable, and explained in visible text: PaperLume may
    // change its default model server-side, so no manual level is offered here.
    const reasoning = await reasoningControl(page);
    await expect(reasoning.trigger).toHaveText(AUTOMATIC_REASONING_LABEL);
    await expect(reasoning.trigger).toBeDisabled();
    await expect(reasoning.description).toBeVisible();
    await expect(reasoning.description).toContainText(
      "Automatic (Recommended) is used with Paperlume default",
    );
    await expect(reasoning.description).toContainText("organization suggestions use Medium");
    await expect(reasoning.description).toContainText(
      "Choose a specific model to customize reasoning",
    );

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

    // ── The EXACT Automatic policy, read from the live migrated catalog ─────
    // Gemini 3.8 Flash has no Minimal, so its Analyze level is Low. Nothing in
    // the frontend names this model's policy: if the catalog row changed, this
    // line would change with no deploy.
    let reasoning = await reasoningControl(page);
    await expect(reasoning.trigger).toHaveText(AUTOMATIC_REASONING_LABEL);
    await expect(reasoning.description).toContainText(
      "Analyze: Low · Organization suggestions: Medium",
    );
    await expect(reasoning.description).toContainText("This balances quality, speed, and cost.");
    // Activated: a pinned model offers a manual choice, and the page says the
    // one thing about it a user would otherwise get wrong.
    await expect(reasoning.trigger).toBeEnabled();
    await expect(reasoning.description).toContainText(
      "A level you choose applies to both Analyze and organization suggestions.",
    );
    await expect(reasoning.description).not.toContainText("not available");

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

    // Gemini 3.5 Flash offers Minimal, and its Automatic Analyze level is it.
    reasoning = await reasoningControl(page);
    await expect(reasoning.description).toContainText(
      "Analyze: Minimal · Organization suggestions: Medium",
    );
    await expect(reasoning.trigger).toBeEnabled();
    // Choosing models never chose a reasoning level: still Automatic, in the row.
    expect(await readSavedPreference(page)).toEqual({ model: "google/gemini-3.5-flash", level: null });

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

  // ── AI-MANUAL-REASONING-001 ──────────────────────────────────────────────

  test("offers every model exactly its own reasoning levels", async ({ page }) => {
    await signInAsEntitled(page);
    await openSettings(page);

    for (const [modelLabel, levels] of EXPECTED_REASONING_OPTIONS) {
      await chooseModel(page, modelLabel);
      const reasoning = await reasoningControl(page);
      await expect(reasoning.trigger, `${modelLabel}: reasoning control`).toBeEnabled();
      await expect(reasoning.trigger).toHaveText(AUTOMATIC_REASONING_LABEL);

      await reasoning.trigger.click();
      // The whole list, in order: Automatic first, then this model's levels,
      // and nothing another model offers — not even disabled.
      await expect(page.getByRole("listbox").getByRole("option")).toHaveText([
        AUTOMATIC_REASONING_LABEL,
        ...levels,
      ]);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("listbox")).toHaveCount(0);
    }

    // Walking all six models pinned each in turn and chose no level.
    expect(await readSavedPreference(page)).toEqual({ model: "openai/gpt-5.6-terra", level: null });

    await chooseModel(page, DEFAULT_LABEL);
    expect(await readSavedPreference(page)).toBeNull();
    await closeSettings(page);
  });

  test("saves, persists, clears and resets a manual level through the RPCs only", async ({ page }) => {
    // Every Data API request the browser makes from here on. The preference
    // tables must see reads only; every write must be one of the four RPCs.
    const writes: Array<{ method: string; path: string; body: string | null }> = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (!url.pathname.startsWith("/rest/v1/")) return;
      if (["GET", "HEAD", "OPTIONS"].includes(request.method())) return;
      writes.push({ method: request.method(), path: url.pathname, body: request.postData() });
    });

    await signInAsEntitled(page);
    await openSettings(page);

    // ── A manual level is saved for the pinned model, and survives a reopen ──
    await chooseModel(page, GEMINI_35_LABEL);
    await chooseReasoning(page, "Minimal");
    const reasoning = await reasoningControl(page);
    await expect(reasoning.description).toContainText(
      "Minimal applies to both Analyze and organization suggestions.",
    );
    // …with this model's Automatic policy still in view.
    await expect(reasoning.description).toContainText(
      "Automatic (Recommended) would use Analyze: Minimal · Organization suggestions: Medium.",
    );
    expect(await readSavedPreference(page)).toEqual({ model: "google/gemini-3.5-flash", level: "minimal" });

    await closeSettings(page);
    await openSettings(page);
    await expect(
      settingsDialog(page).getByRole("combobox", { name: "Reasoning level" }),
    ).toHaveText("Minimal");

    // ── A compatible model switch keeps the level ──────────────────────────
    await chooseModel(page, GEMINI_36_LABEL);
    await expect(
      settingsDialog(page).getByRole("combobox", { name: "Reasoning level" }),
    ).toHaveText("Minimal");
    expect(await readSavedPreference(page)).toEqual({ model: "google/gemini-3.6-flash", level: "minimal" });

    // ── An incompatible one resets it, and says so ─────────────────────────
    // Gemini 3.8 Flash has no Minimal. The server resets the level in the same
    // transaction as the model change; the browser only reports it.
    await chooseModel(page, GEMINI_38_LABEL);
    // `.first()`: Radix renders a toast twice — the visible one and a
    // screen-reader-only status region — so an unqualified match is ambiguous.
    await expect(page.getByText(REASONING_RESET_TOAST).first()).toBeVisible();
    await expect(
      settingsDialog(page).getByRole("combobox", { name: "Reasoning level" }),
    ).toHaveText(AUTOMATIC_REASONING_LABEL);
    expect(await readSavedPreference(page)).toEqual({ model: "google/gemini-3.8-flash", level: null });

    // ── Across providers: Claude's Off is not Terra's None ─────────────────
    await chooseModel(page, CLAUDE_SONNET_5_LABEL);
    await chooseReasoning(page, "Off");
    expect(await readSavedPreference(page)).toEqual({ model: "anthropic/claude-sonnet-5", level: "off" });
    await chooseModel(page, GPT_56_TERRA_LABEL);
    await expect(
      settingsDialog(page).getByRole("combobox", { name: "Reasoning level" }),
    ).toHaveText(AUTOMATIC_REASONING_LABEL);
    expect(await readSavedPreference(page)).toEqual({ model: "openai/gpt-5.6-terra", level: null });

    // ── Automatic clears the level and ONLY the level ──────────────────────
    await chooseReasoning(page, "Extra High");
    expect(await readSavedPreference(page)).toEqual({ model: "openai/gpt-5.6-terra", level: "xhigh" });
    await closeSettings(page);
    await openSettings(page);
    await expect(
      settingsDialog(page).getByRole("combobox", { name: "Reasoning level" }),
    ).toHaveText("Extra High");
    await chooseReasoning(page, AUTOMATIC_REASONING_LABEL);
    expect(await readSavedPreference(page)).toEqual({ model: "openai/gpt-5.6-terra", level: null });
    await expect(
      settingsDialog(page).getByRole("combobox", { name: "AI model" }),
    ).toHaveText(GPT_56_TERRA_LABEL);

    // ── The browser wrote through the four RPCs and nothing else ───────────
    const uiWrites = [...writes];
    expect(uiWrites.length, "the UI flow made preference writes").toBeGreaterThan(0);
    for (const write of uiWrites) {
      expect(write.method, `${write.path} was written with ${write.method}`).toBe("POST");
      expect(write.path).toMatch(/^\/rest\/v1\/rpc\//);
      expect(write.path).not.toMatch(/user_ai_preferences|ai_model_catalog/);
    }
    const reasoningWrites = uiWrites
      .filter((w) => /\/rpc\/(set|clear)_current_user_ai_reasoning$/.test(w.path))
      .map((w) => `${w.path.split("/").pop()} ${w.body ?? ""}`.trim());
    // Exactly the three levels chosen, as canonical values, and one clear.
    expect(reasoningWrites).toEqual([
      'set_current_user_ai_reasoning {"p_reasoning_level":"minimal"}',
      'set_current_user_ai_reasoning {"p_reasoning_level":"off"}',
      'set_current_user_ai_reasoning {"p_reasoning_level":"xhigh"}',
      "clear_current_user_ai_reasoning {}",
    ]);
    // Every AI-preference write went through one of the four approved RPCs.
    const aiWrites = uiWrites.filter((w) => /ai_(model|reasoning)/.test(w.path));
    expect(aiWrites.length, "the UI flow made AI preference writes").toBeGreaterThan(0);
    expect(
      aiWrites.filter((w) => !PREFERENCE_RPCS.some((fn) => w.path === `/rest/v1/rpc/${fn}`)),
    ).toEqual([]);

    // ── No bypass: a direct table write is refused, and the RPC re-checks ──
    const direct = await attemptDirectTableWrites(page);
    // 42501 is PostgreSQL's insufficient_privilege: refused by the grant itself.
    expect(direct).toEqual({ update: "42501", upsert: "42501", catalog: "42501" });
    expect(
      await callRpcDirectly(page, "set_current_user_ai_reasoning", { p_reasoning_level: "off" }),
    ).toEqual({ errorCode: null, saved: false, reason: "reasoning_level_not_supported" });
    expect(await readSavedPreference(page)).toEqual({ model: "openai/gpt-5.6-terra", level: null });

    // ── Back to PaperLume default: model and level go together ─────────────
    await chooseReasoning(page, "Low");
    expect(await readSavedPreference(page)).toEqual({ model: "openai/gpt-5.6-terra", level: "low" });
    await chooseModel(page, DEFAULT_LABEL);
    expect(await readSavedPreference(page)).toBeNull();
    await expect(
      settingsDialog(page).getByRole("combobox", { name: "Reasoning level" }),
    ).toBeDisabled();
    await closeSettings(page);
  });
});
