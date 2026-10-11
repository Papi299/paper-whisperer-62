import { test, expect, type Locator, type Page } from "@playwright/test";
import { waitForDashboard } from "./helpers";

/**
 * EVIDENCE-MATRIX-001B — the read-only multi-paper comparison, end to end.
 *
 * This is the first real-browser run of the 001A read model: the comparison
 * GET goes to the local Data API as the signed-in primary fixture, under RLS.
 *
 * Mutating only within fixtures it owns. `beforeAll` sweeps and then inserts
 * five synthetic `CMP-E2E` papers through the app's own client (so as the
 * signed-in user, under RLS), and `afterAll` removes every `CMP-E2E` paper
 * through `delete_papers_with_attachment_cleanup` (direct DELETE on `papers`
 * is revoked). One test deletes one of them on purpose, to show an unavailable
 * paper. The seeded papers are only ever selected, never written. No Edge
 * Function, AI provider or Storage call is made or needed.
 *
 * Seeded selections come from year filters (the seed's year is 2000 + n % 25):
 * 2001–2002 is exactly 10 papers, 2000–2002 exactly 14. The fixtures use years
 * 1990–1993, which no seeded paper has.
 */

const CLIENT_MODULE_PATH = "/src/integrations/supabase/client.ts";
const FIXTURE_PREFIX = "CMP-E2E";

const ALPHA = `${FIXTURE_PREFIX} Alpha trial`;
const BETA = `${FIXTURE_PREFIX} Beta cohort`;
const DUPLICATE = `${FIXTURE_PREFIX} Duplicate title`;
const VANISHING = `${FIXTURE_PREFIX} Vanishing paper`;

const ABSTRACT_END = "END-OF-STORED-ABSTRACT";
/** One stored term with no break opportunity at all: it must wrap, not widen a phone card. */
const UNBROKEN_SUBSTANCE = "SyntheticCompoundIdentifierWithoutAnyBreakOpportunity0000000001";
const LONG_ABSTRACT = `Background: ${"A synthetic sentence about compound A in adults. ".repeat(60)}${ABSTRACT_END}`;

const PHONE_SMALL = { width: 320, height: 568 };
const PHONE = { width: 390, height: 844 };
const PHONE_LANDSCAPE = { width: 568, height: 320 };
const TABLET_PORTRAIT = { width: 768, height: 1024 };
const TABLET_LANDSCAPE = { width: 1024, height: 768 };
const DESKTOP = { width: 1280, height: 720 };

type Viewport = { width: number; height: number };

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** The comparison projection's attachment embed, which no other read selects. */
const COMPARISON_EMBED = "paper_attachments(id,paper_id,user_id,file_type)";

/**
 * Every list column is an array, as every import path writes it: the library
 * table (not the comparison) assumes `authors` is never NULL.
 */
const EMPTY_LISTS = { authors: [], keywords: [], raw_keywords: [], mesh_terms: [], substances: [] };

function fixtureRows(userId: string) {
  return [
    {
      user_id: userId,
      title: ALPHA,
      // More than six, so the Authors column carries a "Show all" control.
      authors: ["Synthetic A", "Synthetic B", "Synthetic C", "Synthetic D", "Synthetic E", "Synthetic F", "Synthetic G", "Synthetic H"],
      year: 1993,
      journal: "Journal of Comparison Fixtures",
      pmid: "900000401",
      doi: "10.5555/cmp-e2e.0001",
      abstract: LONG_ABSTRACT,
      study_type: "Randomized Controlled Trial",
      raw_study_type: "Randomized Controlled Trial",
      raw_publication_types: ["Randomized Controlled Trial", "Clinical Trial, Phase II"],
      statistical_methods: "Mixed-effects model",
      tldr: "Synthetic TL;DR for the alpha fixture.",
      notes: "Synthetic note for the alpha fixture.",
      keywords: ["compound A"],
      raw_keywords: ["Compound A"],
      mesh_terms: ["Humans", "Adult", "Neoplasms, Experimental"],
      substances: ["Compound A", UNBROKEN_SUBSTANCE],
    },
    {
      ...EMPTY_LISTS,
      user_id: userId,
      title: BETA,
      authors: ["Synthetic D"],
      year: 1991,
      journal: "Journal of Cohort Fixtures",
      abstract: "Short synthetic abstract.",
      tldr: "Not specified",
    },
    { ...EMPTY_LISTS, user_id: userId, title: DUPLICATE, authors: ["Synthetic E"], year: 1992, journal: "Journal X" },
    { ...EMPTY_LISTS, user_id: userId, title: DUPLICATE, authors: ["Synthetic F"], year: 1990, journal: "Journal Y" },
    { ...EMPTY_LISTS, user_id: userId, title: VANISHING, authors: ["Synthetic G"], year: 1992, journal: "Journal Z" },
  ];
}

