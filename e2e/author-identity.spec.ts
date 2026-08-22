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
/** Paper D spells the same name with a period — two people, one 001A key. */
const MERCER_D = "Alex R. Mercer";
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
 * Press the row that names a person in the existing-person chooser.
 *
 * Deliberately NOT a click on the radio itself. That control is visually
 * replaced — a real `<input type="radio">` kept 1px and clipped so the platform
 * still owns grouping, arrow-key movement and the checked state a screen reader
 * reads — and a click aimed at its own box is intercepted by the row painted
 * over it. Which is the whole design: the row is the affordance, for Playwright
 * exactly as for a person. Anything that could only be driven by addressing the
 * hidden control would be reproducing the defect this flow was rebuilt for.
 */
function personRow(scope: ReturnType<Page["getByRole"]>, name: string) {
  return scope
    .getByRole("radio", { name: new RegExp(`^${name}`) })
    .locator("xpath=ancestor::label[1]");
}

/**
 * Open one person's management panel in the People tab.
 *
 * AUTHOR-IDENTITY-PEOPLE-LIST-COMPACTION-001. The People list is compact: a
 * person's linked mentions, aliases, merge control and delete are not in the
 * document at all until their row is opened, and opening one closes any other.
 * Pressing the row is how a person reaches them, so it is how these tests reach
 * them too — the header is the control, not a chevron at the end of it.
 */
async function openPerson(scope: ReturnType<Page["getByRole"]>, name: string) {
  const header = personHeader(scope, name);
  await expect(header).toBeVisible({ timeout: 15_000 });
  if ((await header.getAttribute("aria-expanded")) !== "true") await header.click();
  await expect(header).toHaveAttribute("aria-expanded", "true", { timeout: 10_000 });
  return header;
}

