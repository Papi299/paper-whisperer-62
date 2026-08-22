import { test, expect, type Locator, type Page } from "@playwright/test";
import { openEditPaperDialog, waitForDashboard } from "./helpers";

/**
 * SCROLLAREA-HORIZONTAL-REACHABILITY-AUDIT-001
 *
 * Radix wraps a `ScrollArea`'s children in an element styled
 * `display: table; min-width: 100%`. A table box is never laid out narrower
 * than its own min-content width, so a line that cannot wrap — a `truncate`
 * label, an unbreakable DOI, a row of `whitespace-nowrap` buttons — widens the
 * wrapper *past* the viewport rather than being clipped by it.
 *
 * The viewport is `overflow-x: hidden` and `ui/scroll-area` mounts only a
 * VERTICAL scrollbar (no consumer anywhere passes `orientation="horizontal"`),
 * so whatever ends up out there is reachable by script and by nobody else: no
 * scrollbar, no wheel, no drag.
 *
 * Nothing below uses `toBeVisible()` or `.click()` as evidence of reachability.
 * `.click()` runs `scrollIntoViewIfNeeded`, which sets `scrollLeft` even here —
 * which is how this class of defect passed a green suite in
 * AUTHOR-IDENTITY-PICKER-USABILITY-001. Horizontal containment is measured with
 * NO scrolling of any kind; the hit test is taken after scrolling VERTICALLY
 * ONLY; `scrollLeft` is asserted 0 throughout.
 */

/* ── Realistic worst-case fixtures ─────────────────────────────────────── */

/** Long, but a plausible MeSH-style phrase rather than a robustness stunt. */
const LONG_KEYWORD =
  "postoperative cognitive dysfunction following cardiopulmonary bypass";
/** The worst realistic keyword shape: one token, no break opportunity. */
const LONG_TOKEN_KEYWORD =
  "hydroxymethylglutarylcoenzymeAreductaseinhibitorpharmacogenomics";
const SHORT_KEYWORD = "delirium";
/** A DOI of the length registrars actually issue. One unbreakable token. */
const LONG_DOI = "10.1016/j.jcvaperioperativemedicine.2024.118837294-x";
/** A deterministic seeded paper, used read-then-restore for the Analytics fixture. */
const FIXTURE_PAPER = "E2E Primary Paper 001";

/**
 * The exact audited cause, reintroduced for the negative controls.
 *
 * Specificity matters and is the reason for `html body` and `:not(#x)`. The
 * production fix is a Tailwind arbitrary variant whose compiled selector
 * carries a class, an attribute and a type — (0,2,1). An unqualified
 * `[data-radix-scroll-area-viewport] > div` rule is (0,1,1) and LOSES to it
 * even with `!important`, so it reproduces nothing while appearing to pass.
 */
const REINTRODUCE_TABLE_WRAPPER =
  "html body [data-radix-scroll-area-viewport] > div:not(#x)" +
  " { display: table !important; min-width: 100% !important; }";

/* ── Shared measurement ────────────────────────────────────────────────── */

/**
 * Geometry for the scroll viewport containing `scope`, plus per-row horizontal
 * containment and a centre-point hit test.
 *
 * The two axes are NOT treated alike, and that asymmetry is the whole point.
 * Vertical scrolling is something a person has here, so the hit test is taken
 * after scrolling to the row; horizontal has no scrollbar at all, so
 * containment is measured as the surface stands.
 *
 * Deliberately NOT `scrollIntoView({ block: "nearest" })`: `inline` defaults to
 * `"nearest"`, so on a row that IS horizontally out of view it scrolls sideways
 * too — the exact programmatic rescue this spec exists to forbid, performed by
 * the measurement itself. Measured: it moved `scrollLeft` 0 → 8. Driving
 * `scrollTop` alone cannot touch the other axis.
 */
async function scrollAreaGeometry(scope: Locator, rowSelector = "label") {
  return scope.evaluate((node: HTMLElement, sel: string) => {
    const viewport = node.closest(
      "[data-radix-scroll-area-viewport]",
    ) as HTMLElement;
    const wrapper = viewport.firstElementChild as HTMLElement;
    const vb = viewport.getBoundingClientRect();
    const rows = [...viewport.querySelectorAll(sel)] as HTMLElement[];

    const measured = rows.map((row) => {
      const r = row.getBoundingClientRect();
      const insideHorizontally =
        r.left >= vb.left - 1 && r.right <= vb.right + 1;

      /*
       * Scroll toward the part of the viewport that is actually ON SCREEN, and
       * press where the row is actually visible.
       *
       * A scroll viewport can be taller than the window — `max-h` sits on the
       * ScrollArea root while the Radix viewport is `h-full`, so it can extend
       * past the bottom edge. Centring the row within the VIEWPORT then puts
       * the press point off-screen, and `elementFromPoint` correctly returns
       * null for it. That is a flaw in the measurement, not in the product.
       */
      const vp0 = viewport.getBoundingClientRect();
      const onScreenCentre =
        (Math.max(vp0.top, 0) + Math.min(vp0.bottom, window.innerHeight)) / 2;
      viewport.scrollTop += r.top + r.height / 2 - onScreenCentre;

      const r2 = row.getBoundingClientRect();
      const vp2 = viewport.getBoundingClientRect();
      const top = Math.max(r2.top, vp2.top, 0);
      const bottom = Math.min(r2.bottom, vp2.bottom, window.innerHeight);
      const cx = Math.round(r2.x + r2.width / 2);
      const cy = Math.round((top + bottom) / 2);
      const hit = bottom > top ? document.elementFromPoint(cx, cy) : null;
      return {
        text: (row.textContent ?? "").trim().slice(0, 44),
        insideHorizontally,
        rightOverhangPx: Math.round(Math.max(0, r.right - vb.right)),
        pressAtItsCentreLandsOnIt: hit !== null && row.contains(hit),
      };
    });

    // A `truncate` line doing its job clips its own box. One that widened the
    // wrapper instead does not, and draws no ellipsis at all.
    const truncating = ([...viewport.querySelectorAll("span.truncate")] as HTMLElement[])
      .filter((el) => el.getBoundingClientRect().width > 0)
      .map((el) => ({
        text: (el.textContent ?? "").slice(0, 30),
        clipsItself: el.scrollWidth > el.clientWidth,
      }));

    return {
      viewport: {
        clientWidth: viewport.clientWidth,
        scrollWidth: viewport.scrollWidth,
        scrollLeft: viewport.scrollLeft,
        overflowX: getComputedStyle(viewport).overflowX,
        right: Math.round(vb.right),
      },
      wrapper: {
        display: getComputedStyle(wrapper).display,
        width: Math.round(wrapper.getBoundingClientRect().width),
      },
      rows: measured,
      truncating,
      windowWidth: window.innerWidth,
    };
  }, rowSelector);
}

type Geometry = Awaited<ReturnType<typeof scrollAreaGeometry>>;

/** The reachability contract for a surface with no horizontal scrolling. */
function expectNoHorizontalStranding(geometry: Geometry, where: string) {
  expect(
    geometry.viewport.overflowX,
    `${where}: this surface is only safe because nothing can scroll sideways`,
  ).toBe("hidden");
  expect(
    geometry.viewport.scrollWidth,
    `${where}: content overflows a viewport with no horizontal scrollbar`,
  ).toBeLessThanOrEqual(geometry.viewport.clientWidth);
  expect(
    geometry.wrapper.width,
    `${where}: the Radix content wrapper is sizing to its content again`,
  ).toBeLessThanOrEqual(geometry.viewport.clientWidth);

  expect(geometry.rows.length, `${where}: nothing was measured`).toBeGreaterThan(0);
  for (const row of geometry.rows) {
    expect(
      row.insideHorizontally,
      `${where}: "${row.text}" sits ${row.rightOverhangPx}px outside on the axis the user cannot scroll`,
    ).toBe(true);
    expect(
      row.pressAtItsCentreLandsOnIt,
      `${where}: "${row.text}" cannot be pressed where it is drawn`,
    ).toBe(true);
  }
  expect(geometry.viewport.scrollLeft, `${where}: the list scrolled sideways`).toBe(0);
}

/* ── Keyword pool fixture, used by two surfaces ────────────────────────── */

async function openKeywordPool(page: Page, narrow = false) {
  // A popover left open would swallow the first click as an outside-dismiss.
  await page.keyboard.press("Escape");
  /*
   * The rail and the drawer render the SAME navigation body, so below `md` both
   * are in the tree and an unscoped lookup is ambiguous. Scope to whichever one
   * the user is actually looking at, and address the gear by its accessible
   * name rather than by walking up from the label text.
   */
  const nav = narrow
    ? page.getByRole("dialog", { name: "PaperLume navigation" })
    : page.getByRole("complementary");
  if (narrow) {
    await page.getByRole("button", { name: "Open navigation menu" }).click();
  }
  await expect(nav).toBeVisible({ timeout: 10_000 });
  await nav.getByRole("button", { name: "Manage keyword pool", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: /Manage Keyword Pool/ });
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  return dialog;
}

async function addPoolKeywords(page: Page, keywords: string[], narrow = false) {
  const dialog = await openKeywordPool(page, narrow);
  for (const keyword of keywords) {
    await dialog.getByPlaceholder(/Add a keyword/).fill(keyword);
    await dialog.getByRole("button", { name: "Add keyword to pool" }).click();
    await expect(
      dialog.getByRole("button", { name: `Remove keyword ${keyword} from pool` }),
    ).toBeAttached({ timeout: 10_000 });
  }
  return dialog;
}

