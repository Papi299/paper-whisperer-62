import { test, expect, type Locator, type Page } from "@playwright/test";
import { waitForDashboard } from "./helpers";

test.describe("Bulk Actions", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });
    await expect(page.getByText(/\d+\s+paper/i)).toBeVisible({ timeout: 15_000 });
  });

  test("should show select-all checkbox in paper list header", async ({ page }) => {
    const checkbox = page.locator("thead").getByRole("checkbox");
    if (await checkbox.isVisible()) {
      await expect(checkbox).not.toBeChecked();
    }
  });

  test("should toggle select-all checkbox", async ({ page }) => {
    const headerCheckbox = page.locator("thead").getByRole("checkbox");

    if (await headerCheckbox.isVisible()) {
      await headerCheckbox.click();
      await expect(headerCheckbox).toBeChecked();

      await expect(
        page.getByText(/\d+\s+selected/i),
      ).toBeVisible();

      await headerCheckbox.click();
      await expect(headerCheckbox).not.toBeChecked();
    }
  });

  test("should show bulk actions toolbar when papers are selected", async ({ page }) => {
    const rowCheckbox = page.locator("tbody").getByRole("checkbox").first();

    if (await rowCheckbox.isVisible()) {
      await rowCheckbox.click();

      await expect(page.getByText(/1\s+selected/i)).toBeVisible();
    }
  });
});

// ── BULK-TOOLBAR-CONTAINMENT-001 ────────────────────────────────────────────

/**
 * BULK-TOOLBAR-CONTAINMENT-001 — the bulk-actions toolbar must fit the screen.
 *
 * The toolbar used to be a fixed, centred row that never wrapped. It was about
 * 1,122px wide at every viewport. Measured on the parent commit with the same
 * probes as below, only 1 of its 8 controls was reachable at 320px, 2 at 390px,
 * 4 at 568×320, 5 at 768px and 6 at 1,024px. Nothing could scroll the rest back
 * into view.
 *
 * `toBeVisible()` and `.click()` both pass for a control clipped off-screen,
 * because Playwright scrolls programmatically. So every reachability claim here
 * is a real hit test. The control must be inside the viewport (horizontally
 * with no scrolling at all), and `elementFromPoint` at its centre must resolve
 * to it.
 *
 * Mutating only within a fixture it owns. The bulk-delete case creates one
 * disposable paper and removes it again. Every other dialog is cancelled, and
 * the bulk-write RPCs are watched to prove that. The single AI Analyze run is
 * answered at the HTTP boundary with a provider failure, so no Edge Function or
 * provider is reached, no quota is spent and no paper is written.
 */

const PHONE_SMALL = { width: 320, height: 568 };
const PHONE = { width: 390, height: 844 };
const PHONE_LANDSCAPE = { width: 568, height: 320 };
const TABLET_PORTRAIT = { width: 768, height: 1024 };
const TABLET_LANDSCAPE = { width: 1024, height: 768 };
const DESKTOP = { width: 1280, height: 720 };

type Viewport = { width: number; height: number };
type Insets = { top: number; right: number; bottom: number; left: number };

/** The existing actions, in their existing order, for a one-paper selection. */
const ACTIONS = [
  "AI Analyze (1)",
  "Delete",
  "Set Project",
  "Clear Projects",
  "Set Tags",
  "Clear Tags",
  "Clear Selection",
];

/** The RPCs every bulk write goes through. A cancelled dialog must reach none of them. */
const BULK_WRITE_RPC =
  /\/rest\/v1\/rpc\/(delete_papers_with_attachment_cleanup|bulk_set_paper_projects|bulk_set_paper_tags)\b/;

const ANALYZE_FUNCTION_PATH = "/functions/v1/analyze-paper";

/** CORS headers for the analyze stand-in: the app and the local API are different origins. */
const STAND_IN_CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/** Open the Dashboard at `viewport` and select its first paper from the keyboard. */
async function selectFirstPaper(page: Page, viewport: Viewport) {
  await page.setViewportSize(viewport);
  await page.goto("/", { waitUntil: "networkidle" });
  await waitForDashboard(page);
  // Space, not a click: in a short landscape viewport the sticky table header
  // can sit over the first row.
  const checkbox = page.locator("tbody").getByRole("checkbox").first();
  await checkbox.focus();
  await page.keyboard.press("Space");
  await expect(page.getByText(/^1 selected$/)).toBeVisible();
  return checkbox;
}