/** One person's collapsed disclosure header, by the name it states. */
function personHeader(scope: ReturnType<Page["getByRole"]>, name: string) {
  return scope.locator("button[aria-expanded]").filter({ hasText: name }).first();
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

  for (let sweep = 0; sweep < 80; sweep += 1) {
    await peopleTab.click();
    // Scoped to the panel, and waited for: searching the dialog as a whole would
    // silently look in whichever panel happened to be mounted.
    await expect(peoplePanel).toBeVisible({ timeout: 10_000 });

    if ((await peopleTab.textContent())?.includes("People (0)")) break;

    // The list is compact, so a person's relationships are not in the document
    // until their row is open. Exactly one is, and every person has at least one
    // control: whatever is still attached to them, or Delete once nothing is.
    if ((await peoplePanel.locator('button[aria-expanded="true"]').count()) === 0) {
      await peoplePanel.locator('button[aria-expanded="false"]').first().click();
      await expect(peoplePanel.locator('button[aria-expanded="true"]')).toHaveCount(1, {
        timeout: 10_000,
      });
    }

    // An open person shows only their first five linked mentions, so expand the
    // list: the counted-progress assertion below needs every removable control
    // on screen, or unlinking one of six leaves the count at five and stalls.
    const showAll = peoplePanel.getByRole("button", {
      name: /^Show all \d+ linked mentions$/,
    });
    if ((await showAll.count()) > 0) await showAll.click();

    // Undo merges, then unlink mentions, then drop aliases, then delete what is
    // left — each step is what makes the next one legal.
    let acted = false;
    for (const name of [
      /^Undo merge of /,
      /^Unlink$/,
      /^Remove alias /,
      /^Delete /,
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
  const unlinkPanel = forUnlink.getByRole("tabpanel", { name: /People/ });
  // The collapsed row already says how much is attached, without opening it.
  await expect(personHeader(unlinkPanel, PERSON_A)).toContainText("2 linked mentions");
  await openPerson(unlinkPanel, PERSON_A);
  // `li li` reaches the mention row inside the person's panel. Matching plain
  // `li` would also match the row itself, which by now holds two linked
  // mentions and therefore two Unlink buttons.
  const mentionRows = unlinkPanel.locator("li li").filter({ hasText: PAPER_B });
  await expect(mentionRows).toHaveCount(1);
  await mentionRows.first().getByRole("button", { name: /^Unlink$/ }).click();
  // Wait for the decision to land before reading Analytics. Unlinking refetches
  // the identity dataset AND the linked-paper evidence behind it, so closing the
  // dialog immediately can read a cache that still holds the link. Asserting on
  // the COUNT rather than on the clicked element is the file's rule: `.first()`
  // re-resolves, so "the row I clicked is gone" can never become true while a
  // sibling row still matches.
  await expect(mentionRows).toHaveCount(0, { timeout: 15_000 });
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
  const bothPanel = dialog.getByRole("tabpanel", { name: /People/ });
  // Two rows, both closed: the list is scannable before anything is opened.
  await expect(personHeader(bothPanel, PERSON_A)).toBeVisible();
  await expect(personHeader(bothPanel, PERSON_B)).toBeVisible();
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
  // The accessible name states BOTH ends now — the visible "Merge into X" says
  // only half of a decision whose whole content is its direction.
  await pair.getByRole("button", { name: new RegExp(` into ${PERSON_B}$`) }).click();
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
  const undoPanel = forUndo.getByRole("tabpanel", { name: /People/ });
  // The merge is legible from the compact row itself.
  await expect(undoPanel.getByText("1 merged")).toBeVisible();
  await openPerson(undoPanel, PERSON_B);
  await undoPanel
    .getByRole("button", { name: `Undo merge of ${PERSON_A} into ${PERSON_B}` })
    .click();
  await expect(undoPanel.getByText("1 merged")).toBeHidden({ timeout: 15_000 });
  await closeManager(page);

  // Undo restores the previous grouping immediately, with no reconstruction.
  const unmerged = await authorOptions(page);
  expect(unmerged).toContain(PERSON_A);
  expect(unmerged).toContain(PERSON_B);
});

test("an unresolved mention is linked to a person the evidence never suggested", async ({
  page,
}) => {
  // The manual path, exercised where deterministic evidence offers nothing at
  // all. `Dana Q Rewritten` shares neither an ORCID nor a name key with
  // `Alex R Mercer`, so no candidate button can exist — and that is precisely
  // when a user needs to be able to decide for themselves.
  const dialog = await openManager(page);
  await createPersonFrom(dialog, PAPER_C);

  const card = await unresolvedCard(dialog, PAPER_E);
  await expect(card.getByRole("button", { name: /^Link to / })).toHaveCount(0);

  await card
    .getByRole("button", { name: `Link ${EDITABLE_AUTHOR} to an existing person` })
    .click();
  await card
    .getByLabel(`Search people to link ${EDITABLE_AUTHOR} to`, { exact: true })
    .fill(MERCER);
  await personRow(card, MERCER).click();

  // Choosing is not deciding. Nothing is written until the second, explicit step.
  await expect(card).toContainText(
    `${EDITABLE_AUTHOR} on this paper will be recorded as ${MERCER}.`,
  );
  const confirmLink = card.getByRole("button", {
    name: `Link ${EDITABLE_AUTHOR} to ${MERCER}`,
  });
  await expect(confirmLink).toBeVisible();

  await confirmLink.click();
  await expect(card).toBeHidden({ timeout: 15_000 });

  await closeManager(page);

  // The mention now counts as that person, and its own spelling is gone.
  const options = await authorOptions(page);
  expect(options).toContain(MERCER);
  expect(options).not.toContain(EDITABLE_AUTHOR);
});

test("every existing person is visibly selectable, not merely present in the DOM", async ({
  page,
}) => {
  /*
   * AUTHOR-IDENTITY-PICKER-USABILITY-001 — the regression the old suite could
   * not have caught.
   *
   * The manual-link test above already drove this exact flow and passed while
   * the owner, on the same build, could not select anyone. Three different
   * things were being confused:
   *
   *   DOM existence        the option was in the tree, with an accessible name.
   *   Playwright actionable  `.click()` calls `scrollIntoViewIfNeeded` first,
   *                        which sets `scrollLeft` on the scroll viewport —
   *                        something script may do even where `overflow-x` is
   *                        `hidden` and no scrollbar is mounted.
   *   Actually reachable   a person has none of that. If the control sits
   *                        outside the viewport on an axis they cannot scroll,
   *                        it does not exist for them.
   *
   * `toBeVisible()` only asserts a non-empty box and no `visibility: hidden`, so
   * it was true throughout. What follows asserts the third thing: geometry
   * inside the visible picker, and a hit test at the point the user would press.
   */
  const dialog = await openManager(page);
  await createPersonFrom(dialog, PAPER_A);
  await createPersonFrom(dialog, PAPER_C);
  await createPersonFrom(dialog, PAPER_E);

  const card = await unresolvedCard(dialog, PAPER_D);
  await card
    .getByRole("button", { name: `Link ${MERCER_D} to an existing person` })
    .click();

  // The chooser says whose identity is being decided, and that nothing has been.
  const group = card.getByRole("radiogroup", { name: `Who is ${MERCER_D}?` });
  await expect(group).toBeVisible();
  await expect(card).toContainText(/Nothing will be changed until you confirm/i);

  const options = group.getByRole("radio");
  await expect(options).toHaveCount(3);

  // No container may hide content sideways: this is the measurement that was
  // false before the fix (viewport scrollWidth 1287 against clientWidth 610).
  const overflow = await dialog.evaluate((node) => {
    const targets = [node, ...node.querySelectorAll("[data-radix-scroll-area-viewport]")];
    return targets.map((el) => ({
      cls: el.className.toString().slice(0, 40),
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }));
  });
  for (const box of overflow) {
    expect(box.scrollWidth, `horizontal overflow in ${box.cls}`).toBeLessThanOrEqual(
      box.clientWidth,
    );
  }

  /*
   * Every option must be a real, pressable target where the user is looking.
   *
   * The two axes are NOT equivalent here, and that asymmetry is the bug. The
   * viewport scrolls vertically, with a scrollbar and a wheel — a row below the
   * fold is reachable, so it is measured after being scrolled to, exactly as a
   * user would reach it. Horizontally there is no scrollbar and `overflow-x` is
   * `hidden`: anything out there is reachable by script and by nobody else, so
   * it is measured WITHOUT scrolling and must already be inside.
   */
  const geometry = await group.evaluate((node) => {
    const viewport = node.closest("[data-radix-scroll-area-viewport]") as HTMLElement;
    const rows = [...node.querySelectorAll('input[type="radio"]')].map(
      (input) => input.closest("label") as HTMLElement,
    );

    // Horizontal containment, as the picker stands. No scrolling of any kind.
    const horizontal = rows.map((row) => {
      const r = row.getBoundingClientRect();
      const vb = viewport.getBoundingClientRect();
      return {
        name: (row.textContent ?? "").slice(0, 40),
        width: Math.round(r.width),
        height: Math.round(r.height),
        insideViewportHorizontally: r.left >= vb.left && r.right <= vb.right,
      };
    });

    // Vertical reachability, using the only scroll a user actually has here.
    const reachable = rows.map((row) => {
      row.scrollIntoView({ block: "nearest" });
      const r = row.getBoundingClientRect();
      const vb = viewport.getBoundingClientRect();
      const hit = document.elementFromPoint(
        Math.round(r.x + r.width / 2),
        Math.round(r.y + r.height / 2),
      );
      return {
        name: (row.textContent ?? "").slice(0, 40),
        insideViewport: r.top >= vb.top - 1 && r.bottom <= vb.bottom + 1,
        // The decisive one. A control parked outside a viewport nothing can
        // scroll has nothing painted at its own coordinates.
        pressAtItsCentreLandsOnIt: hit !== null && row.contains(hit),
      };
    });

    return { horizontal, reachable, scrollLeftAfterAll: viewport.scrollLeft };
  });

  expect(geometry.horizontal).toHaveLength(3);
  for (const row of geometry.horizontal) {
    expect(row.width, `${row.name} has no visible width`).toBeGreaterThan(0);
    expect(row.height, `${row.name} is not a usable target`).toBeGreaterThanOrEqual(44);
    expect(
      row.insideViewportHorizontally,
      `${row.name} sits outside the picker on the axis the user cannot scroll`,
    ).toBe(true);
  }
  for (const row of geometry.reachable) {
    expect(row.insideViewport, `${row.name} could not be brought into view`).toBe(true);
    expect(row.pressAtItsCentreLandsOnIt, `${row.name} cannot be pressed`).toBe(true);
  }
  // Nothing above needed a horizontal scroll, because nothing is out there.
  expect(geometry.scrollLeftAfterAll, "the picker scrolled sideways").toBe(0);

  // Drive it the way a person does: press the row, not a control inside it.
  await personRow(group, MERCER).click();
  await expect(
    group.getByRole("radio", { name: new RegExp(`^${MERCER}`) }),
  ).toBeChecked();

  // Selecting alone decides nothing; the commit names both sides of the link.
  const confirm = card.getByRole("button", { name: `Link ${MERCER_D} to ${MERCER}` });
  await expect(confirm).toBeVisible();
  await confirm.click();
  await expect(card).toBeHidden({ timeout: 15_000 });

  await closeManager(page);

  const options_ = await authorOptions(page);
  expect(options_).toContain(MERCER);
  expect(options_).not.toContain(MERCER_D);
});

test("the chooser stays usable when the keyboard is the only input", async ({ page }) => {
  // The row is a real radio in a real group, so arrow keys move and select
  // without any of it being reimplemented — and the row carrying focus is the
  // row that is drawn as focused, which only holds because the visually-hidden
  // control is positioned inside its own row.
  const dialog = await openManager(page);
  await createPersonFrom(dialog, PAPER_C);

  const card = await unresolvedCard(dialog, PAPER_E);
  await card
    .getByRole("button", { name: `Link ${EDITABLE_AUTHOR} to an existing person` })
    .click();

  const search = card.getByLabel(`Search people to link ${EDITABLE_AUTHOR} to`, {
    exact: true,
  });
  await search.focus();
  await page.keyboard.press("Tab");

  const focused = card.getByRole("radio", { name: new RegExp(`^${MERCER}`) });
  await expect(focused).toBeFocused();
  await expect(focused).not.toBeChecked();

  // Selecting from the keyboard is still only a selection.
  await page.keyboard.press("Space");
  await expect(focused).toBeChecked();

  const confirm = card.getByRole("button", { name: `Link ${EDITABLE_AUTHOR} to ${MERCER}` });
  await expect(confirm).toBeVisible();

  // And the focused row is where the user thinks it is, not scrolled away.
  const focusStaysInItsRow = await card.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    const row = active?.closest("label");
    if (!row) return false;
    const a = active!.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    return Math.abs(a.top - r.top) < r.height;
  });
  expect(focusStaysInItsRow, "focus escaped the row it belongs to").toBe(true);

  await card.getByRole("button", { name: /^Cancel$/ }).click();
  await expect(card.getByRole("radiogroup")).toHaveCount(0);
  await closeManager(page);
});

