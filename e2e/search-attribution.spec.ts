import { test, expect, type Page, type Locator } from "@playwright/test";
import { waitForDashboard } from "./helpers";

/**
 * End-to-end coverage for the server-driven `Matched in:` search-attribution UI.
 *
 * After the search wave (PRs #91–#93) every search RPC returns six per-field
 * `matched_*` booleans (title, abstract, authors, journal, notes, keywords)
 * which `PaperList` renders as outline `<Badge>`s in a fixed sub-line under
 * the matching row's title. The unit-test suite already covers the helpers
 * around `MATCH_FIELD_ORDER` and the hook plumbing — what we lacked was an
 * end-to-end check that for each of the six attribution sources, a search
 * targeting only that field surfaces the row with the correct badge.
 *
 * --- Strategy ---
 * UI-driven seeding through the existing Edit Paper dialog. The spec picks
 * the first paper on the dashboard, captures every searchable field's
 * current value, then in a single Save **appends** a per-field unique
 * alphanumeric token to each of the six fields:
 *
 *   title, authors, journal, abstract, keywords, notes
 *
 * Each token follows the shape `e2eattr<field><base36-timestamp>`, which is
 * collision-unlikely against real paper content and survives FTS
 * tokenisation cleanly (3+ chars, alphanumeric, no operator characters).
 * Because each token appears in exactly one field, searching for a token
 * exercises that field's `matched_*` flag in isolation: the row should
 * render `Matched in:` with one badge whose label corresponds to the field.
 *
 * Cleanup is a single restore Save in `afterAll` that writes the captured
 * originals back. We never mutate any other paper, never create or delete
 * rows, never touch the schema.
 *
 * Single-account `storageState`, serial mode, single worker — matches the
 * suite convention.
 */

const TS = Date.now().toString(36);

const TOKENS = {
  title: `e2eattrtitle${TS}`,
  abstract: `e2eattrabstract${TS}`,
  authors: `e2eattrauthor${TS}`,
  journal: `e2eattrjournal${TS}`,
  notes: `e2eattrnotes${TS}`,
  keywords: `e2eattrkeyword${TS}`,
} as const;

/** Maps each token key to the visible badge label rendered in the row. */
const BADGE_LABELS: Record<keyof typeof TOKENS, string> = {
  title: "Title",
  abstract: "Abstract",
  authors: "Authors",
  journal: "Journal",
  notes: "Notes",
  keywords: "Keywords",
};

/**
 * Snapshot of the editable fields we touch — captured before mutation so
 * the cleanup pass in `afterAll` can write the originals back verbatim.
 */
interface Originals {
  paperTitle: string;
  title: string;
  authors: string;
  journal: string;
  abstract: string;
  keywords: string;
  notes: string;
}

const STORAGE_STATE = "e2e/.auth/user.json";

/** Open Edit on the first row and wait for the dialog to be ready. */
async function openEditOnFirstRow(page: Page): Promise<Locator> {
  const firstRow = page.locator("tbody tr").first();
  await firstRow.getByRole("button", { name: /^edit$/i }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible({ timeout: 5_000 });
  // The Abstract textarea is disabled while `useAbstract` is fetching; wait
  // until it's enabled so the captured / overwritten value is the real one.
  await expect(dialog.getByLabel(/^abstract$/i)).toBeEnabled({ timeout: 15_000 });
  return dialog;
}

/** Click Save Changes and wait for the dialog to close. */
async function saveAndCloseDialog(page: Page) {
  await page.getByRole("dialog").getByRole("button", { name: /save changes/i }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 10_000 });
}

/**
 * Capture the current values of the six searchable fields (plus the
 * paper's title for row identification later).
 */
async function captureOriginals(dialog: Locator): Promise<Originals> {
  const title = await dialog.getByLabel(/^title$/i).inputValue();
  const authors = await dialog.getByLabel(/^authors/i).inputValue();
  const journal = await dialog.getByLabel(/^journal$/i).inputValue();
  const abstract = await dialog.getByLabel(/^abstract$/i).inputValue();
  const keywords = await dialog.getByLabel(/^keywords/i).inputValue();
  const notes = await dialog.getByLabel(/^notes$/i).inputValue();
  return {
    paperTitle: title,
    title,
    authors,
    journal,
    abstract,
    keywords,
    notes,
  };
}

/**
 * Append a per-field unique token to each searchable field. We append rather
 * than replace so the paper continues to read like itself; the tokens are
 * only there to drive deterministic single-field matches in search.
 */
async function appendTokensToAllFields(dialog: Locator, originals: Originals) {
  // Comma separators where the field is parsed as a list (authors, keywords).
  const join = (existing: string, token: string, sep = " ") =>
    existing.trim().length === 0 ? token : `${existing}${sep}${token}`;

  await dialog.getByLabel(/^title$/i).fill(join(originals.title, TOKENS.title));
  await dialog.getByLabel(/^authors/i).fill(join(originals.authors, TOKENS.authors, ", "));
  await dialog.getByLabel(/^journal$/i).fill(join(originals.journal, TOKENS.journal));
  await dialog.getByLabel(/^abstract$/i).fill(join(originals.abstract, TOKENS.abstract, "\n\n"));
  await dialog.getByLabel(/^keywords/i).fill(join(originals.keywords, TOKENS.keywords, ", "));
  await dialog.getByLabel(/^notes$/i).fill(join(originals.notes, TOKENS.notes, "\n\n"));
}