interface Fixtures {
  userId: string;
  ids: Record<string, string[]>;
}

/** Sweep any `CMP-E2E` papers, then (unless `create` is false) insert the fixtures. */
async function resetFixtures(page: Page, create: boolean): Promise<Fixtures | null> {
  return page.evaluate(
    async ({ modPath, prefix, rows, create }) => {
      const { supabase } = (await import(modPath)) as {
        supabase: {
          auth: { getUser: () => Promise<{ data: { user: { id: string } | null } }> };
          from: (table: string) => {
            select: (columns: string) => { ilike: (column: string, pattern: string) => Promise<{ data: { id: string }[] | null; error: unknown }> };
            insert: (rows: unknown[]) => { select: (columns: string) => Promise<{ data: { id: string; title: string }[] | null; error: unknown }> };
          };
          rpc: (name: string, args: unknown) => Promise<{ error: unknown }>;
        };
      };
      const { data: auth } = await supabase.auth.getUser();
      if (!auth.user) throw new Error("not signed in");
      const existing = await supabase.from("papers").select("id").ilike("title", `${prefix}%`);
      if (existing.error) throw new Error(`fixture sweep read failed: ${JSON.stringify(existing.error)}`);
      if (existing.data && existing.data.length > 0) {
        const { error } = await supabase.rpc("delete_papers_with_attachment_cleanup", {
          p_paper_ids: existing.data.map((row) => row.id),
        });
        if (error) throw new Error(`fixture sweep failed: ${JSON.stringify(error)}`);
      }
      if (!create) return null;
      const inserted = await supabase
        .from("papers")
        .insert(rows.map((row) => ({ ...row, user_id: auth.user!.id })))
        .select("id, title");
      if (inserted.error || !inserted.data) throw new Error(`fixture insert failed: ${JSON.stringify(inserted.error)}`);
      const ids: Record<string, string[]> = {};
      for (const row of inserted.data) (ids[row.title] ??= []).push(row.id);
      return { userId: auth.user.id, ids };
    },
    { modPath: CLIENT_MODULE_PATH, prefix: FIXTURE_PREFIX, rows: fixtureRows("placeholder"), create },
  );
}

let fixtures: Fixtures;

/**
 * Fixture setup and teardown run through the app's client module only; they
 * do not wait for the Dashboard to render, so a library the Dashboard cannot
 * show can still be cleaned up.
 */
async function withSignedInPage<T>(browser: import("@playwright/test").Browser, run: (page: Page) => Promise<T>) {
  const context = await browser.newContext({ storageState: "e2e/.auth/user.json" });
  const page = await context.newPage();
  try {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    return await run(page);
  } finally {
    await context.close();
  }
}

test.beforeAll(async ({ browser }) => {
  fixtures = (await withSignedInPage(browser, (page) => resetFixtures(page, true)))!;
});

test.afterAll(async ({ browser }) => {
  await withSignedInPage(browser, (page) => resetFixtures(page, false));
});

/**
 * Every comparison read, and anything the comparison must never cause: an Edge
 * Function (so an AI provider), an RPC, Storage, or a write to the Data API.
 * Start it only once the selection is made; it watches the comparison window.
 */
function watchNetwork(page: Page) {
  const comparisonReads: string[] = [];
  const forbidden: string[] = [];
  const onRequest = (request: import("@playwright/test").Request) => {
    const url = decodeURIComponent(request.url());
    if (url.includes("/rest/v1/papers?") && url.includes(COMPARISON_EMBED)) comparisonReads.push(url);
    // The comparison is one plain SELECT; no RPC — read or write — belongs to it.
    if (url.includes("/rest/v1/rpc/")) forbidden.push(`${request.method()} ${url.split("?")[0]}`);
    if (url.includes("/functions/v1/") || url.includes("/storage/v1/")) forbidden.push(`${request.method()} ${url}`);
    if (url.includes("/rest/v1/") && !url.includes("/rest/v1/rpc/") && !["GET", "HEAD", "OPTIONS"].includes(request.method())) {
      forbidden.push(`${request.method()} ${url}`);
    }
  };
  page.on("request", onRequest);
  return { comparisonReads, forbidden, stop: () => page.off("request", onRequest) };
}