test("a manual override is offered, warned about, and reversible", async ({ page }) => {
  // The case the algorithm refuses on purpose: identical names, contradicting
  // ORCIDs. No suggestion is offered — and the person is still selectable by
  // hand, because the user may know which iD is wrong and Paperlume may not.
  const dialog = await openManager(page);
  await createPersonFrom(dialog, PAPER_C);

  const cardD = await unresolvedCard(dialog, PAPER_D);
  await expect(cardD.getByRole("button", { name: /^Link to / })).toHaveCount(0);

  await cardD.getByRole("button", { name: `Link ${MERCER_D} to an existing person` }).click();
  await personRow(cardD, MERCER).click();

  // Both iDs are stated so the user can check them. Neither is called wrong.
  await expect(cardD).toContainText(/Paperlume did not suggest this match/i);
  await expect(cardD).toContainText(/Continuing is your decision/i);

  // Cancelling writes nothing at all.
  await cardD.getByRole("button", { name: /^Cancel$/ }).click();
  await expect(
    cardD.getByRole("button", { name: `Link ${MERCER_D} to ${MERCER}` }),
  ).toHaveCount(0);
  await closeManager(page);
  expect(await authorOptions(page), "cancelling changed nothing").toContain(MERCER);

  // Committing the override groups them, and the conflict is then reported on
  // the person rather than hidden.
  const again = await openManager(page);
  const retry = await unresolvedCard(again, PAPER_D);
  await retry.getByRole("button", { name: `Link ${MERCER_D} to an existing person` }).click();
  await personRow(retry, MERCER).click();
  await retry.getByRole("button", { name: `Link ${MERCER_D} to ${MERCER}` }).click();
  await expect(retry).toBeHidden({ timeout: 15_000 });

  await again.getByRole("tab", { name: /People/ }).click();
  const conflictPanel = again.getByRole("tabpanel", { name: /People/ });
  // Contradictory evidence is stated on the compact row rather than hidden
  // behind a quiet ORCID badge that would imply agreement.
  await expect(personHeader(conflictPanel, MERCER)).toContainText("ORCID conflict");
  await openPerson(conflictPanel, MERCER);
  await expect(conflictPanel.getByText(/Linked papers state different ORCIDs/i)).toBeVisible();
  await closeManager(page);

  // One person now, where the algorithm alone would have left two.
  const options = await authorOptions(page);
  expect(options.filter((label) => label.startsWith("Alex R"))).toHaveLength(1);
});

