import { test, expect, type Locator, type Page } from "@playwright/test";
import { waitForDashboard } from "./helpers";

/**
 * ADD-PAPERS-MOBILE-SELECTORS-001 — searchable multi-selects on a phone.
 *
 * The owner tested Production on an iPhone and reported one defect class across
 * three surfaces: every searchable multi-select is a desktop anchored `Popover`
 * nested inside a modal Dialog/Sheet, so tapping it (a) autofocused its search
 * box and raised the software keyboard unbidden, (b) opened a panel anchored to
 * a trigger already near the bottom of the screen, and (c) left a list that
 * could not be reliably scrolled once the keyboard covered it.
 *
 * These tests are the runtime evidence, because the defect is entirely a
 * browser-interaction one: nothing about it is visible in a unit test.
 *
 * IMPORTANT — what constrained-viewport testing is and is not: Chromium is
 * resized to model a keyboard-shrunk screen. That is a *visual-viewport proxy*.
 * It is NOT a real iOS software keyboard, which shrinks the visual viewport
 * while leaving the layout viewport at full height. The owner's Production
 * iPhone remains the real-device evidence, and real-device confirmation after
 * rollout is still worth having.
 *
 * State: this spec creates one disposable project and one disposable tag (the
 * seed ships none, and the Add Papers assign section does not render without
 * them) and deletes both afterwards. Everything else is read-only — filters and
 * analytics targets are in-memory, and no import is ever run.
 */

const NARROW = { width: 390, height: 844 };
/** Keyboard-constrained stress proxy — see the caveat above. */
const CONSTRAINED = { width: 390, height: 420 };
const MOBILE_MAX = { width: 767, height: 900 };
const DESKTOP_MIN = { width: 768, height: 1024 };
const DESKTOP = { width: 1280, height: 720 };

// Two projects, not one: a single-option list cannot demonstrate that typing
// filters anything, and Any/All only appears from two selections.
const FIXTURE_PROJECT = "ZZ Alpha Fixture Project";
const FIXTURE_PROJECT_ALT = "ZZ Beta Fixture Project";
const FIXTURE_TAG = "ZZ Alpha Fixture Tag";

// ── Fixtures ────────────────────────────────────────────────────────────────

/** Creates the disposable project + tag through the real management modals. */
async function createEntityFixtures(page: Page) {
  await page.setViewportSize(DESKTOP);
  await page.goto("/", { waitUntil: "networkidle" });
  await waitForDashboard(page);

  const add = async (manage: string, field: string, name: string) => {
    await page.getByRole("button", { name: manage, exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    if ((await dialog.getByText(name, { exact: true }).count()) === 0) {
      await dialog.getByRole("textbox", { name: field }).fill(name);
      await dialog.getByRole("button", { name: /^Add$/ }).click();
      await expect(dialog.getByText(name, { exact: true })).toBeVisible({ timeout: 10_000 });
    }
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  };

  await add("Manage projects", "New project name", FIXTURE_PROJECT);
  await add("Manage projects", "New project name", FIXTURE_PROJECT_ALT);
  await add("Manage tags", "New tag name", FIXTURE_TAG);
}

/** Removes them again, so the suite leaves the local library exactly as found. */
async function removeEntityFixtures(page: Page) {
  await page.setViewportSize(DESKTOP);
  await page.goto("/", { waitUntil: "networkidle" });
  await waitForDashboard(page);

  const remove = async (manage: string, deleteLabel: string) => {
    await page.getByRole("button", { name: manage, exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    const del = dialog.getByRole("button", { name: deleteLabel });
    if (await del.count()) {
      await del.first().click();
      const confirm = page.getByRole("button", { name: /^Delete$/ });
      if (await confirm.isVisible({ timeout: 2_000 }).catch(() => false)) await confirm.click();
      await expect(del).toHaveCount(0, { timeout: 10_000 });
    }
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  };

  await remove("Manage projects", `Delete project ${FIXTURE_PROJECT}`);
  await remove("Manage projects", `Delete project ${FIXTURE_PROJECT_ALT}`);
  await remove("Manage tags", `Delete tag ${FIXTURE_TAG}`);
}

// ── Probes ──────────────────────────────────────────────────────────────────

interface ActiveElement {
  tag: string;
  type: string | null;
  role: string | null;
  id: string;
  ariaLabel: string | null;
  text: string;
  isBody: boolean;
  /**
   * Whether the browser would raise the software keyboard for this element.
   * `type="number"` counts — that is precisely the Publication Year field.
   */
  isTextEntry: boolean;
}

async function activeElement(page: Page): Promise<ActiveElement> {
  return page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null;
    const NON_TEXT_INPUTS = new Set([
      "button", "checkbox", "radio", "submit", "reset", "file", "range", "color", "image", "hidden",
    ]);
    const isTextEntry =
      (a instanceof HTMLInputElement && !NON_TEXT_INPUTS.has(a.type)) ||
      a instanceof HTMLTextAreaElement ||
      !!a?.isContentEditable;
    return {
      tag: a?.tagName ?? "NONE",
      type: a?.getAttribute("type") ?? null,
      role: a?.getAttribute("role") ?? null,
      id: a?.id ?? "",
      ariaLabel: a?.getAttribute("aria-label") ?? null,
      text: (a?.textContent ?? "").trim().slice(0, 60),
      isBody: a === document.body,
      isTextEntry,
    };
  });
}

interface ListMetrics {
  clientHeight: number;
  scrollHeight: number;
  scrollTop: number;
  overflows: boolean;
}

/**
 * The selector's own option-scroll container.
 *
 * Resolved by walking up from an option to the nearest ancestor that actually
 * scrolls, by computed style — so the SAME probe measures the pre-fix popover
 * (whose scroller is a Radix `ScrollArea` viewport or a cmdk `CommandList`) and
 * the post-fix sheet. That is what makes the scroll assertions a real negative
 * control rather than a test of `data-testid` existing.
 */
async function measureOptionList(overlay: Locator): Promise<ListMetrics | null> {
  return overlay.evaluate((root) => {
    const option =
      root.querySelector('[role="checkbox"]') ??
      root.querySelector('[role="option"]') ??
      root.querySelector("label");
    if (!option) return null;
    for (let el = option.parentElement; el && el !== root.parentElement; el = el.parentElement) {
      const overflowY = getComputedStyle(el).overflowY;
      if (overflowY === "auto" || overflowY === "scroll") {
        return {
          clientHeight: el.clientHeight,
          scrollHeight: el.scrollHeight,
          scrollTop: el.scrollTop,
          overflows: el.scrollHeight > el.clientHeight,
        };
      }
    }
    return null;
  });
}

async function scrollOptionList(overlay: Locator, to: number): Promise<number> {
  return overlay.evaluate((root, target) => {
    const option =
      root.querySelector('[role="checkbox"]') ??
      root.querySelector('[role="option"]') ??
      root.querySelector("label");
    if (!option) return -1;
    for (let el = option.parentElement; el && el !== root.parentElement; el = el.parentElement) {
      const overflowY = getComputedStyle(el).overflowY;
      if (overflowY === "auto" || overflowY === "scroll") {
        el.scrollTop = target;
        return el.scrollTop;
      }
    }
    return -1;
  }, to);
}

/**
 * Viewport-relative geometry.
 *
 * `Locator.boundingBox()` reports page coordinates, so a scrolled document
 * makes a correctly-pinned fixed overlay look like it hangs off the bottom of
 * the screen. `getBoundingClientRect` is what "is it on screen" actually means.
 */
async function viewportRect(locator: Locator) {
  return locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return {
      top: Math.round(r.top),
      bottom: Math.round(r.bottom),
      height: Math.round(r.height),
      viewport: window.innerHeight,
    };
  });
}