function bulkToolbar(page: Page) {
  return page.getByRole("region", { name: "Bulk actions" });
}

function disclosureToggle(page: Page) {
  return bulkToolbar(page).getByRole("button", { name: /^(More|Fewer) actions$/ });
}

/** The phone action list, resolved through the toggle's `aria-controls`. */
async function controlledList(page: Page) {
  const id = await disclosureToggle(page).getAttribute("aria-controls");
  expect(id, "the toggle names the element it controls").toBeTruthy();
  return page.locator(`[id="${id}"]`);
}

/** The panel's box and every overflow measure a user could notice. */
async function expectToolbarContained(page: Page, where: string) {
  const m = await bulkToolbar(page).evaluate((panel) => {
    const r = panel.getBoundingClientRect();
    return {
      left: r.left,
      right: r.right,
      top: r.top,
      bottom: r.bottom,
      vw: document.documentElement.clientWidth,
      vh: document.documentElement.clientHeight,
      panelOverflowX: panel.scrollWidth - panel.clientWidth,
      docOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      bodyOverflowX: document.body.scrollWidth - document.body.clientWidth,
    };
  });
  expect(m.left, `${where}: toolbar left edge`).toBeGreaterThanOrEqual(0);
  expect(m.right, `${where}: toolbar right edge`).toBeLessThanOrEqual(m.vw);
  expect(m.top, `${where}: toolbar top edge`).toBeGreaterThanOrEqual(0);
  expect(m.bottom, `${where}: toolbar bottom edge`).toBeLessThanOrEqual(m.vh);
  expect(m.panelOverflowX, `${where}: nothing overflows the toolbar sideways`).toBeLessThanOrEqual(0);
  expect(m.docOverflowX, `${where}: no document-level horizontal scroll`).toBeLessThanOrEqual(0);
  expect(m.bodyOverflowX, `${where}: no body-level horizontal scroll`).toBeLessThanOrEqual(0);
  return m;
}

interface Placement {
  name: string;
  width: number;
  height: number;
  /** Inside the viewport's width before any scrolling: nobody can scroll this toolbar sideways. */
  horizontallyContained: boolean;
  /** Fully inside the viewport once its own list has scrolled it into view. */
  insideViewport: boolean;
  /** How far the box reaches past the visible area (viewport ∩ clipping ancestors). */
  clippedPx: number;
  /** `elementFromPoint` at the centre resolves to the control itself. */
  ownsCentre: boolean;
  /** No ancestor (nor the document) had to scroll sideways. */
  noSidewaysScroll: boolean;
}

/**
 * Where a control really is for a person. Horizontal containment is read
 * before anything scrolls. Vertical scrolling inside the expanded phone list is
 * a real affordance, so the control may be brought into view along that axis
 * before the hit test.
 *
 * The visible area is the viewport narrowed by every clipping ancestor up to
 * the fixed toolbar, the same rule `focusRing` uses. Nothing outside a fixed
 * box can clip it, and a `display: contents` element has no box to clip with.
 */
async function placement(control: Locator): Promise<Placement> {
  return control.evaluate((el) => {
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const before = el.getBoundingClientRect();
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
    const r = el.getBoundingClientRect();
    let clip = { left: 0, top: 0, right: vw, bottom: vh };
    for (let n = el.parentElement; n; n = n.parentElement) {
      const style = getComputedStyle(n);
      if (style.display !== "contents" && (style.overflowX !== "visible" || style.overflowY !== "visible")) {
        const c = n.getBoundingClientRect();
        const left = c.left + n.clientLeft;
        const top = c.top + n.clientTop;
        clip = {
          left: Math.max(clip.left, left),
          top: Math.max(clip.top, top),
          right: Math.min(clip.right, left + n.clientWidth),
          bottom: Math.min(clip.bottom, top + n.clientHeight),
        };
      }
      if (style.position === "fixed") break;
    }
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    let noSidewaysScroll = (document.scrollingElement?.scrollLeft ?? 0) === 0;
    for (let n = el.parentElement; n; n = n.parentElement) if (n.scrollLeft !== 0) noSidewaysScroll = false;
    return {
      name: (el.textContent ?? "").trim(),
      width: r.width,
      height: r.height,
      horizontallyContained: before.left >= 0 && before.right <= vw,
      insideViewport: r.left >= 0 && r.right <= vw && r.top >= 0 && r.bottom <= vh,
      clippedPx: Math.max(0, clip.left - r.left, r.right - clip.right, clip.top - r.top, r.bottom - clip.bottom),
      ownsCentre: !!hit && el.contains(hit),
      noSidewaysScroll,
    };
  });
}

