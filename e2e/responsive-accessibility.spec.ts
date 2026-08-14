import { test, expect, type Locator, type Page } from "@playwright/test";
import { waitForDashboard } from "./helpers";

/**
 * PFA-C09 — responsive web shell, table overflow, keyboard access, focus and
 * accessible names.
 *
 * These are runtime behaviours, so Playwright is the primary evidence. Every
 * assertion here is read-only: dialogs are opened and closed, client-side sort
 * and column width are changed, and the table is scrolled — nothing is written
 * back to the database. The one genuinely mutating control on this surface (the
 * badge "exclude" action) is checked for focus visibility and reachability but
 * deliberately never activated.
 *
 * Scope note: this is targeted regression coverage for the defects PFA-C09
 * fixed. It is NOT a formal whole-product WCAG conformance audit and must not
 * be described as one.
 */

const NARROW = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 720 };

/** The six taxonomy "manage" controls, which used to all be called "Settings". */
const MANAGE_BUTTON_NAMES = [
  "Manage projects",
  "Manage tags",
  "Manage keyword pool",
  "Manage study type pool",
  "Manage synonyms",
  "Manage exclusions",
];

/** Document-level horizontal overflow, measured the way a user experiences it. */
async function horizontalOverflow(page: Page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    return {
      docScroll: doc.scrollWidth,
      docClient: doc.clientWidth,
      bodyScroll: document.body.scrollWidth,
      bodyClient: document.body.clientWidth,
    };
  });
}

async function expectNoHorizontalOverflow(page: Page, where: string) {
  const m = await horizontalOverflow(page);
  expect(m.docScroll, `${where}: documentElement scrollWidth vs clientWidth`).toBeLessThanOrEqual(
    m.docClient,
  );
  expect(m.bodyScroll, `${where}: body scrollWidth vs clientWidth`).toBeLessThanOrEqual(
    m.bodyClient,
  );
}

/** The `<th>` owning a given sort button, for reading `aria-sort`. */
function headerOf(sortButton: Locator) {
  return sortButton.locator("xpath=ancestor::th[1]");
}

