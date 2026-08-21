import { test, expect, type Page } from "@playwright/test";
import { waitForDashboard } from "./helpers";

/**
 * AUTHOR-IDENTITY-RESOLUTION-001C — the acceptance flows, through the real UI.
 *
 * The seed provides four papers that reproduce the exact situations the feature
 * exists for, so nothing here imports anything or contacts orcid.org:
 *
 *   A `Stuart M Phillips`  ┐ the same person written two ways, carrying the
 *   B `S M Phillips`       ┘ SAME checksum-valid ORCID
 *   C `Alex R Mercer`      ┐ 001A-EQUIVALENT names carrying DIFFERENT valid
 *   D `Alex R. Mercer`     ┘ ORCIDs — two real people who share a name
 *
 * What every test below is really checking is one sentence: Paperlume may
 * suggest, and must never assert. A and B start as two authors despite the
 * shared ORCID, become one only when the user presses Link, and separate again
 * when the link is removed. C and D are never offered to each other at all,
 * because the identifiers contradict the names.
 *
 * These tests share one account and mutate identity state, so each one cleans up
 * after itself and the suite runs serially.
 */

test.describe.configure({ mode: "serial" });

const PAPER_A = "E2E Identity A — Same ORCID, full name";
const PAPER_B = "E2E Identity B — Same ORCID, initials";
const PAPER_C = "E2E Identity C — Same name, first ORCID";
const PAPER_D = "E2E Identity D — Same name, second ORCID";
const PAPER_E = "E2E Identity E — Rewritten authors";

const PERSON_A = "Stuart M Phillips";
const PERSON_B = "S M Phillips";
const MERCER = "Alex R Mercer";
const EDITABLE_AUTHOR = "Dana Q Rewritten";

/** Open Analytics (desktop inline panel) and wait for the author selector. */
async function openAnalytics(page: Page) {
  const trigger = page.getByRole("button", { name: /Analytics/ }).first();
  await trigger.click();
  await expect(page.getByRole("button", { name: /^Target Authors/ })).toBeVisible();
}

/**
 * Bring one paper into view by searching for it.
 *
 * The seeded library is larger than a page, and the identity fixtures were
 * inserted first so the ordering specs keep their highest-order paper — which
 * puts them past the end of the first page. Searching is how a user reaches
 * them, and it keeps this test independent of page size and sort order.
 */
async function findPaperRow(page: Page, title: string) {
  await page.getByLabel("Search papers", { exact: true }).fill(title);
  const row = page.locator("tbody tr").filter({ hasText: title }).first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  return row;
}

/** Clear the paper search so the next step sees the whole library again. */
async function clearPaperSearch(page: Page) {
  await page.getByLabel("Search papers", { exact: true }).fill("");
}

/**
 * Collapse the Analytics panel.
 *
 * The panel is tall, and with it open a paper row can land underneath the
 * table's sticky header, where the header intercepts the click on the row's own
 * controls. Collapsing it is also what a user would do before editing a paper.
 */
async function closeAnalytics(page: Page) {
  const trigger = page.getByRole("button", { name: /Analytics/ }).first();
  if ((await trigger.getAttribute("aria-expanded")) === "true") await trigger.click();
  await expect(page.getByRole("button", { name: /^Target Authors/ })).toBeHidden();
}

/** Close the manager through its own control, and prove it went. */
async function closeManager(page: Page) {
  const dialog = page.getByRole("dialog", { name: /Author identities/ });
  await dialog.getByRole("button", { name: /^Close$/ }).click();
  await expect(dialog).toBeHidden({ timeout: 10_000 });
}