test("any two people can be merged without a duplicate suggestion", async ({ page }) => {
  // Two people with no shared ORCID and no shared name key, so the duplicate
  // detector says nothing about them. The detector is an assistant, not the list
  // of merges the user is allowed to make.
  const dialog = await openManager(page);
  await createPersonFrom(dialog, PAPER_C);
  await createPersonFrom(dialog, PAPER_E);

  await dialog.getByRole("tab", { name: /Duplicates/ }).click();
  await expect(dialog.getByText(/No possible duplicates found/i)).toBeVisible();

  await dialog.getByRole("tab", { name: /People/ }).click();
  const peoplePanel = dialog.getByRole("tabpanel", { name: /People/ });
  await openPerson(peoplePanel, MERCER);
  await peoplePanel
    .getByRole("button", { name: `Merge ${MERCER} into another person` })
    .click();
  await personRow(peoplePanel, EDITABLE_AUTHOR).click();

  // Direction is explicit: the target's name becomes the group's name.
  await expect(peoplePanel).toContainText(`Merge ${MERCER} into ${EDITABLE_AUTHOR}.`);
  await peoplePanel
    .getByRole("button", { name: `Merge ${MERCER} into ${EDITABLE_AUTHOR}` })
    .click();
  // The source stops being its own person, so its row goes with it and nothing
  // is left open pointing at a person who is no longer in the list.
  await expect(personHeader(peoplePanel, MERCER)).toHaveCount(0, { timeout: 15_000 });
  await openPerson(peoplePanel, EDITABLE_AUTHOR);
  await expect(
    peoplePanel.getByRole("button", { name: `Undo merge of ${MERCER} into ${EDITABLE_AUTHOR}` }),
  ).toBeVisible({ timeout: 15_000 });
  await closeManager(page);

  // Analytics resolves the merged-away person through the root.
  const merged = await authorOptions(page);
  expect(merged).toContain(EDITABLE_AUTHOR);
  expect(merged).not.toContain(MERCER);

  // And undoing restores both, because nothing was moved.
  const undo = await openManager(page);
  await undo.getByRole("tab", { name: /People/ }).click();
  const undoMergePanel = undo.getByRole("tabpanel", { name: /People/ });
  await openPerson(undoMergePanel, EDITABLE_AUTHOR);
  await undoMergePanel
    .getByRole("button", { name: `Undo merge of ${MERCER} into ${EDITABLE_AUTHOR}` })
    .click();
  await expect(
    undoMergePanel.getByRole("button", { name: `Undo merge of ${MERCER} into ${EDITABLE_AUTHOR}` }),
  ).toBeHidden({ timeout: 15_000 });
  await closeManager(page);

  const restored = await authorOptions(page);
  expect(restored).toContain(MERCER);
  expect(restored).toContain(EDITABLE_AUTHOR);
});

test("one merge edge out of a chain is undone by name", async ({ page }) => {
  // `A → B → C` puts two merged members on one card. The user has to be able to
  // tell them apart and reverse exactly one — undoing the wrong edge silently
  // regroups their library.
  const dialog = await openManager(page);
  await createPersonFrom(dialog, PAPER_A);
  await createPersonFrom(dialog, PAPER_C);
  await createPersonFrom(dialog, PAPER_E);

  await dialog.getByRole("tab", { name: /People/ }).click();
  const peoplePanel = dialog.getByRole("tabpanel", { name: /People/ });

  // A into Mercer. The undo control lands on the TARGET's panel, so that is
  // the person opened to read it.
  await openPerson(peoplePanel, PERSON_A);
  await peoplePanel
    .getByRole("button", { name: `Merge ${PERSON_A} into another person` })
    .click();
  await personRow(peoplePanel, MERCER).click();
  await peoplePanel
    .getByRole("button", { name: `Merge ${PERSON_A} into ${MERCER}` })
    .click();
  await expect(personHeader(peoplePanel, PERSON_A)).toHaveCount(0, { timeout: 15_000 });
  await openPerson(peoplePanel, MERCER);
  await expect(
    peoplePanel.getByRole("button", { name: `Undo merge of ${PERSON_A} into ${MERCER}` }),
  ).toBeVisible({ timeout: 15_000 });

  // Mercer into Rewritten, which makes Rewritten the root of all three.
  await peoplePanel
    .getByRole("button", { name: `Merge ${MERCER} into another person` })
    .click();
  await personRow(peoplePanel, EDITABLE_AUTHOR).click();
  await peoplePanel
    .getByRole("button", { name: `Merge ${MERCER} into ${EDITABLE_AUTHOR}` })
    .click();
  await expect(personHeader(peoplePanel, MERCER)).toHaveCount(0, { timeout: 15_000 });
  await openPerson(peoplePanel, EDITABLE_AUTHOR);
  await expect(
    peoplePanel.getByRole("button", { name: `Undo merge of ${MERCER} into ${EDITABLE_AUTHOR}` }),
  ).toBeVisible({ timeout: 15_000 });

  // Two undo controls on one card, each naming its own edge rather than reading
  // "Undo one merge" twice over.
  const undoA = peoplePanel.getByRole("button", {
    name: `Undo merge of ${PERSON_A} into ${MERCER}`,
  });
  const undoMercer = peoplePanel.getByRole("button", {
    name: `Undo merge of ${MERCER} into ${EDITABLE_AUTHOR}`,
  });
  await expect(undoA).toBeVisible();
  await expect(undoMercer).toBeVisible();
  // Both on one panel — the compaction did not split a person in two.

  // Reverse A's edge only. Mercer must stay merged into Rewritten.
  await undoA.click();
  await expect(undoA).toBeHidden({ timeout: 15_000 });
  await expect(undoMercer).toBeVisible();
  await closeManager(page);

  const options = await authorOptions(page);
  expect(options, "A is independent again").toContain(PERSON_A);
  expect(options, "the rest of the chain still stands").toContain(EDITABLE_AUTHOR);
  expect(options).not.toContain(MERCER);
});