/** Fully painted where a person can see it, with no sideways scrolling involved. */
function expectFullyVisible(p: Placement, where: string) {
  expect(p.horizontallyContained, `${where}: "${p.name}" fits the viewport width unscrolled`).toBe(true);
  expect(p.insideViewport, `${where}: "${p.name}" lies inside the viewport`).toBe(true);
  expect(p.clippedPx, `${where}: "${p.name}" is not clipped`).toBeLessThanOrEqual(0);
  expect(p.noSidewaysScroll, `${where}: reaching "${p.name}" needed no sideways scroll`).toBe(true);
}

/**
 * Fully visible and pressable at its centre. Only for enabled controls: the
 * shared Button is `pointer-events: none` while disabled, so a hit test passes
 * straight through it by design.
 */
function expectReachable(p: Placement, where: string) {
  expectFullyVisible(p, where);
  expect(p.ownsCentre, `${where}: "${p.name}" owns the point at its centre`).toBe(true);
}

/**
 * The visible boxes of every button under `scope`, in the content coordinates
 * of their scroll containers, so a scrolled list measures like an unscrolled
 * one. Nothing is scrolled.
 */
async function buttonBoxes(scope: Locator) {
  return scope.evaluate((root) =>
    Array.from(root.querySelectorAll("button"))
      .filter((b) => b.checkVisibility())
      .map((b) => {
        const r = b.getBoundingClientRect();
        let sx = 0;
        let sy = 0;
        for (let n = b.parentElement; n; n = n.parentElement) {
          sx += n.scrollLeft;
          sy += n.scrollTop;
        }
        return {
          name: (b.textContent ?? "").trim(),
          left: r.left + sx,
          right: r.right + sx,
          top: r.top + sy,
          bottom: r.bottom + sy,
          width: r.width,
          height: r.height,
        };
      }),
  );
}

type Box = Awaited<ReturnType<typeof buttonBoxes>>[number];

/** The smallest gap between any two boxes, on whichever axis separates them. */
function minimumSeparation(boxes: Box[]) {
  let min = Infinity;
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      const dx = Math.max(b.left - a.right, a.left - b.right);
      const dy = Math.max(b.top - a.bottom, a.top - b.bottom);
      min = Math.min(min, Math.max(dx, dy));
    }
  }
  return min;
}

/**
 * Whether the focused control's focus ring is drawn and fully visible. The ring
 * is an outset box-shadow, so it is compared with the visible area, by the same
 * rule as `placement`.
 */
async function focusRing(page: Page) {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement;
    const { boxShadow } = getComputedStyle(el);
    const outward = Math.max(
      0,
      ...(boxShadow === "none" ? [] : boxShadow.split(/,(?![^(]*\))/))
        .filter((shadow) => !/inset/.test(shadow))
        .map((shadow) => parseFloat(shadow.match(/-?[\d.]+px/g)?.[3] ?? "0")),
    );
    const r = el.getBoundingClientRect();
    let clip = {
      left: 0,
      top: 0,
      right: document.documentElement.clientWidth,
      bottom: document.documentElement.clientHeight,
    };
    for (let n = el.parentElement; n; n = n.parentElement) {
      const style = getComputedStyle(n);
      if (style.display !== "contents" && (style.overflowX !== "visible" || style.overflowY !== "visible")) {
        const c = n.getBoundingClientRect();
        const left = c.left + n.clientLeft;
        const top = c.top + n.clientTop;
        clip = {
          left: Math.max(clip.left, left),
          top: Math.max(clip.top, top),
          right: Math.min(clip.right, left + n.clientWidth),
          bottom: Math.min(clip.bottom, top + n.clientHeight),
        };
      }
      if (style.position === "fixed") break;
    }
    return {
      name: (el.textContent ?? "").trim(),
      focusVisible: el.matches(":focus-visible"),
      drawn: boxShadow !== "none",
      clippedPx: Math.max(
        0,
        clip.left - (r.left - outward),
        r.right + outward - clip.right,
        clip.top - (r.top - outward),
        r.bottom + outward - clip.bottom,
      ),
    };
  });
}