async function openManager(page: Page) {
  await page.getByRole("button", { name: /Manage author identities/ }).click();
  const dialog = page.getByRole("dialog", { name: /Author identities/ });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** The labels currently offered by the Target Authors selector. */
async function authorOptions(page: Page): Promise<string[]> {
  await page.getByRole("button", { name: /^Target Authors/ }).click();
  const labels = await page.locator('label:has([role="checkbox"])').allTextContents();
  await page.keyboard.press("Escape");
  return labels.map((l) => l.trim());
}

/**
 * Narrow the unresolved list to one paper and return its card.
 *
 * The seeded library has 240-odd unresolved author mentions, and the surface
 * renders a bounded window of them. Searching is how a user reaches a specific
 * one, so the tests reach it the same way — which also keeps each step operating
 * on a two-card list instead of a fifty-card one.
 */
async function unresolvedCard(
  dialog: ReturnType<Page["getByRole"]>,
  paperTitle: string,
) {
  await dialog.getByLabel("Search unresolved author mentions").fill(paperTitle);
  const card = dialog.locator("li").filter({ hasText: paperTitle }).first();
  await expect(card).toBeVisible();
  return card;
}

/**
 * Create a person from one unresolved mention and wait for the decision to land.
 *
 * The wait is the point: creating an identity invalidates and refetches the whole
 * identity dataset, so a test that fires the next click immediately can act on a
 * list that is still mid-update. Waiting for the card to leave the unresolved
 * list is the observable signal that the decision was actually recorded.
 */
async function createPersonFrom(
  dialog: ReturnType<Page["getByRole"]>,
  paperTitle: string,
) {
  const card = await unresolvedCard(dialog, paperTitle);
  await card.getByRole("button", { name: /Create a new person/ }).click();
  await card.getByRole("button", { name: /^Create person$/ }).click();
  await expect(card).toBeHidden({ timeout: 15_000 });
}

/**
 * Return the account to the seeded, fully-unresolved state.
 *
 * Every test starts from here, so no test depends on what ran before it — which
 * matters because `DEFAULT_SPECS` is a filter, not an ordering, and Playwright
 * runs files alphabetically.
 *
 * The order is forced by the product: an identity carrying links, aliases or
 * merge edges refuses to be deleted, so those come off first. Each pass waits for
 * the control it clicked to actually leave the DOM rather than sleeping, and the
 * whole thing repeats until the People tab reports zero — a mutation invalidates
 * and refetches the entire dataset, so one pass is not guaranteed to see the
 * result of the last click in it.
 */
async function resetIdentities(page: Page) {
  const dialog = await openManager(page);
  const peopleTab = dialog.getByRole("tab", { name: /People/ });
  const peoplePanel = dialog.getByRole("tabpanel", { name: /People/ });

  for (let sweep = 0; sweep < 20; sweep += 1) {
    await peopleTab.click();
    // Scoped to the panel, and waited for: searching the dialog as a whole would
    // silently look in whichever panel happened to be mounted.
    await expect(peoplePanel).toBeVisible({ timeout: 10_000 });

    if ((await peopleTab.textContent())?.includes("People (0)")) break;

    // Undo merges, then unlink mentions, then drop aliases, then delete what is
    // left — each step is what makes the next one legal.
    let acted = false;
    for (const name of [
      /Undo one merge/,
      /^Unlink$/,
      /^Remove alias /,
      /Delete person/,
    ]) {
      const matches = peoplePanel.getByRole("button", { name });
      const before = await matches.count();
      if (before === 0) continue;
      await matches.first().click();
      // Assert on the COUNT, not on the clicked element. `.first()` is a live
      // locator: once the button it matched is removed it re-resolves to the
      // next one, which is still on screen, so "the button I clicked is gone"
      // can never become true while another person has the same control.
      await expect(matches).toHaveCount(before - 1, { timeout: 15_000 });
      acted = true;
      break;
    }

    if (!acted) {
      throw new Error(
        `identity reset stalled: ${await peopleTab.textContent()} with no removable relationship`,
      );
    }
  }

  await expect(peopleTab).toHaveText(/People \(0\)/, { timeout: 15_000 });
  await closeManager(page);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await waitForDashboard(page);
  await openAnalytics(page);
  await resetIdentities(page);
});

test.afterAll(async ({ browser }) => {
  const page = await browser.newPage();
  await page.goto("/");
  await waitForDashboard(page);
  await openAnalytics(page);
  await resetIdentities(page);
  await page.close();
});