/** Restores the seed within the spec's own run, so order never matters. */
async function removePoolKeywords(page: Page, keywords: string[], narrow = false) {
  /*
   * Reuse the dialog if it is already open. Radix marks everything outside an
   * open dialog `aria-hidden`, which takes the navigation rail out of the
   * accessibility tree entirely — so reopening from the rail while the pool is
   * still on screen looks exactly like "the sidebar does not exist".
   */
  const open = page.getByRole("dialog", { name: /Manage Keyword Pool/ });
  const dialog = (await open.count()) ? open : await openKeywordPool(page, narrow);
  for (const keyword of keywords) {
    const remove = dialog.getByRole("button", {
      name: `Remove keyword ${keyword} from pool`,
    });
    // `count()` does not auto-wait; give the list a chance to render first.
    await remove.first().waitFor({ state: "attached", timeout: 5_000 }).catch(() => undefined);
    if (await remove.count()) {
      await remove.first().click();
      await expect(remove).toHaveCount(0, { timeout: 10_000 });
    }
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden({ timeout: 10_000 });
}

/* ══ Surface 1 — KeywordFilterDropdown ═════════════════════════════════ */

async function openKeywordFilter(page: Page) {
  await page.getByRole("button", { name: /Filter by keyword/i }).first().click();
  const option = page.locator("[data-radix-popper-content-wrapper] label").first();
  await expect(option).toBeAttached({ timeout: 10_000 });
  return option;
}

test.describe("KeywordFilterDropdown horizontal reachability", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);
    await addPoolKeywords(page, [LONG_KEYWORD]);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden({ timeout: 10_000 });
  });

  test.afterEach(async ({ page }) => {
    await removePoolKeywords(page, [LONG_KEYWORD]);
  });

  for (const size of [
    { name: "desktop", width: 1280, height: 900 },
    { name: "narrow desktop", width: 1024, height: 800 },
  ]) {
    test(`a long keyword cannot push the filter list out of its popover (${size.name})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: size.width, height: size.height });
      const scope = await openKeywordFilter(page);
      const geometry = await scrollAreaGeometry(scope);

      // Before the fix this read 511 against 286, at every viewport.
      expectNoHorizontalStranding(geometry, `keyword filter @ ${size.name}`);
      // The mechanism itself, so a regression names its own cause.
      expect(geometry.wrapper.display).toBe("block");

      // `truncate` is only truthful when the box actually clips.
      const long = geometry.truncating.find((l) =>
        LONG_KEYWORD.startsWith(l.text.trim().slice(0, 20)),
      );
      expect(long?.clipsItself, "the long keyword draws no ellipsis").toBe(true);
    });
  }

  /**
   * Blocker B from independent review: the earlier version of this test allowed
   * a `null` reading — focus never entering the list — to pass, which made it
   * non-load-bearing. Traversal now continues until focus is genuinely inside
   * the option list, and exhausting the bound is a failure, not a skip.
   */
  test("keyboard traversal reaches the option list and never moves it sideways", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const scope = await openKeywordFilter(page);

    const MAX_TABS = 12;
    let landed: Awaited<ReturnType<typeof probeFocus>> = null;
    const probeFocus = () =>
      scope.evaluate((node: HTMLElement) => {
        const viewport = node.closest(
          "[data-radix-scroll-area-viewport]",
        ) as HTMLElement;
        const active = document.activeElement as HTMLElement | null;
        if (!active || !viewport.contains(active)) return null;
        const ab = active.getBoundingClientRect();
        const vb = viewport.getBoundingClientRect();
        const cs = getComputedStyle(active);
        return {
          role: active.getAttribute("role") ?? active.tagName.toLowerCase(),
          name: (active.closest("label")?.textContent ?? "").trim().slice(0, 40),
          insideViewport: ab.left >= vb.left - 1 && ab.right <= vb.right + 1,
          focusVisible: active.matches(":focus-visible"),
          // A focus ring is either an outline or the ring utility's box-shadow.
          ringPerceivable: cs.outlineStyle !== "none" || cs.boxShadow !== "none",
          scrollLeft: viewport.scrollLeft,
        };
      });

    for (let i = 0; i < MAX_TABS && landed === null; i += 1) {
      await page.keyboard.press("Tab");
      landed = await probeFocus();
    }

    expect(
      landed,
      `keyboard focus never entered the option list within ${MAX_TABS} tabs`,
    ).not.toBeNull();
    // The destination is the option's own control, not merely "something".
    expect(landed!.role, "focus did not land on an option control").toBe("checkbox");
    expect(landed!.insideViewport, "the focused option is outside the popover").toBe(true);
    expect(landed!.focusVisible, "the focused option is not keyboard-focus-visible").toBe(true);
    expect(landed!.ringPerceivable, "the focused option draws no focus ring").toBe(true);
    expect(landed!.scrollLeft, "focus dragged the list sideways").toBe(0);
  });

  test("NEGATIVE CONTROL: reintroducing the table wrapper strands the keyword rows", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const scope = await openKeywordFilter(page);
    const control = await page.addStyleTag({ content: REINTRODUCE_TABLE_WRAPPER });
    const broken = await scrollAreaGeometry(scope);

    // Prove the cause is actually restored before claiming the defect returned.
    expect(broken.wrapper.display, "the control did not restore the cause").toBe("table");
    expect(
      broken.viewport.scrollWidth,
      "the restored cause did not reproduce the overflow",
    ).toBeGreaterThan(broken.viewport.clientWidth);
    expect(
      broken.rows.some((r) => !r.insideHorizontally),
      "the restored cause did not strand any row",
    ).toBe(true);
    expect(broken.viewport.scrollLeft).toBe(0);

    // Remove the cause again and prove the real regression is still green.
    await control.evaluate((el) => el.remove());
    expectNoHorizontalStranding(await scrollAreaGeometry(scope), "keyword filter, restored");
  });
});

/* ══ Surface 2 — AnalyticsContent target selector ══════════════════════ */

async function searchFor(page: Page, text: string) {
  await page.getByPlaceholder(/Search titles/i).fill(text);
  await expect(
    page.locator("tbody tr").filter({ hasText: text }).first(),
  ).toBeVisible({ timeout: 15_000 });
}

/**
 * Analytics derives its keyword options from the papers in view, so the long
 * fixture has to live on a paper. Written through the real Edit dialog and read
 * back first, so the exact prior value is restored in `afterEach` — the spec
 * leaves the seed as it found it and stays order-independent.
 */
async function addLongKeywordToFixturePaper(page: Page): Promise<string> {
  await searchFor(page, FIXTURE_PAPER);
  await openEditPaperDialog(page, FIXTURE_PAPER);
  const dialog = page.getByRole("dialog");
  const field = dialog.locator("#keywords");
  const original = await field.inputValue();
  await field.fill(original ? `${original}, ${LONG_KEYWORD}` : LONG_KEYWORD);
  await dialog.getByRole("button", { name: /Save Changes/ }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
  return original;
}

async function restoreFixturePaperKeywords(page: Page, original: string) {
  await searchFor(page, FIXTURE_PAPER);
  await openEditPaperDialog(page, FIXTURE_PAPER);
  const dialog = page.getByRole("dialog");
  await dialog.locator("#keywords").fill(original);
  await dialog.getByRole("button", { name: /Save Changes/ }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
}

async function openAnalyticsKeywordTargets(page: Page) {
  await page.getByRole("button", { name: /Analytics/ }).first().click();
  const trigger = page.getByRole("button", { name: /^Target Keywords/ });
  await expect(trigger).toBeVisible({ timeout: 15_000 });
  await trigger.click();
  const option = page.locator("[data-radix-popper-content-wrapper] label").first();
  await expect(option).toBeAttached({ timeout: 10_000 });
  return option;
}

for (const size of [
  { name: "desktop", width: 1280, height: 900 },
  { name: "narrow desktop", width: 1024, height: 800 },
]) {
  test.describe(`AnalyticsContent target selector @ ${size.name}`, () => {
    // Set before navigation, never resized mid-test: resizing to a narrow width
    // while Analytics is open UNMOUNTS the whole panel rather than reflowing it.
    test.use({ viewport: { width: size.width, height: size.height } });

    let original = "";

    test.beforeEach(async ({ page }) => {
      await page.goto("/", { waitUntil: "networkidle" });
      await waitForDashboard(page);
      original = await addLongKeywordToFixturePaper(page);
    });

    test.afterEach(async ({ page }) => {
      await page.keyboard.press("Escape");
      await restoreFixturePaperKeywords(page, original);
    });

    test("a long keyword cannot push the target list out of its popover", async ({
      page,
    }) => {
      const scope = await openAnalyticsKeywordTargets(page);

      // The fixture actually reached the option list — otherwise the geometry
      // below would be measuring only short seeded keywords and prove nothing.
      await expect(
        page.locator("[data-radix-popper-content-wrapper]").getByText(LONG_KEYWORD),
      ).toBeAttached({ timeout: 10_000 });

      const geometry = await scrollAreaGeometry(scope);
      // Before the fix this read 495 against 270.
      expectNoHorizontalStranding(geometry, `analytics targets @ ${size.name}`);
      expect(geometry.wrapper.display).toBe("block");

      const long = geometry.truncating.find((l) =>
        LONG_KEYWORD.startsWith(l.text.trim().slice(0, 20)),
      );
      expect(long?.clipsItself, "the long keyword draws no ellipsis").toBe(true);
    });

    test("NEGATIVE CONTROL: reintroducing the table wrapper strands the target rows", async ({
      page,
    }) => {
      const scope = await openAnalyticsKeywordTargets(page);
      const control = await page.addStyleTag({ content: REINTRODUCE_TABLE_WRAPPER });
      const broken = await scrollAreaGeometry(scope);

      expect(broken.wrapper.display, "the control did not restore the cause").toBe("table");
      expect(
        broken.viewport.scrollWidth,
        "the restored cause did not reproduce the overflow",
      ).toBeGreaterThan(broken.viewport.clientWidth);
      expect(
        broken.rows.some((r) => !r.insideHorizontally),
        "the restored cause did not strand any row",
      ).toBe(true);
      expect(broken.viewport.scrollLeft).toBe(0);

      await control.evaluate((el) => el.remove());
      expectNoHorizontalStranding(
        await scrollAreaGeometry(scope),
        `analytics targets @ ${size.name}, restored`,
      );
    });
  });
}

test.describe("AnalyticsContent on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  /**
   * Proving the routing decision rather than assuming it. Below 768px Analytics
   * is a sheet reached through the More menu, and its target selector is
   * `MobileMultiSelectSheet` — a plain overflow container, not a `ScrollArea`.
   * The repaired popover genuinely does not exist at this width, so asserting
   * its geometry here would be asserting nothing.
   */
  test("the target selector is a sheet with no ScrollArea, not the desktop popover", async ({
    page,
  }) => {
    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);

    await page.getByRole("button", { name: "More library actions" }).click();
    const actions = page.getByRole("dialog", { name: "Library actions" });
    await actions.getByRole("button", { name: /Analytics & Insights/ }).click();

    const trigger = page.getByRole("button", { name: /^Target Keywords/ });
    await expect(trigger).toBeVisible({ timeout: 15_000 });
    await trigger.click();

    const sheet = page.getByRole("dialog").filter({ hasText: /Target Keywords|Keywords/ }).last();
    await expect(sheet).toBeVisible({ timeout: 10_000 });

    const composition = await sheet.evaluate((node: HTMLElement) => ({
      scrollAreas: node.querySelectorAll("[data-radix-scroll-area-viewport]").length,
      documentOverflows:
        document.documentElement.scrollWidth > document.documentElement.clientWidth,
    }));
    expect(
      composition.scrollAreas,
      "the phone sheet is rendering the desktop ScrollArea after all",
    ).toBe(0);
    expect(composition.documentOverflows, "the phone sheet overflows the screen").toBe(false);
  });
});

/* ══ Surface 3 — DeduplicationDialog ═══════════════════════════════════ */

/**
 * A duplicate pair cannot be created in the database: `idx_papers_user_doi_unique`
 * and `idx_papers_user_pmid_unique` forbid two of the user's papers sharing an
 * identifier. So the detection RPC is stubbed at the network boundary instead.
 *
 * This substitutes the DATA, never the layout: the dialog, the Radix ScrollArea,
 * the compiled Tailwind and every measurement below are the real thing, and no
 * row in the local database is touched — which is also the safest possible
 * answer to "the dedup flow must not mutate seeded data".
 */
const DUPLICATE_PAPER = (n: number) => ({
  id: `audit-dup-${n}`,
  title:
    "Comparative Effectiveness of Perioperative Dexmedetomidine Versus Propofol Sedation on Postoperative Delirium in Elderly Cardiac Surgery",
  authors: [
    "Margarethe van der Brouwershaven-Oosterhuis",
    "Konstantinos Papadimitriou-Anagnostopoulos",
  ],
  year: 2024,
  journal: "Journal of Cardiothoracic and Vascular Anaesthesia",
  pmid: `3861204${n}`,
  doi: LONG_DOI,
  abstract: "Deterministic audit fixture.",
  study_type: "Randomised Controlled Trial",
  keywords: [SHORT_KEYWORD],
  created_at: "2026-03-14T09:12:00.000Z",
});

/** The horizontal audit's fixture: one group, two copies, one unbreakable DOI. */
const HORIZONTAL_DUPLICATE_SET = [
  {
    match_type: "doi",
    match_value: LONG_DOI,
    papers: [DUPLICATE_PAPER(1), DUPLICATE_PAPER(2)],
  },
];

async function stubDuplicateScan(
  page: Page,
  groups: unknown[] = HORIZONTAL_DUPLICATE_SET,
) {
  await page.route("**/rest/v1/rpc/get_duplicate_papers*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(groups),
    });
  });
}

/** Opens Find Duplicates by its real control, which differs on the phone. */
async function openDeduplicationDialog(page: Page, mobile: boolean) {
  if (mobile) {
    await page.getByRole("button", { name: "More library actions" }).click();
    await page
      .getByRole("dialog", { name: "Library actions" })
      .getByRole("button", { name: /Find Duplicates/ })
      .click();
  } else {
    await page.getByRole("button", { name: /Find Duplicates/ }).first().click();
  }
}

/** Geometry for the dedup card: rows, the identifier badge and the copy count. */
async function dedupGeometry(page: Page) {
  return page.evaluate(() => {
    /*
     * Scope to the dialog, never `document`. The Sidebar renders its own
     * ScrollArea and comes FIRST in document order, so an unscoped
     * `document.querySelector("[data-radix-scroll-area-viewport]")` measures the
     * navigation rail — a surface this test says nothing about, and one that is
     * always contained, so the assertions would have passed while proving
     * nothing about the dialog.
     */
    const dialog = [...document.querySelectorAll('[role="dialog"]')].find((d) =>
      d.querySelector("[data-radix-scroll-area-viewport]"),
    ) as HTMLElement;
    const viewport = dialog.querySelector(
      "[data-radix-scroll-area-viewport]",
    ) as HTMLElement;
    const root = viewport.parentElement as HTMLElement;
    const wrapper = viewport.firstElementChild as HTMLElement;
    const vb = viewport.getBoundingClientRect();
    const db = dialog.getBoundingClientRect();

    const box = (el: Element | null) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(
        Math.round(r.x + r.width / 2),
        Math.round(r.y + r.height / 2),
      );
      return {
        text: (el.textContent ?? "").trim().slice(0, 40),
        insideViewport: r.left >= vb.left - 1 && r.right <= vb.right + 1,
        insideWindow: r.left >= 0 && r.right <= window.innerWidth,
        rightOverhangPx: Math.round(Math.max(0, r.right - vb.right)),
        centreHitLandsOnIt: hit !== null && (el.contains(hit) || el === hit),
      };
    };

    /*
     * The group header, the identifier badge, the copy count and the "Keep"
     * marker are measured HERE, before the row loop below drives `scrollTop`.
     *
     * That loop leaves the viewport parked on the LAST row, and since
     * DEDUPLICATION-DIALOG-VERTICAL-SCROLL-REACHABILITY-001 the viewport really
     * scrolls, so anything at the top of the list has genuinely scrolled out of
     * sight by then and `elementFromPoint` correctly returns something else.
     * Reading them first is the only ordering that asks the question this test
     * means to ask: is the badge pressable where the list actually opens?
     */
    const chromeBoxes = {
      groupCard: box(viewport.querySelector(".rounded-lg.border")),
      matchBadge: box(viewport.querySelector(".font-mono")),
      copyCount: box(
        [...viewport.querySelectorAll("span")].find((s) =>
          /\d+ copies/.test(s.textContent ?? ""),
        ) ?? null,
      ),
      keepBadge: box(
        [...viewport.querySelectorAll("div")].find(
          (d) => (d.textContent ?? "").trim() === "Keep",
        ) ?? null,
      ),
    };

    const rows = [...viewport.querySelectorAll("label")] as HTMLElement[];
    const measuredRows = rows.map((row) => {
      const r = row.getBoundingClientRect();
      const insideHorizontally = r.left >= vb.left - 1 && r.right <= vb.right + 1;
      /*
       * The band that is genuinely painted is the ScrollArea ROOT clipped by the
       * window — NOT the Radix viewport. On this surface `max-h-[55vh]` sits on
       * the root while the viewport is `h-full`, so the viewport grows to its
       * content (measured 1573px against a 464px root) and `scrollHeight ===
       * clientHeight`, i.e. it cannot scroll at all. Rows past the root's bottom
       * are clipped with no scrollbar — a VERTICAL reachability defect, tracked
       * separately and deliberately out of scope for this horizontal audit.
       * Recording `verticallyVisible` lets the horizontal contract be asserted
       * on every row without silently asserting the vertical one too.
       */
      const rootBox = root.getBoundingClientRect();
      const bandTop = Math.max(rootBox.top, 0);
      const bandBottom = Math.min(rootBox.bottom, window.innerHeight);
      viewport.scrollTop += r.top + r.height / 2 - (bandTop + bandBottom) / 2;

      const r2 = row.getBoundingClientRect();
      const top = Math.max(r2.top, bandTop);
      const bottom = Math.min(r2.bottom, bandBottom);
      const hit =
        bottom > top
          ? document.elementFromPoint(
              Math.round(r2.x + r2.width / 2),
              Math.round((top + bottom) / 2),
            )
          : null;
      return {
        text: (row.textContent ?? "").trim().slice(0, 40),
        insideHorizontally,
        rightOverhangPx: Math.round(Math.max(0, r.right - vb.right)),
        verticallyVisible: bottom > top,
        pressAtItsCentreLandsOnIt: hit !== null && row.contains(hit),
      };
    });

    return {
      windowWidth: window.innerWidth,
      dialog: {
        left: Math.round(db.left),
        right: Math.round(db.right),
        insideWindow: db.left >= 0 && db.right <= window.innerWidth + 1,
      },
      viewport: {
        clientWidth: viewport.clientWidth,
        scrollWidth: viewport.scrollWidth,
        scrollLeft: viewport.scrollLeft,
        overflowX: getComputedStyle(viewport).overflowX,
      },
      wrapper: {
        display: getComputedStyle(wrapper).display,
        width: Math.round(wrapper.getBoundingClientRect().width),
        minWidthOfARow: getComputedStyle(rows[0]).minWidth,
        wordBreakOfBadge: getComputedStyle(
          viewport.querySelector(".font-mono") as HTMLElement,
        ).wordBreak,
      },
      rows: measuredRows,
      ...chromeBoxes,
    };
  });
}

for (const size of [
  { name: "phone", width: 390, height: 844, mobile: true },
  { name: "desktop", width: 1280, height: 900, mobile: false },
]) {
  test.describe(`DeduplicationDialog @ ${size.name}`, () => {
    test.use({
      viewport: { width: size.width, height: size.height },
      hasTouch: size.mobile,
      isMobile: size.mobile,
    });

    test.beforeEach(async ({ page }) => {
      await stubDuplicateScan(page);
      await page.goto("/", { waitUntil: "networkidle" });
      await waitForDashboard(page);
      await openDeduplicationDialog(page, size.mobile);
      await expect(
        page.getByRole("dialog").getByText(/duplicate group/i).first(),
      ).toBeVisible({ timeout: 20_000 });
    });

    test("a long DOI cannot push the duplicate rows off the screen", async ({ page }) => {
      const g = await dedupGeometry(page);

      // Pre-fix at 390: viewport 324, wrapper 515, every row 174.3px past the
      // edge, carrying the "Keep" badge and copy count off-screen. Desktop was
      // already clean, which is why this is measured at both.
      expect(g.dialog.insideWindow, "the dialog itself overflows the window").toBe(true);
      expect(g.viewport.overflowX).toBe("hidden");
      expect(
        g.viewport.scrollWidth,
        "the duplicate list overflows a viewport with no horizontal scrollbar",
      ).toBeLessThanOrEqual(g.viewport.clientWidth);
      expect(g.wrapper.width).toBeLessThanOrEqual(g.viewport.clientWidth);
      expect(g.viewport.scrollLeft, "the duplicate list scrolled sideways").toBe(0);

      // Horizontal containment is the contract of this audit, and it holds for
      // EVERY row whether or not it is currently painted.
      expect(g.rows.length).toBeGreaterThan(0);
      for (const row of g.rows) {
        expect(
          row.insideHorizontally,
          `paper row "${row.text}" sits ${row.rightOverhangPx}px outside the dialog`,
        ).toBe(true);
      }

      /*
       * Pressability is asserted on the rows the user can actually see, with a
       * floor so this cannot pass vacuously against an empty list.
       *
       * The floor is ONE, deliberately. How many rows fit inside the clipped
       * band is a function of row height and therefore of font metrics: macOS
       * painted two, CI's Linux renderer painted one. Requiring two would
       * encode an assumption about the vertical clipping this test explicitly
       * does not assert — and would fail for a reason that has nothing to do
       * with horizontal reachability. Horizontal containment is still checked
       * on EVERY row above, painted or not, which is the contract that matters.
       */
      const painted = g.rows.filter((row) => row.verticallyVisible);
      expect(
        painted.length,
        "no duplicate row was painted at all",
      ).toBeGreaterThanOrEqual(1);
      for (const row of painted) {
        expect(
          row.pressAtItsCentreLandsOnIt,
          `paper row "${row.text}" cannot be pressed where it is drawn`,
        ).toBe(true);
      }

      for (const [label, part] of [
        ["group card", g.groupCard],
        ["match badge", g.matchBadge],
        ["copy count", g.copyCount],
        ["Keep badge", g.keepBadge],
      ] as const) {
        expect(part, `${label} was not rendered`).not.toBeNull();
        expect(
          part!.insideViewport,
          `${label} sits ${part!.rightOverhangPx}px outside the dialog`,
        ).toBe(true);
        expect(part!.insideWindow, `${label} sits outside the window`).toBe(true);
        expect(
          part!.centreHitLandsOnIt,
          `${label} has nothing painted at its own centre`,
        ).toBe(true);
      }
    });

    test("NEGATIVE CONTROL: restoring the unbreakable identifier strands the rows", async ({
      page,
    }) => {
      // Reintroduce exactly the pre-fix conditions — no production source is
      // altered, and the fix's own classes are what get overridden.
      const control = await page.addStyleTag({
        content:
          '[data-radix-scroll-area-viewport] label { min-width: auto !important; }' +
          ' [data-radix-scroll-area-viewport] .break-all { word-break: normal !important; }' +
          ' [data-radix-scroll-area-viewport] .justify-between { gap: 0 !important; }' +
          ' [data-radix-scroll-area-viewport] .shrink-0 { flex-shrink: 1 !important; }',
      });
      const broken = await dedupGeometry(page);

      // Prove the cause is genuinely restored before claiming the defect is back.
      expect(broken.wrapper.minWidthOfARow, "the control did not restore the cause").toBe("auto");
      expect(broken.wrapper.wordBreakOfBadge, "the control did not restore the cause").toBe("normal");

      if (size.mobile) {
        expect(
          broken.viewport.scrollWidth,
          "the restored cause did not reproduce the overflow",
        ).toBeGreaterThan(broken.viewport.clientWidth);
        expect(
          broken.rows.some((r) => !r.insideHorizontally),
          "the restored cause did not strand any row",
        ).toBe(true);
        expect(broken.viewport.scrollLeft).toBe(0);
      } else {
        // Documented asymmetry: at 1280 the row's min-content still fits, which
        // is exactly why this defect only ever bit narrow viewports.
        expect(broken.viewport.scrollWidth).toBeLessThanOrEqual(broken.viewport.clientWidth);
      }

      // Restore and prove the real regression is still green.
      await control.evaluate((el) => el.remove());
      const fixed = await dedupGeometry(page);
      expect(fixed.viewport.scrollWidth).toBeLessThanOrEqual(fixed.viewport.clientWidth);
      expect(fixed.rows.every((r) => r.insideHorizontally)).toBe(true);
    });
  });
}

/* ══ Surface 3b — DeduplicationDialog, VERTICAL reach ══════════════════ */

/**
 * DEDUPLICATION-DIALOG-VERTICAL-SCROLL-REACHABILITY-001
 *
 * The horizontal audit above recorded — and deliberately did not fix — a second
 * defect on this same surface: the duplicate list could not be scrolled at all.
 *
 * `<ScrollArea className="flex-1 max-h-[55vh]">` put the cap on the Radix ROOT.
 * The root is a `flex-1` item of an auto-height column, so its used height comes
 * from its content and is only then clamped, and a clamped auto height is not a
 * DEFINITE height — so the viewport's `h-full` resolved to `auto` and the
 * viewport grew to its content instead of becoming the scrolling box. Measured
 * on `9d6c0c8` at 390x844 with three duplicate groups: root 464px with
 * `overflow: hidden`, viewport 2602px, `scrollHeight === clientHeight`, no
 * scrollbar mounted, the wheel moved nothing, and 7 of the 9 paper rows started
 * below the root's bottom edge with no way to reach them. Same mechanism at
 * 1024x800 (root 440 / viewport 1469) and 1280x900 (root 495 / viewport 1469).
 *
 * The cap now sits on the viewport itself, so ONE element owns both the bounded
 * height and the scrolling. Nothing below reaches a row with `scrollIntoView()`
 * or a `scrollTop` assignment: the last row is reached with the wheel, with a
 * synthesized touch gesture, or with the keyboard, and `scrollLeft` is asserted
 * 0 throughout so the vertical fix cannot quietly buy itself horizontal room.
 */

/** The cap the dialog intends for the results region, as a fraction of the window. */
const RESULTS_CAP_VH = 0.55;

const LONG_SET_TITLES = [
  "Comparative Effectiveness of Perioperative Dexmedetomidine Versus Propofol Sedation on Postoperative Delirium in Elderly Cardiac Surgery",
  "Restrictive Versus Liberal Transfusion Thresholds After Coronary Artery Bypass Grafting: A Multicentre Randomised Trial",
  "Remote Ischaemic Preconditioning and Acute Kidney Injury Following Valve Replacement Surgery",
];
const LONG_SET_AUTHORS = [
  ["Margarethe van der Brouwershaven-Oosterhuis", "Konstantinos Papadimitriou-Anagnostopoulos"],
  ["Aleksandra Wiśniewska-Kowalczyk", "Rajesh Venkataraman Subramanian"],
  ["Bartholomew Fitzwilliam-Harrington", "Yuki Matsumoto-Nakagawa"],
];

/**
 * Group 0 keeps the audit's unbreakable DOI, so the hard combined case — a long
 * single-token identifier AND enough rows to overflow vertically, at 390px — is
 * exercised on the same DOM the vertical assertions measure.
 */
function longSetPaper(group: number, n: number) {
  return {
    id: `vert-dup-${group}-${n}`,
    title: LONG_SET_TITLES[(group + n) % LONG_SET_TITLES.length],
    authors: LONG_SET_AUTHORS[(group + n) % LONG_SET_AUTHORS.length],
    year: 2020 + ((group + n) % 5),
    journal: "Journal of Cardiothoracic and Vascular Anaesthesia",
    pmid: `386120${group}${n}`,
    doi: group === 0 ? LONG_DOI : `10.1097/aln.000000000000${group}${n}`,
    abstract: "Deterministic audit fixture.",
    study_type: "Randomised Controlled Trial",
    keywords: [SHORT_KEYWORD],
    created_at: "2026-03-14T09:12:00.000Z",
  };
}

/** Three groups of three. Taller than the cap at every audited viewport. */
const LONG_DUPLICATE_SET = Array.from({ length: 3 }, (_, g) => ({
  match_type: g === 0 ? "doi" : "pmid",
  match_value: g === 0 ? LONG_DOI : `3861200${g}`,
  papers: Array.from({ length: 3 }, (_, n) => longSetPaper(g, n)),
}));

/** One small group whose content fits inside the cap at every audited viewport. */
const SHORT_DUPLICATE_SET = [
  {
    match_type: "pmid",
    match_value: "33991001",
    papers: [0, 1].map((n) => ({
      id: `vert-short-${n}`,
      title: "Aspirin and Stroke Prevention",
      authors: ["Lee J"],
      year: 2021 + n,
      journal: "Stroke",
      pmid: `3399100${n}`,
      doi: `10.1161/str.${n}`,
      abstract: null,
      study_type: "Meta-Analysis",
      keywords: [],
      created_at: "2026-03-14T09:12:00.000Z",
    })),
  },
];

/**
 * Vertical geometry for the duplicate list. Measures ONLY — it never scrolls, so
 * a "before" reading is genuinely before.
 *
 * The painted band is the ScrollArea ROOT clipped by the window, not the Radix
 * viewport's raw box: on the broken baseline the viewport ran 2602px down a
 * 844px screen, so a viewport-relative reading would have called rows "inside"
 * that nothing ever drew.
 */
async function dedupVerticalGeometry(page: Page) {
  return page.evaluate(() => {
    const dialog = [...document.querySelectorAll('[role="dialog"]')].find((d) =>
      d.querySelector("[data-radix-scroll-area-viewport]"),
    ) as HTMLElement;
    const viewport = dialog.querySelector(
      "[data-radix-scroll-area-viewport]",
    ) as HTMLElement;
    const root = viewport.parentElement as HTMLElement;
    const wrapper = viewport.firstElementChild as HTMLElement;
    const rb = root.getBoundingClientRect();
    const vb = viewport.getBoundingClientRect();
    const db = dialog.getBoundingClientRect();
    const rs = getComputedStyle(root);
    const vs = getComputedStyle(viewport);

    const bandTop = Math.max(rb.top, 0);
    const bandBottom = Math.min(rb.bottom, window.innerHeight);

    const measure = (el: HTMLElement, i: number) => {
      const r = el.getBoundingClientRect();
      const top = Math.max(r.top, bandTop);
      const bottom = Math.min(r.bottom, bandBottom);
      const hit =
        bottom > top
          ? document.elementFromPoint(
              Math.round(r.x + r.width / 2),
              Math.round((top + bottom) / 2),
            )
          : null;
      return {
        index: i,
        text: (el.textContent ?? "").trim().slice(0, 40),
        top: Math.round(r.top),
        bottom: Math.round(r.bottom),
        // PR #235's axis, re-measured on the taller fixture: this list has no
        // horizontal scrollbar, so anything past the right edge is unreachable.
        insideHorizontally: r.left >= vb.left - 1 && r.right <= vb.right + 1,
        rightOverhangPx: Math.round(Math.max(0, r.right - vb.right)),
        // Fully inside the scrolling box — the acceptance shape for a row that
        // is shorter than the viewport.
        containedInViewport: r.top >= vb.top - 1 && r.bottom <= vb.bottom + 1,
        // Drawn somewhere a person can see, however partially.
        paintedAtAll: bottom > top,
        pressAtItsCentreLandsOnIt: hit !== null && el.contains(hit),
      };
    };

    const rows = ([...viewport.querySelectorAll("label")] as HTMLElement[]).map(measure);
    const groups = ([...viewport.querySelectorAll(".rounded-lg.border")] as HTMLElement[]).map(
      measure,
    );
    const scrollbars = [...root.querySelectorAll(":scope > [data-orientation]")].map((b) => ({
      orientation: b.getAttribute("data-orientation"),
      state: b.getAttribute("data-state"),
      height: Math.round(b.getBoundingClientRect().height),
      thumbs: b.querySelectorAll("[data-state]").length,
    }));

    const chrome = (label: string, el: Element | null) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(
        Math.round(r.x + r.width / 2),
        Math.round(r.y + r.height / 2),
      );
      return {
        label,
        insideWindow:
          r.top >= 0 && r.bottom <= window.innerHeight + 1 && r.left >= 0 && r.right <= window.innerWidth + 1,
        centreHitLandsOnIt: hit !== null && (el.contains(hit) || el === hit),
      };
    };

    return {
      window: { width: window.innerWidth, height: window.innerHeight },
      documentOverflowsX:
        document.documentElement.scrollWidth > document.documentElement.clientWidth,
      dialog: {
        top: Math.round(db.top),
        bottom: Math.round(db.bottom),
        height: Math.round(db.height),
        insideWindow: db.top >= -1 && db.bottom <= window.innerHeight + 1,
      },
      root: {
        top: Math.round(rb.top),
        bottom: Math.round(rb.bottom),
        height: Math.round(rb.height),
        clientHeight: root.clientHeight,
        scrollHeight: root.scrollHeight,
        scrollTop: root.scrollTop,
        cssMaxHeight: rs.maxHeight,
        overflow: rs.overflow,
      },
      viewport: {
        top: Math.round(vb.top),
        bottom: Math.round(vb.bottom),
        height: Math.round(vb.height),
        clientHeight: viewport.clientHeight,
        scrollHeight: viewport.scrollHeight,
        scrollTop: Math.round(viewport.scrollTop),
        maxScrollTop: viewport.scrollHeight - viewport.clientHeight,
        clientWidth: viewport.clientWidth,
        scrollWidth: viewport.scrollWidth,
        scrollLeft: viewport.scrollLeft,
        cssMaxHeight: vs.maxHeight,
        overflowY: vs.overflowY,
        overflowX: vs.overflowX,
        // The viewport must be the thing the root shows, not something the root
        // clips: these two are what the broken baseline got wrong.
        containedByRoot: vb.top >= rb.top - 1 && vb.bottom <= rb.bottom + 1,
        containedByWindow: vb.top >= -1 && vb.bottom <= window.innerHeight + 1,
      },
      wrapper: {
        height: Math.round(wrapper.getBoundingClientRect().height),
        display: getComputedStyle(wrapper).display,
      },
      rows,
      groups,
      scrollbars,
      chrome: [
        chrome("dialog title", dialog.querySelector("h2")),
        chrome(
          "Cancel button",
          [...dialog.querySelectorAll("button")].find(
            (b) => (b.textContent ?? "").trim() === "Cancel",
          ) ?? null,
        ),
        chrome(
          "Merge All button",
          [...dialog.querySelectorAll("button")].find((b) =>
            /^Merge All/.test((b.textContent ?? "").trim()),
          ) ?? null,
        ),
      ],
    };
  });
}

type VerticalGeometry = Awaited<ReturnType<typeof dedupVerticalGeometry>>;

/**
 * `aria-checked` for every paper option, in list order.
 *
 * Scoped to the dedup dialog on purpose. An unscoped
 * `document.querySelector("[data-radix-scroll-area-viewport]")` finds the
 * Sidebar's ScrollArea — it comes first in document order and holds no radios —
 * so the probe returns `[]` and every comparison against it passes vacuously.
 * That is precisely the false green this suite exists to refuse.
 */
async function checkedStates(page: Page) {
  return page.evaluate(() => {
    const dialog = [...document.querySelectorAll('[role="dialog"]')].find((d) =>
      d.querySelector("[data-radix-scroll-area-viewport]"),
    ) as HTMLElement;
    const v = dialog.querySelector("[data-radix-scroll-area-viewport]") as HTMLElement;
    return [...v.querySelectorAll('[role="radio"]')].map((r) =>
      r.getAttribute("aria-checked"),
    );
  });
}

/** The on-screen centre of the results viewport — a point a person could put a
 *  finger or a cursor on. Kept inside the window so hit tests stay meaningful. */
async function resultsPointer(page: Page) {
  return page.evaluate(() => {
    const dialog = [...document.querySelectorAll('[role="dialog"]')].find((d) =>
      d.querySelector("[data-radix-scroll-area-viewport]"),
    ) as HTMLElement;
    const v = dialog.querySelector("[data-radix-scroll-area-viewport]") as HTMLElement;
    const b = v.getBoundingClientRect();
    return {
      x: Math.round(b.x + b.width / 2),
      y: Math.round(
        (Math.max(b.top, 0) + Math.min(b.bottom, window.innerHeight)) / 2,
      ),
    };
  });
}

/** Mouse wheel over the results region. No element API is touched. */
async function wheelResults(page: Page, deltaY: number, ticks = 1) {
  const pt = await resultsPointer(page);
  await page.mouse.move(pt.x, pt.y);
  for (let i = 0; i < ticks; i++) await page.mouse.wheel(0, deltaY);
  await page.waitForTimeout(120);
}

/**
 * A real touch drag, injected as raw input through CDP.
 *
 * Playwright's `touchscreen` only taps, and synthetic touch DOM events do not
 * drive Chromium's scrolling at all — so a "touch works" claim built from
 * `dispatchEvent` would prove nothing. `Input.synthesizeScrollGesture` goes
 * through the compositor exactly as a finger does.
 */
async function touchDragResults(page: Page, yDistance: number) {
  const pt = await resultsPointer(page);
  const client = await page.context().newCDPSession(page);
  await client.send("Input.synthesizeScrollGesture", {
    x: pt.x,
    y: pt.y,
    yDistance,
    gestureSourceType: "touch",
    speed: 4000,
  });
  await client.detach();
  await page.waitForTimeout(120);
}

/** The bounded-scrolling contract, asserted wherever the list overflows. */
function expectBoundedScrollingList(g: VerticalGeometry, where: string) {
  const cap = Math.round(g.window.height * RESULTS_CAP_VH);

  expect(
    g.viewport.scrollHeight,
    `${where}: the results viewport has no scroll range — it sized to its content instead of scrolling`,
  ).toBeGreaterThan(g.viewport.clientHeight);
  expect(
    g.viewport.clientHeight,
    `${where}: the results region grew past its ${cap}px cap`,
  ).toBeLessThanOrEqual(cap + 2);
  expect(
    g.viewport.containedByRoot,
    `${where}: the root is clipping an oversized viewport again`,
  ).toBe(true);
  expect(
    g.viewport.containedByWindow,
    `${where}: the results viewport runs off the screen`,
  ).toBe(true);
  expect(
    g.root.scrollHeight,
    `${where}: the ScrollArea root is hiding overflow of its own`,
  ).toBeLessThanOrEqual(g.root.clientHeight + 1);
  expect(g.dialog.insideWindow, `${where}: the dialog runs off the screen`).toBe(true);

  // PR #235's contract, re-asserted here: the vertical fix must not buy itself
  // room on the axis this surface cannot scroll.
  expect(g.viewport.overflowX, `${where}: horizontal overflow became scrollable`).toBe("hidden");
  expect(
    g.viewport.scrollWidth,
    `${where}: the duplicate list overflows a viewport with no horizontal scrollbar`,
  ).toBeLessThanOrEqual(g.viewport.clientWidth);
  expect(g.viewport.scrollLeft, `${where}: the list scrolled sideways`).toBe(0);
  expect(g.documentOverflowsX, `${where}: the page itself overflows sideways`).toBe(false);

  // Every row, painted or not — the long unbreakable DOI in group 1 is exactly
  // the shape PR #235 fixed, and it must stay contained now that the list is
  // also taller than its box.
  expect(g.rows.length, `${where}: nothing was measured`).toBeGreaterThan(0);
  for (const row of g.rows) {
    expect(
      row.insideHorizontally,
      `${where}: "${row.text}" sits ${row.rightOverhangPx}px outside on the axis the user cannot scroll`,
    ).toBe(true);
  }
}

for (const size of [
  { name: "phone", width: 390, height: 844, mobile: true },
  { name: "tablet", width: 1024, height: 800, mobile: false },
  { name: "desktop", width: 1280, height: 900, mobile: false },
]) {
  test.describe(`DeduplicationDialog vertical reach @ ${size.name}`, () => {
    test.use({
      viewport: { width: size.width, height: size.height },
      hasTouch: size.mobile,
      isMobile: size.mobile,
    });

    async function openWith(page: Page, groups: unknown[]) {
      await stubDuplicateScan(page, groups);
      await page.goto("/", { waitUntil: "networkidle" });
      await waitForDashboard(page);
      await openDeduplicationDialog(page, size.mobile);
      await expect(
        page.getByRole("dialog").getByText(/duplicate group/i).first(),
      ).toBeVisible({ timeout: 20_000 });
      // Radix animates the dialog in; measuring mid-transform reads a rect that
      // is real but transient.
      await page.waitForTimeout(400);
    }

    test("a long duplicate list is capped and genuinely scrollable", async ({ page }) => {
      await openWith(page, LONG_DUPLICATE_SET);
      const g = await dedupVerticalGeometry(page);

      // Pre-fix at this exact fixture: viewport 2602/1469 tall with
      // scrollHeight === clientHeight, i.e. no scroll range whatsoever.
      expect(g.viewport.scrollTop, "the list scrolled before it was measured").toBe(0);
      expectBoundedScrollingList(g, `${size.name} long list`);

      // The cap belongs to the element that scrolls, and to nothing else.
      expect(
        g.viewport.cssMaxHeight,
        "the cap is no longer on the Radix viewport",
      ).not.toBe("none");
      expect(
        g.root.cssMaxHeight,
        "the cap moved back onto the ScrollArea root, which cannot scroll",
      ).toBe("none");
      expect(g.viewport.overflowY).toBe("scroll");

      // The defect's signature, stated as a floor: content must exceed the box.
      expect(g.wrapper.height).toBeGreaterThan(g.viewport.clientHeight);
      expect(g.rows.length).toBe(9);
      expect(g.groups.length).toBe(3);
      expect(
        g.rows.filter((r) => r.paintedAtAll).length,
        "the whole list fits — this fixture is no longer a long one",
      ).toBeLessThan(g.rows.length);

      // Radix mounts the scrollbar on hover (`type="hover"` is the primitive's
      // default), so hovering is part of the contract, not a workaround.
      await wheelResults(page, 0);
      const hovered = await dedupVerticalGeometry(page);
      const vertical = hovered.scrollbars.find((b) => b.orientation === "vertical");
      expect(vertical, "no vertical scrollbar was mounted for an overflowing list").toBeTruthy();
      expect(vertical!.thumbs, "the scrollbar mounted without a thumb").toBeGreaterThan(0);
    });

    test("the wheel reaches every duplicate group and the last paper row", async ({ page }) => {
      await openWith(page, LONG_DUPLICATE_SET);

      const before = await dedupVerticalGeometry(page);
      const lastRow = before.rows[before.rows.length - 1];
      const lastGroup = before.groups[before.groups.length - 1];
      // The acceptance is only meaningful if the target starts out of reach.
      expect(
        lastRow.paintedAtAll,
        "the last paper row was already painted — nothing to prove",
      ).toBe(false);
      expect(lastRow.bottom).toBeGreaterThan(before.viewport.bottom);
      expect(lastGroup.paintedAtAll).toBe(false);

      // Walk the list the way a person does: repeated wheel notches, measuring
      // between them. Nothing here calls scrollIntoView or sets scrollTop.
      const reachedRows = new Set<number>();
      const reachedGroups = new Set<number>();
      let scrollTop = 0;
      let stalled = 0;
      for (let step = 0; step < 40 && stalled < 3; step++) {
        const g = await dedupVerticalGeometry(page);
        for (const r of g.rows) {
          if (r.containedInViewport && r.pressAtItsCentreLandsOnIt) reachedRows.add(r.index);
        }
        for (const c of g.groups) if (c.paintedAtAll) reachedGroups.add(c.index);
        stalled = g.viewport.scrollTop === scrollTop && step > 0 ? stalled + 1 : 0;
        scrollTop = g.viewport.scrollTop;
        await wheelResults(page, Math.round(before.viewport.clientHeight / 3));
      }

      const after = await dedupVerticalGeometry(page);
      expect(after.viewport.scrollTop, "the wheel did not move the results region").toBeGreaterThan(0);
      expect(
        after.viewport.scrollTop,
        "the wheel could not drive the list to its end",
      ).toBe(after.viewport.maxScrollTop);
      expect(after.viewport.scrollLeft, "wheeling moved the list sideways").toBe(0);

      const finalRow = after.rows[after.rows.length - 1];
      expect(
        finalRow.containedInViewport,
        "the last paper row never came fully inside the results viewport",
      ).toBe(true);
      expect(
        finalRow.pressAtItsCentreLandsOnIt,
        "the last paper row cannot be pressed where it is drawn",
      ).toBe(true);

      expect(
        [...reachedRows].length,
        `only rows ${[...reachedRows].join(",")} of ${before.rows.length} could be reached`,
      ).toBe(before.rows.length);
      expect([...reachedGroups].length).toBe(before.groups.length);

      // Header and footer are outside the scroller and must stay put.
      for (const part of after.chrome) {
        expect(part, "dialog chrome went missing").not.toBeNull();
        expect(part!.insideWindow, `${part!.label} left the screen`).toBe(true);
        expect(part!.centreHitLandsOnIt, `${part!.label} is not pressable`).toBe(true);
      }

      // And back up again: the first group is still reachable.
      await wheelResults(page, -Math.round(before.viewport.clientHeight / 2), 12);
      const back = await dedupVerticalGeometry(page);
      expect(back.viewport.scrollTop).toBe(0);
      expect(back.rows[0].containedInViewport).toBe(true);
      expect(back.rows[0].pressAtItsCentreLandsOnIt).toBe(true);
    });

    if (size.mobile) {
      test("a touch drag reaches the last paper row", async ({ page }) => {
        await openWith(page, LONG_DUPLICATE_SET);
        const before = await dedupVerticalGeometry(page);
        expect(before.rows[before.rows.length - 1].paintedAtAll).toBe(false);

        // Negative yDistance drags content upward, i.e. scrolls down.
        for (let i = 0; i < 12; i++) await touchDragResults(page, -400);

        const after = await dedupVerticalGeometry(page);
        expect(
          after.viewport.scrollTop,
          "a touch drag did not scroll the duplicate list",
        ).toBeGreaterThan(0);
        expect(after.viewport.scrollTop).toBe(after.viewport.maxScrollTop);
        expect(after.viewport.scrollLeft).toBe(0);
        expect(
          after.rows[after.rows.length - 1].containedInViewport,
          "the last paper row is unreachable by touch",
        ).toBe(true);
        expect(after.documentOverflowsX, "the page moved sideways under the finger").toBe(false);
      });
    }

    test("keyboard focus reaches a paper option that started below the fold", async ({ page }) => {
      await openWith(page, LONG_DUPLICATE_SET);

      const before = await page.evaluate(() => {
        const dialog = [...document.querySelectorAll('[role="dialog"]')].find((d) =>
          d.querySelector("[data-radix-scroll-area-viewport]"),
        ) as HTMLElement;
        const v = dialog.querySelector("[data-radix-scroll-area-viewport]") as HTMLElement;
        const radios = [...v.querySelectorAll('[role="radio"]')] as HTMLElement[];
        const last = radios[radios.length - 1].getBoundingClientRect();
        const vb = v.getBoundingClientRect();
        return {
          count: radios.length,
          lastStartsBelowTheFold: last.top > vb.bottom,
          scrollTop: v.scrollTop,
        };
      });
      expect(before.count).toBe(9);
      expect(
        before.lastStartsBelowTheFold,
        "the final radio is already on screen — the keyboard journey proves nothing",
      ).toBe(true);

      /** Where focus is, in the list's own terms. */
      const focus = () =>
        page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          const dialog = [...document.querySelectorAll('[role="dialog"]')].find((d) =>
            d.querySelector("[data-radix-scroll-area-viewport]"),
          ) as HTMLElement;
          const v = dialog.querySelector("[data-radix-scroll-area-viewport]") as HTMLElement;
          const radios = [...v.querySelectorAll('[role="radio"]')] as HTMLElement[];
          const index = el ? radios.indexOf(el) : -1;
          const vb = v.getBoundingClientRect();
          const r = el?.getBoundingClientRect();
          const style = el ? getComputedStyle(el) : null;
          const centre =
            r && document.elementFromPoint(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2));
          return {
            index,
            insideDialog: !!el && dialog.contains(el),
            isTheScrollViewport: el === v,
            tag: el?.tagName ?? null,
            intersectsViewport: !!r && r.bottom > vb.top && r.top < vb.bottom,
            containedInViewport: !!r && r.top >= vb.top - 1 && r.bottom <= vb.bottom + 1,
            centreInsideDialog:
              !!r &&
              r.y + r.height / 2 >= dialog.getBoundingClientRect().top &&
              r.y + r.height / 2 <= dialog.getBoundingClientRect().bottom,
            centreHitLandsOnIt: !!centre && !!el && (el.contains(centre) || el === centre),
            focusVisible: !!el && el.matches(":focus-visible"),
            ring: style?.boxShadow ?? "none",
            scrollTop: Math.round(v.scrollTop),
            scrollLeft: v.scrollLeft,
          };
        });

      /*
       * Walk to the final option with real keys only — never `.focus()`.
       *
       * Radix gives each RadioGroup a roving tabindex, so Arrow keys move
       * WITHIN a group and Tab crosses to the next one. With three papers per
       * group that makes the rule: ArrowDown, unless focus is already on a
       * group's last option (or outside the list), in which case Tab. The
       * journey is recorded so a failure says where the keyboard actually went.
       */
      const journey: number[] = [];
      let state = await focus();
      journey.push(state.index);
      for (let step = 0; step < 24 && state.index !== before.count - 1; step++) {
        const atGroupEnd = state.index >= 0 && state.index % 3 === 2;
        await page.keyboard.press(state.index < 0 || atGroupEnd ? "Tab" : "ArrowDown");
        // Radix moves roving focus and React commits the resulting selection
        // change before the next item is focusable; reading straight after the
        // keyup samples the previous tab stop.
        await page.waitForTimeout(80);
        state = await focus();
        journey.push(state.index);
        expect(
          state.insideDialog,
          `keyboard focus left the modal (journey ${journey.join(" -> ")})`,
        ).toBe(true);
      }

      expect(
        state.index,
        `the keyboard never reached the final paper option (journey ${journey.join(" -> ")})`,
      ).toBe(before.count - 1);
      expect(state.intersectsViewport, "the focused option is outside the results viewport").toBe(true);
      expect(state.containedInViewport, "the focused option is only partly reachable").toBe(true);
      expect(state.centreInsideDialog, "the focused option sits outside the dialog").toBe(true);
      expect(state.centreHitLandsOnIt, "nothing is painted where the focused option is").toBe(true);
      expect(state.focusVisible, "the focused option draws no focus indicator").toBe(true);
      expect(state.ring, "the focus ring is not rendered").not.toBe("none");
      expect(state.scrollTop, "reaching it did not scroll the results region").toBeGreaterThan(0);
      expect(state.scrollLeft, "keyboard navigation moved the list sideways").toBe(0);

      /*
       * Focus trap, and no NEW tab stop.
       *
       * Chromium makes an overflowing scroller keyboard-focusable when it has
       * no focusable children; this one has nine radios, so it must not become
       * a tab stop of its own just because it now scrolls. Tab must keep
       * cycling inside the modal and must never land on the viewport itself.
       */
      for (let i = 0; i < 14; i++) {
        await page.keyboard.press("Tab");
        const seen = await focus();
        expect(seen.insideDialog, "Tab left the modal").toBe(true);
        expect(seen.isTheScrollViewport, "the scroll viewport became its own tab stop").toBe(
          false,
        );
      }
    });

    test("a paper below the fold can be selected, and scrolling changes no selection", async ({
      page,
    }) => {
      await openWith(page, LONG_DUPLICATE_SET);

      const keptBefore = await checkedStates(page);
      expect(keptBefore.length, "the probe did not find the duplicate list").toBe(9);

      await wheelResults(page, 300, 20);
      const scrolled = await dedupVerticalGeometry(page);
      // Scrolling alone must not touch the selection.
      const keptAfterScroll = await checkedStates(page);
      expect(keptAfterScroll, "scrolling changed which paper is kept").toEqual(keptBefore);
      expect(scrolled.rows[scrolled.rows.length - 1].containedInViewport).toBe(true);

      // Now select the last paper through the real UI.
      const lastRadio = page
        .getByRole("dialog")
        .locator("[data-radix-scroll-area-viewport] [role='radio']")
        .last();
      await lastRadio.click();

      const afterSelect = await page.evaluate(() => {
        const dialog = [...document.querySelectorAll('[role="dialog"]')].find((d) =>
          d.querySelector("[data-radix-scroll-area-viewport]"),
        ) as HTMLElement;
        const v = dialog.querySelector("[data-radix-scroll-area-viewport]") as HTMLElement;
        const radios = [...v.querySelectorAll('[role="radio"]')] as HTMLElement[];
        const lastRow = ([...v.querySelectorAll("label")] as HTMLElement[]).slice(-1)[0];
        return {
          checked: radios.map((r) => r.getAttribute("aria-checked")),
          lastRowShowsKeep: /Keep$/.test((lastRow.textContent ?? "").trim()),
          scrollLeft: v.scrollLeft,
          dialogStillOpen: !!dialog,
          mergeLabel:
            [...dialog.querySelectorAll("button")]
              .map((b) => (b.textContent ?? "").trim())
              .find((t) => /^Merge All/.test(t)) ?? null,
        };
      });

      expect(afterSelect.checked[8], "the last paper did not become the kept one").toBe("true");
      // The other groups keep the selections they had.
      expect(afterSelect.checked.slice(0, 3)).toEqual(keptBefore.slice(0, 3));
      expect(afterSelect.checked.slice(3, 6)).toEqual(keptBefore.slice(3, 6));
      expect(afterSelect.lastRowShowsKeep, "the Keep marker did not follow the selection").toBe(true);
      expect(afterSelect.scrollLeft, "selecting scrolled the list sideways").toBe(0);
      // Selecting must not have merged anything.
      expect(afterSelect.dialogStillOpen).toBe(true);
      expect(afterSelect.mergeLabel).toBe("Merge All (3 groups)");

      // Scroll back up: the first group's selection survived the journey.
      await wheelResults(page, -400, 20);
      const back = await checkedStates(page);
      const backGeometry = await dedupVerticalGeometry(page);
      expect(backGeometry.viewport.scrollTop).toBe(0);
      expect(back[8], "scrolling back up dropped the new selection").toBe("true");
      expect(back.slice(0, 6)).toEqual(keptBefore.slice(0, 6));
    });

    test("a short duplicate list stays compact and does not scroll", async ({ page }) => {
      await openWith(page, SHORT_DUPLICATE_SET);
      const g = await dedupVerticalGeometry(page);
      const cap = Math.round(g.window.height * RESULTS_CAP_VH);

      expect(
        g.viewport.scrollHeight,
        "a list that fits was given a scroll range anyway",
      ).toBe(g.viewport.clientHeight);
      expect(g.viewport.maxScrollTop).toBe(0);
      expect(
        g.viewport.clientHeight,
        `the results region padded itself out to the ${cap}px cap`,
      ).toBeLessThan(cap);
      expect(
        g.root.height,
        "the ScrollArea root is taller than the list it holds",
      ).toBeLessThanOrEqual(g.viewport.height + 1);

      for (const row of g.rows) {
        expect(row.containedInViewport, `"${row.text}" is not fully visible`).toBe(true);
        expect(row.pressAtItsCentreLandsOnIt, `"${row.text}" is not pressable`).toBe(true);
      }
      expect(g.groups[0].containedInViewport, "the only group is not fully visible").toBe(true);

      // Hovering an unscrollable region must not conjure a misleading scrollbar.
      await wheelResults(page, 200, 4);
      const hovered = await dedupVerticalGeometry(page);
      expect(hovered.viewport.scrollTop, "a list that fits scrolled").toBe(0);
      expect(
        hovered.scrollbars.filter((b) => b.state === "visible").length,
        "a scrollbar was shown for content that fits",
      ).toBe(0);

      // Selection still behaves normally on a short list.
      await page
        .getByRole("dialog")
        .locator("[data-radix-scroll-area-viewport] [role='radio']")
        .last()
        .click();
      const checked = await checkedStates(page);
      expect(checked.length).toBe(2);
      expect(checked[checked.length - 1]).toBe("true");
    });

    test("the no-duplicates state renders no scrolling region at all", async ({ page }) => {
      await stubDuplicateScan(page, []);
      await page.goto("/", { waitUntil: "networkidle" });
      await waitForDashboard(page);
      await openDeduplicationDialog(page, size.mobile);
      const dialog = page.getByRole("dialog").filter({ hasText: "No duplicates found" });
      await expect(dialog).toBeVisible({ timeout: 20_000 });
      await page.waitForTimeout(300);

      const empty = await dialog.evaluate((node: HTMLElement) => {
        const r = node.getBoundingClientRect();
        return {
          scrollAreas: node.querySelectorAll("[data-radix-scroll-area-viewport]").length,
          height: Math.round(r.height),
          insideWindow: r.top >= -1 && r.bottom <= window.innerHeight + 1,
        };
      });
      expect(
        empty.scrollAreas,
        "the empty state mounted a scrolling region with nothing in it",
      ).toBe(0);
      expect(
        empty.height,
        "the empty state reserved the full capped height",
      ).toBeLessThan(Math.round(size.height * RESULTS_CAP_VH));
      expect(empty.insideWindow).toBe(true);
    });

    test("NEGATIVE CONTROL: capping the root instead of the viewport strands the last rows", async ({
      page,
    }) => {
      await openWith(page, LONG_DUPLICATE_SET);

      /*
       * Restore the exact pre-fix ownership: cap on the ScrollArea ROOT, none on
       * the Radix viewport. Specificity is deliberate — the production fix is a
       * Tailwind arbitrary variant compiling to `.<class> [data-radix-…]`, i.e.
       * (0,2,0), and an unqualified `[data-radix-…]` rule is (0,1,0) and LOSES
       * even with `!important` on both sides. `html body … :not(#x)` clears it.
       */
      const control = await page.addStyleTag({
        content:
          'html body [role="dialog"] [data-radix-scroll-area-viewport]:not(#x)' +
          " { max-height: none !important; }" +
          ' html body [role="dialog"] div:has(> [data-radix-scroll-area-viewport]):not(#x)' +
          " { max-height: 55vh !important; overflow: hidden !important; }",
      });
      await page.waitForTimeout(200);
      const broken = await dedupVerticalGeometry(page);

      // ── Prove the CAUSE is genuinely restored before claiming the defect is.
      expect(
        Math.round(parseFloat(broken.root.cssMaxHeight)),
        "the control did not put the cap back on the root",
      ).toBe(Math.round(broken.window.height * RESULTS_CAP_VH));
      expect(broken.root.overflow, "the control did not restore the root's clipping").toBe("hidden");
      expect(
        broken.viewport.cssMaxHeight,
        "the control did not take the cap off the viewport",
      ).toBe("none");
      expect(
        broken.viewport.height,
        "the viewport did not grow past the root — the old mechanism is not reproduced",
      ).toBeGreaterThan(broken.root.height);
      expect(
        broken.viewport.scrollHeight,
        "the viewport kept a scroll range — the old mechanism is not reproduced",
      ).toBe(broken.viewport.clientHeight);
      expect(broken.viewport.maxScrollTop).toBe(0);
      expect(
        broken.root.scrollHeight,
        "the root is not clipping anything — the old mechanism is not reproduced",
      ).toBeGreaterThan(broken.root.clientHeight);

      // ── Now the defect itself: the last row is unreachable by any user action.
      const strandedRow = broken.rows[broken.rows.length - 1];
      expect(strandedRow.paintedAtAll, "the last row is still painted").toBe(false);
      expect(strandedRow.top).toBeGreaterThan(broken.root.bottom);

      await wheelResults(page, 400, 10);
      const afterWheel = await dedupVerticalGeometry(page);
      expect(afterWheel.viewport.scrollTop, "the broken viewport scrolled after all").toBe(0);
      expect(afterWheel.root.scrollTop, "the clipping root scrolled after all").toBe(0);
      expect(
        afterWheel.rows[afterWheel.rows.length - 1].paintedAtAll,
        "wheeling reached the last row on the broken baseline",
      ).toBe(false);
      expect(
        afterWheel.scrollbars.filter((b) => b.state === "visible").length,
        "the broken baseline mounted a scrollbar",
      ).toBe(0);

      // ── Remove the control; the real fix must be green again.
      await control.evaluate((el) => el.remove());
      await page.waitForTimeout(200);
      const fixed = await dedupVerticalGeometry(page);
      expectBoundedScrollingList(fixed, `${size.name} after control removal`);
      await wheelResults(page, Math.round(fixed.viewport.clientHeight / 2), 12);
      const reached = await dedupVerticalGeometry(page);
      expect(reached.viewport.scrollTop).toBeGreaterThan(0);
      expect(
        reached.rows[reached.rows.length - 1].containedInViewport,
        "the last row is unreachable once the control is gone",
      ).toBe(true);
    });
  });
}