async function openDashboard(page: Page, viewport: Viewport) {
  await page.setViewportSize(viewport);
  await page.goto("/", { waitUntil: "networkidle" });
  await waitForDashboard(page);
}

/** Select a row by keyboard (a sticky header can sit over the first row in a short viewport). */
async function selectRow(page: Page, title: string, nth = 0) {
  const checkbox = page.getByRole("checkbox", { name: `Select ${title}`, exact: true }).nth(nth);
  await checkbox.focus();
  await page.keyboard.press("Space");
  await expect(checkbox).toBeChecked();
}

function toolbar(page: Page) {
  return page.getByRole("region", { name: "Bulk actions" });
}

function compareButton(page: Page) {
  return toolbar(page).getByRole("button", { name: "Compare", exact: true });
}

function comparisonDialog(page: Page) {
  return page.getByRole("dialog", { name: "Compare papers" });
}

/** Wait for the dialog's open animation to finish, so geometry is measured at rest. */
async function openedDialog(page: Page, papers: number) {
  const dialog = comparisonDialog(page);
  await expect(dialog).toBeVisible();
  await dialog.evaluate((el) => Promise.all(el.getAnimations().map((animation) => animation.finished)));
  await expect(dialog.getByRole("status")).toHaveText(new RegExp(`^Comparing ${papers} papers\\.`));
  return dialog;
}

/** Row header titles (matrix) or card headings (cards), in display order. */
async function shownTitles(dialog: Locator) {
  const headers = dialog.locator("th[scope=row] [id$='-title'], article h3");
  return headers.evaluateAll((elements) => elements.map((el) => (el.textContent ?? "").trim()));
}

async function expectNoUuidIn(dialog: Locator) {
  expect(await dialog.evaluate((el) => el.outerHTML), "no paper id reaches the page").not.toMatch(UUID);
}

/** No document-level sideways scroll, and the dialog inside the viewport. */
async function expectDialogContained(page: Page, dialog: Locator, where: string) {
  const m = await dialog.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return {
      left: r.left,
      right: r.right,
      top: r.top,
      bottom: r.bottom,
      vw: document.documentElement.clientWidth,
      vh: document.documentElement.clientHeight,
      dialogOverflowX: el.scrollWidth - el.clientWidth,
      docOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  expect(m.left, `${where}: dialog left`).toBeGreaterThanOrEqual(0);
  expect(m.right, `${where}: dialog right`).toBeLessThanOrEqual(m.vw + 0.5);
  expect(m.top, `${where}: dialog top`).toBeGreaterThanOrEqual(0);
  expect(m.bottom, `${where}: dialog bottom`).toBeLessThanOrEqual(m.vh + 0.5);
  expect(m.dialogOverflowX, `${where}: nothing overflows the dialog sideways`).toBeLessThanOrEqual(0);
  expect(m.docOverflowX, `${where}: no document-level horizontal scroll`).toBeLessThanOrEqual(0);
}

/**
 * Nothing inside the dialog scrolls sideways: no scroll container in it (the
 * dialog, its body, a card) is wider inside than out. `skip` names a container
 * that may scroll on purpose — the matrix's labelled tab panel.
 */
async function expectNoSidewaysScrollInside(dialog: Locator, where: string, skip?: string) {
  const overflowing = await dialog.evaluate((root, skipSelector) => {
    const found: string[] = [];
    for (const el of [root, ...Array.from(root.querySelectorAll<HTMLElement>("*"))]) {
      if (skipSelector && el.matches(skipSelector)) continue;
      const style = getComputedStyle(el);
      // Visually hidden text (a 1px box clipped to nothing) is not a scroller anyone sees.
      if (el.clientWidth <= 1 && style.position === "absolute") continue;
      const scrolls = style.overflowX !== "visible" || style.overflowY !== "visible";
      if (scrolls && el.scrollWidth > el.clientWidth + 0.5) {
        found.push(`${el.tagName.toLowerCase()}.${el.className.toString().slice(0, 40)} ${el.scrollWidth}>${el.clientWidth}`);
      }
    }
    return found;
  }, skip ?? null);
  expect(overflowing, `${where}: no sideways scroll inside the dialog`).toEqual([]);
}

/** Inside the viewport and every clipping ancestor, and owning the point at its centre. */
async function expectReachable(control: Locator, where: string, minSize = 0) {
  const p = await control.evaluate((el) => {
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
    const r = el.getBoundingClientRect();
    let clip = { left: 0, top: 0, right: document.documentElement.clientWidth, bottom: document.documentElement.clientHeight };
    for (let n = el.parentElement; n; n = n.parentElement) {
      const style = getComputedStyle(n);
      if (style.display !== "contents" && (style.overflowX !== "visible" || style.overflowY !== "visible")) {
        const c = n.getBoundingClientRect();
        clip = {
          left: Math.max(clip.left, c.left + n.clientLeft),
          top: Math.max(clip.top, c.top + n.clientTop),
          right: Math.min(clip.right, c.left + n.clientLeft + n.clientWidth),
          bottom: Math.min(clip.bottom, c.top + n.clientTop + n.clientHeight),
        };
      }
      if (style.position === "fixed") break;
    }
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      name: (el.textContent ?? "").trim().slice(0, 40),
      width: r.width,
      height: r.height,
      clippedPx: Math.max(0, clip.left - r.left, r.right - clip.right, clip.top - r.top, r.bottom - clip.bottom),
      ownsCentre: !!hit && el.contains(hit),
    };
  });
  expect(p.clippedPx, `${where}: "${p.name}" is not clipped`).toBeLessThanOrEqual(0.5);
  expect(p.ownsCentre, `${where}: "${p.name}" owns the point at its centre`).toBe(true);
  if (minSize > 0) {
    expect(p.width, `${where}: "${p.name}" target width`).toBeGreaterThanOrEqual(minSize);
    expect(p.height, `${where}: "${p.name}" target height`).toBeGreaterThanOrEqual(minSize);
  }
}