test("a failed identity read is reported, not disguised as 001A grouping", async ({
  page,
}) => {
  // The dangerous case: identity data that FAILS to load looks exactly like
  // identity data that is not installed, and both leave Analytics grouping
  // authors by name. A user who resolved two spellings into one person would
  // watch them split apart and be told nothing.
  const dialog = await openManager(page);
  await createPersonFrom(dialog, PAPER_A);
  const linkCard = await unresolvedCard(dialog, PAPER_B);
  await linkCard.getByRole("button", { name: new RegExp(`Link to ${PERSON_A}`) }).click();
  await expect(linkCard).toBeHidden({ timeout: 15_000 });
  await closeManager(page);

  // Both spellings are one person right now.
  const grouped = await authorOptions(page);
  expect(grouped).toContain(PERSON_A);
  expect(grouped).not.toContain(PERSON_B);

  // Now make the identity read genuinely fail, and reload into that state.
  const identityRoute = "**/rest/v1/author_identities*";
  await page.route(identityRoute, (route) => route.abort("failed"));
  await page.reload();
  await waitForDashboard(page);
  await openAnalytics(page);

  // Analytics says so rather than quietly reverting to name grouping.
  await expect(page.getByText(/Author identities could not be loaded/i)).toBeVisible({
    timeout: 15_000,
  });
  await expect(
    page.getByText(/someone you resolved may appear more than once/i),
  ).toBeVisible();

  // The unaffected analytics keep working.
  await expect(page.getByRole("button", { name: /^Target Keywords/ })).toBeVisible();

  // The manager reports the failure too — and offers nothing to edit, because
  // nothing may be written against a graph that did not load.
  const failedDialog = await openManager(page);
  await expect(failedDialog.getByText(/could not be loaded/i)).toBeVisible();
  await expect(failedDialog.getByRole("tab")).toHaveCount(0);
  await expect(
    failedDialog.getByText(/not available in this environment yet/i),
  ).toHaveCount(0);

  // Retry restores the real thing.
  await page.unroute(identityRoute);
  await failedDialog.getByRole("button", { name: "Try again" }).click();
  await expect(failedDialog.getByRole("tab", { name: /People/ })).toBeVisible({
    timeout: 15_000,
  });
  await closeManager(page);

  const restored = await authorOptions(page);
  expect(restored, "the person is back once the read succeeds").toContain(PERSON_A);
  expect(restored).not.toContain(PERSON_B);
});