/** Restore the captured originals into the same paper. */
async function restoreOriginalFields(dialog: Locator, originals: Originals) {
  await dialog.getByLabel(/^title$/i).fill(originals.title);
  await dialog.getByLabel(/^authors/i).fill(originals.authors);
  await dialog.getByLabel(/^journal$/i).fill(originals.journal);
  await dialog.getByLabel(/^abstract$/i).fill(originals.abstract);
  await dialog.getByLabel(/^keywords/i).fill(originals.keywords);
  await dialog.getByLabel(/^notes$/i).fill(originals.notes);
}

/**
 * The seeded paper's row, located by the title token. We always scope by the
 * **title** token because the table cell renders the title verbatim, while
 * abstract, notes, and keywords are not part of the row's collapsed text
 * (abstract is fetched on demand; notes live in a popover; keywords live in
 * a separate column that may be hidden). The title token is the one stable
 * substring guaranteed to appear in every test row.
 */
function seededRow(page: Page): Locator {
  return page.locator("tbody tr").filter({ hasText: TOKENS.title }).first();
}

/**
 * Assert that the given row's `Matched in:` sub-line shows EXACTLY ONE
 * badge with the expected label. Scoping to the sub-line container avoids
 * accidental matches against unrelated row text.
 */
async function expectAttribution(row: Locator, expectedLabel: string) {
  // The container `<div>` of the Matched-in line is the parent of the
  // `Matched in:` <span>. Scope all label assertions to that container.
  const matchedInLabel = row.getByText("Matched in:", { exact: true });
  await expect(matchedInLabel).toBeVisible({ timeout: 10_000 });
  const attribLine = matchedInLabel.locator("xpath=..");
  await expect(attribLine.getByText(expectedLabel, { exact: true })).toBeVisible({
    timeout: 5_000,
  });
}

test.describe("Search attribution — Matched in: badges", () => {
  test.describe.configure({ mode: "serial" });

  let originals: Originals;

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: STORAGE_STATE });
    const page = await ctx.newPage();
    try {
      await page.goto("/", { waitUntil: "networkidle" });
      await waitForDashboard(page);
      const dialog = await openEditOnFirstRow(page);
      originals = await captureOriginals(dialog);
      await appendTokensToAllFields(dialog, originals);
      await saveAndCloseDialog(page);
      // Sanity: the row now contains every appended token so any of them can
      // be used to scope assertions later. We pick the title token here as
      // a quick smoke check that the save committed and the search index
      // (a generated `tsvector` column) regenerated.
      const searchInput = page.getByPlaceholder(/search titles/i);
      await searchInput.fill(TOKENS.title);
      await expect(seededRow(page)).toBeVisible({ timeout: 15_000 });
    } finally {
      await ctx.close();
    }
  });

  test.afterAll(async ({ browser }) => {
    if (!originals) return;
    const ctx = await browser.newContext({ storageState: STORAGE_STATE });
    const page = await ctx.newPage();
    try {
      await page.goto("/", { waitUntil: "networkidle" });
      await waitForDashboard(page);
      // Find the paper by the title token — captured originals are restored
      // even if the paper has been re-sorted.
      const searchInput = page.getByPlaceholder(/search titles/i);
      await searchInput.fill(TOKENS.title);
      const row = seededRow(page);
      if (await row.isVisible({ timeout: 10_000 }).catch(() => false)) {
        await row.getByRole("button", { name: /^edit$/i }).click();
        const dialog = page.getByRole("dialog");
        await expect(dialog).toBeVisible({ timeout: 5_000 });
        await expect(dialog.getByLabel(/^abstract$/i)).toBeEnabled({ timeout: 15_000 });
        await restoreOriginalFields(dialog, originals);
        await saveAndCloseDialog(page);
      }
      // Best-effort search clear so subsequent specs (if any) start clean.
      await searchInput.fill("");
    } finally {
      await ctx.close();
    }
  });

  test.beforeEach(async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);
  });

  // One test per attribution source. Each one:
  //   1. types the field-specific unique token into the main search box
  //   2. waits for the seeded paper row to appear
  //   3. asserts the row's `Matched in:` sub-line shows the expected badge

  test("title: searching a title-only token shows Matched in: Title", async ({ page }) => {
    await page.getByPlaceholder(/search titles/i).fill(TOKENS.title);
    await expectAttribution(seededRow(page), BADGE_LABELS.title);
  });

  test("abstract: searching an abstract-only token shows Matched in: Abstract", async ({ page }) => {
    await page.getByPlaceholder(/search titles/i).fill(TOKENS.abstract);
    await expectAttribution(seededRow(page), BADGE_LABELS.abstract);
  });

  test("authors: searching an author-only token shows Matched in: Authors", async ({ page }) => {
    await page.getByPlaceholder(/search titles/i).fill(TOKENS.authors);
    await expectAttribution(seededRow(page), BADGE_LABELS.authors);
  });

  test("journal: searching a journal-only token shows Matched in: Journal", async ({ page }) => {
    await page.getByPlaceholder(/search titles/i).fill(TOKENS.journal);
    await expectAttribution(seededRow(page), BADGE_LABELS.journal);
  });

  test("notes: searching a notes-only token shows Matched in: Notes", async ({ page }) => {
    await page.getByPlaceholder(/search titles/i).fill(TOKENS.notes);
    await expectAttribution(seededRow(page), BADGE_LABELS.notes);
  });

  test("keywords: searching a keyword-only token shows Matched in: Keywords", async ({ page }) => {
    await page.getByPlaceholder(/search titles/i).fill(TOKENS.keywords);
    await expectAttribution(seededRow(page), BADGE_LABELS.keywords);
  });
});