/**
 * The rect once the sheet's slide-in animation has finished.
 *
 * `toBeVisible()` resolves the instant the element is in the DOM with a box,
 * which for a bottom sheet is while it is still translated a full height below
 * the fold — measuring there reports a correctly-pinned sheet as off-screen.
 * Polling for two equal reads is not enough either: transforms only advance
 * once per frame, so two round-trips inside one frame look "settled". The Web
 * Animations API is the deterministic signal.
 */
async function settledRect(locator: Locator) {
  await locator.evaluate(async (el) => {
    await Promise.all(el.getAnimations().map((a) => a.finished.catch(() => undefined)));
  });
  return viewportRect(locator);
}

interface ParentState {
  mounted: boolean;
  /** Radix marks outside content `aria-hidden` while a modal child is open. */
  inert: boolean;
  rendered: boolean;
}

/**
 * The parent surface's state while a child selector is open.
 *
 * It is deliberately NOT asserted with `toBeVisible()`: a correctly nested modal
 * child makes its parent inert, which removes the parent from the accessibility
 * tree — so a role-based locator stops matching. That inertness *is* the
 * contract (§14), so presence is read from the DOM instead.
 */
async function parentState(page: Page, title: string): Promise<ParentState> {
  return page.evaluate((t) => {
    const el = ([...document.querySelectorAll('[role="dialog"]')] as HTMLElement[]).find((d) =>
      (d.querySelector("h2")?.textContent ?? "").trim().startsWith(t),
    );
    if (!el) return { mounted: false, inert: false, rendered: false };
    return {
      mounted: true,
      inert:
        el.getAttribute("aria-hidden") === "true" ||
        el.closest("[aria-hidden='true']") !== null,
      rendered: el.getBoundingClientRect().height > 0,
    };
  }, title);
}

// ── Parent surfaces ─────────────────────────────────────────────────────────

type Context = "add-papers" | "filters" | "analytics";

const PARENT_TITLE: Record<Context, string> = {
  "add-papers": "Add Papers",
  filters: "Filters",
  analytics: "Analytics",
};

async function openFilters(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: /^Filters/ }).click();
  const sheet = page.getByRole("dialog", { name: "Filters" });
  await expect(sheet).toBeVisible();
  return sheet;
}

async function openAnalytics(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "More library actions" }).click();
  const more = page.getByRole("dialog", { name: "Library actions" });
  await expect(more).toBeVisible();
  await more.getByRole("button", { name: /Analytics & Insights/ }).click();
  const sheet = page.getByRole("dialog", { name: /Analytics & Insights/ });
  await expect(sheet).toBeVisible();
  return sheet;
}

async function openAddPapers(
  page: Page,
  tab: "Import IDs" | "Import File" | "Manual" = "Import IDs",
): Promise<Locator> {
  await page.getByRole("button", { name: "Add papers" }).click();
  const dialog = page.getByRole("dialog", { name: "Add Papers" });
  await expect(dialog).toBeVisible();
  if (tab !== "Import IDs") {
    await dialog.getByRole("tab", { name: tab }).click();
  }
  return dialog;
}

async function openParent(page: Page, context: Context): Promise<Locator> {
  if (context === "filters") return openFilters(page);
  if (context === "analytics") return openAnalytics(page);
  return openAddPapers(page);
}

