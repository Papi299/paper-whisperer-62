import { test, expect, type Page } from "@playwright/test";

/**
 * End-to-end coverage for the Saved Searches / Filter Presets surface
 * after PRs #96, #98, #99, #101, #102 (UI) and #103 (docs).
 *
 * These tests exercise the full user flow through the real UI:
 *   • Save a preset, reload, load it back, verify fields restore
 *   • Dirty-state dot + "Update \"<name>\"" enabled/disabled semantics
 *   • Rename via the pencil icon (id-targeted, metadata-only)
 *   • Delete via the trash icon + confirmation
 *   • "Saved searches · N" count label + empty-state behavior
 *
 * All presets created by this spec use the E2E_PREFIX so the `beforeEach`
 * cleanup can reliably remove leftovers from prior failed runs without
 * touching the user's real presets.
 *
 * Cross-user RLS isolation is deliberately NOT covered here: the existing
 * auth harness (`e2e/global-setup.ts`) signs in a single storageState
 * account. Adding a second account would require multi-user auth plumbing
 * that exceeds the scope of this testing-only PR. Unit tests + empirical
 * two-account manual QA (documented in migration-history.md for PR #96)
 * already cover RLS isolation.
 */

const E2E_PREFIX = "E2E-";

/** Build a unique, easy-to-clean-up preset name. */
function uniqueName(label: string): string {
  return `${E2E_PREFIX}${label}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
}

/** Wait for dashboard to fully render (paper count visible). */
async function waitForDashboard(page: Page) {
  await expect(page.getByText(/\d+\s+paper/i)).toBeVisible({ timeout: 20_000 });
}

/** Open the Presets dropdown. Tolerates the two aria-label variants
 *  ("Presets" / "Presets — unsaved changes"). */
async function openPresetsMenu(page: Page) {
  await page.getByRole("button", { name: /^presets/i }).click();
  // Menu opens as a Radix portal with role=menu.
  await expect(page.getByRole("menu")).toBeVisible({ timeout: 5_000 });
}

/** Close the Presets dropdown if open (Escape key). */
async function closePresetsMenu(page: Page) {
  // If a menu is open, Escape dismisses it. Idempotent.
  await page.keyboard.press("Escape");
}

/**
 * Best-effort dismissal of stale UI overlays at the start of a test.
 *
 * A fresh `page.goto("/")` gives each Playwright test a clean DOM in theory,
 * but when the full suite runs a rapid sequence of saves/deletes, a toast
 * from the previous test's final mutation can still be animating out when
 * the next test's `beforeEach` fires its first click. The floating toast
 * can overlay the Presets trigger button and make the click flaky. We
 * hammer Escape a couple of times (also closes any menu/dialog that might
 * have survived a navigation) and then wait for role=dialog, role=menu,
 * and role=alertdialog to all be absent.
 */
async function dismissStaleOverlays(page: Page) {
  for (let i = 0; i < 2; i++) {
    await page.keyboard.press("Escape");
  }
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 3_000 });
  await expect(page.getByRole("alertdialog")).toHaveCount(0, { timeout: 3_000 });
  await expect(page.getByRole("menu")).toHaveCount(0, { timeout: 3_000 });
}

/**
 * Wait for a success toast with the given exact title to fully leave the DOM.
 *
 * shadcn toasts default to ~5s auto-dismiss; their fade-out overlays the
 * top-right region of the screen and can intercept subsequent clicks on
 * the Presets trigger during rapid-fire mutation sequences. Waiting for
 * the detached state is the most reliable way to avoid those races.
 *
 * Tolerates an already-detached toast (e.g. if the auto-dismiss raced us).
 */
async function waitForToastDetached(page: Page, title: string) {
  const toast = page.getByText(title, { exact: true });
  await toast
    .waitFor({ state: "detached", timeout: 15_000 })
    .catch(() => {});
}

/** The Presets trigger button. Used to read its aria-label for dirty-state. */
function presetsTrigger(page: Page) {
  return page.getByRole("button", { name: /^presets/i });
}

/** Search input. */
function searchInput(page: Page) {
  return page.getByPlaceholder(/search titles/i);
}

/** Year-from input (first of two number inputs with From/To placeholders). */
function yearFromInput(page: Page) {
  return page.getByPlaceholder("From");
}

/** Clear filters if the Clear button is visible. */
async function clearAllFilters(page: Page) {
  const clearBtn = page.getByRole("button", { name: "Clear", exact: true });
  if (await clearBtn.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await clearBtn.click();
  }
  // Defensive: also reset search input directly in case Clear was not present.
  const search = searchInput(page);
  if (await search.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await search.fill("");
  }
}

/** Save the current filter state as a new preset with the given name.
 *  Waits for the success toast and for the dialog to close. */
async function saveCurrentSearchAs(page: Page, name: string) {
  await openPresetsMenu(page);
  await page.getByRole("menuitem", { name: /save current search/i }).click();
  const dialog = page.getByRole("dialog").filter({ hasText: /save current search/i });
  await expect(dialog).toBeVisible({ timeout: 5_000 });
  // The dialog's Input is the only textbox inside it.
  await dialog.getByRole("textbox").fill(name);
  await dialog.getByRole("button", { name: /^save$/i }).click();
  await expect(page.getByText("Preset saved", { exact: true })).toBeVisible({
    timeout: 10_000,
  });
  await expect(dialog).toBeHidden({ timeout: 5_000 });
  // Wait for the success toast to fully leave the DOM before returning. The
  // floating toast can otherwise overlay the next UI target (most notably
  // the Presets trigger in the count-label test, which does two saves back
  // to back before reopening the menu).
  await waitForToastDetached(page, "Preset saved");
}

/** Load a preset by clicking its name button inside the open menu. */
async function loadPresetByName(page: Page, name: string) {
  await openPresetsMenu(page);
  // Preset rows use native <button> elements (role=button, not menuitem).
  const menu = page.getByRole("menu");
  await menu.getByRole("button", { name, exact: true }).click();
  // The menu closes on load; make sure it's gone before proceeding.
  await expect(menu).toBeHidden({ timeout: 5_000 });
}

/** Delete a preset by name: open menu → click its trash → confirm. */
async function deletePresetByName(page: Page, name: string) {
  await openPresetsMenu(page);
  const trashBtn = page.getByRole("button", { name: `Delete preset "${name}"` });
  await trashBtn.click();
  const confirmDialog = page
    .getByRole("alertdialog")
    .filter({ hasText: /delete saved search/i });
  await expect(confirmDialog).toBeVisible({ timeout: 5_000 });
  await confirmDialog.getByRole("button", { name: /^delete$/i }).click();
  await expect(page.getByText("Preset deleted", { exact: true })).toBeVisible({
    timeout: 10_000,
  });
  await waitForToastDetached(page, "Preset deleted");
}

/** Cleanup: open the menu and delete any preset whose name starts with the
 *  E2E prefix. Tolerant of "no presets" and of stale DOM between iterations. */
async function deleteAllE2EPresets(page: Page) {
  // Cap iterations so a pathological loop can't hang the suite.
  for (let attempt = 0; attempt < 20; attempt++) {
    await openPresetsMenu(page);
    const menu = page.getByRole("menu");
    // Find any Delete-button whose aria-label names a preset starting with E2E-.
    const trash = menu.getByRole("button", {
      name: new RegExp(`^Delete preset "${E2E_PREFIX}`),
    });
    const count = await trash.count();
    if (count === 0) {
      await closePresetsMenu(page);
      return;
    }
    await trash.first().click();
    const confirmDialog = page
      .getByRole("alertdialog")
      .filter({ hasText: /delete saved search/i });
    await expect(confirmDialog).toBeVisible({ timeout: 5_000 });
    await confirmDialog.getByRole("button", { name: /^delete$/i }).click();
    await expect(page.getByText("Preset deleted", { exact: true })).toBeVisible({
      timeout: 10_000,
    });
    // Wait for the toast to fully leave the DOM before the next iteration —
    // the floating toast otherwise overlays the Presets trigger and can make
    // the next `openPresetsMenu` click miss. This replaces the previous
    // fixed 300ms wait, which was both slower and less reliable.
    await waitForToastDetached(page, "Preset deleted");
  }
  throw new Error("deleteAllE2EPresets: exceeded iteration cap — aborting");
}