/** Tab forward `count` times, asserting each stop's name and its focus ring. */
async function expectTabSequence(page: Page, names: string[], where: string) {
  for (const name of names) {
    await page.keyboard.press("Tab");
    const ring = await focusRing(page);
    expect(ring.name, `${where}: Tab order`).toBe(name);
    expect(ring.focusVisible && ring.drawn, `${where}: "${name}" shows a focus ring`).toBe(true);
    expect(ring.clippedPx, `${where}: "${name}" focus ring is not clipped`).toBeLessThanOrEqual(0);
  }
}

/** Whether keyboard focus is currently inside `scope`. */
async function focusIsInside(scope: Locator) {
  return scope.evaluate((root) => root.contains(document.activeElement));
}

/**
 * Emulate device safe-area insets through CDP. Returns false where the browser
 * build does not support it; the caller then records that and moves on.
 */
async function emulateSafeArea(page: Page, insets: Insets) {
  const client = await page.context().newCDPSession(page);
  try {
    await client.send("Emulation.setSafeAreaInsetsOverride", { insets });
    return true;
  } catch {
    return false;
  } finally {
    await client.detach().catch(() => {});
  }
}

/**
 * The phone presentation: collapsed to the count and the disclosure, every
 * action reachable once expanded, keyboard and touch included.
 */
async function expectPhoneToolbar(page: Page, where: string) {
  await expectToolbarContained(page, `${where} collapsed`);
  const toggle = disclosureToggle(page);
  const list = await controlledList(page);

  // Collapsed: count and toggle only. The actions are not displayed, not in
  // the accessibility tree and not tabbable.
  await expect(page.getByText(/^1 selected$/)).toBeVisible();
  await expect(toggle).toHaveAccessibleName("More actions");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(list).toBeHidden();
  for (const name of ACTIONS) {
    await expect(bulkToolbar(page).getByRole("button", { name, exact: true })).toHaveCount(0);
  }
  const togglePlacement = await placement(toggle);
  expectReachable(togglePlacement, `${where} collapsed`);
  expect(togglePlacement.width, `${where}: toggle target width`).toBeGreaterThanOrEqual(40);
  expect(togglePlacement.height, `${where}: toggle target height`).toBeGreaterThanOrEqual(40);
  await toggle.focus();
  await page.keyboard.press("Tab");
  expect(await focusIsInside(list), `${where}: Tab skips the collapsed actions`).toBe(false);
  await toggle.focus();
  await page.keyboard.press("Shift+Tab");
  expect(await focusIsInside(list), `${where}: Shift+Tab skips the collapsed actions`).toBe(false);

  // Expanded.
  await toggle.click();
  await expect(toggle).toHaveAccessibleName("Fewer actions");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(list).toBeVisible();
  const panel = await expectToolbarContained(page, `${where} expanded`);
  expect(
    await list.getByRole("button").evaluateAll((buttons) => buttons.map((b) => (b.textContent ?? "").trim())),
    `${where}: every action, once, in the existing order`,
  ).toEqual(ACTIONS);
  // The count stays visible at the foot of the expanded panel, so the user
  // keeps their bearings.
  expectReachable(await placement(page.getByText(/^1 selected$/)), `${where} expanded`);

  for (const name of ACTIONS) {
    const p = await placement(list.getByRole("button", { name, exact: true }));
    expectReachable(p, `${where} expanded`);
    expect(p.width, `${where}: "${name}" target width`).toBeGreaterThanOrEqual(40);
    expect(p.height, `${where}: "${name}" target height`).toBeGreaterThanOrEqual(40);
  }
  expect(
    minimumSeparation(await buttonBoxes(list)),
    `${where}: separation between adjacent action targets`,
  ).toBeGreaterThanOrEqual(6);

  // Keyboard: from the toggle, Tab walks the list in order and then leaves.
  await toggle.focus();
  await expectTabSequence(page, ACTIONS, `${where} expanded`);
  await page.keyboard.press("Tab");
  expect(await focusIsInside(bulkToolbar(page)), `${where}: Tab leaves after the last action`).toBe(false);

  // Collapsing with focus on an action the collapse hides must not strand it.
  // `dispatchEvent` presses the toggle without moving focus, as a pointer
  // press does in a browser that never focuses buttons on click.
  await list.getByRole("button", { name: "Set Tags", exact: true }).focus();
  await toggle.dispatchEvent("click");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(list).toBeHidden();
  await expect(toggle).toBeFocused();
  return panel;
}