/* ══ Surface 4 — ManageKeywordPoolModal ════════════════════════════════ */

const POOL_FIXTURES = [SHORT_KEYWORD, LONG_KEYWORD, LONG_TOKEN_KEYWORD];

/** Geometry for the pool list, measured against the WINDOW as well as the
 *  viewport — the defect here pushed the whole scroller off the screen, so a
 *  viewport-relative check alone would have called it contained. */
async function keywordPoolGeometry(page: Page) {
  return page.evaluate(() => {
    // Same rule as the dedup helper: the pool dialog is the one holding the
    // Remove controls, not merely the first dialog or the first ScrollArea.
    const dialog = [...document.querySelectorAll('[role="dialog"]')].find((d) =>
      d.querySelector("button[aria-label^='Remove keyword']"),
    ) as HTMLElement;
    const viewport = dialog.querySelector(
      "[data-radix-scroll-area-viewport]",
    ) as HTMLElement;
    const root = viewport.parentElement as HTMLElement;
    const db = dialog.getBoundingClientRect();
    const rb = root.getBoundingClientRect();

    const removes = ([...viewport.querySelectorAll("button[aria-label^='Remove keyword']")] as HTMLElement[])
      .map((btn) => {
        const r = btn.getBoundingClientRect();
        const hit = document.elementFromPoint(
          Math.round(r.x + r.width / 2),
          Math.round(r.y + r.height / 2),
        );
        return {
          name: (btn.getAttribute("aria-label") ?? "").slice(0, 50),
          insideWindow: r.left >= 0 && r.right <= window.innerWidth,
          rightOverhangPastWindow: Math.round(Math.max(0, r.right - window.innerWidth)),
          centreHitLandsOnIt: hit !== null && (btn.contains(hit) || btn === hit),
        };
      });

    return {
      windowWidth: window.innerWidth,
      dialogInsideWindow: db.left >= -1 && db.right <= window.innerWidth + 1,
      scrollAreaRoot: {
        width: Math.round(rb.width),
        right: Math.round(rb.right),
        insideWindow: rb.left >= -1 && rb.right <= window.innerWidth + 1,
      },
      viewport: {
        clientWidth: viewport.clientWidth,
        scrollWidth: viewport.scrollWidth,
        scrollLeft: viewport.scrollLeft,
        overflowX: getComputedStyle(viewport).overflowX,
      },
      wrapperWidth: Math.round(
        (viewport.firstElementChild as HTMLElement).getBoundingClientRect().width,
      ),
      actionRowWrap: getComputedStyle(
        dialog.querySelector(".flex.flex-wrap.gap-2, .flex.gap-2") as HTMLElement,
      ).flexWrap,
      removes,
    };
  });
}

