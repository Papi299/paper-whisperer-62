import { test, expect, type Locator, type Page } from "@playwright/test";
import { waitForDashboard } from "./helpers";

/**
 * REAL-DEVICE-TOUCH-UX-REMEDIATION-001 — touch behaviour above the 768px
 * breakpoint, plus the paper-table hit targets the owner mis-tapped.
 *
 * PR #210 fixed the phone. Real-device verification afterwards found the same
 * defect class still present wherever the *layout* is desktop but the *input*
 * is a finger — an iPad — and one purely geometric defect on the phone itself.
 * These specs are the regression proxy for both.
 *
 * The touch describes run in a Chromium context with `hasTouch`, which makes
 * `(pointer: coarse)` match — exactly the signal `useCoarsePointer()` reads,
 * verified by the first assertion in this file. The desktop describes run in
 * the default context, where it does not, so the two halves of every focus
 * behaviour are pinned by the same probe.
 *
 * IMPORTANT — what this proves and what it does not: Chromium matching
 * `(pointer: coarse)` is not an iOS software keyboard. These tests prove which
 * element the browser focuses when a surface opens, which is the *cause* of the
 * keyboard appearing; they cannot prove when iOS physically animates it in. The
 * owner's iPhone and iPad remain the real-device evidence.
 *
 * State: creates two disposable projects and one disposable tag (the seed ships
 * none, and neither the Filters option lists nor the Add Papers assign section
 * render without them) and deletes them afterwards. One disposable saved search
 * is created and deleted for the Save/Rename dialogs. Nothing else is written.
 */

const PHONE = { width: 390, height: 844 };
const TABLET_PORTRAIT = { width: 768, height: 1024 };
const TABLET_11 = { width: 834, height: 1194 };
const TABLET_LANDSCAPE = { width: 1024, height: 768 };
const DESKTOP = { width: 1280, height: 720 };

const FIXTURE_PROJECT = "ZZ Touch Fixture Project";
const FIXTURE_PROJECT_ALT = "ZZ Touch Fixture Project Two";
const FIXTURE_TAG = "ZZ Touch Fixture Tag";
const FIXTURE_PRESET = "ZZ Touch Fixture Search";

// ── Probes ──────────────────────────────────────────────────────────────────

interface ActiveElement {
  tag: string;
  role: string | null;
  id: string;
  ariaLabel: string | null;
  isBody: boolean;
  /** Whether the browser would raise a software keyboard for this element. */
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
      role: a?.getAttribute("role") ?? null,
      id: a?.id ?? "",
      ariaLabel: a?.getAttribute("aria-label") ?? null,
      isBody: a === document.body,
      isTextEntry,
    };
  });
}

/** Whether the focused element is inside `surface` — i.e. the trap still holds. */
async function activeElementIsInside(surface: Locator) {
  return surface.evaluate((root) => root.contains(document.activeElement));
}

/** Document-level horizontal overflow, measured the way a user experiences it. */
async function expectNoHorizontalOverflow(page: Page, where: string) {
  const m = await page.evaluate(() => ({
    docScroll: document.documentElement.scrollWidth,
    docClient: document.documentElement.clientWidth,
    bodyScroll: document.body.scrollWidth,
    bodyClient: document.body.clientWidth,
  }));
  expect(m.docScroll, `${where}: documentElement scrollWidth vs clientWidth`).toBeLessThanOrEqual(
    m.docClient,
  );
  expect(m.bodyScroll, `${where}: body scrollWidth vs clientWidth`).toBeLessThanOrEqual(
    m.bodyClient,
  );
}

/** The Actions cell buttons of the first row, left to right. */
async function actionGeometry(page: Page) {
  const row = page.locator("tbody tr").first();
  const edit = row.getByRole("button", { name: /^Edit / });
  await edit.scrollIntoViewIfNeeded();
  return page.evaluate(() => {
    const firstRow = document.querySelector("tbody tr");
    if (!firstRow) return null;
    const cells = Array.from(firstRow.querySelectorAll("td"));
    const actionsCell = cells[cells.length - 1];
    const buttons = Array.from(actionsCell.querySelectorAll("button"));
    const boxes = buttons.map((b) => {
      const r = b.getBoundingClientRect();
      return { label: b.getAttribute("aria-label") ?? "", width: r.width, height: r.height, left: r.left, right: r.right };
    });
    const gaps: number[] = [];
    for (let i = 1; i < boxes.length; i++) gaps.push(boxes[i].left - boxes[i - 1].right);
    return { boxes, gaps };
  });
}