/**
 * Re-measure the phone toolbar under emulated safe-area insets: it must sit
 * above the bottom inset, inside the side insets, and its expanded height must
 * leave the top inset clear.
 */
async function expectSafeAreaRespected(page: Page, insets: Insets, where: string) {
  if (!(await emulateSafeArea(page, insets))) {
    test.info().annotations.push({ type: "note", description: `${where}: safe-area emulation unsupported` });
    return;
  }
  const toggle = disclosureToggle(page);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const m = await expectToolbarContained(page, `${where} with safe-area insets`);
  expect(m.vh - m.bottom, `${where}: gap above the bottom inset`).toBeCloseTo(24 + insets.bottom, 0);
  expect(m.left, `${where}: clear of the left inset`).toBeGreaterThanOrEqual(Math.max(16, insets.left) - 0.5);
  expect(m.vw - m.right, `${where}: clear of the right inset`).toBeGreaterThanOrEqual(Math.max(16, insets.right) - 0.5);
  expect(m.top, `${where}: expanded panel leaves the top inset clear`).toBeGreaterThanOrEqual(24 + insets.top - 0.5);
  const list = await controlledList(page);
  for (const name of ACTIONS) {
    expectReachable(await placement(list.getByRole("button", { name, exact: true })), `${where} with insets`);
  }
}

/**
 * The md+ presentation: every action directly visible, with no disclosure,
 * wrapping inside its own box when the row cannot fit.
 */
