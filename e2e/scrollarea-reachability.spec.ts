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

async function stubDuplicateScan(page: Page) {
  await page.route("**/rest/v1/rpc/get_duplicate_papers*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        {
          match_type: "doi",
          match_value: LONG_DOI,
          papers: [DUPLICATE_PAPER(1), DUPLICATE_PAPER(2)],
        },
      ]),
    });
  });
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
      if (size.mobile) {
        await page.getByRole("button", { name: "More library actions" }).click();
        await page
          .getByRole("dialog", { name: "Library actions" })
          .getByRole("button", { name: /Find Duplicates/ })
          .click();
      } else {
        await page.getByRole("button", { name: /Find Duplicates/ }).first().click();
      }
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