// ── Fixtures ────────────────────────────────────────────────────────────────

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

  // One saved search, so the Rename dialog has something to rename.
  await page.getByRole("button", { name: /Saved Searches|Presets/i }).click();
  await page.getByRole("menuitem", { name: /Save current search/i }).click();
  const saveDialog = page.getByRole("dialog");
  await expect(saveDialog).toBeVisible();
  await saveDialog.getByRole("textbox").fill(FIXTURE_PRESET);
  await saveDialog.getByRole("button", { name: /^Save$/ }).click();
  await expect(saveDialog).toBeHidden({ timeout: 15_000 });
}

async function removeEntityFixtures(page: Page) {
  await page.setViewportSize(DESKTOP);
  await page.goto("/", { waitUntil: "networkidle" });
  await waitForDashboard(page);

  await page.getByRole("button", { name: /Saved Searches|Presets/i }).click();
  const deletePreset = page.getByRole("button", { name: `Delete preset "${FIXTURE_PRESET}"` });
  if (await deletePreset.count()) {
    await deletePreset.first().click();
    const confirm = page.getByRole("alertdialog").getByRole("button", { name: /^Delete$/ });
    if (await confirm.isVisible({ timeout: 3_000 }).catch(() => false)) await confirm.click();
    await expect(page.getByRole("alertdialog")).toBeHidden({ timeout: 10_000 }).catch(() => {});
  }
  await page.keyboard.press("Escape");

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

// ── Touch-context specs ─────────────────────────────────────────────────────

test.describe("REAL-DEVICE-TOUCH-UX-REMEDIATION-001 — coarse pointer", () => {
  test.use({ hasTouch: true });

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await createEntityFixtures(page);
    await page.close();
  });

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    await removeEntityFixtures(page).catch(() => {});
    await page.close();
  });

  test("the touch context is what the app reads as a coarse pointer", async ({ page }) => {
    await page.setViewportSize(TABLET_PORTRAIT);
    await page.goto("/", { waitUntil: "networkidle" });
    // Everything below keys off this. If Chromium ever stops emulating it, the
    // rest of this file would silently assert desktop behaviour instead.
    expect(await page.evaluate(() => window.matchMedia("(pointer: coarse)").matches)).toBe(true);
  });

  // ── A. Paper-table Actions hit targets ──────────────────────────────────

  for (const vp of [PHONE, TABLET_PORTRAIT]) {
    test(`paper actions are touch-sized and separated @${vp.width}x${vp.height}`, async ({ page }) => {
      await page.setViewportSize(vp);
      await page.goto("/", { waitUntil: "networkidle" });
      await waitForDashboard(page);

      const geo = await actionGeometry(page);
      expect(geo, "actions cell resolved").not.toBeNull();
      expect(geo!.boxes.length, "at least Edit and Delete are present").toBeGreaterThanOrEqual(2);

      for (const box of geo!.boxes) {
        // Pre-fix these measured 16×32 — the icon's own width, because the
        // buttons were shrinkable inside a fixed 80px column.
        expect(box.width, `hit-target width of "${box.label}"`).toBeGreaterThanOrEqual(40);
        expect(box.height, `hit-target height of "${box.label}"`).toBeGreaterThanOrEqual(40);
      }
      for (const gap of geo!.gaps) {
        // Pre-fix every gap was 2px, which is what made AI Analyze and Edit
        // read as one target under a thumb.
        expect(gap, "separation between adjacent action buttons").toBeGreaterThanOrEqual(6);
      }

      // Semantics are untouched by the resize.
      const row = page.locator("tbody tr").first();
      await expect(row.getByRole("button", { name: /^Edit / })).toBeVisible();
      await expect(row.getByRole("button", { name: /^Delete / })).toBeVisible();
    });
  }

  // ── B. Sidebar management dialogs ───────────────────────────────────────

  const MANAGE_DIALOGS = [
    { trigger: "Manage projects", field: "New project name" },
    { trigger: "Manage tags", field: "New tag name" },
    { trigger: "Manage keyword pool", field: "Keyword to add to pool" },
  ];

  for (const { trigger, field } of MANAGE_DIALOGS) {
    test(`${trigger} opens without focusing its text field`, async ({ page }) => {
      await page.setViewportSize(TABLET_PORTRAIT);
      await page.goto("/", { waitUntil: "networkidle" });
      await waitForDashboard(page);

      await page.getByRole("button", { name: trigger, exact: true }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();

      const active = await activeElement(page);
      expect(active.isTextEntry, `${trigger}: opening must not focus a text field`).toBe(false);
      expect(active.isBody, `${trigger}: focus must not be dropped on <body>`).toBe(false);
      expect(
        await activeElementIsInside(dialog),
        `${trigger}: focus must stay inside the open dialog`,
      ).toBe(true);

      // Explicitly tapping the field still focuses it — the keyboard is
      // deferred, never denied.
      const input = dialog.getByRole("textbox", { name: field });
      await input.click();
      await expect(input).toBeFocused();
      await input.fill("zz probe");
      await expect(input).toHaveValue("zz probe");

      // PFA-C09's close behaviour is untouched.
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      expect((await activeElement(page)).isBody, `${trigger}: focus restored off <body>`).toBe(false);
    });
  }

  /**
   * Manage Exclusions gets its own case rather than a row in MANAGE_DIALOGS:
   * it is the only management dialog with *two* create fields, so the shared
   * shape above would only prove the first one is left alone. This asserts the
   * whole contract — the heading is the deliberate target, neither exclusion
   * field is focused, and both still take an explicit tap.
   */
  test("Manage exclusions opens on its heading, not either exclusion field", async ({ page }) => {
    await page.setViewportSize(TABLET_PORTRAIT);
    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);

    await page.getByRole("button", { name: "Manage exclusions", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    const active = await activeElement(page);
    expect(
      active.isTextEntry,
      `opening must not focus a text field (focused ${active.tag}#${active.id})`,
    ).toBe(false);
    expect(active.isBody, "focus must not be dropped on <body>").toBe(false);
    expect(await activeElementIsInside(dialog), "focus stays inside the open dialog").toBe(true);
    await expect(
      dialog.getByRole("heading", { name: "Manage Exclusion Pools" }),
      "the dialog heading is the deliberate coarse-pointer target",
    ).toBeFocused();

    const keyword = dialog.getByRole("textbox", { name: "Keyword to exclude" });
    const studyType = dialog.getByRole("textbox", { name: "Study type to exclude" });
    await expect(keyword, "the keyword field is not autofocused").not.toBeFocused();
    await expect(studyType, "the study-type field is not autofocused").not.toBeFocused();

    // Both fields still accept an explicit tap. Neither probe is submitted, so
    // this writes no exclusion record.
    await keyword.click();
    await expect(keyword).toBeFocused();
    await keyword.fill("zz probe keyword");
    await expect(keyword).toHaveValue("zz probe keyword");

    await studyType.click();
    await expect(studyType).toBeFocused();
    await studyType.fill("zz probe study type");
    await expect(studyType).toHaveValue("zz probe study type");

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    // The sidebar opener carries `aria-label="Manage exclusions"`, so this
    // identifies the restored node without holding a handle across the close.
    const restored = await activeElement(page);
    expect(restored.isBody, "focus restored off <body>").toBe(false);
    expect(restored.ariaLabel, "focus returns to the Manage exclusions opener").toBe(
      "Manage exclusions",
    );
  });

  // ── C. Tablet Analytics vertical reachability ───────────────────────────

  for (const vp of [TABLET_PORTRAIT, TABLET_11, TABLET_LANDSCAPE]) {
    test(`expanded analytics is fully reachable @${vp.width}x${vp.height}`, async ({ page }) => {
      await page.setViewportSize(vp);
      await page.goto("/", { waitUntil: "networkidle" });
      await waitForDashboard(page);

      const controls = page.getByTestId("dashboard-controls");
      await page.getByRole("button", { name: /Analytics & Insights/ }).click();
      await expect(page.getByText("Publication Year Distribution")).toBeAttached();

      // The header region now owns a bounded vertical scroll. Pre-fix it was
      // `shrink-0` with `overflow: visible` inside an `overflow: hidden` main,
      // so anything past the viewport had no scroll owner at all.
      const box = await controls.evaluate((el) => ({
        overflowY: getComputedStyle(el).overflowY,
        clientHeight: el.clientHeight,
        scrollHeight: el.scrollHeight,
        mainClientHeight: (el.parentElement as HTMLElement).clientHeight,
      }));
      expect(box.overflowY, "controls region is an explicit scroll owner").toBe("auto");
      expect(
        box.clientHeight,
        "controls region never exceeds the space its parent actually has",
      ).toBeLessThanOrEqual(box.mainClientHeight);

      // Every bottom-of-analytics target the owner could not reach is
      // reachable by scrolling that region — and lands inside the viewport.
      for (const name of ["Publication Year Distribution", "Target Keywords", "Target Authors"]) {
        const target = page.getByText(name, { exact: true }).first();
        await target.scrollIntoViewIfNeeded();
        const visible = await target.evaluate((el) => {
          const r = el.getBoundingClientRect();
          return r.top >= 0 && r.bottom <= window.innerHeight && r.height > 0;
        });
        expect(visible, `${name} reachable within the viewport @${vp.width}x${vp.height}`).toBe(true);
      }

      await expectNoHorizontalOverflow(page, `analytics expanded @${vp.width}x${vp.height}`);

      // Collapsing restores the table.
      await controls.evaluate((el) => el.scrollTo(0, 0));
      await page.getByRole("button", { name: /Analytics & Insights/ }).click();
      await expect(page.getByText("Publication Year Distribution")).toHaveCount(0);
      await expect(page.locator("tbody tr").first()).toBeVisible();
      await expectNoHorizontalOverflow(page, `analytics collapsed @${vp.width}x${vp.height}`);
    });
  }

  // ── D. Tablet Filters → Projects / Tags ─────────────────────────────────

  const FILTER_SELECTORS = [
    { trigger: /Filter by project/i, search: "Search projects", option: FIXTURE_PROJECT },
    { trigger: /Filter by tag/i, search: "Search tags", option: FIXTURE_TAG },
  ];

  for (const { trigger, search, option } of FILTER_SELECTORS) {
    test(`Filters ${search} does not autofocus on open`, async ({ page }) => {
      await page.setViewportSize(TABLET_PORTRAIT);
      await page.goto("/", { waitUntil: "networkidle" });
      await waitForDashboard(page);

      await page.getByRole("combobox", { name: trigger }).click();
      const popover = page.locator("[data-radix-popper-content-wrapper]").last();
      await expect(popover).toBeVisible();

      const active = await activeElement(page);
      expect(active.isTextEntry, "opening the selector must not focus its search box").toBe(false);
      expect(active.isBody, "focus must not be dropped on <body>").toBe(false);
      expect(await activeElementIsInside(popover), "focus stays inside the popover").toBe(true);

      // Options are visible and selectable without typing anything.
      const optionRow = popover.getByRole("option", { name: option, exact: true });
      await expect(optionRow).toBeVisible();

      // Explicit search interaction focuses and filters, unchanged.
      const searchBox = popover.getByRole("combobox", { name: search });
      await searchBox.click();
      await expect(searchBox).toBeFocused();
      if (option === FIXTURE_PROJECT) {
        await searchBox.fill("Fixture Project Two");
        await expect(
          popover.getByRole("option", { name: FIXTURE_PROJECT_ALT, exact: true }),
        ).toBeVisible();
        await expect(popover.getByRole("option", { name: FIXTURE_PROJECT, exact: true })).toHaveCount(0);
        await searchBox.fill("");
      }

      // Selection semantics unchanged: the trigger reflects the selection.
      await optionRow.click();
      await expect(optionRow).toHaveAttribute("aria-selected", "true");
      await page.keyboard.press("Escape");
      await expect(page.getByRole("combobox", { name: new RegExp(option) })).toBeVisible();
    });
  }

  // ── E. Tablet Add Papers → Projects / Tags ──────────────────────────────

  for (const { label, search, option } of [
    { label: /Projects/, search: "Search projects", option: FIXTURE_PROJECT },
    { label: /Tags/, search: "Search tags", option: FIXTURE_TAG },
  ]) {
    test(`Add Papers ${search} does not autofocus on open`, async ({ page }) => {
      await page.setViewportSize(TABLET_LANDSCAPE);
      await page.goto("/", { waitUntil: "networkidle" });
      await waitForDashboard(page);

      await page.getByRole("button", { name: /^Add Papers$/ }).click();
      // Scoped by its heading: the assignment Popover is `modal`, so it also
      // carries `role="dialog"` once open.
      const dialog = page.getByRole("dialog").filter({ has: page.getByText("Add Papers", { exact: true }) });
      await expect(dialog).toBeVisible();

      // Held as a handle: the trigger's accessible name changes once something
      // is selected, so a name-based locator could not be re-resolved after.
      const trigger = await dialog.getByRole("button", { name: label }).first().elementHandle();
      await trigger!.click();
      const popover = page.locator("[data-radix-popper-content-wrapper]").last();
      await expect(popover).toBeVisible();

      const active = await activeElement(page);
      expect(active.isTextEntry, "opening the selector must not focus its search box").toBe(false);
      expect(await activeElementIsInside(popover), "focus stays inside the popover").toBe(true);

      // The panel is on screen, not opened off the bottom edge of a short
      // landscape tablet — the reason collision avoidance is now enabled.
      const onScreen = await popover.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, viewport: window.innerHeight };
      });
      expect(onScreen.top, "popover top is on screen").toBeGreaterThanOrEqual(0);
      expect(onScreen.bottom, "popover bottom is on screen").toBeLessThanOrEqual(
        onScreen.viewport + 1,
      );

      // Explicit search interaction works, and selection still toggles.
      const searchBox = popover.getByRole("combobox", { name: search });
      await searchBox.click();
      await expect(searchBox).toBeFocused();
      await searchBox.fill(option);
      const optionRow = popover.getByRole("option", { name: option, exact: true });
      await expect(optionRow).toBeVisible();
      await optionRow.click();
      // The shared assignment state took the selection: the option reads as
      // selected and the dialog's assign summary lists it.
      await expect(optionRow).toHaveAttribute("aria-selected", "true");
      expect(await trigger!.textContent(), "trigger reflects the shared assignment state").toMatch(
        /1 (project|tag)/,
      );

      await page.keyboard.press("Escape");
      await expect(popover).toBeHidden();
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
    });
  }

  // ── F. Save Current Search / Rename ─────────────────────────────────────

  test("Save current search does not autofocus its name field", async ({ page }) => {
    await page.setViewportSize(TABLET_PORTRAIT);
    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);

    await page.getByRole("button", { name: /Saved Searches|Presets/i }).click();
    await page.getByRole("menuitem", { name: /Save current search/i }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    const active = await activeElement(page);
    expect(active.isTextEntry, "opening Save must not focus the name field").toBe(false);
    expect(await activeElementIsInside(dialog), "focus stays inside the dialog").toBe(true);

    // Validation and submission are unchanged: Save stays disabled until a
    // name is typed into the explicitly-focused field.
    const saveButton = dialog.getByRole("button", { name: /^Save$/ });
    await expect(saveButton).toBeDisabled();
    const input = dialog.getByRole("textbox");
    await input.click();
    await expect(input).toBeFocused();
    await input.fill("zz probe name");
    await expect(saveButton).toBeEnabled();

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });

  test("Rename saved search does not autofocus its name field", async ({ page }) => {
    await page.setViewportSize(TABLET_PORTRAIT);
    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);

    await page.getByRole("button", { name: /Saved Searches|Presets/i }).click();
    await page.getByRole("button", { name: `Rename preset "${FIXTURE_PRESET}"` }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    const active = await activeElement(page);
    expect(active.isTextEntry, "opening Rename must not focus the name field").toBe(false);
    expect(await activeElementIsInside(dialog), "focus stays inside the dialog").toBe(true);

    // The draft is still pre-filled; it is simply not focused-and-selected.
    const input = dialog.getByRole("textbox");
    await expect(input).toHaveValue(FIXTURE_PRESET);
    await input.click();
    await expect(input).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });
});