async function expectInlineToolbar(page: Page, where: string, { coarse }: { coarse: boolean }) {
  await expectToolbarContained(page, where);
  const toolbar = bulkToolbar(page);
  await expect(disclosureToggle(page)).toHaveCount(0);
  expect(
    await toolbar.getByRole("button").evaluateAll((buttons) => buttons.map((b) => (b.textContent ?? "").trim())),
    `${where}: every action, once, in the existing order`,
  ).toEqual(ACTIONS);

  for (const name of ACTIONS) {
    const p = await placement(toolbar.getByRole("button", { name, exact: true }));
    expectReachable(p, where);
    if (coarse) {
      expect(p.width, `${where}: "${name}" target width`).toBeGreaterThanOrEqual(40);
      expect(p.height, `${where}: "${name}" target height`).toBeGreaterThanOrEqual(40);
    } else {
      // Desktop density is unchanged: the original 36px small button.
      expect(p.height, `${where}: "${name}" keeps the desktop height`).toBe(36);
    }
  }
  expect(minimumSeparation(await buttonBoxes(toolbar)), `${where}: separation between action targets`).toBeGreaterThanOrEqual(6);

  // Separators sit beside whole blocks, never alone at the end of a wrapped
  // line: one between the count and the actions, one before Clear Selection.
  const layout = await page.getByText(/^1 selected$/).evaluate((badge) => {
    const panel = badge.parentElement!;
    const box = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    };
    const buttons = Array.from(panel.querySelectorAll("button")).filter((b) => b.checkVisibility());
    const clear = buttons.find((b) => b.textContent?.trim() === "Clear Selection")!;
    const actions = buttons.filter((b) => b !== clear).map(box);
    const separators = Array.from(panel.querySelectorAll("div"))
      .filter((d) => d.childElementCount === 0 && !d.textContent?.trim() && d.checkVisibility())
      .map(box)
      .filter((b) => b.width <= 2 && b.height >= 8)
      .sort((a, b) => a.left - b.left);
    return {
      badge: box(badge),
      clear: box(clear),
      separators,
      block: {
        left: Math.min(...actions.map((a) => a.left)),
        right: Math.max(...actions.map((a) => a.right)),
        top: Math.min(...actions.map((a) => a.top)),
        bottom: Math.max(...actions.map((a) => a.bottom)),
      },
    };
  });
  expect(layout.separators, `${where}: two separators`).toHaveLength(2);
  const [first, second] = layout.separators;
  expect(first.left, `${where}: first separator follows the count`).toBeGreaterThanOrEqual(layout.badge.right);
  expect(first.right, `${where}: first separator precedes the actions`).toBeLessThanOrEqual(layout.block.left);
  expect(second.left, `${where}: second separator follows every action`).toBeGreaterThanOrEqual(layout.block.right);
  expect(second.right, `${where}: second separator precedes Clear Selection`).toBeLessThanOrEqual(layout.clear.left);
  for (const separator of layout.separators) {
    const middle = (separator.top + separator.bottom) / 2;
    expect(middle, `${where}: separator sits beside the action block`).toBeGreaterThanOrEqual(layout.block.top);
    expect(middle, `${where}: separator sits beside the action block`).toBeLessThanOrEqual(layout.block.bottom);
  }

  // Keyboard: the hidden toggle is no stop, so Shift+Tab from the first action
  // leaves the toolbar; Tab from it walks the rest in order and then leaves.
  await toolbar.getByRole("button", { name: ACTIONS[1], exact: true }).focus();
  await page.keyboard.press("Shift+Tab");
  const firstRing = await focusRing(page);
  expect(firstRing.name, `${where}: Shift+Tab order`).toBe(ACTIONS[0]);
  expect(firstRing.focusVisible && firstRing.drawn, `${where}: "${ACTIONS[0]}" shows a focus ring`).toBe(true);
  expect(firstRing.clippedPx, `${where}: "${ACTIONS[0]}" focus ring is not clipped`).toBeLessThanOrEqual(0);
  await page.keyboard.press("Shift+Tab");
  expect(await focusIsInside(toolbar), `${where}: nothing tabbable precedes the first action`).toBe(false);
  await toolbar.getByRole("button", { name: ACTIONS[0], exact: true }).focus();
  await expectTabSequence(page, ACTIONS.slice(1), where);
  await page.keyboard.press("Tab");
  expect(await focusIsInside(toolbar), `${where}: Tab leaves after the last action`).toBe(false);

  // The fixture-cleanup contract four other specs rely on: Delete inside the
  // count badge's parent div. Opening it is safe; nothing is confirmed.
  const cleanupDelete = page
    .getByText(/\d+\s+selected/i)
    .locator("xpath=ancestor::div[1]")
    .getByRole("button", { name: /delete/i });
  await expect(cleanupDelete).toHaveCount(1);
  await cleanupDelete.click();
  const confirm = page.getByRole("dialog", { name: "Delete 1 paper?" });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(confirm).toBeHidden();
}

test.describe("BULK-TOOLBAR-CONTAINMENT-001 — phone, coarse pointer", () => {
  test.use({ hasTouch: true });

  test("320×568: collapsed by default, every action reachable through the disclosure", async ({ page }) => {
    await selectFirstPaper(page, PHONE_SMALL);
    await expectPhoneToolbar(page, "320×568");
    await expectSafeAreaRespected(page, { top: 20, right: 0, bottom: 0, left: 0 }, "320×568");
  });

  test("390×844: collapsed by default, every action reachable through the disclosure", async ({ page }) => {
    await selectFirstPaper(page, PHONE);
    await expectPhoneToolbar(page, "390×844");
    await expectSafeAreaRespected(page, { top: 47, right: 0, bottom: 34, left: 0 }, "390×844");
  });

  test("568×320 landscape: the expanded list is height-capped and scrolls instead of leaving the screen", async ({
    page,
  }) => {
    await selectFirstPaper(page, PHONE_LANDSCAPE);
    const panel = await expectPhoneToolbar(page, "568×320");
    // The cap really binds here: the panel is limited to the viewport less
    // its margins, and the list scrolls to reach every action.
    expect(panel.bottom - panel.top, "568×320: expanded panel height").toBeLessThanOrEqual(PHONE_LANDSCAPE.height - 48 + 0.5);
    await disclosureToggle(page).click();
    const list = await controlledList(page);
    const scroll = await list.evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight }));
    expect(scroll.sh, "568×320: the action list scrolls").toBeGreaterThan(scroll.ch);
    await disclosureToggle(page).click();
    await expectSafeAreaRespected(page, { top: 0, right: 47, bottom: 21, left: 47 }, "568×320");
  });
});