test("two people with the same name give distinguishable merge actions", async ({
  page,
}) => {
  // An exact shared name is itself duplicate evidence, so this tab is exactly
  // where two legitimately same-named people meet. Two buttons both reading
  // "Merge into Stuart M Phillips" would ask the user to pick blind between the
  // two records whose fate they are deciding.
  const dialog = await openManager(page);
  await createPersonFrom(dialog, PAPER_A);
  await createPersonFrom(dialog, PAPER_B);

  // Rename the second so both people are called the same thing — which nothing
  // prevents, and which the product deliberately allows.
  await dialog.getByRole("tab", { name: /People/ }).click();
  const renamePanel = dialog.getByRole("tabpanel", { name: /People/ });
  await openPerson(renamePanel, PERSON_B);
  const secondName = renamePanel.getByLabel(`Name for ${PERSON_B}`, { exact: true });
  await secondName.fill(PERSON_A);
  await secondName.blur();
  // Two rows now carrying the same name — and still two distinguishable rows,
  // because each states its own evidence rather than the name alone.
  const sameName = renamePanel.locator("button[aria-expanded]").filter({ hasText: PERSON_A });
  await expect(sameName).toHaveCount(2, { timeout: 15_000 });
  const rowNames = await sameName.evaluateAll((nodes) =>
    nodes.map((node) => (node.textContent ?? "").trim()),
  );
  expect(new Set(rowNames).size, "same-name rows must be tellable apart").toBe(2);
  for (const rowName of rowNames) {
    expect(rowName).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  }
  // The renamed person stayed open: a person who changes their name is the same
  // person, and the row is keyed by identity rather than by label. Asserted on
  // the count, because by now the NAME no longer identifies a row.
  await expect(renamePanel.locator('button[aria-expanded="true"]')).toHaveCount(1);
  await expect(renamePanel.getByLabel(new RegExp(`^Name for ${PERSON_A}`))).toHaveCount(1);

  await dialog.getByRole("tab", { name: /Duplicates/ }).click();
  const merges = dialog
    .getByRole("tabpanel", { name: /Duplicates/ })
    .getByRole("button", { name: /^Merge / });
  await expect(merges).toHaveCount(2);

  const labels = await merges.evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("aria-label") ?? ""),
  );
  expect(new Set(labels).size, "both directions must be distinguishable").toBe(2);
  // Each names BOTH ends, so direction never has to be inferred from DOM order,
  // and neither falls back to a UUID.
  for (const label of labels) {
    expect(label).toMatch(/ into /);
    expect(label).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  }

  // The visible text distinguishes them too, not only the accessible name.
  const visible = await merges.allTextContents();
  expect(new Set(visible).size).toBe(2);

  await merges.first().click();
  await expect(dialog.getByRole("tab", { name: /Duplicates \(0\)/ })).toBeVisible({
    timeout: 15_000,
  });
  await closeManager(page);

  // One person now, and undoing names the exact edge that was made.
  const undo = await openManager(page);
  await undo.getByRole("tab", { name: /People/ }).click();
  const undoNamePanel = undo.getByRole("tabpanel", { name: /People/ });
  await openPerson(undoNamePanel, PERSON_A);
  await expect(undoNamePanel.getByRole("button", { name: /^Undo merge of / })).toHaveCount(1);
  await closeManager(page);
});

