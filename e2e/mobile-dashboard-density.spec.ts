import { test, expect, type Locator, type Page } from "@playwright/test";
import { waitForDashboard } from "./helpers";

/**
 * MOBILE-DASHBOARD-DENSITY-001 — the paper table is the primary smartphone
 * surface.
 *
 * PFA-C09 removed horizontal clipping, but it did so by *wrapping* the whole
 * permanent Dashboard toolbar onto many lines. On a real phone that traded a
 * sideways-overflow bug for a vertical-density one: the owner's Production
 * screenshot shows the control region consuming almost the entire first
 * viewport with only a sliver of table below it.
 *
 * "No horizontal overflow" is therefore not sufficient acceptance evidence, so
 * these tests measure real geometry. Every assertion is read-only: sheets are
 * opened and closed and filter state is changed in memory — nothing is written
 * to the database.
 */

const NARROW = { width: 390, height: 844 };
const LARGE_PHONE = { width: 430, height: 932 };
const MOBILE_MAX = { width: 767, height: 900 };
const DESKTOP_MIN = { width: 768, height: 1024 };
const DESKTOP = { width: 1280, height: 720 };
const DESKTOP_WIDE = { width: 1440, height: 900 };

interface DensityMetrics {
  viewportHeight: number;
  /** Bottom edge of the permanent (non-scrolling) control region. */
  controlsBottom: number | null;
  /** Top edge of the PaperList scroll container. */
  listTop: number | null;
  /** Height of the PaperList scroll container. */
  listHeight: number | null;
  /**
   * How much of that scroll container actually falls inside the viewport.
   *
   * This, not `listHeight`, is the honest density measure: a container that
   * overflows the shell reports a huge `listHeight` while showing the user
   * almost nothing, which is precisely the reported defect.
   */
  listVisibleHeight: number | null;
  /** Top edge of the sticky table header. */
  headerTop: number | null;
  headerBottom: number | null;
  /** First data row, when one is rendered. */
  firstRowTop: number | null;
  firstRowBottom: number | null;
  docScroll: number;
  docClient: number;
  bodyScroll: number;
  bodyClient: number;
}

/**
 * Measures the vertical layout the way the owner experienced it: what is
 * actually inside the first viewport with nothing scrolled and no overlay open.
 *
 * The control region is found by `data-testid` where present and otherwise by
 * `main > div:first-child`, so the SAME spec measures the pre-fix tree — that
 * is what makes it a usable negative control rather than a tautology.
 */
async function measureDensity(page: Page): Promise<DensityMetrics> {
  return page.evaluate(() => {
    const num = (v: number | undefined) => (typeof v === "number" ? Math.round(v) : null);
    const controls =
      document.querySelector("[data-testid='dashboard-controls']") ??
      document.querySelector("main > div:first-child");
    const table = document.querySelector("main table");
    // Walk to the real scrolling ancestor by computed style. The table's direct
    // parent is the virtualizer's full-height spacer (`scrollHeight` of every
    // row), which would report ~5700px and make any "the list is big enough"
    // assertion vacuously true.
    let scroller: HTMLElement | null = null;
    for (let el = table?.parentElement ?? null; el; el = el.parentElement) {
      const overflowY = getComputedStyle(el).overflowY;
      if (overflowY === "auto" || overflowY === "scroll") {
        scroller = el;
        break;
      }
    }
    const thead = table?.querySelector("thead");
    const firstRow = table?.querySelector("tbody tr");

    const controlsRect = controls?.getBoundingClientRect();
    const listRect = scroller?.getBoundingClientRect();
    const headRect = thead?.getBoundingClientRect();
    const rowRect = firstRow?.getBoundingClientRect();
    const doc = document.documentElement;

    const listVisible = listRect
      ? Math.max(
          0,
          Math.min(listRect.bottom, window.innerHeight) - Math.max(listRect.top, 0),
        )
      : undefined;

    return {
      viewportHeight: window.innerHeight,
      controlsBottom: num(controlsRect?.bottom),
      listTop: num(listRect?.top),
      listHeight: num(listRect?.height),
      listVisibleHeight: num(listVisible),
      headerTop: num(headRect?.top),
      headerBottom: num(headRect?.bottom),
      firstRowTop: num(rowRect?.top),
      firstRowBottom: num(rowRect?.bottom),
      docScroll: doc.scrollWidth,
      docClient: doc.clientWidth,
      bodyScroll: document.body.scrollWidth,
      bodyClient: document.body.clientWidth,
    };
  });
}