test.describe("BULK-TOOLBAR-CONTAINMENT-001 — narrow window, fine pointer", () => {
  // A small desktop browser window gets the phone layout too. Without the
  // coarse-pointer minimum height, only the rows' own sizing stops a capped
  // list from squashing them instead of scrolling.
  test("568×320: the capped list keeps 40px rows and scrolls", async ({ page }) => {
    await selectFirstPaper(page, PHONE_LANDSCAPE);
    await expectPhoneToolbar(page, "568×320 fine pointer");
  });
});

test.describe("BULK-TOOLBAR-CONTAINMENT-001 — tablet, coarse pointer", () => {
  test.use({ hasTouch: true });

  for (const vp of [TABLET_PORTRAIT, TABLET_LANDSCAPE]) {
    test(`${vp.width}×${vp.height}: every action visible, wrapping without clipping`, async ({ page }) => {
      await selectFirstPaper(page, vp);
      await expectInlineToolbar(page, `${vp.width}×${vp.height}`, { coarse: true });
    });
  }
});

test.describe("BULK-TOOLBAR-CONTAINMENT-001 — desktop, fine pointer", () => {
  for (const vp of [TABLET_LANDSCAPE, DESKTOP]) {
    test(`${vp.width}×${vp.height}: every action directly reachable at desktop density`, async ({ page }) => {
      await selectFirstPaper(page, vp);
      await expectInlineToolbar(page, `${vp.width}×${vp.height}`, { coarse: false });
    });
  }
});