/**
 * The last words of a long stored text, once expanded, are on screen and not
 * clipped by any scroll container: the reader can actually get to the end.
 */
async function expectTextEndReadable(text: Locator, marker: string, where: string) {
  const p = await text.evaluate((el, marker) => {
    el.scrollIntoView({ block: "end", inline: "nearest" });
    const node = Array.from(el.childNodes).find((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").includes(marker));
    if (!node) return null;
    const start = (node.textContent ?? "").lastIndexOf(marker);
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, start + marker.length);
    const r = range.getBoundingClientRect();
    let clip = { left: 0, top: 0, right: document.documentElement.clientWidth, bottom: document.documentElement.clientHeight };
    for (let n = el.parentElement; n; n = n.parentElement) {
      const style = getComputedStyle(n);
      if (style.overflowX !== "visible" || style.overflowY !== "visible") {
        const c = n.getBoundingClientRect();
        clip = {
          left: Math.max(clip.left, c.left + n.clientLeft),
          top: Math.max(clip.top, c.top + n.clientTop),
          right: Math.min(clip.right, c.left + n.clientLeft + n.clientWidth),
          bottom: Math.min(clip.bottom, c.top + n.clientTop + n.clientHeight),
        };
      }
      if (style.position === "fixed") break;
    }
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      clippedPx: Math.max(0, clip.left - r.left, r.right - clip.right, clip.top - r.top, r.bottom - clip.bottom),
      ownsCentre: !!hit && el.contains(hit),
      clamped: el.scrollHeight > el.clientHeight + 1,
    };
  }, marker);
  expect(p, `${where}: the stored text contains its last words`).not.toBeNull();
  expect(p!.clamped, `${where}: nothing is clamped once expanded`).toBe(false);
  expect(p!.clippedPx, `${where}: the last words are not clipped`).toBeLessThanOrEqual(0.5);
  expect(p!.ownsCentre, `${where}: the last words are on top, not under a sticky header`).toBe(true);
}

async function chooseGroup(dialog: Locator, label: string) {
  await dialog.getByRole("tab", { name: label }).click();
  await expect(dialog.getByRole("tab", { name: label })).toHaveAttribute("aria-selected", "true");
}