// ── Desktop-context specs ───────────────────────────────────────────────────

test.describe("REAL-DEVICE-TOUCH-UX-REMEDIATION-001 — fine pointer preserved", () => {
  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await createEntityFixtures(page);
    await page.close();
  });

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    await removeEntityFixtures(page).catch(() => {});
    await page.close();
  });

  test("the desktop context is not a coarse pointer", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto("/", { waitUntil: "networkidle" });
    expect(await page.evaluate(() => window.matchMedia("(pointer: coarse)").matches)).toBe(false);
  });

  test("management dialogs still autofocus their create field", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);

    for (const { trigger, field } of [
      { trigger: "Manage projects", field: "New project name" },
      { trigger: "Manage tags", field: "New tag name" },
      { trigger: "Manage keyword pool", field: "Keyword to add to pool" },
      { trigger: "Manage exclusions", field: "Keyword to exclude" },
    ]) {
      await page.getByRole("button", { name: trigger, exact: true }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("textbox", { name: field })).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
    }
  });

  test("Filters and Add Papers still autofocus their search box", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);

    await page.getByRole("combobox", { name: /Filter by project/i }).click();
    let popover = page.locator("[data-radix-popper-content-wrapper]").last();
    await expect(popover.getByRole("combobox", { name: "Search projects" })).toBeFocused();
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: /^Add Papers$/ }).click();
    const dialog = page.getByRole("dialog").filter({ has: page.getByText("Add Papers", { exact: true }) });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: /Projects/ }).first().click();
    popover = page.locator("[data-radix-popper-content-wrapper]").last();
    await expect(popover.getByRole("combobox", { name: "Search projects" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(popover).toBeHidden();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });

  test("Save and Rename still autofocus, and Rename still selects its text", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);

    await page.getByRole("button", { name: /Saved Searches|Presets/i }).click();
    await page.getByRole("menuitem", { name: /Save current search/i }).click();
    let dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("textbox")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();

    await page.getByRole("button", { name: /Saved Searches|Presets/i }).click();
    await page.getByRole("button", { name: `Rename preset "${FIXTURE_PRESET}"` }).click();
    dialog = page.getByRole("dialog");
    const input = dialog.getByRole("textbox");
    await expect(input).toBeFocused();
    // Select-all on open is the behaviour that makes typing replace the name.
    const selection = await input.evaluate((el: HTMLInputElement) => ({
      start: el.selectionStart,
      end: el.selectionEnd,
      length: el.value.length,
    }));
    expect(selection.start).toBe(0);
    expect(selection.end).toBe(selection.length);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });

  test("desktop paper-table action density is unchanged", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);

    const actionsColumnWidth = await page.evaluate(() => {
      const th = Array.from(document.querySelectorAll("th")).find(
        (n) => n.textContent?.trim() === "Actions",
      );
      return th ? th.getBoundingClientRect().width : null;
    });
    // The coarse-pointer widening must not leak into the mouse layout.
    expect(actionsColumnWidth).toBeLessThanOrEqual(96);
    await expectNoHorizontalOverflow(page, "desktop dashboard");
  });

  test("desktop dashboard header does not scroll when analytics is collapsed", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);

    const controls = page.getByTestId("dashboard-controls");
    const collapsed = await controls.evaluate((el) => ({
      overflows: el.scrollHeight > el.clientHeight,
    }));
    expect(collapsed.overflows, "collapsed header fits, so no scrollbar appears").toBe(false);
    await expect(page.locator("tbody tr").first()).toBeVisible();
  });
});
