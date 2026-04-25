import { test, expect, type Page, type Locator } from "@playwright/test";
import { waitForDashboard } from "./helpers";

/**
 * End-to-end coverage for the Paper Notes feature
 * (PRs #84–#87 for the notes column + indicator + filter + FTS weight-D,
 *  PRs #91–#93 for `Matched in: Notes` attribution + placeholder guidance).
 *
 * These tests lock in the five user-visible Notes workflows end-to-end:
 *   1. Add a note via the Edit dialog → list-row StickyNote indicator →
 *      Popover preview reads the text back verbatim.
 *   2. Edit an existing note — the textarea round-trips the saved value
 *      and the new content is persisted.
 *   3. Clearing the note (empty textarea → Save) removes the row indicator.
 *   4. "Has notes" / "No notes" filter correctly partitions a paper that
 *      currently has a note.
 *   5. Searching for a unique token inside a note returns the paper and
 *      its row shows the `Matched in: Notes` attribution badge.
 *
 * --- Strategy ---
 * UI-driven only (no direct DB calls). The spec picks two papers from the
 * first ~30 visible rows that currently have NO notes indicator and uses
 * them for the duration of the run. Each test is self-contained: it sets
 * up the notes state it needs, asserts, and restores the paper to "no
 * notes" before finishing. The `afterAll` hook does a second defensive
 * clear in case a test aborts mid-way.
 *
 * Unique per-run tokens (`E2E-NOTES-<timestamp>-<rand>`) mean search-based
 * assertions can never collide with the user's real notes content.
 *
 * Serial mode + single-worker: matches the rest of the suite and avoids
 * cross-test interference when two specs touch the same dashboard.
 */

const TOKEN_PREFIX = "E2E-NOTES";

function uniqueToken(label: string): string {
  return `${TOKEN_PREFIX}-${label}-${Date.now()}-${Math.floor(Math.random() * 1_000)}`;
}

/** Dismiss any stale toast / dialog / menu from a previous test. */
async function dismissStaleOverlays(page: Page) {
  for (let i = 0; i < 2; i++) await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 3_000 });
  await expect(page.getByRole("menu")).toHaveCount(0, { timeout: 3_000 });
}

/** Wait for a toast with the given text to leave the DOM (best-effort). */
async function waitForToastDetached(page: Page, title: string) {
  await page
    .getByText(title, { exact: true })
    .waitFor({ state: "detached", timeout: 15_000 })
    .catch(() => {});
}

/** Title of the paper in a given row (first `<p>` in the first cell). */
async function titleOfRow(row: Locator): Promise<string> {
  const titleEl = row.locator("td p").first();
  const text = (await titleEl.textContent())?.trim() ?? "";
  return text;
}

/**
 * Whether a row currently displays the `StickyNote` "View notes" indicator
 * button. The product renders this button iff `paper.notes?.trim()` is truthy.
 */
async function rowHasNotesIndicator(row: Locator): Promise<boolean> {
  const btn = row.getByRole("button", { name: /view notes/i });
  return await btn.isVisible({ timeout: 500 }).catch(() => false);
}

/**
 * Find a paper row by title substring (virtual-table safe; the table uses
 * @tanstack/react-virtual so absolute indexes are unreliable but filtering
 * by title text always finds a rendered row when the paper is visible).
 */
function rowByTitle(page: Page, title: string): Locator {
  return page.locator("tbody tr").filter({ hasText: title }).first();
}

/** Open the Edit dialog for the paper in the given row. */
async function openEditDialogForRow(page: Page, row: Locator) {
  await row.getByRole("button", { name: /^edit$/i }).click();
  await expect(page.getByRole("dialog")).toBeVisible({ timeout: 5_000 });
}

/** Set the Notes textarea to `value` and click Save Changes. */
async function setNotesAndSave(page: Page, value: string) {
  const dialog = page.getByRole("dialog");
  const notesField = dialog.getByLabel("Notes", { exact: true });
  await expect(notesField).toBeVisible();
  await notesField.fill(value);
  await dialog.getByRole("button", { name: /save changes/i }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 5_000 });
}

/**
 * Restore a paper identified by title substring to an empty notes field.
 * Idempotent — safe to call even when the paper already has no notes.
 */
async function restoreEmptyNotes(page: Page, title: string) {
  const row = rowByTitle(page, title);
  if (!(await row.isVisible({ timeout: 2_000 }).catch(() => false))) return;
  // Fast path: no indicator means notes is already empty/null.
  if (!(await rowHasNotesIndicator(row))) return;
  await openEditDialogForRow(page, row);
  await setNotesAndSave(page, "");
  // After save, the indicator should be gone.
  await expect(row.getByRole("button", { name: /view notes/i })).toHaveCount(0, {
    timeout: 3_000,
  });
}

/**
 * Scan the first N table rows and return the titles of the first two that
 * currently have NO notes indicator. Throws if fewer than 2 are found — the
 * dev DB used by the E2E account has 100+ papers and the vast majority have
 * no notes, so this should always succeed.
 */