test("an alias is added and removed by the row it names", async ({ page }) => {
  // The alias path is the one place where a name is NOT a key: two rows may
  // carry the same words, so removal has to identify the row. A UI that removed
  // "by text" would delete nothing and leave the name on screen, which is
  // exactly what this asserts does not happen.
  const dialog = await openManager(page);
  await createPersonFrom(dialog, PAPER_A);

  await dialog.getByRole("tab", { name: /People/ }).click();
  const panel = dialog.getByRole("tabpanel", { name: /People/ });
  await expect(panel).toBeVisible();
  await openPerson(panel, PERSON_A);
  await expect(panel.getByText(/No other names recorded/i)).toBeVisible();

  await panel.getByLabel(`Add another name for ${PERSON_A}`).fill(PERSON_B);
  await panel.getByRole("button", { name: /^Add$/ }).click();
  await expect(panel.getByRole("button", { name: `Remove alias ${PERSON_B}` })).toBeVisible({
    timeout: 15_000,
  });
  // The compact row recounts itself, and the person stays open through it.
  await expect(personHeader(panel, PERSON_A)).toContainText("1 alias");
  await expect(personHeader(panel, PERSON_A)).toHaveAttribute("aria-expanded", "true");
  await closeManager(page);

  // The alias makes the person findable by a name no linked mention supplies.
  const forSearch = await openManager(page);
  await forSearch.getByRole("tab", { name: /People/ }).click();
  const searchPanel = forSearch.getByRole("tabpanel", { name: /People/ });
  // The alias makes the person findable by a name no linked mention supplies —
  // 001C's approved matching, reached from the People tab's own search.
  await searchPanel.getByLabel("Search people").fill(PERSON_B);
  await expect(personHeader(searchPanel, PERSON_A)).toBeVisible();
  await searchPanel.getByLabel("Search people").fill("");

  await openPerson(searchPanel, PERSON_A);
  await searchPanel.getByRole("button", { name: `Remove alias ${PERSON_B}` }).click();
  await expect(
    searchPanel.getByText(/No other names recorded/i),
    "removing an alias must actually delete its row",
  ).toBeVisible({ timeout: 15_000 });
  await closeManager(page);
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
  const notesPanel = afterNotes.getByRole("tabpanel", { name: /People/ });
  await expect(notesPanel).toBeVisible();
  await openPerson(notesPanel, EDITABLE_AUTHOR);
  await expect(
    notesPanel.getByText(/Linked mentions \(1\)/),
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
  const authorsPanel = afterAuthors.getByRole("tabpanel", { name: /People/ });
  await expect(authorsPanel).toBeVisible();
  // A person with nothing left attached keeps their row, and says so.
  await expect(personHeader(authorsPanel, EDITABLE_AUTHOR)).toContainText(
    "0 linked mentions",
    { timeout: 15_000 },
  );
  await openPerson(authorsPanel, EDITABLE_AUTHOR);
  await expect(
    authorsPanel.getByText(/Nothing is linked to this person/i),
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

/**
 * Every disclosure header, and every Unlink inside whatever is open.
 *
 * Measured the way PR #233 taught: containment on the axis the user cannot
 * scroll, and a hit test at the point they would actually press. `toBeVisible()`
 * is true for a control parked outside a viewport with no horizontal scrollbar,
 * and so is `.click()`, which scrolls there programmatically first.
 */
async function peopleGeometry(panel: ReturnType<Page["getByRole"]>) {
  return panel.evaluate((node) => {
    const viewport = node.querySelector(
      "[data-radix-scroll-area-viewport]",
    ) as HTMLElement;
    const box = (el: Element) => el.getBoundingClientRect();
    const vb = box(viewport);

    const measure = (el: HTMLElement) => {
      // Vertical scrolling is something a person has here — a scrollbar and a
      // wheel — so a row below the fold is reached the way they would reach it.
      el.scrollIntoView({ block: "nearest" });
      const r = box(el);
      const hit = document.elementFromPoint(
        Math.round(r.x + r.width / 2),
        Math.round(r.y + r.height / 2),
      );
      return {
        name: (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40),
        height: Math.round(r.height),
        insideHorizontally: r.left >= vb.left - 1 && r.right <= vb.right + 1,
        insideVertically: r.top >= vb.top - 1 && r.bottom <= vb.bottom + 1,
        pressAtItsCentreLandsOnIt: hit !== null && el.contains(hit),
      };
    };

    const headers = [...viewport.querySelectorAll("button[aria-expanded]")] as HTMLElement[];
    const unlinks = ([...viewport.querySelectorAll("button")] as HTMLElement[]).filter(
      (button) => button.textContent?.trim() === "Unlink",
    );

    return {
      overflow: [node, viewport].map((el) => ({
        cls: el.className.toString().slice(0, 40),
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
      })),
      documentOverflow: {
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      },
      headers: headers.map(measure),
      unlinks: unlinks.map(measure),
      // Nothing above needed a sideways scroll, because nothing is out there.
      scrollLeft: viewport.scrollLeft,
    };
  });
}

function expectReachable(
  geometry: Awaited<ReturnType<typeof peopleGeometry>>,
  where: string,
) {
  for (const el of geometry.overflow) {
    expect(
      el.scrollWidth,
      `horizontal overflow in ${el.cls} at ${where}`,
    ).toBeLessThanOrEqual(el.clientWidth);
  }
  expect(
    geometry.documentOverflow.scrollWidth,
    `the page itself overflows sideways at ${where}`,
  ).toBeLessThanOrEqual(geometry.documentOverflow.clientWidth);

  for (const row of [...geometry.headers, ...geometry.unlinks]) {
    expect(row.insideHorizontally, `${row.name} is out of reach sideways at ${where}`).toBe(true);
    expect(row.insideVertically, `${row.name} could not be brought into view at ${where}`).toBe(true);
    expect(row.pressAtItsCentreLandsOnIt, `${row.name} cannot be pressed at ${where}`).toBe(true);
  }
  for (const header of geometry.headers) {
    expect(header.height, `${header.name} is not a usable target at ${where}`).toBeGreaterThanOrEqual(44);
  }
  expect(geometry.scrollLeft, `the People list scrolled sideways at ${where}`).toBe(0);
}

test("the People list opens compact and opens one person at a time", async ({ page }) => {
  /*
   * AUTHOR-IDENTITY-PEOPLE-LIST-COMPACTION-001 — the owner opened People on a
   * real library and found one prolific author taller than the whole dialog,
   * because every person's mentions, aliases, alias editor and merge control
   * were rendered at once. What follows is the contract that replaced it: a row
   * per person, nothing but rows until one is asked for, and one at a time.
   */
  const dialog = await openManager(page);
  await createPersonFrom(dialog, PAPER_A);
  await createPersonFrom(dialog, PAPER_C);
  await createPersonFrom(dialog, PAPER_E);

  await dialog.getByRole("tab", { name: /People/ }).click();
  const panel = dialog.getByRole("tabpanel", { name: /People/ });
  await expect(panel).toBeVisible();

  const headers = panel.locator("button[aria-expanded]");
  await expect(headers).toHaveCount(3);
  await expect(panel.locator('button[aria-expanded="true"]')).toHaveCount(0);

  // Not hidden — absent. This is the compaction: three people's management
  // bodies are not in the document at all.
  await expect(panel.getByRole("button", { name: /^Unlink$/ })).toHaveCount(0);
  await expect(panel.getByLabel(/^Name for /)).toHaveCount(0);
  await expect(panel.getByRole("button", { name: /into another person/ })).toHaveCount(0);

  // Each row states who and how much, so the list can be read without opening
  // anything.
  await expect(personHeader(panel, PERSON_A)).toContainText("1 linked mention");
  await expect(personHeader(panel, MERCER)).toContainText("1 linked mention");
  await expect(personHeader(panel, EDITABLE_AUTHOR)).toContainText("1 linked mention");

  expectReachable(await peopleGeometry(panel), "1280×720, all collapsed");

  // The whole row is the control. Opening the second closes the first.
  await openPerson(panel, PERSON_A);
  await expect(panel.getByLabel(`Name for ${PERSON_A}`, { exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: /^Unlink$/ })).toHaveCount(1);

  await openPerson(panel, MERCER);
  await expect(personHeader(panel, PERSON_A)).toHaveAttribute("aria-expanded", "false");
  await expect(panel.getByLabel(`Name for ${PERSON_A}`, { exact: true })).toHaveCount(0);
  await expect(panel.getByLabel(`Name for ${MERCER}`, { exact: true })).toBeVisible();

  expectReachable(await peopleGeometry(panel), "1280×720, one person open");

  // Pressing the open row closes it, leaving the list fully compact again.
  await personHeader(panel, MERCER).click();
  await expect(panel.locator('button[aria-expanded="true"]')).toHaveCount(0);
  await expect(panel.getByRole("button", { name: /^Unlink$/ })).toHaveCount(0);

  // The People tab's own search, on 001C's approved evidence and nothing looser.
  await panel.getByLabel("Search people").fill(MERCER);
  await expect(headers).toHaveCount(1);
  await expect(personHeader(panel, MERCER)).toBeVisible();
  await panel.getByLabel("Search people").fill("");
  await expect(headers).toHaveCount(3);

  await closeManager(page);
});

test("the compact People list is reachable on a phone-sized screen", async ({ page }) => {
  // Its own flow rather than a resize mid-test: Analytics is a desktop inline
  // panel, so narrowing the window unmounts it and the dialog inside it.
  // A phone is where a stranded control is the same defect and where a chevron
  // at the end of a row would be the whole target.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/", { waitUntil: "networkidle" });
  await waitForDashboard(page);

  // On a phone the library actions live behind a menu and Analytics is a sheet,
  // so this is the route a person actually takes to the manager.
  await page.getByRole("button", { name: "More library actions" }).click();
  const actions = page.getByRole("dialog", { name: "Library actions" });
  await expect(actions).toBeVisible();
  await actions.getByRole("button", { name: /Analytics & Insights/ }).click();
  await expect(page.getByRole("dialog", { name: /Analytics & Insights/ })).toBeVisible();

  const dialog = await openManager(page);
  await createPersonFrom(dialog, PAPER_A);
  await createPersonFrom(dialog, PAPER_C);

  await dialog.getByRole("tab", { name: /People/ }).click();
  const panel = dialog.getByRole("tabpanel", { name: /People/ });
  await expect(panel.locator("button[aria-expanded]")).toHaveCount(2);

  expectReachable(await peopleGeometry(panel), "390×844, all collapsed");

  await openPerson(panel, PERSON_A);
  await expect(panel.getByRole("button", { name: /^Unlink$/ })).toHaveCount(1);
  expectReachable(await peopleGeometry(panel), "390×844, one person open");

  // The alias controls and the merge action are reachable too, not only the
  // header that opened them.
  await expect(panel.getByLabel(`Add another name for ${PERSON_A}`)).toBeVisible();
  const merge = panel.getByRole("button", { name: `Merge ${PERSON_A} into another person` });
  await expect(merge).toBeVisible();
  const mergeReach = await merge.evaluate((el) => {
    const viewport = el.closest("[data-radix-scroll-area-viewport]") as HTMLElement;
    el.scrollIntoView({ block: "nearest" });
    const r = el.getBoundingClientRect();
    const vb = viewport.getBoundingClientRect();
    const hit = document.elementFromPoint(
      Math.round(r.x + r.width / 2),
      Math.round(r.y + r.height / 2),
    );
    return {
      inside: r.left >= vb.left - 1 && r.right <= vb.right + 1,
      pressed: hit !== null && el.contains(hit),
      scrollLeft: viewport.scrollLeft,
    };
  });
  expect(mergeReach.inside, "the merge action is out of reach sideways on a phone").toBe(true);
  expect(mergeReach.pressed, "the merge action cannot be pressed on a phone").toBe(true);
  expect(mergeReach.scrollLeft, "the People list scrolled sideways on a phone").toBe(0);

  await closeManager(page);
});

test("a long linked-mention list is capped until the user asks for it", async ({
  page,
}) => {
  // Six mentions on one person: more than the panel shows, which is the case a
  // prolific author reaches immediately and the reason this list is capped.
  test.setTimeout(120_000);

  const dialog = await openManager(page);
  await createPersonFrom(dialog, PAPER_A);

  for (let n = 1; n <= 5; n += 1) {
    const title = `E2E Primary Paper ${String(n).padStart(3, "0")}`;
    const mention = `Author A${n}`;
    await dialog.getByLabel("Search unresolved author mentions").fill(title);
    // These papers carry two authors each, so the file's rule applies twice
    // over: assert on the COUNT, never on the clicked card. `.first()` is a live
    // locator and re-resolves to the paper's OTHER mention the moment this one
    // is resolved, so "the card I clicked is gone" would never become true.
    const cards = dialog.locator("li").filter({ hasText: title });
    await expect(cards).toHaveCount(2);
    const card = cards.first();
    await card.getByRole("button", { name: `Link ${mention} to an existing person` }).click();
    await personRow(card, PERSON_A).click();
    await card.getByRole("button", { name: `Link ${mention} to ${PERSON_A}` }).click();
    await expect(cards).toHaveCount(1, { timeout: 15_000 });
  }

  await dialog.getByRole("tab", { name: /People/ }).click();
  const panel = dialog.getByRole("tabpanel", { name: /People/ });
  await expect(personHeader(panel, PERSON_A)).toContainText("6 linked mentions", {
    timeout: 15_000,
  });

  await openPerson(panel, PERSON_A);

  // The count is the truth; five is what is rendered.
  await expect(panel.getByText("Linked mentions (6)")).toBeVisible();
  const unlinks = panel.getByRole("button", { name: /^Unlink$/ });
  await expect(unlinks).toHaveCount(5);

  const showAll = panel.getByRole("button", { name: "Show all 6 linked mentions" });
  await expect(showAll).toBeVisible();
  await showAll.click();
  await expect(unlinks).toHaveCount(6);

  // Every one of them is a control a person can actually press — six rows is
  // where a list that widens itself would strand the last of them.
  expectReachable(await peopleGeometry(panel), "1280×720, six mentions shown");

  await panel.getByRole("button", { name: "Show fewer" }).click();
  await expect(unlinks).toHaveCount(5);

  // Closing and reopening starts from the compact view again, rather than
  // remembering an expansion the user made several people ago.
  await personHeader(panel, PERSON_A).click();
  await openPerson(panel, PERSON_A);
  await expect(unlinks).toHaveCount(5);
  await expect(panel.getByRole("button", { name: "Show all 6 linked mentions" })).toBeVisible();

  await closeManager(page);
});