/**
 * A selector's search field, located by its accessible name.
 *
 * Deliberately an attribute selector rather than `getByRole("textbox")`: cmdk's
 * `CommandInput` — which four of the seven pre-fix selectors use — renders its
 * input as `role="combobox"`, while the post-fix sheet uses a plain textbox. A
 * role-based locator would therefore "fail" on the baseline for the wrong
 * reason, turning the negative control into a test of DOM shape instead of the
 * reported behaviour.
 */
function searchField(scope: Page | Locator, searchLabel: string): Locator {
  return scope.locator(`input[aria-label="${searchLabel}"]`);
}

/**
 * The selector's own overlay, identified as "the dialog that contains this
 * search field". True of the pre-fix Radix Popover and the post-fix Sheet
 * alike, so every assertion below runs unmodified against both trees.
 */
function selectorOverlay(page: Page, searchLabel: string): Locator {
  return page.getByRole("dialog").filter({ has: searchField(page, searchLabel) });
}

/**
 * The selectable rows. Pre-fix, cmdk renders `role="option"` and the Radix
 * checkbox lists render `role="checkbox"`; post-fix every list is a checkbox.
 * Matching both keeps the option counts meaningful on either tree.
 */
function options(overlay: Locator): Locator {
  return overlay.locator('[role="checkbox"], [role="option"]');
}

interface SelectorCase {
  id: string;
  context: Context;
  trigger: (parent: Locator) => Locator;
  searchLabel: string;
}

/** All seven in-scope mobile selectors. Every one is exercised — none inferred. */
const SELECTORS: SelectorCase[] = [
  {
    id: "Add Papers → Projects",
    context: "add-papers",
    trigger: (p) => p.getByRole("button", { name: /^(Projects|\d+ projects?)$/ }),
    searchLabel: "Search projects",
  },
  {
    id: "Add Papers → Tags",
    context: "add-papers",
    trigger: (p) => p.getByRole("button", { name: /^(Tags|\d+ tags?)$/ }),
    searchLabel: "Search tags",
  },
  {
    id: "Filters → Projects",
    context: "filters",
    trigger: (p) => p.getByRole("combobox", { name: /^Filter by project/ }),
    searchLabel: "Search projects",
  },
  {
    id: "Filters → Tags",
    context: "filters",
    trigger: (p) => p.getByRole("combobox", { name: /^Filter by tag/ }),
    searchLabel: "Search tags",
  },
  {
    id: "Filters → Keywords",
    context: "filters",
    trigger: (p) => p.getByRole("button", { name: "Filter by keyword" }),
    searchLabel: "Search keywords",
  },
  {
    id: "Analytics → Target Keywords",
    context: "analytics",
    trigger: (p) => p.getByRole("button", { name: /^Target Keywords/ }),
    searchLabel: "Search target keywords",
  },
  {
    id: "Analytics → Target Authors",
    context: "analytics",
    trigger: (p) => p.getByRole("button", { name: /^Target Authors/ }),
    searchLabel: "Search target authors",
  },
];

async function gotoMobile(page: Page, viewport = NARROW) {
  await page.setViewportSize(viewport);
  await page.goto("/", { waitUntil: "networkidle" });
  await waitForDashboard(page);
}

// ── Suite ───────────────────────────────────────────────────────────────────