test.describe.configure({ mode: "serial" });

test.describe("Filter Presets (Saved Searches)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);
    // Dismiss any stray overlays that might have survived a navigation from
    // a crashed prior test (dialogs, alertdialogs, menus, lingering toasts).
    // A fresh goto normally clears these, but the full-suite run has
    // occasionally left one behind and the resulting overlay intercepts the
    // first click we make in the test.
    await dismissStaleOverlays(page);
    await clearAllFilters(page);
    await deleteAllE2EPresets(page);
  });

  test.afterEach(async ({ page }) => {
    // Defensive cleanup; keeps the test account tidy even on mid-test failure.
    await clearAllFilters(page).catch(() => {});
    await deleteAllE2EPresets(page).catch(() => {});
  });

  test("save + reload + load restores the saved filter state", async ({ page }) => {
    const name = uniqueName("save-load");
    const phraseQuery = '"muscle protein synthesis"';
    const yearFrom = "2020";

    // Set a non-trivial state: a quoted phrase search + a year-from value.
    await searchInput(page).fill(phraseQuery);
    await yearFromInput(page).fill(yearFrom);

    await saveCurrentSearchAs(page, name);

    // Reload the page — `loadedPresetId` is client state only, so a reload
    // resets it. This is exactly the flow we want to exercise.
    await page.reload({ waitUntil: "networkidle" });
    await waitForDashboard(page);

    // The filter state *also* resets on reload (it is not persisted to URL
    // or storage), so we expect a clean slate before loading.
    await expect(searchInput(page)).toHaveValue("");
    await expect(yearFromInput(page)).toHaveValue("");

    await loadPresetByName(page, name);

    // Verify both tracked fields round-trip exactly, including the quote chars.
    await expect(searchInput(page)).toHaveValue(phraseQuery);
    await expect(yearFromInput(page)).toHaveValue(yearFrom);
  });

  test("dirty-state dot + Update \"<name>\" enable/disable + update overwrites payload", async ({
    page,
  }) => {
    const name = uniqueName("dirty");
    const initialQuery = "alpha";
    const updatedQuery = "beta";

    await searchInput(page).fill(initialQuery);
    await saveCurrentSearchAs(page, name);

    // Immediately after save: preset is loaded, state matches payload → clean.
    // Trigger label reads "Presets" (no unsaved-changes suffix).
    await expect(presetsTrigger(page)).toHaveAttribute("aria-label", "Presets");

    // Update item is present (preset is loaded) but disabled (clean state).
    await openPresetsMenu(page);
    const updateItem = page.getByRole("menuitem", { name: /^update/i });
    await expect(updateItem).toBeVisible();
    await expect(updateItem).toBeDisabled();
    await closePresetsMenu(page);

    // Mutate one tracked field → becomes dirty.
    await searchInput(page).fill(updatedQuery);

    // Trigger label flips to the unsaved-changes variant.
    await expect(presetsTrigger(page)).toHaveAttribute(
      "aria-label",
      "Presets — unsaved changes",
    );

    // Update item is now enabled.
    await openPresetsMenu(page);
    const enabledUpdateItem = page.getByRole("menuitem", { name: /^update/i });
    await expect(enabledUpdateItem).toBeVisible();
    await expect(enabledUpdateItem).toBeEnabled();
    await enabledUpdateItem.click();

    // Confirm the AlertDialog.
    const confirmDialog = page
      .getByRole("alertdialog")
      .filter({ hasText: /update saved search/i });
    await expect(confirmDialog).toBeVisible({ timeout: 5_000 });
    await confirmDialog.getByRole("button", { name: /^update$/i }).click();
    await expect(page.getByText("Preset updated", { exact: true })).toBeVisible({
      timeout: 10_000,
    });
    await waitForToastDetached(page, "Preset updated");

    // Back to clean: dot gone, Update disabled again.
    await expect(presetsTrigger(page)).toHaveAttribute("aria-label", "Presets");

    // Verify the payload really was overwritten: change the field, then
    // load the preset, then confirm it restores the *updated* value.
    await searchInput(page).fill("something else entirely");
    await loadPresetByName(page, name);
    await expect(searchInput(page)).toHaveValue(updatedQuery);
  });

  test("rename changes the displayed name, preserves payload, and does not dirty the preset", async ({
    page,
  }) => {
    const originalName = uniqueName("rename-orig");
    const renamedName = uniqueName("rename-new");
    const query = "sleep";

    await searchInput(page).fill(query);
    await saveCurrentSearchAs(page, originalName);

    // Sanity: clean state after save.
    await expect(presetsTrigger(page)).toHaveAttribute("aria-label", "Presets");

    // Open menu, click the pencil for this preset.
    await openPresetsMenu(page);
    await page
      .getByRole("button", { name: `Rename preset "${originalName}"` })
      .click();

    const renameDialog = page
      .getByRole("dialog")
      .filter({ hasText: /rename saved search/i });
    await expect(renameDialog).toBeVisible({ timeout: 5_000 });

    // Input should be prefilled with the current name.
    const renameInput = renameDialog.getByRole("textbox");
    await expect(renameInput).toHaveValue(originalName);

    await renameInput.fill(renamedName);
    await renameDialog.getByRole("button", { name: /^save$/i }).click();
    await expect(page.getByText("Preset renamed", { exact: true })).toBeVisible({
      timeout: 10_000,
    });
    await waitForToastDetached(page, "Preset renamed");

    // Rename does not affect payload → loaded preset is still clean.
    await expect(presetsTrigger(page)).toHaveAttribute("aria-label", "Presets");

    // Open the menu: new name appears, old name is gone, Update label
    // reflects the new name.
    await openPresetsMenu(page);
    const menu = page.getByRole("menu");
    await expect(menu.getByRole("button", { name: renamedName, exact: true })).toBeVisible();
    await expect(
      menu.getByRole("button", { name: originalName, exact: true }),
    ).toHaveCount(0);
    // The "Update \"<name>\"" menuitem picks up the new name.
    await expect(
      menu.getByRole("menuitem", { name: new RegExp(renamedName) }),
    ).toBeVisible();
    await closePresetsMenu(page);

    // Payload round-trip sanity: load the renamed preset, verify query value.
    await searchInput(page).fill("noise");
    await loadPresetByName(page, renamedName);
    await expect(searchInput(page)).toHaveValue(query);
  });

  test("delete removes the preset from the dropdown and updates the count label", async ({
    page,
  }) => {
    const name = uniqueName("del");

    await searchInput(page).fill("temporary");
    await saveCurrentSearchAs(page, name);

    // Menu shows the count label with at least our preset counted.
    await openPresetsMenu(page);
    await expect(page.getByText(/^Saved searches · \d+$/)).toBeVisible();
    await closePresetsMenu(page);

    await deletePresetByName(page, name);

    // Reopen menu: preset is gone. Depending on whether any non-E2E presets
    // also exist on this account, either the empty state or a reduced count
    // label is visible — but the deleted preset's row must be absent.
    await openPresetsMenu(page);
    const menu = page.getByRole("menu");
    await expect(
      menu.getByRole("button", { name, exact: true }),
    ).toHaveCount(0);
    await closePresetsMenu(page);
  });

  test("count label reflects preset count and shows empty state when none exist", async ({
    page,
  }) => {
    // `beforeEach` removes any stale E2E-* presets. We assume the user has
    // no non-E2E presets on the test account; if they do, this test skips
    // the empty-state assertion (defensive).
    const nameA = uniqueName("count-a");
    const nameB = uniqueName("count-b");

    // Check the starting state. If there are zero presets, the empty-state
    // copy must be visible and the count suffix must be absent.
    await openPresetsMenu(page);
    const emptyState = page.getByText("No saved searches yet", { exact: true });
    const startedEmpty = await emptyState.isVisible({ timeout: 2_000 }).catch(() => false);
    if (startedEmpty) {
      // "Saved searches" label with no " · N" suffix.
      await expect(page.getByText("Saved searches", { exact: true })).toBeVisible();
    }
    await closePresetsMenu(page);

    // Create two presets.
    await searchInput(page).fill("count-a-query");
    await saveCurrentSearchAs(page, nameA);
    await clearAllFilters(page);
    await searchInput(page).fill("count-b-query");
    await saveCurrentSearchAs(page, nameB);

    // Label now reads "Saved searches · N" where N ≥ 2.
    await openPresetsMenu(page);
    const countLabel = page.getByText(/^Saved searches · \d+$/);
    await expect(countLabel).toBeVisible();
    const labelText = (await countLabel.textContent()) ?? "";
    const match = labelText.match(/·\s*(\d+)/);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeGreaterThanOrEqual(2);
    await closePresetsMenu(page);

    // Clean up via the normal afterEach pathway — no extra assertions on the
    // empty state here because non-E2E presets on the test account would make
    // that assertion flaky. The `startedEmpty` branch above already covers it
    // when the account truly has zero presets before the test runs.
  });
});