test.describe("EVIDENCE-MATRIX-001B — desktop", () => {
  test("keyboard: compare two papers, sort and expand locally, close back to Compare, reopen fresh", async ({ page }) => {
    await openDashboard(page, DESKTOP);
    await selectRow(page, ALPHA);
    await selectRow(page, BETA);
    await expect(page.getByText(/^2 selected$/)).toBeVisible();
    const network = watchNetwork(page);

    const compare = compareButton(page);
    await expect(compare).not.toHaveAttribute("aria-disabled");
    await compare.focus();
    await page.keyboard.press("Enter");
    const dialog = await openedDialog(page, 2);
    await expect(dialog.getByRole("heading", { name: "Compare papers" })).toBeFocused();

    // One owner-scoped read of exactly the frozen ids.
    expect(network.comparisonReads).toHaveLength(1);
    const read = network.comparisonReads[0];
    expect(read).toContain(`user_id=eq.${fixtures.userId}`);
    const requested = read.match(/id=in\.\(([^)]*)\)/)?.[1].split(",").sort();
    expect(requested).toEqual([fixtures.ids[ALPHA][0], fixtures.ids[BETA][0]].sort());

    // Newest first by default; sorting moves whole rows and reads nothing.
    expect(await shownTitles(dialog)).toEqual([ALPHA, BETA]);
    const sort = dialog.getByLabel("Sort papers");
    await sort.selectOption("year_asc");
    expect(await shownTitles(dialog)).toEqual([BETA, ALPHA]);
    await expect(dialog.getByRole("row", { name: new RegExp(BETA) }).getByRole("cell", { name: "Journal of Cohort Fixtures" })).toBeVisible();
    await expect(dialog.getByRole("row", { name: new RegExp(ALPHA) }).getByRole("cell", { name: "Journal of Comparison Fixtures" })).toBeVisible();
    await sort.selectOption("title_asc");
    expect(await shownTitles(dialog)).toEqual([ALPHA, BETA]);

    // Field groups by keyboard.
    await dialog.getByRole("tab", { name: "Bibliographic" }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(dialog.getByRole("tab", { name: "Study metadata" })).toHaveAttribute("aria-selected", "true");
    const classification = dialog.getByRole("columnheader", { name: "PaperLume study-type classification" });
    await expect(classification).toContainText("Source and scientific accuracy not independently verified.");
    const alphaStudy = dialog.getByRole("row", { name: new RegExp(ALPHA) });
    await expect(alphaStudy.getByRole("listitem")).toHaveText(["Randomized Controlled Trial", "Clinical Trial, Phase II"]);
    await expect(dialog.getByRole("row", { name: new RegExp(BETA) }).getByText("Not recorded in library").first()).toBeVisible();

    // A long stored abstract: clamped, then readable in full in place.
    await page.keyboard.press("ArrowRight");
    await expect(dialog.getByRole("tab", { name: "Stored research content" })).toHaveAttribute("aria-selected", "true");
    await expect(dialog.getByRole("row", { name: new RegExp(BETA) }).getByText("Stored placeholder: Not specified")).toBeVisible();
    const showFull = dialog.getByRole("row", { name: new RegExp(ALPHA) }).getByRole("button", { name: "Show full abstract" });
    const controls = await showFull.getAttribute("aria-controls");
    // The control relabels itself ("Show less"), so it is followed by what it controls.
    const expand = dialog.locator(`button[aria-controls="${controls}"]`);
    const abstract = page.locator(`[id="${controls}"]`);
    expect(await abstract.evaluate((el) => el.scrollHeight > el.clientHeight + 1), "clamped while collapsed").toBe(true);
    await expand.focus();
    await page.keyboard.press("Enter");
    await expect(expand).toHaveAttribute("aria-expanded", "true");
    await expectTextEndReadable(abstract, ABSTRACT_END, "1280×720 expanded abstract");
    await expectNoUuidIn(dialog);

    // Escape closes back to Compare; the selection is untouched.
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(compare).toBeFocused();
    await expect(page.getByText(/^2 selected$/)).toBeVisible();
    await expect(page.getByRole("checkbox", { name: `Select ${ALPHA}`, exact: true })).toBeChecked();
    await expect(page.getByRole("checkbox", { name: `Select ${BETA}`, exact: true })).toBeChecked();

    // Reopening is a new session and a new read.
    await page.keyboard.press("Enter");
    const reopened = await openedDialog(page, 2);
    expect(network.comparisonReads).toHaveLength(2);
    await expect(reopened.getByLabel("Sort papers")).toHaveValue("year_desc");
    await reopened.getByRole("button", { name: "Close" }).click();
    await expect(reopened).toBeHidden();
    await expect(compare).toBeFocused();
    expect(network.forbidden, "no Edge Function, RPC, Storage or Data API write").toEqual([]);
  });

  test("ten papers across unloaded pages and a cleared filter; more than ten is refused, never truncated", async ({ page }) => {
    // Registered before the page loads, so a second page fetched at startup would count too.
    const listPages: string[] = [];
    page.on("request", (request) => {
      const url = decodeURIComponent(request.url());
      if (url.includes("/rest/v1/papers?") && url.includes("offset=100")) listPages.push(url);
    });
    await openDashboard(page, DESKTOP);
    const selectAll = page.getByRole("checkbox", { name: "Select all" });

    await page.getByLabel("Published from year").fill("2001");
    await page.getByLabel("Published to year").fill("2002");
    await expect(page.getByText(/^10 of \d+ papers$/)).toBeVisible();
    await expect(selectAll).toBeEnabled();
    await selectAll.click();
    await expect(page.getByText(/^10 selected$/)).toBeVisible();

    // Clearing the filter keeps the selection; the oldest seeded papers are now
    // on the second, unloaded page of the library.
    await page.getByLabel("Published from year").fill("");
    await page.getByLabel("Published to year").fill("");
    await expect(page.getByText(/^\d+ papers$/).first()).toBeVisible();
    await expect(page.getByText(/^10 selected$/)).toBeVisible();
    expect(listPages, "the second library page was never loaded").toEqual([]);

    const ten = watchNetwork(page);
    await compareButton(page).click();
    const dialog = await openedDialog(page, 10);
    const titles = await shownTitles(dialog);
    expect(titles).toHaveLength(10);
    expect(titles).toEqual(expect.arrayContaining(["E2E Primary Paper 001", "E2E Primary Paper 002"]));
    expect(ten.comparisonReads).toHaveLength(1);
    expect(ten.comparisonReads[0].match(/id=in\.\(([^)]*)\)/)?.[1].split(",")).toHaveLength(10);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    ten.stop();
    expect(ten.forbidden).toEqual([]);

    // Fourteen: Compare stays reachable, says why, and does nothing.
    await page.getByLabel("Published from year").fill("2000");
    await page.getByLabel("Published to year").fill("2002");
    await expect(page.getByText(/^14 of \d+ papers$/)).toBeVisible();
    await selectAll.click();
    await expect(page.getByText(/^14 selected$/)).toBeVisible();
    const refused = watchNetwork(page);
    const compare = compareButton(page);
    const reason = "Compare works with up to 10 papers. Narrow the selection to compare.";
    await expect(compare).toHaveAttribute("aria-disabled", "true");
    await expect(compare).toHaveAccessibleDescription(reason);
    await expect(toolbar(page).getByText(reason)).toBeVisible();
    // Playwright will not click an aria-disabled control, so the press is
    // dispatched directly — exactly what a pointer press delivers.
    await compare.dispatchEvent("click");
    await compare.focus();
    await page.keyboard.press("Enter");
    await expect(comparisonDialog(page)).toHaveCount(0);
    await expect(page.getByText(/^14 selected$/)).toBeVisible();
    refused.stop();
    expect(refused.comparisonReads, "no read for a refused selection").toEqual([]);
    expect(refused.forbidden).toEqual([]);
  });
});