test.describe("ADD-PAPERS-MOBILE-SELECTORS-001 — mobile searchable selectors", () => {
  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    try {
      await createEntityFixtures(page);
    } finally {
      await page.close();
    }
  });

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    try {
      await removeEntityFixtures(page);
    } finally {
      await page.close();
    }
  });

  // ── §32 — the Filters sheet itself ──

  test("opening Filters does not put focus in a text field", async ({ page }) => {
    await gotoMobile(page);

    const trigger = page.getByRole("button", { name: /^Filters/ });
    await trigger.focus();
    await trigger.click();

    const sheet = page.getByRole("dialog", { name: "Filters" });
    await expect(sheet).toBeVisible();

    const active = await activeElement(page);
    console.log(`[filters-open-focus] ${JSON.stringify(active)}`);

    // The defect: Radix autofocused the first tabbable descendant, which is the
    // "Published from year" number input — so the keyboard opened unasked.
    expect(active.isTextEntry, "opening Filters must not focus a text-entry field").toBe(false);
    expect(active.id).not.toBe("year-from");
    expect(active.id).not.toBe("year-to");
    expect(active.isBody, "focus must not fall to <body>").toBe(false);

    // …and it is genuinely inside the sheet, not left behind on the trigger.
    const inside = await sheet.evaluate((el) => el.contains(document.activeElement));
    expect(inside, "focus must be inside the Filters sheet").toBe(true);

    // Nothing in the sheet holds implicit focus.
    await expect(sheet.getByRole("spinbutton", { name: "Published from year" })).not.toBeFocused();
    await expect(sheet.getByRole("spinbutton", { name: "Published to year" })).not.toBeFocused();

    // Escape still closes, and focus still returns to the dashboard trigger.
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  // ── §33 — the seven-selector matrix ──

  for (const selector of SELECTORS) {
    test(`${selector.id} — opens without summoning the keyboard`, async ({ page }) => {
      await gotoMobile(page);

      const parent = await openParent(page, selector.context);
      const trigger = selector.trigger(parent);
      await expect(trigger).toBeVisible();
      await trigger.scrollIntoViewIfNeeded();
      await trigger.click();

      const overlay = selectorOverlay(page, selector.searchLabel);
      await expect(overlay).toBeVisible();

      // The search field is right there and usable — it simply has not grabbed
      // focus. "Opening a selector" is not "asking to type".
      const search = searchField(overlay, selector.searchLabel);
      await expect(search).toBeVisible();
      await expect(search).not.toBeFocused();

      const active = await activeElement(page);
      console.log(`[no-autofocus] ${selector.id} → ${JSON.stringify(active)}`);
      expect(active.isTextEntry, `${selector.id} must not focus a text field on open`).toBe(false);
      expect(active.isBody, `${selector.id} must not drop focus to <body>`).toBe(false);

      const inside = await overlay.evaluate((el) => el.contains(document.activeElement));
      expect(inside, `${selector.id} must place focus inside its own overlay`).toBe(true);

      // The parent stays mounted and painted behind the child rather than being
      // torn down — but inert, so there are never two live modal layers.
      const whileOpen = await parentState(page, PARENT_TITLE[selector.context]);
      console.log(`[parent-while-open] ${selector.id} → ${JSON.stringify(whileOpen)}`);
      expect(whileOpen.mounted, "the parent surface must stay mounted").toBe(true);
      expect(whileOpen.rendered, "the parent must stay painted behind the child").toBe(true);
      expect(whileOpen.inert, "the parent must be inert while the child is open").toBe(true);

      // Closing returns focus to the exact trigger that opened it.
      await page.keyboard.press("Escape");
      await expect(overlay).toHaveCount(0);
      await expect(parent).toBeVisible();
      await expect(trigger).toBeFocused();
    });
  }

  // ── §34 — search still works, on purpose ──

  const EXPLICIT_SEARCH: Array<{ selector: SelectorCase; query: string }> = [
    { selector: SELECTORS[0], query: "Alpha" }, // Add Papers → Projects (2 of them)
    { selector: SELECTORS[4], query: "card" }, // Filters → Keywords
    { selector: SELECTORS[6], query: "Author A1" }, // Analytics → Target Authors
  ];

  for (const { selector, query } of EXPLICIT_SEARCH) {
    test(`${selector.id} — tapping Search focuses it and typing filters`, async ({ page }) => {
      await gotoMobile(page);

      const parent = await openParent(page, selector.context);
      const trigger = selector.trigger(parent);
      await trigger.scrollIntoViewIfNeeded();
      await trigger.click();

      const overlay = selectorOverlay(page, selector.searchLabel);
      await expect(overlay).toBeVisible();
      const search = searchField(overlay, selector.searchLabel);
      await expect(search).not.toBeFocused();

      const before = await options(overlay).count();
      expect(before, "the selector must offer options to filter").toBeGreaterThan(0);

      // The explicit user action — this is the moment a keyboard should appear.
      await search.click();
      await expect(search).toBeFocused();

      await search.fill(query);
      await expect
        .poll(async () => options(overlay).count(), { timeout: 5_000 })
        .toBeLessThan(before);

      const after = await options(overlay).count();
      expect(after, "a matching query must still leave matches visible").toBeGreaterThan(0);
      console.log(`[search] ${selector.id} "${query}" → ${before} then ${after} options`);

      // Filtering never mutates the selection.
      expect(await overlay.getByRole("checkbox", { checked: true }).count()).toBe(0);
    });
  }

  // ── §35 / §36 — the list scrolls at a keyboard-constrained height ──

  const LONG_LISTS = [SELECTORS[4], SELECTORS[6]]; // Filters Keywords, Analytics Target Authors

  for (const selector of LONG_LISTS) {
    test(`${selector.id} — option list scrolls at a constrained height`, async ({ page }) => {
      await gotoMobile(page);

      const parent = await openParent(page, selector.context);
      const trigger = selector.trigger(parent);
      await trigger.scrollIntoViewIfNeeded();
      await trigger.click();

      const overlay = selectorOverlay(page, selector.searchLabel);
      await expect(overlay).toBeVisible();

      // Focus Search explicitly, as a user reaching for the keyboard would…
      const search = searchField(overlay, selector.searchLabel);
      await search.click();
      await expect(search).toBeFocused();

      // …then shrink the viewport to model the keyboard taking the bottom half.
      await page.setViewportSize(CONSTRAINED);
      await expect(overlay).toBeVisible();

      const rect = await settledRect(overlay);
      console.log(`[constrained] ${selector.id} ${JSON.stringify(rect)}`);
      // It fits the visible viewport instead of hanging off the bottom edge.
      expect(rect.top, "the selector must not start above the viewport").toBeGreaterThanOrEqual(-2);
      expect(
        rect.bottom,
        "the selector must not extend past the bottom of the visible viewport",
      ).toBeLessThanOrEqual(CONSTRAINED.height + 2);

      // Done stays reachable — the keyboard must not bury the only way out.
      const done = overlay.getByRole("button", { name: "Done" });
      if (await done.count()) {
        const doneRect = await viewportRect(done);
        expect(doneRect.bottom).toBeLessThanOrEqual(CONSTRAINED.height + 2);
      }

      const metrics = await measureOptionList(overlay);
      console.log(`[constrained-list] ${selector.id} ${JSON.stringify(metrics)}`);
      expect(metrics, "an option scroll container must be identifiable").not.toBeNull();
      const m = metrics as ListMetrics;
      expect(
        m.scrollHeight,
        "this list must genuinely overflow at the constrained height, or the scroll assertion proves nothing",
      ).toBeGreaterThan(m.clientHeight);

      // It actually scrolls, and a later option can be brought into view.
      expect(m.scrollTop).toBe(0);
      const scrolled = await scrollOptionList(overlay, m.scrollHeight);
      expect(scrolled, "the option list must respond to scrolling").toBeGreaterThan(0);

      const lastOption = options(overlay).last();
      await expect(lastOption).toBeInViewport();

      // Structure that a touch pan depends on: a native overflow container that
      // nothing is covering.
      const structure = await overlay.evaluate((root) => {
        const option = root.querySelector('[role="checkbox"]') as HTMLElement | null;
        if (!option) return null;
        let scroller: HTMLElement | null = null;
        for (let el = option.parentElement; el && el !== root.parentElement; el = el.parentElement) {
          const oy = getComputedStyle(el).overflowY;
          if (oy === "auto" || oy === "scroll") { scroller = el; break; }
        }
        if (!scroller) return null;
        const cs = getComputedStyle(scroller);
        const r = scroller.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + 10);
        return {
          overflowY: cs.overflowY,
          pointerEvents: cs.pointerEvents,
          touchAction: cs.touchAction,
          overscrollBehaviorY: cs.overscrollBehaviorY,
          topmostIsInsideList: !!hit && scroller.contains(hit),
        };
      });
      console.log(`[touch-structure] ${selector.id} ${JSON.stringify(structure)}`);
      expect(structure).not.toBeNull();
      expect(structure!.pointerEvents, "the option list must accept pointer input").not.toBe("none");
      expect(
        structure!.topmostIsInsideList,
        "nothing may sit above the option list and swallow a touch pan",
      ).toBe(true);

      // Restore: the selector must reclaim the space the "keyboard" gave back.
      await page.setViewportSize(NARROW);
      await expect(overlay).toBeVisible();
      await expect
        .poll(async () => (await measureOptionList(overlay))?.clientHeight ?? 0, {
          timeout: 5_000,
        })
        .toBeGreaterThan(m.clientHeight);
      const restored = await measureOptionList(overlay);
      console.log(`[restored-list] ${selector.id} ${JSON.stringify(restored)}`);
      const restoredRect = await settledRect(overlay);
      expect(restoredRect.bottom).toBeLessThanOrEqual(NARROW.height + 2);
      await expect(options(overlay).first()).toBeVisible();
    });
  }

  // ── §37 — Add Papers assignment state ──

  test("Add Papers selections persist across tabs and both selectors work", async ({ page }) => {
    await gotoMobile(page);

    const dialog = await openAddPapers(page, "Import IDs");

    // Projects, on the Import IDs tab.
    const projects = dialog.getByRole("button", { name: /^(Projects|\d+ projects?)$/ });
    await projects.click();
    const projectSheet = selectorOverlay(page, "Search projects");
    await expect(projectSheet).toBeVisible();
    await projectSheet.getByRole("checkbox", { name: FIXTURE_PROJECT }).click();
    // Multi-select: choosing one option must NOT close the selector.
    await expect(projectSheet).toBeVisible();
    await expect(projectSheet.getByRole("checkbox", { name: FIXTURE_PROJECT })).toBeChecked();
    await projectSheet.getByRole("button", { name: "Done" }).click();
    await expect(projectSheet).toHaveCount(0);
    await expect(projects).toBeFocused();

    // The trigger and the badge summary both reflect it.
    await expect(dialog.getByRole("button", { name: "1 project" })).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: `Remove project ${FIXTURE_PROJECT}` }),
    ).toBeVisible();

    // Tags, on the Manual tab — the assign section is shared, so this is the
    // same state, not a second per-tab copy.
    await dialog.getByRole("tab", { name: "Manual" }).click();
    await expect(dialog.getByRole("button", { name: "1 project" })).toBeVisible();

    const tags = dialog.getByRole("button", { name: /^(Tags|\d+ tags?)$/ });
    await tags.scrollIntoViewIfNeeded();
    await tags.click();
    const tagSheet = selectorOverlay(page, "Search tags");
    await expect(tagSheet).toBeVisible();
    await tagSheet.getByRole("checkbox", { name: FIXTURE_TAG }).click();
    await tagSheet.getByRole("button", { name: "Done" }).click();
    await expect(tagSheet).toHaveCount(0);
    await expect(tags).toBeFocused();

    await expect(dialog.getByRole("button", { name: "1 tag" })).toBeVisible();

    // Via the File tab and back. The assign section is deliberately not shown
    // on Import File until a file has actually been parsed (existing behaviour,
    // unchanged here), so this proves the round trip does not reset the shared
    // state rather than asserting a control that is not meant to be there yet.
    await dialog.getByRole("tab", { name: "Import File" }).click();
    await expect(dialog.getByRole("button", { name: /Choose a file|drag/i }).first()).toBeVisible();
    await expect(dialog.getByRole("button", { name: "1 project" })).toHaveCount(0);

    await dialog.getByRole("tab", { name: "Import IDs" }).click();
    await expect(dialog.getByRole("button", { name: "1 project" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "1 tag" })).toBeVisible();

    // Nothing is imported: this proves selection, not a write.
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });

  test("Add Papers parent dialog stays usable while a selector is open", async ({ page }) => {
    await gotoMobile(page);
    const dialog = await openAddPapers(page);

    const projects = dialog.getByRole("button", { name: /^(Projects|\d+ projects?)$/ });
    await projects.scrollIntoViewIfNeeded();
    await projects.click();

    const sheet = selectorOverlay(page, "Search projects");
    await expect(sheet).toBeVisible();

    // The child overlays the dialog cleanly: fully on screen, and painting
    // above the parent rather than behind it.
    const rect = await settledRect(sheet);
    console.log(`[add-papers-child] ${JSON.stringify(rect)}`);
    expect(rect.top).toBeGreaterThanOrEqual(-2);
    expect(rect.bottom).toBeLessThanOrEqual(NARROW.height + 2);

    const layering = await sheet.evaluate((child) => {
      const r = child.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + 40);
      return { childOnTop: !!hit && child.contains(hit) };
    });
    expect(layering.childOnTop, "the selector must paint above Add Papers").toBe(true);

    await sheet.getByRole("button", { name: "Done" }).click();
    await expect(sheet).toHaveCount(0);

    // The parent survives with its tabs and assign trigger still reachable.
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("tab", { name: "Import IDs" })).toBeVisible();
    await expect(dialog.getByRole("tab", { name: "Manual" })).toBeVisible();
    await expect(projects).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("button", { name: "Add papers" })).toBeFocused();
  });

  // ── §38 / §49 / §51 — Filters state, sequential selectors, parent scroll ──

  test("Filters selections stay live, and Any/All survives the mobile surface", async ({ page }) => {
    await gotoMobile(page);
    const sheet = await openFilters(page);

    // Keywords FIRST, deliberately. The Keywords control only renders while the
    // current result set actually has keywords, and the fixture project/tag are
    // assigned to no papers — so selecting them empties the library and the
    // control correctly disappears. Driving it first exercises all three
    // selectors in one sequence without fighting that (correct) behaviour.
    const keywords = sheet.getByRole("button", { name: "Filter by keyword" });
    await keywords.scrollIntoViewIfNeeded();

    // Remember where the parent was scrolled to before the child opened.
    const scrollBefore = await sheet.evaluate((el) => {
      const s = el.querySelector(".overflow-y-auto") as HTMLElement | null;
      return s?.scrollTop ?? 0;
    });

    await keywords.click();
    const keywordSheet = selectorOverlay(page, "Search keywords");
    await expect(keywordSheet).toBeVisible();
    const firstKeyword = keywordSheet.getByRole("checkbox").first();
    const keywordName = (await firstKeyword.textContent())?.trim() ?? "";
    await firstKeyword.click();
    await keywordSheet.getByRole("button", { name: "Done" }).click();
    await expect(keywordSheet).toHaveCount(0);

    // The Filters sheet is still open, focus is back on its trigger, and it did
    // not jump back to the top.
    await expect(sheet).toBeVisible();
    await expect(keywords).toBeFocused();
    const scrollAfter = await sheet.evaluate((el) => {
      const s = el.querySelector(".overflow-y-auto") as HTMLElement | null;
      return s?.scrollTop ?? 0;
    });
    console.log(`[parent-scroll] before=${scrollBefore} after=${scrollAfter}`);
    expect(Math.abs(scrollAfter - scrollBefore)).toBeLessThanOrEqual(80);

    // §49 — several child selectors in a row, then the parent's own footer.
    const tags = sheet.getByRole("combobox", { name: /^Filter by tag/ });
    await tags.scrollIntoViewIfNeeded();
    await tags.click();
    const tagSheet = selectorOverlay(page, "Search tags");
    await expect(tagSheet).toBeVisible();
    await tagSheet.getByRole("checkbox", { name: FIXTURE_TAG }).click();
    await tagSheet.getByRole("button", { name: "Done" }).click();
    await expect(tagSheet).toHaveCount(0);
    await expect(tags).toBeFocused();

    const projects = sheet.getByRole("combobox", { name: /^Filter by project/ });
    await projects.scrollIntoViewIfNeeded();
    await projects.click();
    const projectSheet = selectorOverlay(page, "Search projects");
    await expect(projectSheet).toBeVisible();
    await projectSheet.getByRole("checkbox", { name: FIXTURE_PROJECT }).click();
    await projectSheet.getByRole("button", { name: "Done" }).click();
    await expect(projectSheet).toHaveCount(0);
    await expect(projects).toBeFocused();

    // The filter is live behind the overlay — the trigger names the selection.
    await expect(sheet.getByRole("combobox", { name: /Filter by project\./ })).toBeVisible();
    await expect(sheet.getByRole("combobox", { name: /Filter by tag\./ })).toBeVisible();
    console.log(`[filters] keyword="${keywordName}" + tag + project selected`);

    // The parent's footer is still reachable after three child round-trips.
    await expect(sheet.getByRole("button", { name: /presets/i })).toBeVisible();
    const clearAll = sheet.getByRole("button", { name: "Clear all filters" });
    await expect(clearAll).toBeVisible();

    // Three categories active: Projects, Tags, Keywords.
    await sheet.getByRole("button", { name: "Done" }).click();
    await expect(sheet).toBeHidden();
    const badge = page.getByRole("button", { name: "Filters, 3 active filter categories" });
    await expect(badge).toBeVisible();

    // Reopening shows the same selection — one live state, no draft copy.
    await badge.click();
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole("combobox", { name: /Filter by project\./ })).toBeVisible();

    // Clear through the existing path only; nothing is written to the database.
    await sheet.getByRole("button", { name: "Clear all filters" }).click();
    await expect(sheet.getByRole("combobox", { name: /All Projects/ })).toBeVisible();
    await sheet.getByRole("button", { name: "Done" }).click();
    await expect(page.getByRole("button", { name: "Filters", exact: true })).toBeVisible();
  });

  test("Filters Projects exposes Any/All inside the mobile selector", async ({ page }) => {
    await gotoMobile(page);
    const sheet = await openFilters(page);

    const projects = sheet.getByRole("combobox", { name: /^Filter by project/ });
    await projects.scrollIntoViewIfNeeded();
    await projects.click();
    const projectSheet = selectorOverlay(page, "Search projects");
    await expect(projectSheet).toBeVisible();

    const anyMode = projectSheet.getByRole("radio", {
      name: "Match papers in at least one selected project",
    });
    const allMode = projectSheet.getByRole("radio", {
      name: "Match papers in every selected project",
    });

    // Preserved semantic: Any and All are identical below two selections, so
    // the control is correctly absent at zero and at one.
    await expect(anyMode).toHaveCount(0);
    await projectSheet.getByRole("checkbox", { name: FIXTURE_PROJECT }).click();
    await expect(anyMode).toHaveCount(0);

    // …and appears at two, defaulting to Any, switchable without closing.
    await projectSheet.getByRole("checkbox", { name: FIXTURE_PROJECT_ALT }).click();
    await expect(anyMode).toBeVisible();
    await expect(anyMode).toHaveAttribute("aria-checked", "true");
    await allMode.click();
    await expect(allMode).toHaveAttribute("aria-checked", "true");
    await expect(projectSheet).toBeVisible();

    await projectSheet.getByRole("button", { name: "Done" }).click();
    await expect(projectSheet).toHaveCount(0);

    // The closed trigger states the active mode exactly once.
    await expect(
      sheet.getByRole("combobox", { name: /2 Projects selected, matching all/ }),
    ).toBeVisible();

    await sheet.getByRole("button", { name: "Clear all filters" }).click();
    await sheet.getByRole("button", { name: "Done" }).click();
    await expect(page.getByRole("button", { name: "Filters", exact: true })).toBeVisible();
  });

  // ── §39 — Analytics targets ──

  test("Analytics targets select, chart and survive the breakpoint", async ({ page }) => {
    await gotoMobile(page);
    const analytics = await openAnalytics(page);

    const authors = analytics.getByRole("button", { name: /^Target Authors/ });
    await authors.scrollIntoViewIfNeeded();
    await authors.click();
    const authorSheet = selectorOverlay(page, "Search target authors");
    await expect(authorSheet).toBeVisible();
    const firstAuthor = authorSheet.getByRole("checkbox").first();
    const author = (await firstAuthor.textContent())?.trim() ?? "";
    expect(author).not.toBe("");
    await firstAuthor.click();
    await authorSheet.getByRole("button", { name: "Done" }).click();
    await expect(authorSheet).toHaveCount(0);
    await expect(authors).toBeFocused();

    // Analytics is still open, the target is shown, and it drives the chart.
    await expect(analytics).toBeVisible();
    await expect(analytics.getByRole("button", { name: `Remove ${author}` })).toBeVisible();
    await expect(analytics.getByRole("heading", { name: "Author Distribution" })).toBeVisible();

    // Close and reopen Analytics within the session — the target survives,
    // because the Dashboard owns it (PR #209's contract, unchanged).
    await page.keyboard.press("Escape");
    await expect(analytics).toBeHidden();
    const reopened = await openAnalytics(page);
    await expect(reopened.getByRole("button", { name: `Remove ${author}` })).toBeVisible();

    // Cross into the desktop presentation and back.
    await page.setViewportSize(DESKTOP_MIN);
    await expect(page.getByRole("dialog", { name: /Analytics & Insights/ })).toHaveCount(0);
    const desktop = page.locator("main");
    await expect(desktop.getByRole("button", { name: `Remove ${author}` })).toBeVisible();
    await expect(desktop.getByRole("heading", { name: "Author Distribution" })).toBeVisible();

    await page.setViewportSize(NARROW);
    const mobileAgain = page.getByRole("dialog", { name: /Analytics & Insights/ });
    await expect(mobileAgain).toBeVisible();
    await expect(mobileAgain.getByRole("button", { name: `Remove ${author}` })).toBeVisible();

    // Clear affects only this dimension.
    const keywords = mobileAgain.getByRole("button", { name: /^Target Keywords/ });
    await keywords.scrollIntoViewIfNeeded();
    await keywords.click();
    const keywordSheet = selectorOverlay(page, "Search target keywords");
    await expect(keywordSheet).toBeVisible();
    const firstKeyword = keywordSheet.getByRole("checkbox").first();
    const keyword = (await firstKeyword.textContent())?.trim() ?? "";
    await firstKeyword.click();
    await keywordSheet.getByRole("button", { name: "Clear" }).click();
    await expect(keywordSheet.getByRole("checkbox", { checked: true })).toHaveCount(0);
    await keywordSheet.getByRole("button", { name: "Done" }).click();

    console.log(`[analytics] author="${author}" keyword="${keyword}"`);
    // Clearing keywords left the author target alone.
    await expect(mobileAgain.getByRole("button", { name: `Remove ${author}` })).toBeVisible();
    await expect(mobileAgain.getByRole("button", { name: `Remove ${keyword}` })).toHaveCount(0);
  });

  // ── §50 — the second open is where nested overlays usually break ──

  const REPEAT_OPEN = [SELECTORS[0], SELECTORS[4], SELECTORS[5]];

  for (const selector of REPEAT_OPEN) {
    test(`${selector.id} — reopening leaves no stale overlay`, async ({ page }) => {
      await gotoMobile(page);
      const parent = await openParent(page, selector.context);
      const trigger = selector.trigger(parent);

      for (const pass of [1, 2, 3]) {
        await trigger.scrollIntoViewIfNeeded();
        await trigger.click();

        const overlay = selectorOverlay(page, selector.searchLabel);
        await expect(overlay).toBeVisible();
        // Exactly one selector overlay — no duplicate portal left by pass N-1.
        await expect(overlay).toHaveCount(1);

        const search = searchField(overlay, selector.searchLabel);
        await expect(search, `pass ${pass}: search must not autofocus`).not.toBeFocused();
        expect((await activeElement(page)).isTextEntry).toBe(false);

        // Still scrollable / still populated on every pass.
        expect(await options(overlay).count()).toBeGreaterThan(0);

        await page.keyboard.press("Escape");
        await expect(overlay).toHaveCount(0);
        await expect(trigger).toBeFocused();
      }

      // The parent survived three round-trips, and the page is not left with a
      // stuck body scroll/pointer lock once everything closes.
      await expect(parent).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(parent).toBeHidden();
      const bodyPointerEvents = await page.evaluate(
        () => getComputedStyle(document.body).pointerEvents,
      );
      expect(bodyPointerEvents, "closing everything must release the body lock").not.toBe("none");
    });
  }

  // ── §40 / §41 — breakpoint and desktop preservation ──

  test("767px uses the mobile selector, 768px uses the desktop popover", async ({ page }) => {
    await gotoMobile(page, MOBILE_MAX);

    // 767 — mobile architecture: a bottom sheet with a Done action.
    const sheet = await openFilters(page);
    await sheet.getByRole("button", { name: "Filter by keyword" }).click();
    const overlay = selectorOverlay(page, "Search keywords");
    await expect(overlay).toBeVisible();
    await expect(overlay.getByRole("button", { name: "Done" })).toBeVisible();
    await expect(
      searchField(overlay, "Search keywords"),
    ).not.toBeFocused();
    // Exactly one keyword search field exists at this width — the two
    // presentations are never mounted together.
    await expect(searchField(page, "Search keywords")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");

    // 768 — desktop architecture: the inline toolbar, popover, autofocused
    // search (which is correct with a keyboard and mouse).
    await page.setViewportSize(DESKTOP_MIN);
    await expect(page.getByRole("button", { name: /^Filters/ })).toHaveCount(0);
    const keywordTrigger = page.getByRole("button", { name: "Filter by keyword" });
    await expect(keywordTrigger).toBeVisible();
    await keywordTrigger.click();
    const popover = selectorOverlay(page, "Search keywords");
    await expect(popover).toBeVisible();
    await expect(popover.getByRole("button", { name: "Done" })).toHaveCount(0);
    await page.keyboard.press("Escape");
  });

  test("desktop selectors keep their popover behaviour at 1280x720", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);

    // Filters — all three are inline toolbar controls, not behind a sheet.
    await expect(page.getByRole("combobox", { name: /^Filter by project/ })).toBeVisible();
    await expect(page.getByRole("combobox", { name: /^Filter by tag/ })).toBeVisible();
    const keywords = page.getByRole("button", { name: "Filter by keyword" });
    await expect(keywords).toBeVisible();

    // Desktop keeps type-immediately: the popover autofocuses its search box.
    await keywords.click();
    const keywordPopover = selectorOverlay(page, "Search keywords");
    await expect(keywordPopover).toBeVisible();
    await expect(
      searchField(keywordPopover, "Search keywords"),
    ).toBeFocused();
    // Multi-select still keeps the popover open across selections.
    const first = keywordPopover.getByRole("checkbox").first();
    await first.click();
    await expect(keywordPopover).toBeVisible();
    await keywordPopover.getByRole("button", { name: "Clear all" }).click();
    await page.keyboard.press("Escape");

    // Projects — the desktop Command popover, with its own search.
    const projects = page.getByRole("combobox", { name: /^Filter by project/ });
    await projects.click();
    const projectPopover = selectorOverlay(page, "Search projects");
    await expect(projectPopover).toBeVisible();
    await expect(projectPopover.getByRole("button", { name: "Done" })).toHaveCount(0);
    await page.keyboard.press("Escape");

    // Analytics — inline Collapsible, compact popovers, no sheet.
    await page.getByRole("button", { name: /Analytics & Insights/ }).click();
    const main = page.locator("main");
    const targetAuthors = main.getByRole("button", { name: /^Target Authors/ });
    await expect(targetAuthors).toBeVisible();
    await targetAuthors.click();
    const authorPopover = selectorOverlay(page, "Search target authors");
    await expect(authorPopover).toBeVisible();
    await expect(authorPopover.getByRole("button", { name: "Done" })).toHaveCount(0);
    await page.keyboard.press("Escape");

    // Add Papers — the compact w-52 Command popover, not a full-screen sheet.
    const dialog = await openAddPapers(page);
    const addProjects = dialog.getByRole("button", { name: /^(Projects|\d+ projects?)$/ });
    await addProjects.click();
    const addPopover = selectorOverlay(page, "Search projects");
    await expect(addPopover).toBeVisible();
    const width = await addPopover.evaluate((el) => Math.round(el.getBoundingClientRect().width));
    console.log(`[desktop-add-papers] popover width=${width}`);
    expect(width, "the desktop Add Papers selector stays compact").toBeLessThan(400);
    await expect(addPopover.getByRole("button", { name: "Done" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });
});