test("a shared ORCID suggests a link but never applies one", async ({ page }) => {
  // Before anything: two separate authors, despite the identical ORCID. This is
  // the 001A/001B behaviour the feature must not pre-empt.
  const before = await authorOptions(page);
  expect(before).toContain(PERSON_A);
  expect(before).toContain(PERSON_B);

  const dialog = await openManager(page);

  // Create a person from paper A's mention. The default name is the source
  // spelling, editable before confirming.
  const cardA = await unresolvedCard(dialog, PAPER_A);
  await cardA.getByRole("button", { name: /Create a new person/ }).click();
  await expect(cardA.getByLabel("Name for this person")).toHaveValue(PERSON_A);
  await cardA.getByRole("button", { name: /^Create person$/ }).click();
  await expect(cardA).toBeHidden({ timeout: 10_000 });

  // Paper B now carries a Same ORCID suggestion — and is still unresolved.
  const cardB = await unresolvedCard(dialog, PAPER_B);
  const suggestion = cardB.getByRole("button", { name: new RegExp(`Link to ${PERSON_A}`) });
  await expect(suggestion).toBeVisible();
  await expect(suggestion).toContainText("Same ORCID");

  await closeManager(page);
  const afterSuggestion = await authorOptions(page);
  expect(
    afterSuggestion,
    "a suggestion must not group anything until the user acts",
  ).toContain(PERSON_B);

  // The explicit action. Only now do the two become one person.
  const reopened = await openManager(page);
  const cardBAgain = await unresolvedCard(reopened, PAPER_B);
  await cardBAgain
    .getByRole("button", { name: new RegExp(`Link to ${PERSON_A}`) })
    .click();
  await expect(cardBAgain).toBeHidden({ timeout: 15_000 });
  await closeManager(page);

  const grouped = await authorOptions(page);
  expect(grouped).toContain(PERSON_A);
  expect(grouped, "the initialled spelling is now part of the person").not.toContain(PERSON_B);

  // ...and unlinking puts it back, immediately.
  const forUnlink = await openManager(page);
  await forUnlink.getByRole("tab", { name: /People/ }).click();
  // `li li` reaches the mention row inside the person card. Matching plain `li`
  // would also match the card itself, which by now holds two linked mentions and
  // therefore two Unlink buttons.
  const mentionRow = forUnlink.locator("li li").filter({ hasText: PAPER_B }).first();
  await mentionRow.getByRole("button", { name: /^Unlink$/ }).click();
  await closeManager(page);

  const split = await authorOptions(page);
  expect(split).toContain(PERSON_A);
  expect(split).toContain(PERSON_B);
});

test("contradictory ORCIDs suppress the name suggestion entirely", async ({ page }) => {
  const dialog = await openManager(page);

  // Create a person from paper C. Paper D's author is 001A-equivalent to it.
  await createPersonFrom(dialog, PAPER_C);

  // No suggestion may be offered for D: its ORCID says it is someone else, and
  // a name match must never override that.
  const cardD = await unresolvedCard(dialog, PAPER_D);
  await expect(cardD).toBeVisible();
  await expect(cardD.getByRole("button", { name: /Link to/ })).toHaveCount(0);

  // Nor may they be proposed as duplicates of each other.
  await dialog.getByRole("tab", { name: /Duplicates/ }).click();
  await expect(dialog.getByText(/No possible duplicates found/i)).toBeVisible();

  await closeManager(page);

  // And Analytics still shows them as the two distinct people they are.
  const options = await authorOptions(page);
  expect(options.filter((label) => label.startsWith("Alex R"))).toHaveLength(2);
});

test("a merge is reversible and moves nothing", async ({ page }) => {
  const dialog = await openManager(page);

  // Two people, one mention each, deliberately created as separate records even
  // though they share an ORCID — which is exactly the mess a user can make, and
  // exactly what the duplicate review exists to help them undo.
  await createPersonFrom(dialog, PAPER_A);
  await createPersonFrom(dialog, PAPER_B);

  await dialog.getByRole("tab", { name: /People/ }).click();
  await expect(dialog.getByLabel(`Name for ${PERSON_A}`, { exact: true })).toBeVisible();
  await expect(dialog.getByLabel(`Name for ${PERSON_B}`, { exact: true })).toBeVisible();
  await closeManager(page);

  const beforeMerge = await authorOptions(page);
  expect(beforeMerge).toContain(PERSON_A);
  expect(beforeMerge).toContain(PERSON_B);

  // The shared ORCID makes them a strong duplicate candidate. It is still only a
  // candidate: nothing merged until the button below is pressed.
  const forMerge = await openManager(page);
  await forMerge.getByRole("tab", { name: /Duplicates/ }).click();
  const pair = forMerge.getByRole("tabpanel", { name: /Duplicates/ }).locator("li").first();
  await expect(pair).toBeVisible();
  await expect(pair).toContainText("Same ORCID");
  await expect(pair).toContainText(/Merging keeps both records/i);
  await pair.getByRole("button", { name: new RegExp(`Merge into ${PERSON_B}`) }).click();
  await expect(forMerge.getByRole("tab", { name: /Duplicates \(0\)/ })).toBeVisible({
    timeout: 15_000,
  });
  await closeManager(page);

  const merged = await authorOptions(page);
  expect(merged, "both mentions now resolve to the merge target").toContain(PERSON_B);
  expect(merged).not.toContain(PERSON_A);

  // The merged-away record is still there, holding its own link — nothing was
  // copied or moved, which is the whole reason a merge is an edge.
  const forUndo = await openManager(page);
  await forUndo.getByRole("tab", { name: /People/ }).click();
  await expect(forUndo.getByText("1 merged")).toBeVisible();
  await forUndo.getByRole("button", { name: /Undo one merge/ }).first().click();
  await expect(forUndo.getByText("1 merged")).toBeHidden({ timeout: 15_000 });
  await closeManager(page);

  // Undo restores the previous grouping immediately, with no reconstruction.
  const unmerged = await authorOptions(page);
  expect(unmerged).toContain(PERSON_A);
  expect(unmerged).toContain(PERSON_B);
});