test.describe("EVIDENCE-MATRIX-001B — read boundary and matrix layout", () => {
  test("1024×768: a paper deleted before Compare is counted, never identified; only the caller's rows return", async ({ page }) => {
    await openDashboard(page, TABLET_LANDSCAPE);
    await selectRow(page, ALPHA);
    await selectRow(page, BETA);
    await selectRow(page, VANISHING);
    await expect(page.getByText(/^3 selected$/)).toBeVisible();
    // Another tab deletes one selected paper; this page's list does not know.
    await page.evaluate(
      async ({ modPath, id }) => {
        const { supabase } = (await import(modPath)) as {
          supabase: { rpc: (name: string, args: unknown) => Promise<{ error: unknown }> };
        };
        const { error } = await supabase.rpc("delete_papers_with_attachment_cleanup", { p_paper_ids: [id] });
        if (error) throw new Error(JSON.stringify(error));
      },
      { modPath: CLIENT_MODULE_PATH, id: fixtures.ids[VANISHING][0] },
    );

    const response = page.waitForResponse((r) => decodeURIComponent(r.url()).includes(COMPARISON_EMBED));
    await compareButton(page).click();
    const rows = (await (await response).json()) as { id: string; user_id: string; paper_attachments: unknown[] }[];
    expect(rows.map((row) => row.id).sort()).toEqual([fixtures.ids[ALPHA][0], fixtures.ids[BETA][0]].sort());
    expect(rows.every((row) => row.user_id === fixtures.userId)).toBe(true);

    const dialog = await openedDialog(page, 2);
    await expect(dialog.getByText(/1 of the 3 selected papers could not be included/).first()).toBeVisible();
    await expect(dialog.getByRole("status")).toHaveText("Comparing 2 papers. 1 of the 3 selected papers could not be included.");
    expect(await shownTitles(dialog)).toEqual([ALPHA, BETA]);
    await expectNoUuidIn(dialog);
    await expectDialogContained(page, dialog, "1024×768");
    await expectReachable(dialog.getByRole("button", { name: "Close" }), "1024×768", 40);
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(dialog).toBeHidden();
  });

});