test.describe("BULK-TOOLBAR-CONTAINMENT-001 — behaviour", () => {
  test("dialogs opened from the phone list close back to their trigger and write nothing", async ({ page }) => {
    const writes: string[] = [];
    page.on("request", (request) => {
      if (BULK_WRITE_RPC.test(request.url())) writes.push(request.url());
    });
    await selectFirstPaper(page, PHONE);
    await disclosureToggle(page).click();
    const list = await controlledList(page);

    const cases = [
      { action: "Delete", dialog: "Delete 1 paper?", close: "Escape" },
      { action: "Delete", dialog: "Delete 1 paper?", close: "Cancel" },
      { action: "Set Project", dialog: "Set Projects for 1 paper", close: "Cancel" },
      { action: "Clear Projects", dialog: "Clear projects from 1 paper?", close: "Escape" },
      { action: "Set Tags", dialog: "Set Tags for 1 paper", close: "Escape" },
      { action: "Clear Tags", dialog: "Clear tags from 1 paper?", close: "Cancel" },
    ];
    for (const { action, dialog: title, close } of cases) {
      const trigger = list.getByRole("button", { name: action, exact: true });
      await trigger.click();
      const dialog = page.getByRole("dialog", { name: title });
      await expect(dialog, `${action} opens its dialog`).toBeVisible();
      if (close === "Escape") await page.keyboard.press("Escape");
      else await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(dialog, `${close} closes the ${action} dialog`).toBeHidden();
      await expect(trigger, `focus returns to ${action}`).toBeFocused();
      await expect(list, "the list stays open behind the dialog").toBeVisible();
    }
    await expect(page.getByText(/^1 selected$/)).toBeVisible();
    expect(writes, "no bulk write was sent").toEqual([]);
  });

  test("Clear Selection removes the toolbar and returns focus to the row it came from", async ({ page }) => {
    const row = await selectFirstPaper(page, PHONE);
    await disclosureToggle(page).click();
    const list = await controlledList(page);
    await list.getByRole("button", { name: "Clear Selection", exact: true }).click();
    await expect(bulkToolbar(page)).toHaveCount(0);
    await expect(row).not.toBeChecked();
    await expect(row, "focus is back on the row checkbox, not <body>").toBeFocused();
  });

  test("AI Analyze progress stays readable in the phone list while the other actions wait", async ({ page }) => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let analyzeCalls = 0;
    await page.route(
      (url) => url.pathname === ANALYZE_FUNCTION_PATH,
      async (route) => {
        if (route.request().method() === "OPTIONS") {
          await route.fulfill({ status: 204, headers: STAND_IN_CORS_HEADERS, body: "" });
          return;
        }
        analyzeCalls++;
        await held;
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          headers: STAND_IN_CORS_HEADERS,
          body: JSON.stringify({
            error: "analysis_unavailable",
            code: "provider_unavailable",
            message: "AI analysis is temporarily unavailable.",
          }),
        });
      },
    );
    const paperWrites: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "PATCH" && request.url().includes("/rest/v1/papers")) paperWrites.push(request.url());
    });

    await selectFirstPaper(page, PHONE);
    await disclosureToggle(page).click();
    const list = await controlledList(page);
    await list.getByRole("button", { name: "AI Analyze (1)", exact: true }).click();

    const progress = list.getByRole("button", { name: "Analyzing 1 of 1...", exact: true });
    await expect(progress).toBeVisible();
    await expect(progress).toBeDisabled();
    expectFullyVisible(await placement(progress), "390×844 analyzing");
    expect(
      await progress.evaluate((el) => el.scrollWidth - el.clientWidth),
      "the progress label is not cut off",
    ).toBeLessThanOrEqual(0);
    for (const name of ACTIONS.slice(1)) {
      await expect(list.getByRole("button", { name, exact: true }), `${name} waits`).toBeDisabled();
    }
    await expect(disclosureToggle(page), "the disclosure stays usable").toBeEnabled();

    release();
    await expect(list.getByRole("button", { name: "AI Analyze (1)", exact: true })).toBeEnabled({ timeout: 15_000 });
    expect(analyzeCalls, "one analysis request, answered by the stand-in").toBe(1);
    expect(paperWrites, "the failed analysis wrote nothing").toEqual([]);
  });

  test("a confirmed bulk delete from the phone list hands focus to Select all", async ({ page }) => {
    test.setTimeout(90_000);
    const title = "ZZ Bulk Toolbar Disposable Paper";
    const rowCheckbox = page.getByRole("checkbox", { name: `Select ${title}`, exact: true });
    const rowDelete = page.getByRole("button", { name: `Delete ${title}`, exact: true });

    await page.setViewportSize(PHONE);
    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);
    try {
      if ((await rowCheckbox.count()) === 0) {
        await page.getByRole("button", { name: /add papers/i }).click();
        const add = page.getByRole("dialog");
        await expect(add).toBeVisible();
        await add.getByRole("tab", { name: /manual/i }).click();
        await page.locator("#manual-title").fill(title);
        await add.getByRole("button", { name: /^add paper$/i }).click();
        await expect(add).toBeHidden({ timeout: 20_000 });
      }
      await expect(rowCheckbox).toHaveCount(1, { timeout: 20_000 });
      await rowCheckbox.focus();
      await page.keyboard.press("Space");
      await expect(page.getByText(/^1 selected$/)).toBeVisible();

      await disclosureToggle(page).click();
      const list = await controlledList(page);
      await list.getByRole("button", { name: "Delete", exact: true }).click();
      const confirm = page.getByRole("dialog", { name: "Delete 1 paper?" });
      await expect(confirm).toBeVisible();
      await confirm.getByRole("button", { name: "Delete", exact: true }).click();

      await expect(bulkToolbar(page)).toHaveCount(0, { timeout: 20_000 });
      await expect(rowCheckbox).toHaveCount(0, { timeout: 20_000 });
      // The row the selection came from is gone, so focus falls back to the
      // table's own Select all checkbox rather than to <body>.
      await expect(page.getByRole("checkbox", { name: "Select all" })).toBeFocused();
    } finally {
      for (let i = 0; i < 3 && (await rowDelete.count()) > 0; i++) {
        await rowDelete.first().click();
        const confirm = page.getByRole("alertdialog");
        await expect(confirm).toBeVisible();
        await confirm.getByRole("button", { name: "Delete", exact: true }).click();
        await expect(page.getByRole("alertdialog")).toHaveCount(0, { timeout: 10_000 });
      }
    }
  });
});