async function findTwoPapersWithoutNotes(page: Page, maxScan = 30): Promise<[string, string]> {
  const rows = page.locator("tbody tr");
  const total = await rows.count();
  const limit = Math.min(total, maxScan);
  const found: string[] = [];
  for (let i = 0; i < limit && found.length < 2; i++) {
    const row = rows.nth(i);
    if (!(await row.isVisible({ timeout: 500 }).catch(() => false))) continue;
    const title = await titleOfRow(row);
    if (!title) continue;
    // Skip rows that already have a note indicator.
    if (await rowHasNotesIndicator(row)) continue;
    // Skip duplicates (defensive — titles should be unique but not guaranteed).
    if (found.includes(title)) continue;
    found.push(title);
  }
  if (found.length < 2) {
    throw new Error(
      `notes.spec: expected at least 2 papers without notes in the first ${maxScan} rows, found ${found.length}`,
    );
  }
  return [found[0], found[1]];
}

/** The Notes-presence Select trigger. Defaults to "All Papers". */
function notesFilterTrigger(page: Page): Locator {
  // There are several shadcn Selects on the page (Study type, Notes presence,
  // Project, Tag). The Notes presence select is uniquely identified by its
  // default value text "All Papers" — Projects shows "All Projects", Tags
  // shows "All Tags", Study types shows "All Types".
  return page.getByRole("combobox").filter({ hasText: /^all papers$/i }).first();
}

/** Pick a value from the currently-open Notes-presence dropdown. */
async function pickNotesFilterOption(page: Page, optionText: "All Papers" | "Has notes" | "No notes") {
  const option = page.getByRole("option", { name: optionText, exact: true });
  await expect(option).toBeVisible({ timeout: 3_000 });
  await option.click();
}