test.describe("PFA-C09 responsive shell", () => {
  test("narrow viewport replaces the fixed rail with a keyboard-operable drawer", async ({
    page,
  }) => {
    await page.setViewportSize(NARROW);
    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);

    // 1. The desktop rail must not occupy a 390px viewport. Before PFA-C09 the
    //    `w-64` <aside> was rendered unconditionally and ate ~2/3 of the width.
    await expect(page.getByRole("complementary")).toBeHidden();
    await expect(page.getByRole("button", { name: "Manage projects" })).toBeHidden();

    // 2. A navigation trigger exists and names itself. Two locators on purpose:
    //    the role locator proves the accessible name, and the CSS locator keeps
    //    working once Radix marks the background `aria-hidden` (see step 5).
    const trigger = page.getByRole("button", { name: "Open navigation menu" });
    const triggerEl = page.locator('button[aria-label="Open navigation menu"]');
    await expect(trigger).toBeVisible();
    await expect(triggerEl).toHaveAttribute("aria-expanded", "false");

    // 3. It opens from the keyboard alone.
    await trigger.focus();
    await expect(trigger).toBeFocused();
    await page.keyboard.press("Enter");

    const drawer = page.getByRole("dialog", { name: /PaperLume navigation/i });
    await expect(drawer).toBeVisible();
    await expect(triggerEl).toHaveAttribute("aria-expanded", "true");

    // 4. Every sidebar capability is present inside the drawer, and the product
    //    name travels with it (PFA-C07 branding must survive this shell change).
    await expect(drawer.getByText("PaperLume", { exact: true })).toBeVisible();
    for (const name of MANAGE_BUTTON_NAMES) {
      await expect(drawer.getByRole("button", { name })).toBeVisible();
    }
    await expect(drawer.getByRole("button", { name: "Settings" })).toBeVisible();

    // 5. Focus moved into the drawer — background content is not still holding it.
    const focusInsideDrawer = await page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]');
      return !!dialog && !!document.activeElement && dialog.contains(document.activeElement);
    });
    expect(focusInsideDrawer, "focus should move into the navigation drawer").toBe(true);

    // 6. An explicit close control exists (the Sheet's own Close button).
    await expect(drawer.getByRole("button", { name: /close/i })).toBeVisible();

    // 7. The drawer is modal: background content is removed from the
    //    accessibility tree, so it cannot be tabbed or read behind the overlay.
    //    This is why `trigger` (a role locator) resolves to nothing right now.
    await expect(trigger).toHaveCount(0);
    await expect(page.getByRole("button", { name: /add papers/i })).toHaveCount(0);

    // 8. Escape closes it and focus returns to the trigger.
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect(triggerEl).toHaveAttribute("aria-expanded", "false");

    // 9. Opening a full-width drawer must not have introduced page overflow.
    await expectNoHorizontalOverflow(page, "dashboard @390");
  });

  test("no body-level horizontal overflow on Auth or Dashboard", async ({ page, browser }) => {
    // Authenticated dashboard, at both required viewports.
    for (const vp of [NARROW, DESKTOP]) {
      await page.setViewportSize(vp);
      await page.goto("/", { waitUntil: "networkidle" });
      await waitForDashboard(page);
      await expectNoHorizontalOverflow(page, `dashboard @${vp.width}`);
    }

    // Unauthenticated Auth page needs its own storage-free context.
    const context = await browser.newContext({ storageState: undefined, viewport: NARROW });
    const authPage = await context.newPage();
    await authPage.goto("/auth", { waitUntil: "networkidle" });
    await expect(
      authPage.getByRole("heading", { name: "PaperLume", exact: true }),
    ).toBeVisible({ timeout: 10_000 });
    await expectNoHorizontalOverflow(authPage, "auth @390");
    await context.close();
  });

  test("primary dashboard actions stay reachable at a narrow width", async ({ page }) => {
    await page.setViewportSize(NARROW);
    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);

    // Header actions wrap rather than being pushed off-screen.
    for (const name of [/add papers/i, /find duplicates/i, /columns/i]) {
      const button = page.getByRole("button", { name }).first();
      await expect(button).toBeVisible();
      await expect(button).toBeInViewport();
    }

    // Filter controls carry programmatic names that survive the user typing.
    await expect(page.getByRole("textbox", { name: "Search papers" })).toBeVisible();
    const from = page.getByRole("spinbutton", { name: "Published from year" });
    const to = page.getByRole("spinbutton", { name: "Published to year" });
    await expect(from).toBeVisible();
    await expect(to).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Filter by study type" })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Filter by notes presence" })).toBeVisible();
  });
});