test("editing a paper's authors clears its identity links atomically", async ({ page }) => {
  // Paper E exists for this test alone: rewriting an authors array also replaces
  // the paper's provenance with honest manual entries, and papers A-D must keep
  // the source ORCIDs the other flows depend on.
  const dialog = await openManager(page);
  await createPersonFrom(dialog, PAPER_E);
  await closeManager(page);

  expect(await authorOptions(page)).toContain(EDITABLE_AUTHOR);

  // An unrelated field first: the decision must survive it.
  await closeAnalytics(page);
  const rowForNotes = await findPaperRow(page, PAPER_E);
  await rowForNotes.getByRole("button", { name: `Edit ${PAPER_E}`, exact: true }).click();
  const editDialog = page.getByRole("dialog").first();
  await editDialog.getByLabel(/^Notes$/i).fill("An unrelated edit.");
  await editDialog.getByRole("button", { name: /^Save/ }).click();
  await expect(editDialog).toBeHidden();

  await openAnalytics(page);
  const afterNotes = await openManager(page);
  await afterNotes.getByRole("tab", { name: /People/ }).click();
  await expect(afterNotes.getByRole("tabpanel", { name: /People/ })).toBeVisible();
  await expect(
    afterNotes.getByText(/Linked mentions \(1\)/),
    "an unrelated edit must not discard a person decision",
  ).toBeVisible();
  await closeManager(page);

  // Now rewrite the authors array. Every link on that paper must go, because the
  // link named text that no longer stands there.
  await closeAnalytics(page);
  const rowForAuthors = await findPaperRow(page, PAPER_E);
  await rowForAuthors.getByRole("button", { name: `Edit ${PAPER_E}`, exact: true }).click();
  const editAuthors = page.getByRole("dialog").first();
  await editAuthors.getByLabel(/Authors \(comma-separated\)/i).fill("Someone Entirely Different");
  await editAuthors.getByRole("button", { name: /^Save/ }).click();
  await expect(editAuthors).toBeHidden();

  await openAnalytics(page);
  const afterAuthors = await openManager(page);
  await afterAuthors.getByRole("tab", { name: /People/ }).click();
  await expect(afterAuthors.getByRole("tabpanel", { name: /People/ })).toBeVisible();
  await expect(
    afterAuthors.getByText(/Nothing is linked to this person/i),
    "an authors rewrite must clear the paper's links",
  ).toBeVisible({ timeout: 15_000 });
  await closeManager(page);

  // Analytics falls back to unresolved 001A grouping for the new text.
  await clearPaperSearch(page);
  const options = await authorOptions(page);
  expect(options).toContain("Someone Entirely Different");

  // Restore the fixture so a re-run starts from the seeded state.
  await closeAnalytics(page);
  const rowForRestore = await findPaperRow(page, PAPER_E);
  await rowForRestore.getByRole("button", { name: `Edit ${PAPER_E}`, exact: true }).click();
  const restore = page.getByRole("dialog").first();
  await restore.getByLabel(/Authors \(comma-separated\)/i).fill(EDITABLE_AUTHOR);
  await restore.getByRole("button", { name: /^Save/ }).click();
  await expect(restore).toBeHidden();
  await clearPaperSearch(page);
  await openAnalytics(page);
});