for (const size of [
  { name: "phone", width: 390, height: 844, mobile: true },
  { name: "desktop", width: 1280, height: 900, mobile: false },
]) {
  test.describe(`ManageKeywordPoolModal @ ${size.name}`, () => {
    test.use({
      viewport: { width: size.width, height: size.height },
      hasTouch: size.mobile,
      isMobile: size.mobile,
    });

    test.beforeEach(async ({ page }) => {
      await page.goto("/", { waitUntil: "networkidle" });
      await waitForDashboard(page);
      await addPoolKeywords(page, POOL_FIXTURES, size.mobile);
    });

    test.afterEach(async ({ page }) => {
      await removePoolKeywords(page, POOL_FIXTURES, size.mobile);
    });

    test("every destructive Remove control stays on the screen", async ({ page }) => {
      const g = await keywordPoolGeometry(page);

      /*
       * Pre-fix at 390: the three `whitespace-nowrap` action buttons had a
       * combined min-content of 420px, which became the dialog's grid track —
       * so the ScrollArea ROOT was laid out 420px wide inside a 390px window,
       * running to x=445. Three "Remove keyword" buttons sat entirely off the
       * screen with `elementFromPoint` returning null at their centres.
       *
       * The root is measured against the window, not just its own viewport:
       * relative to a scroller that is itself off-screen, everything looks
       * contained.
       */
      expect(g.actionRowWrap, "the action row stopped wrapping").toBe("wrap");
      expect(g.dialogInsideWindow, "the dialog overflows the window").toBe(true);
      expect(
        g.scrollAreaRoot.insideWindow,
        `the keyword list runs to x=${g.scrollAreaRoot.right} in a ${g.windowWidth}px window`,
      ).toBe(true);
      expect(g.viewport.overflowX).toBe("hidden");
      expect(
        g.viewport.scrollWidth,
        "the keyword list overflows a viewport with no horizontal scrollbar",
      ).toBeLessThanOrEqual(g.viewport.clientWidth);
      expect(g.wrapperWidth).toBeLessThanOrEqual(g.viewport.clientWidth);
      expect(g.viewport.scrollLeft, "the keyword list scrolled sideways").toBe(0);

      // Ordinary short keywords and pathological ones alike.
      expect(g.removes.length).toBe(POOL_FIXTURES.length);
      for (const remove of g.removes) {
        expect(
          remove.insideWindow,
          `"${remove.name}" sits ${remove.rightOverhangPastWindow}px past the right edge of the screen`,
        ).toBe(true);
        expect(
          remove.centreHitLandsOnIt,
          `"${remove.name}" has nothing painted at its own centre`,
        ).toBe(true);
      }
    });

    test("NEGATIVE CONTROL: an unwrapped action row strands the Remove controls", async ({
      page,
    }) => {
      const control = await page.addStyleTag({
        content:
          '[role="dialog"] .flex.flex-wrap.gap-2 { flex-wrap: nowrap !important; }' +
          ' [data-radix-scroll-area-viewport] span.break-all { word-break: normal !important; }',
      });
      const broken = await keywordPoolGeometry(page);

      // Prove the cause is genuinely restored first.
      expect(broken.actionRowWrap, "the control did not restore the cause").toBe("nowrap");

      // Restore the fixed state before asserting anything else — and before
      // `afterEach` tries to press Remove controls this control just pushed
      // off the screen, which it could not reach either.
      const restore = async () => {
        await control.evaluate((el) => el.remove());
        const fixed = await keywordPoolGeometry(page);
        expect(fixed.actionRowWrap).toBe("wrap");
        expect(fixed.scrollAreaRoot.insideWindow).toBe(true);
        expect(fixed.removes.every((r) => r.insideWindow && r.centreHitLandsOnIt)).toBe(true);
      };

      if (size.mobile) {
        expect(
          broken.scrollAreaRoot.insideWindow,
          "the restored cause did not push the list off the screen",
        ).toBe(false);
        expect(
          broken.removes.filter((r) => !r.insideWindow).length,
          "the restored cause did not strand any Remove control",
        ).toBeGreaterThan(0);
        expect(
          broken.removes.filter((r) => !r.centreHitLandsOnIt).length,
          "the restored cause did not break any centre hit-test",
        ).toBeGreaterThan(0);
      } else {
        // At 1280 the same markup fits, which is why this only bit phones.
        expect(broken.scrollAreaRoot.insideWindow).toBe(true);
      }
      await restore();
    });
  });
}