test.describe("Paper Notes — end-to-end", () => {
  test.describe.configure({ mode: "serial" });

  let paperA: string;
  let paperB: string;

  test.beforeAll(async ({ browser }) => {
    // Use a dedicated context so we can pick the target papers once and share.
    const ctx = await browser.newContext({ storageState: "e2e/.auth/user.json" });
    const page = await ctx.newPage();
    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);
    [paperA, paperB] = await findTwoPapersWithoutNotes(page);
    await ctx.close();
  });

  test.beforeEach(async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);
    await dismissStaleOverlays(page);
  });

  test.afterAll(async ({ browser }) => {
    // Defensive cleanup: if any test aborted mid-way with notes still set,
    // wipe them here. Uses a fresh context to avoid interference.
    const ctx = await browser.newContext({ storageState: "e2e/.auth/user.json" });
    const page = await ctx.newPage();
    try {
      await page.goto("/", { waitUntil: "networkidle" });
      await waitForDashboard(page);
      if (paperA) await restoreEmptyNotes(page, paperA);
      if (paperB) await restoreEmptyNotes(page, paperB);
    } finally {
      await ctx.close();
    }
  });

  test("1. add note → list indicator appears → popover preview shows text", async ({ page }) => {
    const note = `${uniqueToken("ADD")}\nSecond line with UTF-8 — ✓`;

    const row = rowByTitle(page, paperA);
    await expect(row).toBeVisible();

    // Sanity: no indicator before.
    expect(await rowHasNotesIndicator(row)).toBe(false);

    await openEditDialogForRow(page, row);
    await setNotesAndSave(page, note);

    // Indicator button appears on the row.
    const indicator = row.getByRole("button", { name: /view notes/i });
    await expect(indicator).toBeVisible({ timeout: 5_000 });

    // Clicking opens the popover (rendered as a modal dialog by <Popover modal>).
    await indicator.click();
    const popover = page.getByRole("dialog");
    await expect(popover).toBeVisible({ timeout: 3_000 });
    // Heading "Notes" (uppercase via CSS — text content is exactly "Notes").
    await expect(popover.getByText("Notes", { exact: true })).toBeVisible();
    // Full note text (including newline + unicode) renders verbatim.
    await expect(popover.getByText(note, { exact: false })).toBeVisible();

    // Close popover and restore.
    await page.keyboard.press("Escape");
    await expect(popover).not.toBeVisible({ timeout: 3_000 });

    await restoreEmptyNotes(page, paperA);
  });

  test("2. edit existing note — textarea round-trips, new content persists", async ({ page }) => {
    const firstNote = uniqueToken("EDIT-1");
    const secondNote = uniqueToken("EDIT-2");

    // Arrange: seed a note.
    const row = rowByTitle(page, paperA);
    await openEditDialogForRow(page, row);
    await setNotesAndSave(page, firstNote);
    await expect(row.getByRole("button", { name: /view notes/i })).toBeVisible({ timeout: 5_000 });

    // Act: re-open the dialog — textarea should show the saved value.
    await openEditDialogForRow(page, row);
    const notesField = page.getByRole("dialog").getByLabel("Notes", { exact: true });
    await expect(notesField).toHaveValue(firstNote);

    // Replace content and save.
    await notesField.fill(secondNote);
    await page.getByRole("dialog").getByRole("button", { name: /save changes/i }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 5_000 });

    // Assert: re-open and verify the new content was persisted.
    await openEditDialogForRow(page, row);
    const notesField2 = page.getByRole("dialog").getByLabel("Notes", { exact: true });
    await expect(notesField2).toHaveValue(secondNote);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 3_000 });

    await restoreEmptyNotes(page, paperA);
  });

  test("3. clearing the note removes the row indicator", async ({ page }) => {
    const note = uniqueToken("CLEAR");

    // Arrange: seed a note so the indicator renders.
    const row = rowByTitle(page, paperA);
    await openEditDialogForRow(page, row);
    await setNotesAndSave(page, note);
    await expect(row.getByRole("button", { name: /view notes/i })).toBeVisible({ timeout: 5_000 });

    // Act: re-open, empty the textarea, save.
    await openEditDialogForRow(page, row);
    await setNotesAndSave(page, "");

    // Assert: indicator is gone (product predicate is `paper.notes?.trim()`).
    await expect(row.getByRole("button", { name: /view notes/i })).toHaveCount(0, {
      timeout: 5_000,
    });
  });

  test("4. Has notes / No notes filter partitions papers correctly", async ({ page }) => {
    const note = uniqueToken("FILTER");

    // Arrange: give paperB a note; paperA remains empty.
    const rowB = rowByTitle(page, paperB);
    await openEditDialogForRow(page, rowB);
    await setNotesAndSave(page, note);
    await expect(rowB.getByRole("button", { name: /view notes/i })).toBeVisible({ timeout: 5_000 });

    // Act + assert: "Has notes" includes paperB, excludes paperA.
    await notesFilterTrigger(page).click();
    await pickNotesFilterOption(page, "Has notes");
    // Wait for table to re-render.
    await expect(rowByTitle(page, paperB)).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("tbody tr").filter({ hasText: paperA })).toHaveCount(0, {
      timeout: 5_000,
    });

    // Flip to "No notes": paperA must appear, paperB must disappear.
    // After the first pick the select now shows "Has notes"; re-target by new label.
    const trigger2 = page.getByRole("combobox").filter({ hasText: /^has notes$/i }).first();
    await trigger2.click();
    await pickNotesFilterOption(page, "No notes");
    await expect(rowByTitle(page, paperA)).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("tbody tr").filter({ hasText: paperB })).toHaveCount(0, {
      timeout: 5_000,
    });

    // Reset filter back to "All Papers" so cleanup can locate paperB again.
    const trigger3 = page.getByRole("combobox").filter({ hasText: /^no notes$/i }).first();
    await trigger3.click();
    await pickNotesFilterOption(page, "All Papers");
    await expect(rowByTitle(page, paperB)).toBeVisible({ timeout: 10_000 });

    await restoreEmptyNotes(page, paperB);
    await waitForToastDetached(page, "Paper updated");
  });

  test("5. searching a notes token surfaces the paper with Matched in: Notes", async ({ page }) => {
    // FTS strips non-alphanumeric characters and may discard short pure-numeric
    // tokens, so we deliberately embed a lowercase-alphabetic marker that is
    // guaranteed to survive tokenisation and be unique across the library.
    // `zzq` prefix puts us far into the alphabet (collision-unlikely) and the
    // timestamp tail guarantees per-run uniqueness.
    const marker = `zzqnote${Date.now().toString(36)}`;
    const note = `Pre-token filler text. ${marker} Trailing context.`;

    // Arrange: plant the marker in paperA's notes.
    const row = rowByTitle(page, paperA);
    await openEditDialogForRow(page, row);
    await setNotesAndSave(page, note);
    await expect(row.getByRole("button", { name: /view notes/i })).toBeVisible({ timeout: 5_000 });

    // Act: type the marker into the main search box (3+ chars → FTS path,
    // which returns the six `matched_*` attribution booleans).
    const searchInput = page.getByPlaceholder(/search titles/i);
    await searchInput.fill(marker);

    // Wait for the table to converge on the matching row. Short-query (<3
    // chars) uses the ILIKE RPC, 3+ uses FTS — either way, paperA must appear.
    const targetRow = rowByTitle(page, paperA);
    await expect(targetRow).toBeVisible({ timeout: 10_000 });

    // Assert: the `Matched in:` attribution sub-line includes a "Notes" badge.
    const matchedInLabel = targetRow.getByText("Matched in:", { exact: true });
    await expect(matchedInLabel).toBeVisible({ timeout: 5_000 });
    // The badges are rendered as siblings after the label; scope to the row
    // to avoid the risk of matching a different paper's "Notes" badge.
    await expect(targetRow.getByText("Notes", { exact: true })).toBeVisible({ timeout: 3_000 });

    // Cleanup: clear the search first so the edit dialog can locate the row.
    await searchInput.fill("");
    await expect(rowByTitle(page, paperA)).toBeVisible({ timeout: 10_000 });

    await restoreEmptyNotes(page, paperA);
  });
});