test.describe("EVIDENCE-MATRIX-001B — tablet, coarse pointer", () => {
  test.use({ hasTouch: true });

  test("768×1024 touch: the matrix scrolls inside its labelled panel and keeps focus clear of the sticky column", async ({
    page,
  }) => {
    await openDashboard(page, TABLET_PORTRAIT);
    await selectRow(page, ALPHA);
    await selectRow(page, DUPLICATE, 0);
    await selectRow(page, DUPLICATE, 1);
    await compareButton(page).click();
    const dialog = await openedDialog(page, 3);
    await expectDialogContained(page, dialog, "768×1024");

    // Two papers with the same title stay apart, each with its own values.
    expect(await shownTitles(dialog)).toEqual([ALPHA, DUPLICATE, DUPLICATE]);
    const rows = dialog.locator("tbody tr");
    await expect(rows.nth(1).getByRole("cell", { name: "Journal X" })).toBeVisible();
    await expect(rows.nth(2).getByRole("cell", { name: "Journal Y" })).toBeVisible();

    // One tab stop, named by its tab, that scrolls sideways — the page does not.
    const panel = dialog.getByRole("tabpanel", { name: "Bibliographic" });
    await expect(panel).toHaveAttribute("tabindex", "0");
    const scroll = await panel.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
    expect(scroll.sw, "the matrix scrolls sideways inside its panel").toBeGreaterThan(scroll.cw);

    // Tab across row 0 to the last column (the panel scrolls right), then
    // Shift+Tab back to the first data column: the browser must bring that
    // control in clear of the sticky paper column, which only the panel's
    // scroll padding achieves — a plain "nearest" scroll would park it under it.
    await panel.focus();
    for (let i = 0; i < 3; i++) await page.keyboard.press("Tab");
    const doiLink = rows.nth(0).getByRole("link", { name: /Open DOI link/ });
    await expect(doiLink).toBeFocused();
    expect(await panel.evaluate((el) => el.scrollLeft), "reaching the last column scrolled the panel").toBeGreaterThan(0);
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Shift+Tab");
    const authorsToggle = rows.nth(0).getByRole("button", { name: "Show all 8 authors" });
    await expect(authorsToggle).toBeFocused();
    const clearance = await authorsToggle.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const sticky = el.closest("tr")!.querySelector("th")!.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { gap: r.left - sticky.right, owns: !!hit && el.contains(hit), focusVisible: el.matches(":focus-visible") };
    });
    expect(clearance.owns, "the focused control is not under the sticky column").toBe(true);
    expect(clearance.gap, "its focus ring clears the sticky column").toBeGreaterThanOrEqual(4);
    expect(clearance.focusVisible).toBe(true);

    // Chromium centres a control it scrolls to for focus; WebKit and Firefox
    // align it to the nearest edge, which is where the scroll padding matters.
    await panel.evaluate((el) => {
      el.scrollLeft = el.scrollWidth;
    });
    const nearestGap = await authorsToggle.evaluate((el) => {
      el.scrollIntoView({ block: "nearest", inline: "nearest" });
      const sticky = el.closest("tr")!.querySelector("th")!.getBoundingClientRect();
      return el.getBoundingClientRect().left - sticky.right;
    });
    expect(nearestGap, "a nearest-edge scroll also keeps it clear of the sticky column").toBeGreaterThanOrEqual(4);

    // The sticky header row's measured height is kept as scroll padding, in every group.
    for (const label of ["Bibliographic", "Study metadata", "Stored research content", "Library organization"]) {
      await chooseGroup(dialog, label);
      const group = dialog.getByRole("tabpanel", { name: label });
      const header = await group.evaluate((el) => ({
        padding: parseFloat(getComputedStyle(el).scrollPaddingTop),
        head: el.querySelector("thead")!.getBoundingClientRect().height,
      }));
      expect(header.padding, `${label}: scroll padding covers the sticky header`).toBeGreaterThanOrEqual(header.head);
    }
    for (const label of ["Bibliographic", "Study metadata", "Stored research content", "Library organization"]) {
      await expectReachable(dialog.getByRole("tab", { name: label }), "768×1024", 40);
    }
    await expectReachable(dialog.getByRole("button", { name: "Close" }), "768×1024", 40);
    await expectNoUuidIn(dialog);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(compareButton(page)).toBeFocused();
  });
});