function reportDensity(label: string, m: DensityMetrics) {
  const pct = (v: number | null) =>
    v === null ? "n/a" : `${((v / m.viewportHeight) * 100).toFixed(1)}%`;
  console.log(
    `[density:${label}] viewport=${m.viewportHeight} controlsBottom=${m.controlsBottom} (${pct(
      m.controlsBottom,
    )}) listTop=${m.listTop} (${pct(m.listTop)}) listHeight=${m.listHeight} listVisible=${
      m.listVisibleHeight
    } (${pct(m.listVisibleHeight)}) headerTop=${m.headerTop} firstRowTop=${
      m.firstRowTop
    } firstRowBottom=${m.firstRowBottom}`,
  );
}

async function expectNoHorizontalOverflow(page: Page, where: string) {
  const m = await measureDensity(page);
  expect(m.docScroll, `${where}: documentElement scrollWidth vs clientWidth`).toBeLessThanOrEqual(
    m.docClient,
  );
  expect(m.bodyScroll, `${where}: body scrollWidth vs clientWidth`).toBeLessThanOrEqual(
    m.bodyClient,
  );
}

/**
 * Picks the first available option in one of the Analytics target selectors and
 * returns its text, so the caller can follow that exact value across a
 * breakpoint transition without depending on which papers the seed contains.
 */
async function selectFirstTarget(
  page: Page,
  label: "Target Keywords" | "Target Authors",
  scope: Locator,
): Promise<string> {
  await scope.getByRole("button", { name: label }).click();

  const search = page.getByRole("textbox", { name: `Search ${label.toLowerCase()}` });
  await expect(search).toBeVisible();
  const popover = page.getByRole("dialog").filter({ has: search });

  const option = popover.locator("label").first();
  await expect(option).toBeVisible();
  const value = (await option.innerText()).trim();
  expect(value, `the seed must offer at least one ${label}`).not.toBe("");

  // Click the control itself rather than the wrapping <label>: Radix's checkbox
  // is a button beside a hidden input, so a label click is not a reliable proxy.
  await option.getByRole("checkbox").click();

  // Escape dismisses only the topmost layer — the popover, not the sheet.
  await page.keyboard.press("Escape");
  await expect(search).toBeHidden();
  return value;
}

async function gotoMobileDashboard(page: Page, viewport = NARROW) {
  await page.setViewportSize(viewport);
  await page.goto("/", { waitUntil: "networkidle" });
  await waitForDashboard(page);
}