test.describe("PFA-C09 table overflow and keyboard operation", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);
    await expect(page.locator("table")).toBeVisible();
  });

  test("horizontal table overflow is contained in its own scroll region", async ({ page }) => {
    // The page itself must not scroll sideways...
    await expectNoHorizontalOverflow(page, "dashboard @1280");

    // ...while the table's dedicated container absorbs the extra width.
    const scroller = page.locator("table").locator("xpath=ancestor::div[contains(@class,'overflow-auto')][1]");
    const metrics = await scroller.evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }));

    if (metrics.scrollWidth <= metrics.clientWidth) {
      // Nothing to contain at this width — do not manufacture overflow.
      test.skip(true, "table fits the viewport; no horizontal containment to prove");
    }

    // The far-right Actions column is reachable by scrolling that container.
    await scroller.evaluate((el) => {
      el.scrollLeft = el.scrollWidth;
    });
    const scrolled = await scroller.evaluate((el) => el.scrollLeft);
    expect(scrolled, "table scroll container should move horizontally").toBeGreaterThan(0);

    await expect(page.getByRole("columnheader", { name: "Actions" })).toBeInViewport();

    // Vertical virtualization still works after the horizontal excursion.
    const before = await page.locator("tbody[data-index]").count();
    expect(before).toBeGreaterThan(0);
    await scroller.evaluate((el) => {
      el.scrollLeft = 0;
      el.scrollTop = 1200;
    });
    await expect
      .poll(async () => page.locator("tbody[data-index]").first().getAttribute("data-index"))
      .not.toBe("0");
  });

  test("column headers sort from the keyboard and expose aria-sort", async ({ page }) => {
    const sortButton = page.getByRole("button", { name: "Title", exact: true });
    const th = headerOf(sortButton);

    await expect(th).toHaveAttribute("aria-sort", "none");

    // Reachable and activatable without a pointer.
    await sortButton.focus();
    await expect(sortButton).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(th).toHaveAttribute("aria-sort", "ascending");

    await page.keyboard.press("Enter");
    await expect(th).toHaveAttribute("aria-sort", "descending");

    // Full cycle returns to unsorted.
    await page.keyboard.press("Enter");
    await expect(th).toHaveAttribute("aria-sort", "none");
  });

  test("column resize handles are keyboard-operable and never trigger a sort", async ({
    page,
  }) => {
    const separator = page.getByRole("separator", { name: "Resize Title column" });
    await expect(separator).toBeVisible();

    const th = headerOf(page.getByRole("button", { name: "Title", exact: true }));
    await expect(th).toHaveAttribute("aria-sort", "none");

    const widthOf = () => th.evaluate((el) => el.getBoundingClientRect().width);
    const startWidth = await widthOf();
    const startValue = Number(await separator.getAttribute("aria-valuenow"));

    await separator.focus();
    await expect(separator).toBeFocused();

    await page.keyboard.press("ArrowRight");
    await expect
      .poll(async () => Number(await separator.getAttribute("aria-valuenow")))
      .toBeGreaterThan(startValue);
    expect(await widthOf(), "ArrowRight should widen the column").toBeGreaterThan(startWidth);

    await page.keyboard.press("ArrowLeft");
    await expect
      .poll(async () => Number(await separator.getAttribute("aria-valuenow")))
      .toBe(startValue);

    // Resizing must not have been interpreted as a sort request.
    await expect(th).toHaveAttribute("aria-sort", "none");

    // Clamping still applies: End pins at the advertised maximum.
    const max = Number(await separator.getAttribute("aria-valuemax"));
    await page.keyboard.press("End");
    await expect
      .poll(async () => Number(await separator.getAttribute("aria-valuenow")))
      .toBe(max);

    // Tab still escapes the handle — the resize model is not a keyboard trap.
    await page.keyboard.press("Tab");
    await expect(separator).not.toBeFocused();
  });

  test("paper-row icon controls have meaningful, row-specific accessible names", async ({
    page,
  }) => {
    const row = page.locator("tbody[data-index]").first();
    const title = (await row.locator("td p").first().textContent())?.trim();
    expect(title, "seeded fixture row should have a title").toBeTruthy();

    // Icon-only controls that previously announced only "Edit" / "Delete" /
    // "GS" / "J" — or nothing at all — now name their row.
    await expect(row.getByRole("button", { name: `Edit ${title}` })).toBeVisible();
    await expect(row.getByRole("button", { name: `Delete ${title}` })).toBeVisible();
    await expect(row.getByRole("link", { name: `Search ${title} on Google Scholar` })).toBeVisible();
    await expect(row.getByRole("button", { name: `Add cloud link for ${title}` })).toBeVisible();
    await expect(row.getByRole("button", { name: `Analyze ${title} with AI` })).toBeVisible();

    // Expand/collapse exposes state semantically, not just visually.
    const expander = row.getByRole("button", { name: `Expand abstract for ${title}` });
    await expect(expander).toHaveAttribute("aria-expanded", "false");
    await expander.focus();
    await page.keyboard.press("Enter");
    const collapser = row.getByRole("button", { name: `Collapse abstract for ${title}` });
    await expect(collapser).toHaveAttribute("aria-expanded", "true");

    // aria-controls points at a region that actually exists.
    const controls = await collapser.getAttribute("aria-controls");
    expect(controls).toBeTruthy();
    await expect(page.locator(`#${controls}`)).toBeVisible();

    await page.keyboard.press("Enter");
    await expect(expander).toHaveAttribute("aria-expanded", "false");
  });

  test("hover-hidden exclude control is reachable and visible on keyboard focus", async ({
    page,
  }) => {
    // Seeded papers carry 1–3 keywords, so a keyword badge is always present.
    const excludeButton = page.getByRole("button", { name: /^Exclude keyword / }).first();
    await expect(excludeButton).toBeAttached();

    // Reachable by keyboard: Tab forward from the row's expander until this
    // control takes focus. No pointer is involved at any point.
    const row = page.locator("tbody[data-index]").first();
    await row.getByRole("button", { name: /^Expand abstract for / }).focus();
    let reached = false;
    for (let i = 0; i < 40 && !reached; i++) {
      await page.keyboard.press("Tab");
      reached = await excludeButton.evaluate((el) => el === document.activeElement);
    }
    expect(reached, "exclude control should be reachable by Tab alone").toBe(true);

    // Pre-fix this button was `opacity-0` until pointer hover, so a keyboard
    // user focused a control they could not see. It must now be visible while
    // focused (poll past the opacity transition).
    await expect(excludeButton).toBeVisible();
    await expect
      .poll(
        async () => Number(await excludeButton.evaluate((el) => getComputedStyle(el).opacity)),
        { message: "focused exclude control must not be transparent" },
      )
      .toBeGreaterThan(0.9);

    // Deliberately NOT activated — excluding a keyword is a real mutation.
  });

  test("quick cloud-link flow names its input and its actions", async ({ page }) => {
    const row = page.locator("tbody[data-index]").first();
    const title = (await row.locator("td p").first().textContent())?.trim();

    const trigger = row.getByRole("button", { name: `Add cloud link for ${title}` });
    await trigger.focus();
    await page.keyboard.press("Enter");

    const input = page.getByRole("textbox", { name: "Cloud link URL" });
    await expect(input).toBeVisible();
    await expect(page.getByRole("button", { name: "Save cloud link" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Cancel cloud link" })).toBeVisible();

    // Escape still closes without saving (behaviour preserved by PFA-C09).
    await input.press("Escape");
    await expect(input).toBeHidden();
  });
});

test.describe("PFA-C09 focus and labelling", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);
  });

  test("sidebar management buttons have unique, action-specific names", async ({ page }) => {
    const sidebar = page.getByRole("complementary");
    await expect(sidebar).toBeVisible();

    for (const name of MANAGE_BUTTON_NAMES) {
      // Exactly one control per destination — six buttons all called
      // "Settings" was the pre-fix state.
      await expect(sidebar.getByRole("button", { name, exact: true })).toHaveCount(1);
    }
  });

  test("a management modal opens by keyboard, traps focus and restores it on close", async ({
    page,
  }) => {
    const trigger = page.getByRole("complementary").getByRole("button", {
      name: "Manage projects",
      exact: true,
    });

    await trigger.focus();
    await expect(trigger).toBeFocused();
    await page.keyboard.press("Enter");

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // Focus is inside the dialog, and Tab keeps it there.
    const inside = async () =>
      page.evaluate(() => {
        const d = document.querySelector('[role="dialog"]');
        return !!d && !!document.activeElement && d.contains(document.activeElement);
      });
    expect(await inside(), "focus should enter the dialog").toBe(true);

    for (let i = 0; i < 12; i++) {
      await page.keyboard.press("Tab");
      expect(await inside(), `focus escaped the dialog after ${i + 1} Tab presses`).toBe(true);
    }
    await page.keyboard.press("Shift+Tab");
    expect(await inside(), "focus escaped the dialog on Shift+Tab").toBe(true);

    // Escape closes and focus returns to the control that opened it.
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test("nothing steals focus on dashboard load", async ({ page }) => {
    const active = await page.evaluate(() => {
      const el = document.activeElement;
      return { tag: el?.tagName ?? null, isBody: el === document.body };
    });
    // A page-load autofocus would strand screen-reader and keyboard users
    // mid-document; the dashboard must leave focus at the document start.
    expect(active.isBody || active.tag === "HTML", `focus was on <${active.tag}>`).toBe(true);
  });
});