/**
 * The phone presentation: Compare reachable straight from the collapsed bar,
 * then a full-screen dialog of cards with no sideways scrolling anywhere.
 */
async function expectPhoneComparison(page: Page, viewport: Viewport) {
  const where = `${viewport.width}×${viewport.height}`;
  await openDashboard(page, viewport);
  await selectRow(page, ALPHA);
  await selectRow(page, BETA);
  const compare = compareButton(page);
  await expect(compare).not.toHaveAttribute("aria-disabled");
  await expectReachable(compare, `${where} toolbar`, 40);
  await expect(toolbar(page).getByRole("button", { name: "More actions" })).toBeVisible();
  const network = watchNetwork(page);

  await compare.tap();
  const dialog = await openedDialog(page, 2);
  await expectDialogContained(page, dialog, where);
  await expect(dialog.getByRole("table")).toHaveCount(0);
  await expectReachable(dialog.getByRole("button", { name: "Close" }), where, 40);
  for (const label of ["Bibliographic", "Study metadata", "Stored research content", "Library organization"]) {
    await expectReachable(dialog.getByRole("tab", { name: label }), where, 40);
  }

  // Cards follow the whole-comparison sort.
  expect(await shownTitles(dialog)).toEqual([ALPHA, BETA]);
  await dialog.getByLabel("Sort papers").selectOption("year_asc");
  expect(await shownTitles(dialog)).toEqual([BETA, ALPHA]);

  // Every card states each field's provenance beside it.
  await chooseGroup(dialog, "Study metadata");
  const alphaCard = dialog.getByRole("article", { name: new RegExp(ALPHA) });
  await expect(alphaCard.getByRole("term").first()).toContainText("Source and scientific accuracy not independently verified.");
  await expect(alphaCard.getByText("Randomized Controlled Trial", { exact: true }).first()).toBeVisible();

  // The long abstract expands in place and its end is readable, unclipped.
  await chooseGroup(dialog, "Stored research content");
  const controls = await alphaCard.getByRole("button", { name: "Show full abstract" }).getAttribute("aria-controls");
  const expand = dialog.locator(`button[aria-controls="${controls}"]`);
  await expand.tap();
  await expect(expand).toHaveAttribute("aria-expanded", "true");
  await expect(expand).toHaveText("Show less");
  await expectTextEndReadable(page.locator(`[id="${controls}"]`), ABSTRACT_END, `${where} expanded abstract`);
  await expectDialogContained(page, dialog, `${where} expanded`);
  await expectNoSidewaysScrollInside(dialog, `${where} expanded abstract`);

  // A stored term with no break opportunity wraps inside its card.
  await chooseGroup(dialog, "Library organization");
  await expect(alphaCard.getByText(UNBROKEN_SUBSTANCE)).toBeVisible();
  await expectNoSidewaysScrollInside(dialog, `${where} unbroken term`);
  await expectNoUuidIn(dialog);

  await dialog.getByRole("button", { name: "Close" }).tap();
  await expect(dialog).toBeHidden();
  await expect(compare, `${where}: focus is back on Compare, not <body>`).toBeFocused();
  await expect(page.getByText(/^2 selected$/)).toBeVisible();
  expect(network.comparisonReads).toHaveLength(1);
  expect(network.forbidden).toEqual([]);
}

test.describe("EVIDENCE-MATRIX-001B — phone, coarse pointer", () => {
  test.use({ hasTouch: true });

  for (const viewport of [PHONE_SMALL, PHONE, PHONE_LANDSCAPE]) {
    test(`${viewport.width}×${viewport.height}: Compare from the collapsed bar, cards with no sideways scroll`, async ({ page }) => {
      await expectPhoneComparison(page, viewport);
    });
  }
});