test.describe("MOBILE-DASHBOARD-DENSITY-001 — table is the primary mobile surface", () => {

  test("the paper table is visible in the first 390x844 viewport", async ({ page }) => {
    await gotoMobileDashboard(page);

    // ── The measured result, not a screenshot claim. Measured FIRST so this
    //    test fails on the density defect itself against the pre-fix tree,
    //    rather than short-circuiting on a control that does not exist yet. ──
    const m = await measureDensity(page);
    reportDensity("390x844", m);

    expect(m.headerTop, "table header must render").not.toBeNull();
    expect(m.firstRowTop, "a first data row must render").not.toBeNull();

    // The primary invariant: header AND the beginning of the first data row are
    // inside the viewport with nothing scrolled and no overlay open.
    expect(
      m.headerBottom as number,
      "table header must be fully inside the first viewport",
    ).toBeLessThanOrEqual(m.viewportHeight);
    expect(
      m.firstRowTop as number,
      "the first paper row must start inside the first viewport",
    ).toBeLessThan(m.viewportHeight);
    // "Beginning of the row" means a usable band of it, not one stray pixel.
    expect(
      m.viewportHeight - (m.firstRowTop as number),
      "at least 48px of the first paper row must be visible",
    ).toBeGreaterThanOrEqual(48);

    // Proportional guard: the library, not the toolbar, owns the viewport.
    expect(
      m.listTop as number,
      "PaperList must begin within the upper 45% of the viewport",
    ).toBeLessThanOrEqual(m.viewportHeight * 0.45);
    expect(
      m.listVisibleHeight as number,
      "PaperList must receive at least 45% of viewport height on screen",
    ).toBeGreaterThanOrEqual(m.viewportHeight * 0.45);

    // ── The permanent controls, all reachable without scrolling ──
    await expect(page.getByRole("button", { name: "Open navigation menu" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Papers", level: 1 })).toBeVisible();
    await expect(page.locator("p").filter({ hasText: /^\d+\s+papers?$/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Add papers" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Search papers" })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Filters/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /^More/ })).toBeVisible();

    await expectNoHorizontalOverflow(page, "390x844 dashboard");
  });

  test("Filters sheet holds every non-search filter and returns focus", async ({ page }) => {
    await gotoMobileDashboard(page);

    const filters = page.getByRole("button", { name: /^Filters/ });
    await filters.focus();
    await expect(filters).toBeFocused();
    await page.keyboard.press("Enter");

    const sheet = page.getByRole("dialog", { name: "Filters" });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByText("Refine the papers shown in your library.")).toBeVisible();

    // Focus actually moved into the sheet (Radix owns the trap).
    await expect
      .poll(() =>
        page.evaluate(() => {
          const d = document.querySelector('[role="dialog"]');
          return !!d && !!document.activeElement && d.contains(document.activeElement);
        }),
      )
      .toBe(true);

    // Every filter category the desktop toolbar offers is present here.
    await expect(sheet.getByRole("spinbutton", { name: "Published from year" })).toBeVisible();
    await expect(sheet.getByRole("spinbutton", { name: "Published to year" })).toBeVisible();
    await expect(sheet.getByRole("combobox", { name: "Filter by study type" })).toBeVisible();
    await expect(sheet.getByRole("combobox", { name: "Filter by notes presence" })).toBeVisible();
    await expect(sheet.getByRole("combobox", { name: /^Filter by project/ })).toBeVisible();
    await expect(sheet.getByRole("combobox", { name: /^Filter by tag/ })).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Filter by keyword" })).toBeVisible();
    await expect(sheet.getByRole("button", { name: /presets/i })).toBeVisible();

    // Search is NOT duplicated into the sheet — it stays permanently visible
    // outside it, and there must be exactly one search input in the document.
    await expect(sheet.getByRole("textbox", { name: "Search papers" })).toHaveCount(0);
    expect(
      await page.locator("#paper-search").count(),
      "exactly one search field must exist",
    ).toBe(1);

    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await expect(filters).toBeFocused();
  });

  test("filter state is live, shared and clearable — no draft copy", async ({ page }) => {
    await gotoMobileDashboard(page);

    const filters = page.getByRole("button", { name: /^Filters/ });
    // No filter category is active yet, so the trigger carries no count.
    await expect(filters).toHaveAttribute("aria-label", "Filters");

    await filters.click();
    const sheet = page.getByRole("dialog", { name: "Filters" });
    await expect(sheet).toBeVisible();

    // A non-destructive, purely client-to-server filter change.
    await sheet.getByRole("spinbutton", { name: "Published from year" }).fill("2015");

    await sheet.getByRole("button", { name: "Done" }).click();
    await expect(sheet).toBeHidden();

    // One category active — counted by category, not by value.
    const withOne = page.getByRole("button", { name: "Filters, 1 active filter category" });
    await expect(withOne).toBeVisible();
    await expect(withOne.getByText("1", { exact: true })).toBeVisible();

    // The dashboard count switched to its filtered form, proving the sheet
    // wrote to the real filter state rather than a private draft.
    await expect(page.locator("p").filter({ hasText: /^\d+ of \d+ papers$/ })).toBeVisible();

    // Reopening shows the current selection (no reset, no second copy).
    await withOne.click();
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole("spinbutton", { name: "Published from year" })).toHaveValue("2015");

    // Clear is labelled truthfully: the shared handler also clears search.
    const clearAll = sheet.getByRole("button", { name: "Clear all filters" });
    await expect(clearAll).toBeVisible();
    await clearAll.click();

    await expect(sheet.getByRole("spinbutton", { name: "Published from year" })).toHaveValue("");
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await expect(page.getByRole("button", { name: "Filters", exact: true })).toBeVisible();
    await expect(page.locator("p").filter({ hasText: /^\d+\s+papers?$/ })).toBeVisible();
  });

  test("More sheet exposes every secondary action and returns focus", async ({ page }) => {
    await gotoMobileDashboard(page);

    const more = page.getByRole("button", { name: /^More/ });
    await more.focus();
    await page.keyboard.press("Enter");

    const sheet = page.getByRole("dialog", { name: "Library actions" });
    await expect(sheet).toBeVisible();

    // Nothing was removed from the product — only relocated.
    await expect(sheet.getByRole("button", { name: "Find Duplicates" })).toBeVisible();
    await expect(sheet.getByRole("button", { name: /Analytics & Insights/ })).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Export as CSV" })).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Export as RIS" })).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Export as BibTeX" })).toBeVisible();

    // Columns operate on the same column model, rendered as a direct list.
    await expect(sheet.getByRole("checkbox", { name: /^Title/ })).toBeVisible();
    const columnBoxes = await sheet.getByRole("checkbox").count();
    expect(columnBoxes, "every available column is toggleable here").toBeGreaterThan(1);

    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await expect(more).toBeFocused();
  });

  test("More -> child dialog hands focus over and back deterministically", async ({ page }) => {
    await gotoMobileDashboard(page);

    const more = page.getByRole("button", { name: /^More/ });
    await more.focus();
    await page.keyboard.press("Enter");

    const moreSheet = page.getByRole("dialog", { name: "Library actions" });
    await expect(moreSheet).toBeVisible();

    const findDupes = moreSheet.getByRole("button", { name: "Find Duplicates" });
    await findDupes.focus();
    await page.keyboard.press("Enter");

    // The sheet closes and exactly one overlay remains: no stacked focus traps.
    await expect(moreSheet).toBeHidden();
    const dedup = page.getByRole("dialog", { name: /Find Duplicates/ });
    await expect(dedup).toBeVisible();
    expect(await page.getByRole("dialog").count()).toBe(1);

    // Focus is inside the child, never dropped on <body>.
    await expect
      .poll(() =>
        page.evaluate(() => {
          const d = document.querySelector('[role="dialog"]');
          return !!d && !!document.activeElement && d.contains(document.activeElement);
        }),
      )
      .toBe(true);

    await page.keyboard.press("Escape");
    await expect(dedup).toBeHidden();

    // And it comes back to a stable, visible Dashboard control — the trigger
    // that started the chain, which stayed mounted throughout.
    await expect(more).toBeFocused();
    await expect(more).toBeInViewport();
  });

  test("analytics opens as an overlay without displacing the table", async ({ page }) => {
    await gotoMobileDashboard(page);

    const before = await measureDensity(page);

    const more = page.getByRole("button", { name: /^More/ });
    await more.click();
    await page.getByRole("dialog", { name: "Library actions" }).getByRole("button", {
      name: /Analytics & Insights/,
    }).click();

    const analytics = page.getByRole("dialog", { name: /Analytics & Insights/ });
    await expect(analytics).toBeVisible();

    // The whole point: analytics must NOT push the table down on mobile.
    const during = await measureDensity(page);
    reportDensity("390x844+analytics", during);
    expect(during.listTop, "table must not move when analytics opens").toBe(before.listTop);
    expect(during.listHeight, "table must not resize when analytics opens").toBe(
      before.listHeight,
    );

    // The overlay fits the viewport and scrolls internally rather than widening
    // the document. Measured through the analytics locator specifically — a bare
    // `[role=dialog]` query can resolve to whichever overlay is first in the
    // document, which is not necessarily this one.
    const viewportH = await page.evaluate(() => window.innerHeight);
    // The sheet slides up on open, so its box is legitimately outside the
    // viewport mid-animation. Poll the settled geometry rather than sleeping.
    await expect
      .poll(
        async () => {
          const b = await analytics.boundingBox();
          return b ? Math.round(b.y + b.height) : null;
        },
        { message: "analytics overlay must settle inside the viewport" },
      )
      .toBeLessThanOrEqual(viewportH + 1);

    const overflowsHorizontally = await analytics
      .locator(".overflow-y-auto")
      .first()
      .evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(overflowsHorizontally, "analytics must not scroll sideways").toBe(false);
    await expectNoHorizontalOverflow(page, "390x844 analytics overlay");

    await page.keyboard.press("Escape");
    await expect(analytics).toBeHidden();
    await expect(more).toBeFocused();

    const after = await measureDensity(page);
    expect(after.listTop, "table geometry restored after closing analytics").toBe(before.listTop);
  });

  test("analytics target selections survive crossing the breakpoint", async ({ page }) => {
    // Review found that the two Analytics shells shared `isAnalyticsOpen` but
    // NOT the target selections, which were `useState` inside the shared body.
    // Since the shells are mutually exclusive and chosen by viewport width,
    // resizing (or rotating a phone) unmounted one instance and mounted a fresh
    // one, silently discarding what the user had selected.
    await gotoMobileDashboard(page);

    const more = page.getByRole("button", { name: /^More/ });
    await more.click();
    await page
      .getByRole("dialog", { name: "Library actions" })
      .getByRole("button", { name: /Analytics & Insights/ })
      .click();

    const mobileAnalytics = page.getByRole("dialog", { name: /Analytics & Insights/ });
    await expect(mobileAnalytics).toBeVisible();

    // Purely client-side selection: nothing is written to the database.
    const keyword = await selectFirstTarget(page, "Target Keywords", mobileAnalytics);
    const author = await selectFirstTarget(page, "Target Authors", mobileAnalytics);
    console.log(`[analytics-targets] keyword="${keyword}" author="${author}"`);
    await expect(mobileAnalytics).toBeVisible();

    // Selected, and actually driving the computed charts.
    await expect(mobileAnalytics.getByRole("button", { name: `Remove ${keyword}` })).toBeVisible();
    await expect(mobileAnalytics.getByRole("button", { name: `Remove ${author}` })).toBeVisible();
    await expect(
      mobileAnalytics.getByRole("heading", { name: "Keyword Distribution" }),
    ).toBeVisible();
    await expect(
      mobileAnalytics.getByRole("heading", { name: "Author Distribution" }),
    ).toBeVisible();

    // ── Cross into the desktop presentation ──
    await page.setViewportSize(DESKTOP_MIN);

    // The mobile overlay is gone entirely — not merely hidden alongside the
    // desktop one, which would duplicate these controls in the a11y tree.
    await expect(mobileAnalytics).toHaveCount(0);

    // Desktop analytics is still open…
    const desktopTrigger = page.getByRole("button", { name: /Analytics & Insights/ });
    await expect(desktopTrigger).toBeVisible();
    await expect(desktopTrigger).toHaveAttribute("aria-expanded", "true");
    const desktopAnalytics = page.locator("main");

    // …and showing exactly the same selections, from the same one state.
    await expect(desktopAnalytics.getByRole("button", { name: `Remove ${keyword}` })).toBeVisible();
    await expect(desktopAnalytics.getByRole("button", { name: `Remove ${author}` })).toBeVisible();
    await expect(
      desktopAnalytics.getByRole("heading", { name: "Keyword Distribution" }),
    ).toBeVisible();
    await expect(
      desktopAnalytics.getByRole("heading", { name: "Author Distribution" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "More library actions" })).toHaveCount(0);

    // ── And back again ──
    await page.setViewportSize(NARROW);

    const mobileAgain = page.getByRole("dialog", { name: /Analytics & Insights/ });
    await expect(mobileAgain).toBeVisible();
    await expect(mobileAgain.getByRole("button", { name: `Remove ${keyword}` })).toBeVisible();
    await expect(mobileAgain.getByRole("button", { name: `Remove ${author}` })).toBeVisible();

    // Clearing still works through the shared state, and closing/reopening in
    // the same session keeps what is left rather than resetting it.
    await mobileAgain.getByRole("button", { name: `Remove ${author}` }).click();
    await expect(mobileAgain.getByRole("button", { name: `Remove ${author}` })).toHaveCount(0);
    await expect(mobileAgain.getByRole("button", { name: `Remove ${keyword}` })).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(mobileAgain).toBeHidden();
    await more.click();
    await page
      .getByRole("dialog", { name: "Library actions" })
      .getByRole("button", { name: /Analytics & Insights/ })
      .click();
    await expect(mobileAgain.getByRole("button", { name: `Remove ${keyword}` })).toBeVisible();
  });

  test("the compact AI status keeps its full accessible name", async ({ page }) => {
    await gotoMobileDashboard(page);

    // The local fixture resolves a real quota, so the indicator is present.
    const status = page.getByRole("status");
    await expect(status).toBeVisible();

    // Compact visible text — a bare ratio, glyph or state word, never the full
    // desktop sentence.
    await expect(status).not.toContainText("AI analyses:");

    // …but the accessible name still carries the whole statement, so the number
    // is not the only carrier of the state.
    const label = await status.getAttribute("aria-label");
    expect(label, "compact status must keep a descriptive accessible name").toBeTruthy();
    expect(label as string).toMatch(/AI analys|Unlimited/i);
    expect((label as string).length).toBeGreaterThan(20);
  });

  test("the mobile contract holds at 767px and the desktop contract at 768px", async ({
    page,
  }) => {
    // The two layouts are distinguished by markers that cannot collide.
    // Accessible-name matching is case-insensitive and substring-based, so
    // "Add Papers" would also match the compact "Add papers" control — these
    // locators therefore key off the exact desktop button text and the mobile
    // controls' unique aria-labels instead.
    const mobileOnly = {
      nav: page.locator('button[aria-label="Open navigation menu"]'),
      filters: page.locator('button[aria-label^="Filters"]'),
      more: page.locator('button[aria-label="More library actions"]'),
    };
    const desktopOnly = {
      columns: page.locator("button").filter({ hasText: /^Columns$/ }),
      findDuplicates: page.locator("button").filter({ hasText: /^Find Duplicates$/ }),
      addPapers: page.locator("button").filter({ hasText: /^Add Papers$/ }),
    };

    // 767 — still mobile. This pins the off-by-one at the breakpoint edge.
    await gotoMobileDashboard(page, MOBILE_MAX);
    await expect(mobileOnly.nav).toBeVisible();
    await expect(mobileOnly.filters).toBeVisible();
    await expect(mobileOnly.more).toBeVisible();
    await expect(page.getByRole("complementary")).toBeHidden();
    await expect(desktopOnly.columns).toHaveCount(0);
    await expect(desktopOnly.findDuplicates).toHaveCount(0);
    await expect(desktopOnly.addPapers).toHaveCount(0);
    await expectNoHorizontalOverflow(page, "767px");

    // 768 — desktop. The mobile controls must be gone, not merely hidden twice.
    await gotoMobileDashboard(page, DESKTOP_MIN);
    await expect(page.getByRole("complementary")).toBeVisible();
    await expect(desktopOnly.columns).toBeVisible();
    await expect(desktopOnly.findDuplicates).toBeVisible();
    await expect(desktopOnly.addPapers).toBeVisible();
    await expect(mobileOnly.nav).toHaveCount(0);
    await expect(mobileOnly.filters).toHaveCount(0);
    await expect(mobileOnly.more).toHaveCount(0);
    await expectNoHorizontalOverflow(page, "768px");
  });

  test("the desktop workflow is preserved", async ({ page }) => {
    for (const viewport of [DESKTOP, DESKTOP_WIDE]) {
      await gotoMobileDashboard(page, viewport);
      const where = `${viewport.width}x${viewport.height}`;

      // Everything stays inline and directly visible — no progressive
      // disclosure was imposed on desktop.
      await expect(page.getByRole("complementary")).toBeVisible();
      await expect(page.getByRole("button", { name: "Columns" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Find Duplicates" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Add Papers" })).toBeVisible();
      await expect(page.getByRole("button", { name: /Analytics & Insights/ })).toBeVisible();
      await expect(page.getByRole("textbox", { name: "Search papers" })).toBeVisible();
      await expect(page.getByRole("combobox", { name: "Filter by study type" })).toBeVisible();
      await expect(page.getByRole("combobox", { name: /^Filter by project/ })).toBeVisible();
      await expect(page.getByRole("button", { name: /export/i })).toBeVisible();

      // The full AI quota presentation, not the compact one.
      await expect(page.getByRole("status")).toContainText("AI analyses:");

      // No mobile-only control leaked into the desktop tree.
      await expect(page.getByRole("button", { name: "More library actions" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: /^Filters/ })).toHaveCount(0);

      const m = await measureDensity(page);
      reportDensity(where, m);
      await expectNoHorizontalOverflow(page, where);
      // PaperList still owns its own horizontal scrolling.
      const ownsScroll = await page.evaluate(() => {
        const table = document.querySelector("main table");
        for (let el = table?.parentElement ?? null; el; el = el.parentElement) {
          const o = getComputedStyle(el).overflowX;
          if (o === "auto" || o === "scroll") return el.scrollWidth > el.clientWidth;
        }
        return null;
      });
      expect(ownsScroll, `${where}: the table scrolls inside its own container`).toBe(true);
    }
  });
});
