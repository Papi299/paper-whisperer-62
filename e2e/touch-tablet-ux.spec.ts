import { test, expect, type Locator, type Page } from "@playwright/test";
import { getPaperCount, waitForDashboard } from "./helpers";

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
 * is created and deleted for the Save/Rename dialogs, and one disposable synonym
 * group for the Edit Synonym Group sub-dialog (REAL-DEVICE-TOUCH-UX-REMEDIATION
 * -002). All of it is written and removed through the UI. Nothing else is
 * written — in particular no focus probe below ever saves an edit.
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
const FIXTURE_SYNONYM = "ZZ Touch Fixture Synonym";
const FIXTURE_SYNONYM_TERMS = "[ZZ Touch Alias One][ZZ Touch Alias Two]";

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

/**
 * Scope a Dialog by its heading.
 *
 * Every REMEDIATION-002 edit surface is a sub-dialog opened from a management
 * dialog, so two Dialogs are on screen at once and a bare `getByRole("dialog")`
 * is ambiguous. A `hasText` filter is not enough either — the Manage Synonyms
 * dialog contains an "Add Synonym Group" *button*, so filtering on that string
 * matches both. The heading is the only unambiguous discriminator.
 */
function dialogByHeading(page: Page, heading: string) {
  return page
    .getByRole("dialog")
    .filter({ has: page.getByRole("heading", { name: heading, exact: true }) });
}

/**
 * Open a sidebar management dialog. Below 768px the sidebar itself lives behind
 * the nav sheet, so the manage button has to be reached through it.
 */
async function openSidebarManager(page: Page, label: string, viewportWidth: number) {
  if (viewportWidth < 768) {
    await page.getByRole("button", { name: "Open navigation menu" }).click();
  }
  await page.getByRole("button", { name: label, exact: true }).click();
}

/** Escape out of however many Dialogs are stacked, and wait for them to go. */
async function closeAllDialogs(page: Page) {
  for (let i = 0; i < 4; i++) {
    if ((await page.getByRole("dialog").count()) === 0) break;
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
  }
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 5_000 });
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

  // One synonym group, so the Edit Synonym Group sub-dialog has something to
  // edit. Created through the Add sub-dialog — the same surface under test —
  // rather than by writing to the database directly.
  await page.getByRole("button", { name: "Manage synonyms", exact: true }).click();
  const synonyms = dialogByHeading(page, "Manage Synonyms");
  await expect(synonyms).toBeVisible();
  if ((await page.getByRole("button", { name: `Edit synonym group ${FIXTURE_SYNONYM}` }).count()) === 0) {
    await page.getByRole("button", { name: "Add Synonym Group", exact: true }).click();
    const sub = dialogByHeading(page, "Add Synonym Group");
    await expect(sub).toBeVisible();
    await sub.getByLabel("Display Name (Canonical Term)").fill(FIXTURE_SYNONYM);
    await sub.getByLabel(/^Synonyms/).fill(FIXTURE_SYNONYM_TERMS);
    await sub.getByRole("button", { name: "Add", exact: true }).click();
    await expect(sub).toBeHidden({ timeout: 10_000 });
  }
  await page.keyboard.press("Escape");
  await expect(synonyms).toBeHidden();

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

  // The synonym group deletes without a confirm step.
  await page.getByRole("button", { name: "Manage synonyms", exact: true }).click();
  const synonyms = dialogByHeading(page, "Manage Synonyms");
  await expect(synonyms).toBeVisible();
  const deleteSynonym = page.getByRole("button", { name: `Delete synonym group ${FIXTURE_SYNONYM}` });
  if (await deleteSynonym.count()) {
    await deleteSynonym.first().click();
    await expect(deleteSynonym).toHaveCount(0, { timeout: 10_000 });
  }
  await page.keyboard.press("Escape");
  await expect(synonyms).toBeHidden();
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

// ── REAL-DEVICE-TOUCH-UX-REMEDIATION-002 ────────────────────────────────────

/**
 * REAL-DEVICE-TOUCH-UX-REMEDIATION-002 — the surfaces the owner found still
 * broken on real hardware after PR #214 shipped REMEDIATION-001.
 *
 * Same defect class, same rule — opening a surface is not consent to type — on
 * the management/edit/settings/analytics surfaces that REMEDIATION-001 did not
 * reach: Analytics' two Target selectors, Settings, Edit Project, Edit Tag,
 * Edit Synonym Group, Edit Paper and Edit Paper's own Projects/Tags selectors.
 *
 * Plus one layout defect that is not a focus problem at all: the long Edit Paper
 * form was not reliably scrollable on the owner's iPhone/iPad. See the scroll
 * describe below for exactly what automation can and cannot prove about it.
 */
test.describe("REAL-DEVICE-TOUCH-UX-REMEDIATION-002 — coarse pointer", () => {
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

  // ── A. Analytics → Target Keywords / Target Authors ─────────────────────

  const TARGET_SELECTORS = [
    { label: "Target Keywords", search: "Search target keywords" },
    { label: "Target Authors", search: "Search target authors" },
  ];

  for (const { label, search } of TARGET_SELECTORS) {
    for (const vp of [TABLET_PORTRAIT, TABLET_LANDSCAPE]) {
      test(`Analytics ${label} does not autofocus Search @${vp.width}x${vp.height}`, async ({ page }) => {
        await page.setViewportSize(vp);
        await page.goto("/", { waitUntil: "networkidle" });
        await waitForDashboard(page);

        await page.getByRole("button", { name: /Analytics & Insights/ }).click();
        await expect(page.getByText("Publication Year Distribution")).toBeAttached();

        // These two controls sit at the very bottom of the analytics region,
        // which owns its own scroll above 768px.
        const trigger = page.getByRole("button", { name: new RegExp(`^${label}`) }).first();
        await trigger.scrollIntoViewIfNeeded();
        await trigger.click();

        const popover = page.locator("[data-radix-popper-content-wrapper]").last();
        await expect(popover).toBeVisible();

        // Pre-fix this was the search box: INPUT[aria-label="Search target
        // keywords"], isTextEntry true — so the keyboard covered the option
        // list the user opened the selector to read.
        const active = await activeElement(page);
        expect(
          active.isTextEntry,
          `${label}: opening must not focus Search (focused ${active.tag} "${active.ariaLabel}")`,
        ).toBe(false);
        expect(active.isBody, `${label}: focus must not be dropped on <body>`).toBe(false);
        expect(await activeElementIsInside(popover), `${label}: focus stays inside the popover`).toBe(
          true,
        );

        const searchBox = popover.getByRole("textbox", { name: search });
        await expect(searchBox, `${label}: Search is not focused`).not.toBeFocused();

        // The list is readable before anything is typed — the whole point of
        // not raising the keyboard over it. Target Keywords draws its options
        // from paper keywords/MeSH terms, which the deterministic seed does not
        // populate, so that one legitimately renders an empty list; either way
        // the list content has to be on screen without typing first.
        const options = popover.getByRole("checkbox");
        const optionCount = await options.count();
        if (optionCount > 0) {
          await expect(
            options.first(),
            `${label}: options are visible before typing`,
          ).toBeVisible();
        } else {
          await expect(
            popover.getByText("No matches"),
            `${label}: the empty list is readable before typing`,
          ).toBeVisible();
        }

        // Explicitly tapping Search still focuses it and still accepts input.
        await searchBox.click();
        await expect(searchBox).toBeFocused();
        if (optionCount > 0) {
          // …and still filters the list down to a match.
          const optionText = (await popover.locator("label").first().innerText()).trim();
          await searchBox.fill(optionText.slice(0, 4));
          await expect(options.first()).toBeVisible();
          await expect(
            popover.getByText(optionText, { exact: true }).first(),
            `${label}: filtering keeps the matching option`,
          ).toBeVisible();
        } else {
          await searchBox.fill("zz probe");
          await expect(searchBox).toHaveValue("zz probe");
        }

        await page.keyboard.press("Escape");
        await expect(popover).toBeHidden();
        expect(
          (await activeElement(page)).isBody,
          `${label}: focus restored off <body>`,
        ).toBe(false);
      });
    }
  }

  // ── B. Settings ─────────────────────────────────────────────────────────

  test("Settings opens on its heading, not the PubMed API key field", async ({ page }) => {
    await page.setViewportSize(TABLET_PORTRAIT);
    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const dialog = dialogByHeading(page, "Settings");
    await expect(dialog).toBeVisible();

    const active = await activeElement(page);
    expect(
      active.isTextEntry,
      `opening Settings must not focus a text field (focused ${active.tag}#${active.id})`,
    ).toBe(false);
    expect(active.isBody, "focus must not be dropped on <body>").toBe(false);
    expect(await activeElementIsInside(dialog), "focus stays inside Settings").toBe(true);
    await expect(
      dialog.getByRole("heading", { name: "Settings" }),
      "the dialog heading is the deliberate coarse-pointer target",
    ).toBeFocused();

    // The field loads asynchronously; it must still be unfocused once it has.
    const pubmed = dialog.getByLabel("PubMed API Key (NCBI)");
    await expect(pubmed).toBeVisible({ timeout: 10_000 });
    await expect(pubmed, "the PubMed field is not implicitly focused once it resolves").not.toBeFocused();

    // An explicit tap focuses it. Nothing is typed and nothing is saved, so the
    // user's real API key is neither read back nor mutated by this test.
    await pubmed.click();
    await expect(pubmed).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    expect((await activeElement(page)).isBody, "focus restored off <body>").toBe(false);
  });

  // ── C/D/E. Edit Project / Edit Tag / Edit Synonym Group ─────────────────

  const EDIT_SUB_DIALOGS = [
    {
      manage: "Manage projects",
      open: () => `Edit project ${FIXTURE_PROJECT}`,
      heading: "Edit Project",
      field: "Name",
      fieldId: "project-name",
    },
    {
      manage: "Manage tags",
      open: () => `Edit tag ${FIXTURE_TAG}`,
      heading: "Edit Tag",
      field: "Name",
      fieldId: "tag-name",
    },
    {
      manage: "Manage synonyms",
      open: () => `Edit synonym group ${FIXTURE_SYNONYM}`,
      heading: "Edit Synonym Group",
      field: "Display Name (Canonical Term)",
      fieldId: "canonical",
    },
  ];

  for (const { manage, open, heading, field, fieldId } of EDIT_SUB_DIALOGS) {
    for (const vp of [PHONE, TABLET_PORTRAIT]) {
      test(`${heading} opens on its heading @${vp.width}x${vp.height}`, async ({ page }) => {
        await page.setViewportSize(vp);
        await page.goto("/", { waitUntil: "networkidle" });
        await waitForDashboard(page);

        await openSidebarManager(page, manage, vp.width);
        // `exact` matters: the fixture project's name is a prefix of the second
        // fixture project's, so a substring match resolves to both openers.
        const opener = page.getByRole("button", { name: open(), exact: true });
        await expect(opener).toBeVisible();
        await opener.click();

        const dialog = dialogByHeading(page, heading);
        await expect(dialog).toBeVisible();

        // Pre-fix: INPUT#<fieldId>, isTextEntry true.
        const active = await activeElement(page);
        expect(
          active.isTextEntry,
          `${heading}: opening must not focus a text field (focused ${active.tag}#${active.id})`,
        ).toBe(false);
        expect(active.isBody, `${heading}: focus must not be dropped on <body>`).toBe(false);
        expect(
          await activeElementIsInside(dialog),
          `${heading}: focus stays inside the open sub-dialog`,
        ).toBe(true);
        await expect(
          dialog.getByRole("heading", { name: heading, exact: true }),
          `${heading}: the heading is the deliberate coarse-pointer target`,
        ).toBeFocused();

        const input = dialog.getByLabel(field, { exact: true });
        await expect(input, `${heading}: ${field} is not autofocused`).not.toBeFocused();
        expect(active.id, `${heading}: #${fieldId} specifically is not the focused node`).not.toBe(
          fieldId,
        );

        // An explicit tap still focuses and still types. Nothing is submitted:
        // no Save/Update is clicked, so the fixture is not mutated.
        await input.click();
        await expect(input).toBeFocused();
        await input.fill("zz probe");
        await expect(input).toHaveValue("zz probe");

        await closeAllDialogs(page);
        expect((await activeElement(page)).isBody, `${heading}: focus restored off <body>`).toBe(
          false,
        );
      });
    }
  }

  // ── F. Edit Paper outer Dialog ──────────────────────────────────────────

  for (const vp of [PHONE, TABLET_PORTRAIT]) {
    test(`Edit Paper opens on its heading @${vp.width}x${vp.height}`, async ({ page }) => {
      await page.setViewportSize(vp);
      await page.goto("/", { waitUntil: "networkidle" });
      await waitForDashboard(page);

      await page.locator("tbody tr").first().getByRole("button", { name: /^Edit / }).click();
      const dialog = dialogByHeading(page, "Edit Paper");
      await expect(dialog).toBeVisible();

      // Pre-fix: INPUT#title, isTextEntry true.
      const active = await activeElement(page);
      expect(
        active.isTextEntry,
        `Edit Paper: opening must not focus Title (focused ${active.tag}#${active.id})`,
      ).toBe(false);
      expect(active.isBody, "focus must not be dropped on <body>").toBe(false);
      expect(await activeElementIsInside(dialog), "focus stays inside Edit Paper").toBe(true);
      await expect(
        dialog.getByRole("heading", { name: "Edit Paper", exact: true }),
        "the dialog heading is the deliberate coarse-pointer target",
      ).toBeFocused();

      const title = dialog.locator("#title");
      await expect(title, "Title is not autofocused").not.toBeFocused();
      await title.click();
      await expect(title).toBeFocused();

      // Deliberately no Save Changes: the paper is not modified by this probe.
      await closeAllDialogs(page);
      const restored = await activeElement(page);
      expect(restored.isBody, "focus restored off <body>").toBe(false);
      expect(restored.ariaLabel ?? "", "focus returns to the paper's Edit opener").toMatch(/^Edit /);
    });
  }

  // ── G. Edit Paper vertical reachability ─────────────────────────────────

  /**
   * The owner's report is that the long Edit Paper form is not reliably
   * scrollable on an iPhone/iPad. That specific failure is an iOS one and this
   * suite cannot reproduce it: `vh` in Chromium equals the visible viewport,
   * whereas on iOS Safari it resolves against the *large* viewport, so the
   * pre-fix `max-h-[90vh]` shell could be taller than the screen while the
   * browser still believed its contents fit. What this test does prove is the
   * contract that makes the iOS case impossible: a single deliberate scroll
   * owner, bounded to the viewport that is actually visible, with the whole
   * form reachable inside it and no dependence on the page behind the modal.
   */
  for (const vp of [PHONE, TABLET_PORTRAIT, TABLET_LANDSCAPE]) {
    test(`Edit Paper is fully reachable @${vp.width}x${vp.height}`, async ({ page }) => {
      await page.setViewportSize(vp);
      await page.goto("/", { waitUntil: "networkidle" });
      await waitForDashboard(page);

      await page.locator("tbody tr").first().getByRole("button", { name: /^Edit / }).click();
      const dialog = dialogByHeading(page, "Edit Paper");
      await expect(dialog).toBeVisible();

      const scroller = dialog.getByTestId("edit-paper-scroll");
      await expect(scroller, "Edit Paper has one deliberate scroll owner").toBeVisible();

      const before = await scroller.evaluate((el) => {
        const cs = getComputedStyle(el);
        return {
          overflowY: cs.overflowY,
          overscrollY: cs.overscrollBehaviorY,
          touchAction: cs.touchAction,
          clientHeight: el.clientHeight,
          scrollHeight: el.scrollHeight,
          scrollTop: el.scrollTop,
          viewport: window.innerHeight,
          dialogBottom: (el.closest("[role=dialog]") as HTMLElement).getBoundingClientRect().bottom,
          dialogTop: (el.closest("[role=dialog]") as HTMLElement).getBoundingClientRect().top,
        };
      });

      expect(before.overflowY, "the scroll owner declares vertical overflow").toBe("auto");
      // Touch panning is allowed on it, and a pan that runs past the end does
      // not chain out to the scroll-locked page behind the modal.
      expect(before.touchAction, "touch panning is allowed").toMatch(/pan-y|auto/);
      expect(before.overscrollY, "overscroll does not chain to the page behind").toBe("contain");

      // Bounded to the viewport that is actually visible — the property the
      // pre-fix `vh` shell could not guarantee on iOS.
      expect(
        before.clientHeight,
        "the scroll owner never exceeds the visible viewport",
      ).toBeLessThanOrEqual(before.viewport);
      expect(before.dialogTop, "the dialog's top edge is on screen").toBeGreaterThanOrEqual(-1);
      expect(
        before.dialogBottom,
        "the dialog's bottom edge is on screen",
      ).toBeLessThanOrEqual(before.viewport + 1);

      // The document behind the modal is not the scroll owner.
      const bodyLocked = await page.evaluate(() => getComputedStyle(document.body).overflow);
      expect(bodyLocked, "the page behind the modal stays scroll-locked").toBe("hidden");

      if (before.scrollHeight > before.clientHeight) {
        // Content genuinely exceeds the box: scrollTop must actually move.
        const moved = await scroller.evaluate((el) => {
          el.scrollTop = el.scrollHeight;
          return el.scrollTop;
        });
        expect(moved, "scrollTop moves off 0").toBeGreaterThan(0);
      }

      // Bottom of the form is reachable and lands fully inside the viewport.
      const save = dialog.getByRole("button", { name: "Save Changes" });
      await save.scrollIntoViewIfNeeded();
      const saveBox = await save.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, viewport: window.innerHeight };
      });
      expect(saveBox.top, "Save Changes top is on screen").toBeGreaterThanOrEqual(0);
      expect(saveBox.bottom, "Save Changes bottom is on screen").toBeLessThanOrEqual(
        saveBox.viewport + 1,
      );

      // The attachments region is part of the same scroll owner when rendered.
      const attachments = dialog.getByText("Visuals & Attachments", { exact: false });
      if (await attachments.count()) {
        await attachments.first().scrollIntoViewIfNeeded();
        const inView = await attachments.first().evaluate((el) => {
          const r = el.getBoundingClientRect();
          return r.top >= 0 && r.bottom <= window.innerHeight;
        });
        expect(inView, "the attachments section is reachable").toBe(true);
      }

      // …and the top comes back.
      const title = dialog.locator("#title");
      await title.scrollIntoViewIfNeeded();
      const titleBox = await title.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, viewport: window.innerHeight };
      });
      expect(titleBox.top, "Title can be returned into view").toBeGreaterThanOrEqual(0);
      expect(titleBox.bottom, "Title lands fully on screen").toBeLessThanOrEqual(
        titleBox.viewport + 1,
      );

      await expectNoHorizontalOverflow(page, `Edit Paper @${vp.width}x${vp.height}`);
      await closeAllDialogs(page);
    });
  }

  // ── H. Edit Paper → Projects / Tags ─────────────────────────────────────

  const PAPER_SELECTORS = [
    { trigger: /Select projects|project.? selected/, search: "Search projects", option: FIXTURE_PROJECT },
    { trigger: /Select tags|tags? selected/, search: "Search tags", option: FIXTURE_TAG },
  ];

  for (const { trigger, search, option } of PAPER_SELECTORS) {
    for (const vp of [PHONE, TABLET_PORTRAIT, TABLET_LANDSCAPE]) {
      test(`Edit Paper ${search} does not autofocus @${vp.width}x${vp.height}`, async ({ page }) => {
        await page.setViewportSize(vp);
        await page.goto("/", { waitUntil: "networkidle" });
        await waitForDashboard(page);

        await page.locator("tbody tr").first().getByRole("button", { name: /^Edit / }).click();
        const dialog = dialogByHeading(page, "Edit Paper");
        await expect(dialog).toBeVisible();

        // Held as a handle: the trigger's label changes once something is
        // selected, so a name-based locator could not be re-resolved after.
        const triggerEl = await dialog.getByRole("button", { name: trigger }).first().elementHandle();
        await triggerEl!.scrollIntoViewIfNeeded();
        await triggerEl!.click();

        const popover = page.locator("[data-radix-popper-content-wrapper]").last();
        await expect(popover).toBeVisible();

        // Pre-fix this was the CommandInput: INPUT[role=combobox], isTextEntry
        // true, so the keyboard covered the very list being chosen from.
        const active = await activeElement(page);
        expect(
          active.isTextEntry,
          `${search}: opening must not focus Search (focused ${active.tag} "${active.ariaLabel}")`,
        ).toBe(false);
        expect(active.isBody, `${search}: focus must not be dropped on <body>`).toBe(false);
        expect(await activeElementIsInside(popover), `${search}: focus stays inside the popover`).toBe(
          true,
        );

        const searchBox = popover.getByRole("combobox", { name: search });
        await expect(searchBox, `${search}: Search is not focused`).not.toBeFocused();

        // The panel is on screen. Pre-fix, with collision avoidance disabled,
        // the Tags panel opened past the bottom edge of a landscape tablet.
        const geo = await popover.evaluate((el) => {
          const r = el.getBoundingClientRect();
          return { top: r.top, bottom: r.bottom, viewport: window.innerHeight };
        });
        expect(geo.top, `${search}: popover top is on screen`).toBeGreaterThanOrEqual(0);
        expect(geo.bottom, `${search}: popover bottom is on screen`).toBeLessThanOrEqual(
          geo.viewport + 1,
        );

        // Options are inspectable and selectable before anything is typed.
        const optionRow = popover.getByRole("option", { name: option, exact: true });
        await expect(optionRow, `${search}: options are usable before typing`).toBeVisible();

        // Explicit Search interaction still focuses and still filters.
        await searchBox.click();
        await expect(searchBox).toBeFocused();
        await searchBox.fill(option);
        await expect(optionRow).toBeVisible();

        // Selection semantics are unchanged — this is dialog-local state until
        // Save Changes, which this test never clicks.
        await optionRow.click();
        await expect(optionRow).toHaveAttribute("aria-selected", "true");
        await page.keyboard.press("Escape");
        await expect(popover).toBeHidden();
        await expect(
          dialog.getByRole("button", { name: `Remove ${option.includes("Project") ? "project" : "tag"} "${option}"` }),
          `${search}: the selection landed in the dialog's own state`,
        ).toBeVisible();

        await closeAllDialogs(page);
      });
    }
  }
});

// ── REMEDIATION-002 desktop preservation ────────────────────────────────────

test.describe("REAL-DEVICE-TOUCH-UX-REMEDIATION-002 — fine pointer preserved", () => {
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

  test("Analytics target selectors still autofocus their search box", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);

    await page.getByRole("button", { name: /Analytics & Insights/ }).click();
    await expect(page.getByText("Publication Year Distribution")).toBeAttached();

    for (const { label, search } of [
      { label: "Target Keywords", search: "Search target keywords" },
      { label: "Target Authors", search: "Search target authors" },
    ]) {
      const trigger = page.getByRole("button", { name: new RegExp(`^${label}`) }).first();
      await trigger.scrollIntoViewIfNeeded();
      await trigger.click();
      const popover = page.locator("[data-radix-popper-content-wrapper]").last();
      await expect(popover.getByRole("textbox", { name: search })).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(popover).toBeHidden();
    }
  });

  test("Settings still autofocuses the PubMed API key field", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);

    // Measured baseline: on a fine pointer this field is focused the moment the
    // dialog opens, and still focused once the settings query resolves.
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const dialog = dialogByHeading(page, "Settings");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("PubMed API Key (NCBI)")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });

  test("Edit sub-dialogs still autofocus their first field", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);

    for (const { manage, open, heading, field } of [
      { manage: "Manage projects", open: `Edit project ${FIXTURE_PROJECT}`, heading: "Edit Project", field: "Name" },
      { manage: "Manage tags", open: `Edit tag ${FIXTURE_TAG}`, heading: "Edit Tag", field: "Name" },
      {
        manage: "Manage synonyms",
        open: `Edit synonym group ${FIXTURE_SYNONYM}`,
        heading: "Edit Synonym Group",
        field: "Display Name (Canonical Term)",
      },
    ]) {
      await page.getByRole("button", { name: manage, exact: true }).click();
      await page.getByRole("button", { name: open, exact: true }).click();
      const dialog = dialogByHeading(page, heading);
      await expect(dialog).toBeVisible();
      await expect(dialog.getByLabel(field, { exact: true })).toBeFocused();
      await closeAllDialogs(page);
    }
  });

  test("Edit Paper still autofocuses Title, and its selectors still autofocus Search", async ({
    page,
  }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);

    await page.locator("tbody tr").first().getByRole("button", { name: /^Edit / }).click();
    const dialog = dialogByHeading(page, "Edit Paper");
    await expect(dialog).toBeVisible();
    await expect(dialog.locator("#title")).toBeFocused();

    for (const { trigger, search } of [
      { trigger: /Select projects|project.? selected/, search: "Search projects" },
      { trigger: /Select tags|tags? selected/, search: "Search tags" },
    ]) {
      const triggerEl = await dialog.getByRole("button", { name: trigger }).first().elementHandle();
      await triggerEl!.scrollIntoViewIfNeeded();
      await triggerEl!.click();
      const popover = page.locator("[data-radix-popper-content-wrapper]").last();
      await expect(popover.getByRole("combobox", { name: search })).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(popover).toBeHidden();
    }

    // The desktop two-column composition and its scroll owner are unchanged.
    const desktop = await dialog.getByTestId("edit-paper-scroll").evaluate((el) => ({
      overflowY: getComputedStyle(el).overflowY,
      columns: getComputedStyle(el.querySelector(".grid") as HTMLElement).gridTemplateColumns.split(" ").length,
    }));
    expect(desktop.overflowY).toBe("auto");
    expect(desktop.columns, "desktop keeps the two-column form").toBe(2);

    await closeAllDialogs(page);
  });
});

// ── AlertDialog close-focus restoration ─────────────────────────────────────

/**
 * ALERT-DIALOG-FOCUS-RESTORATION-001 — where focus lands *after* an
 * `AlertDialogContent` closes.
 *
 * Separate concern from everything above: those specs pin which control an
 * opening surface focuses; these pin which control gets focus back when a
 * confirmation is dismissed. Radix's modal content prevents the FocusScope's
 * natural restore and focuses `triggerRef` instead, so a confirmation opened
 * without an `<AlertDialogTrigger>` had nothing to restore to and dropped the
 * keyboard user on `<body>`.
 *
 * Three opener lifecycles exist in this app and each is proven here:
 *
 *   • trigger-backed          — Manage exclusions → Clear (real AlertDialogTrigger)
 *   • controlled, opener stays — paper row Delete (button is still mounted)
 *   • controlled, opener goes  — saved-search Delete (a dropdown item that unmounts)
 *
 * Every assertion reads `document.activeElement`; none infers focus from
 * styling. All but the last probe below dismiss the confirmation (Cancel or
 * Escape) and destroy nothing; the final probe deliberately *confirms* the
 * saved-search deletion, which is also how that disposable fixture is disposed
 * of. Post-deletion focus in the paper table is a separate contract, proven in
 * POST-DELETION-PAPER-TABLE-FOCUS-CONTINUITY-001 below.
 */

const FIXTURE_ALERT_PRESET = "ZZ Alert Focus Fixture Search";
const FIXTURE_ALERT_KEYWORD = "zzalertfocusfixture";

/** The Presets dropdown trigger — the persistent control that owns the saved-search workflow. */
function presetsTrigger(page: Page) {
  return page.getByRole("button", { name: /Saved Searches|Presets/i });
}

test.describe("ALERT-DIALOG-FOCUS-RESTORATION-001 — close-focus restoration", () => {
  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await page.setViewportSize(DESKTOP);
    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);

    // One disposable saved search, so the transient-opener probe has a row with
    // a Delete control inside the Presets dropdown.
    await presetsTrigger(page).click();
    await page.getByRole("menuitem", { name: /Save current search/i }).click();
    const saveDialog = page.getByRole("dialog");
    await expect(saveDialog).toBeVisible();
    await saveDialog.getByRole("textbox").fill(FIXTURE_ALERT_PRESET);
    await saveDialog.getByRole("button", { name: /^Save$/ }).click();
    await expect(saveDialog).toBeHidden({ timeout: 15_000 });

    await page.close();
  });

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    await page
      .goto("/", { waitUntil: "networkidle" })
      .then(async () => {
        await page.setViewportSize(DESKTOP);
        await waitForDashboard(page);

        // Saved search — deleted through its own confirmation.
        await presetsTrigger(page).click();
        const del = page.getByRole("button", { name: `Delete preset "${FIXTURE_ALERT_PRESET}"` });
        if (await del.count()) {
          await del.first().click();
          await page.getByRole("alertdialog").getByRole("button", { name: /^Delete$/ }).click();
          await expect(page.getByRole("alertdialog")).toHaveCount(0, { timeout: 10_000 });
        }
        await page.keyboard.press("Escape");

        // Excluded keyword — removed individually, never via Clear All.
        await page.getByRole("button", { name: "Manage exclusions", exact: true }).click();
        const manage = page.getByRole("dialog");
        await expect(manage).toBeVisible();
        const remove = manage.getByRole("button", {
          name: `Remove excluded keyword ${FIXTURE_ALERT_KEYWORD}`,
        });
        if (await remove.count()) {
          await remove.first().click();
          await expect(remove).toHaveCount(0, { timeout: 10_000 });
        }
        await closeAllDialogs(page);
      })
      .catch(() => {});
    await page.close();
  });

  // ── A. Controlled AlertDialog whose opener stays mounted ──────────────────

  for (const close of ["Cancel", "Escape"] as const) {
    test(`paper delete confirmation dismissed with ${close} restores the exact Delete button`, async ({
      page,
    }) => {
      await page.setViewportSize(DESKTOP);
      await page.goto("/", { waitUntil: "networkidle" });
      await waitForDashboard(page);

      const deleteButton = page.locator("tbody tr").first().getByRole("button", { name: /^Delete / });
      await deleteButton.scrollIntoViewIfNeeded();
      const openerLabel = await deleteButton.getAttribute("aria-label");
      expect(openerLabel, "the row Delete button carries its paper title").toBeTruthy();
      // A handle, not the Locator: Radix marks everything behind an open modal
      // `aria-hidden`, so a role-based query stops resolving while it is up.
      const openerHandle = await deleteButton.elementHandle();

      await deleteButton.click();
      const confirm = page.getByRole("alertdialog");
      await expect(confirm).toBeVisible();
      await expect(confirm.getByText("Delete Paper", { exact: true })).toBeVisible();

      // The opener is still in the document while the confirmation is open —
      // this is the class where exact restoration is possible.
      expect(
        await openerHandle!.evaluate((el) => el.isConnected),
        "the row Delete button stays mounted behind the confirmation",
      ).toBe(true);

      if (close === "Cancel") {
        await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
      } else {
        await page.keyboard.press("Escape");
      }
      await expect(page.getByRole("alertdialog")).toHaveCount(0, { timeout: 10_000 });

      const active = await activeElement(page);
      expect(active.isBody, "focus must not drop to <body>").toBe(false);
      expect(active.ariaLabel, "focus returns to the exact Delete button that opened it").toBe(
        openerLabel,
      );
      await expect(deleteButton).toBeFocused();

      // Cancelling deletes nothing: the row is still there.
      await expect(deleteButton).toBeVisible();
    });
  }

  // ── B. Controlled AlertDialog whose opener is unmounted ───────────────────

  test("saved-search delete confirmation restores the persistent Presets trigger", async ({
    page,
  }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);

    const trigger = presetsTrigger(page);
    await trigger.click();
    const menuItem = page.getByRole("button", { name: `Delete preset "${FIXTURE_ALERT_PRESET}"` });
    await expect(menuItem).toBeVisible();
    // Hold a handle to the launching control so its lifecycle can be read after
    // the dropdown closes — a Locator would just resolve to nothing.
    const menuItemHandle = await menuItem.elementHandle();

    await menuItem.click();
    const confirm = page.getByRole("alertdialog");
    await expect(confirm).toBeVisible();
    await expect(confirm.getByText("Delete saved search?", { exact: true })).toBeVisible();

    // The defining property of this class: the control that opened the
    // confirmation has left the DOM, so it is not a restoration target at all.
    await expect
      .poll(
        async () => menuItemHandle!.evaluate((el) => el.isConnected),
        { message: "the dropdown item that opened the confirmation unmounts", timeout: 5_000 },
      )
      .toBe(false);

    await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByRole("alertdialog")).toHaveCount(0, { timeout: 10_000 });

    const active = await activeElement(page);
    expect(active.isBody, "focus must not drop to <body>").toBe(false);
    await expect(trigger).toBeFocused();

    // Cancelling deletes nothing: the saved search is still listed.
    await trigger.click();
    await expect(menuItem).toBeVisible();
    await page.keyboard.press("Escape");
  });

  test("saved-search update confirmation restores the persistent Presets trigger", async ({
    page,
  }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);

    const trigger = presetsTrigger(page);

    // Load the fixture preset, then dirty the filter state so `Update "…"`
    // becomes enabled. Both menu items share the dropdown's lifecycle, so this
    // is the same disconnected-opener class as the Delete confirmation.
    await trigger.click();
    await page.getByRole("button", { name: FIXTURE_ALERT_PRESET, exact: true }).click();
    await expect(page.getByRole("menu")).toHaveCount(0, { timeout: 5_000 });

    const search = page.getByRole("searchbox").or(page.getByPlaceholder(/search/i)).first();
    await search.fill("zz alert focus probe");
    await expect(trigger).toHaveAccessibleName(/unsaved changes/i, { timeout: 10_000 });

    await trigger.click();
    const updateItem = page.getByRole("menuitem", { name: /^Update/ });
    await expect(updateItem).toBeEnabled();
    const updateHandle = await updateItem.elementHandle();

    await updateItem.click();
    const confirm = page.getByRole("alertdialog");
    await expect(confirm).toBeVisible();
    await expect(confirm.getByText("Update saved search?", { exact: true })).toBeVisible();
    await expect
      .poll(async () => updateHandle!.evaluate((el) => el.isConnected), {
        message: "the Update menu item unmounts with the dropdown",
        timeout: 5_000,
      })
      .toBe(false);

    await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByRole("alertdialog")).toHaveCount(0, { timeout: 10_000 });

    const active = await activeElement(page);
    expect(active.isBody, "focus must not drop to <body>").toBe(false);
    await expect(trigger).toBeFocused();

    // Cancelling overwrites nothing: the preset is still dirty, i.e. unsaved.
    await expect(trigger).toHaveAccessibleName(/unsaved changes/i);
  });

  // ── C. Trigger-backed AlertDialog ─────────────────────────────────────────

  test("trigger-backed Clear confirmation still restores its own trigger", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);

    await page.getByRole("button", { name: "Manage exclusions", exact: true }).click();
    const manage = page.getByRole("dialog");
    await expect(manage).toBeVisible();

    // The Clear control only renders once the pool is non-empty, so seed one
    // disposable keyword through the dialog's own Add control.
    const keywordField = manage.getByRole("textbox", { name: "Keyword to exclude" });
    await keywordField.fill(FIXTURE_ALERT_KEYWORD);
    await manage.getByRole("button", { name: "Add excluded keyword" }).click();
    const chip = manage.getByRole("button", {
      name: `Remove excluded keyword ${FIXTURE_ALERT_KEYWORD}`,
    });
    await expect(chip).toBeVisible({ timeout: 10_000 });

    // This one has a real <AlertDialogTrigger>; native Radix restoration must
    // keep working once the central wrapper takes part in close focus.
    const clear = manage.getByRole("button", { name: "Clear" }).first();
    await clear.focus();
    await expect(clear).toBeFocused();
    await clear.click();

    const confirm = page.getByRole("alertdialog");
    await expect(confirm).toBeVisible();
    await expect(confirm.getByText("Clear all excluded keywords?", { exact: true })).toBeVisible();

    await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByRole("alertdialog")).toHaveCount(0, { timeout: 10_000 });

    const active = await activeElement(page);
    expect(active.isBody, "focus must not drop to <body>").toBe(false);
    await expect(clear).toBeFocused();

    // Cancelling clears nothing, and the fixture keyword is removed one-by-one
    // rather than through the destructive Clear All action.
    await expect(chip).toBeVisible();
    await chip.click();
    await expect(chip).toHaveCount(0, { timeout: 10_000 });
    await closeAllDialogs(page);
  });

  // ── D. Confirming the action, not just dismissing it ──────────────────────

  /**
   * Runs last, and is also how the saved-search fixture is disposed of: the
   * confirmation is the product's own delete path, so proving focus through it
   * costs no mutation that the teardown would not perform anyway.
   *
   * The fallback is on `onCloseAutoFocus`, which fires for every close reason,
   * so confirming lands on the same persistent trigger as cancelling — the one
   * case where the opener is gone *and* the row it referred to is gone too.
   */
  test("confirming the saved-search delete also lands on the Presets trigger", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);

    const trigger = presetsTrigger(page);
    await trigger.click();
    const menuItem = page.getByRole("button", { name: `Delete preset "${FIXTURE_ALERT_PRESET}"` });
    await expect(menuItem).toBeVisible();
    await menuItem.click();

    const confirm = page.getByRole("alertdialog");
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.getByRole("alertdialog")).toHaveCount(0, { timeout: 10_000 });

    const active = await activeElement(page);
    expect(active.isBody, "focus must not drop to <body>").toBe(false);
    await expect(trigger).toBeFocused();

    // The saved search really is gone — this is the confirm path, not Cancel.
    await trigger.click();
    await expect(menuItem).toHaveCount(0, { timeout: 10_000 });
    await page.keyboard.press("Escape");
  });
});

// ── Post-deletion focus continuity in the paper table ───────────────────────

/**
 * POST-DELETION-PAPER-TABLE-FOCUS-CONTINUITY-001 — where focus lands after a
 * paper deletion is *confirmed*.
 *
 * The block above proves *dismissal*: the opener survives, so restoring it is
 * the whole answer. Confirming is the case restoration cannot serve — the row
 * and its Delete button are unmounted by the optimistic cache update, so there
 * is no opener left to return to and focus fell to `<body>`.
 *
 * The implemented contract is positional, resolved from `PaperList`'s own
 * `papers` array by id: the row that *followed* the deleted one, else the row
 * that preceded it, else the same clamped slot, else the empty-state heading.
 *
 * Every fixture here is a disposable paper created through Add Papers →
 * Manual and removed again through the product's own delete confirmation, so
 * the deterministic seed is never touched. Each scenario isolates its fixtures
 * behind a unique search token, which is also what makes the visible ordering
 * knowable — the order is *read* from the DOM, never assumed.
 */

/** Search tokens embedded in fixture titles so each scenario owns its own view. */
const PDF_GROUP_TOKEN = "zzpdfgroup";
const PDF_LAST_TOKEN = "zzpdflast";
const PDF_SOLO_TOKEN = "zzpdfsolo";
const PDF_SLOW_TOKEN = "zzpdfslow";
const PDF_THEFT_TOKEN = "zzpdftheft";
const PDF_ALL_TOKENS = [
  PDF_GROUP_TOKEN,
  PDF_LAST_TOKEN,
  PDF_SOLO_TOKEN,
  PDF_SLOW_TOKEN,
  PDF_THEFT_TOKEN,
];

function searchBox(page: Page) {
  return page.getByRole("searchbox").or(page.getByPlaceholder(/search/i)).first();
}

/**
 * Every row Delete button, in visible order.
 *
 * Their accessible names are `Delete ${paper.title}`, so this doubles as the
 * ordered identity of the visible rows — the trailing space in the pattern is
 * what keeps the confirmation's own bare `Delete` action out of the set.
 */
function rowDeleteButtons(page: Page) {
  return page.getByRole("button", { name: /^Delete / });
}

/** The observed visible ordering, as accessible names. Never assumed. */
async function visibleDeleteLabels(page: Page): Promise<string[]> {
  return rowDeleteButtons(page).evaluateAll((els) =>
    els.map((el) => el.getAttribute("aria-label") ?? ""),
  );
}

/** Narrow the table to one scenario's fixtures and wait for exactly `expected` rows. */
async function filterToFixtures(page: Page, token: string, expected: number) {
  await searchBox(page).fill(token);
  await expect(rowDeleteButtons(page)).toHaveCount(expected, { timeout: 20_000 });
}

/** Create one disposable paper through Add Papers → Manual. */
async function createDisposablePaper(page: Page, title: string) {
  await page.getByRole("button", { name: /add papers/i }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("tab", { name: /manual/i }).click();
  await page.locator("#manual-title").fill(title);
  await dialog.getByRole("button", { name: /^add paper$/i }).click();
  await expect(dialog).toBeHidden({ timeout: 20_000 });
}

/**
 * Remove every paper still matching `token`, through the product's own row
 * confirmation. Tolerant of an already-empty view so it is safe in teardown.
 */
async function deleteFixturesMatching(page: Page, token: string) {
  await searchBox(page).fill(token);
  // Give the filtered read a chance to settle before concluding "nothing left".
  await page.waitForTimeout(1_500);
  for (let i = 0; i < 8; i++) {
    const buttons = rowDeleteButtons(page);
    if ((await buttons.count()) === 0) break;
    await buttons.first().click();
    const confirm = page.getByRole("alertdialog");
    await expect(confirm).toBeVisible({ timeout: 10_000 });
    await confirm.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.getByRole("alertdialog")).toHaveCount(0, { timeout: 10_000 });
    await page.waitForTimeout(500);
  }
  await expect(rowDeleteButtons(page)).toHaveCount(0, { timeout: 20_000 });
}

test.describe("POST-DELETION-PAPER-TABLE-FOCUS-CONTINUITY-001 — confirmed-delete focus", () => {
  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    await page
      .goto("/", { waitUntil: "networkidle" })
      .then(async () => {
        await page.setViewportSize(DESKTOP);
        await waitForDashboard(page);
        for (const token of PDF_ALL_TOKENS) {
          await deleteFixturesMatching(page, token).catch(() => {});
        }
      })
      .catch(() => {});
    await page.close();
  });

  // ── A. Middle-row deletion → the row that followed it ─────────────────────

  test("deleting a middle row focuses the following row's Delete button", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize(DESKTOP);
    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);

    try {
      for (const name of ["Alfa", "Bravo", "Charlie"]) {
        await createDisposablePaper(page, `ZZ Post Delete Focus ${name} ${PDF_GROUP_TOKEN}`);
      }
      await filterToFixtures(page, PDF_GROUP_TOKEN, 3);

      // The pre-deletion ordering is read, not assumed: sort/filter order lives
      // in the data, and the contract is defined against *that* order.
      const before = await visibleDeleteLabels(page);
      expect(before, "three disposable rows are isolated by the search token").toHaveLength(3);
      const [previousLabel, deletedLabel, nextLabel] = before;

      const opener = page.getByRole("button", { name: deletedLabel, exact: true });
      const openerHandle = await opener.elementHandle();
      await opener.click();

      const confirm = page.getByRole("alertdialog");
      await expect(confirm).toBeVisible();
      await expect(confirm.getByText("Delete Paper", { exact: true })).toBeVisible();
      await confirm.getByRole("button", { name: "Delete", exact: true }).click();
      await expect(page.getByRole("alertdialog")).toHaveCount(0, { timeout: 10_000 });

      // The row really is gone, and with it the control that opened the
      // confirmation — this is the lifecycle restoration cannot serve.
      await expect(rowDeleteButtons(page)).toHaveCount(2, { timeout: 20_000 });
      expect(
        await openerHandle!.evaluate((el) => el.isConnected),
        "the opener leaves the DOM with its row",
      ).toBe(false);

      const active = await activeElement(page);
      expect(active.isBody, "focus must not drop to <body>").toBe(false);
      expect(active.ariaLabel, "focus lands on the row that followed the deleted one").toBe(
        nextLabel,
      );
      await expect(page.getByRole("button", { name: nextLabel, exact: true })).toBeFocused();

      // …and the preceding row is untouched, i.e. this is genuinely positional.
      await expect(page.getByRole("button", { name: previousLabel, exact: true })).toBeVisible();
    } finally {
      await deleteFixturesMatching(page, PDF_GROUP_TOKEN).catch(() => {});
    }
  });

  // ── B. Last-row deletion → the row that preceded it ───────────────────────

  test("deleting the last visible row focuses the preceding row's Delete button", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize(DESKTOP);
    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);

    try {
      for (const name of ["Delta", "Echo"]) {
        await createDisposablePaper(page, `ZZ Post Delete Focus ${name} ${PDF_LAST_TOKEN}`);
      }
      await filterToFixtures(page, PDF_LAST_TOKEN, 2);

      const before = await visibleDeleteLabels(page);
      expect(before).toHaveLength(2);
      const [previousLabel, deletedLabel] = before;

      const opener = page.getByRole("button", { name: deletedLabel, exact: true });
      const openerHandle = await opener.elementHandle();
      await opener.click();

      const confirm = page.getByRole("alertdialog");
      await expect(confirm).toBeVisible();
      await confirm.getByRole("button", { name: "Delete", exact: true }).click();
      await expect(page.getByRole("alertdialog")).toHaveCount(0, { timeout: 10_000 });

      await expect(rowDeleteButtons(page)).toHaveCount(1, { timeout: 20_000 });
      expect(
        await openerHandle!.evaluate((el) => el.isConnected),
        "the opener leaves the DOM with its row",
      ).toBe(false);

      // No following row exists, so the contract falls back to the previous one.
      const active = await activeElement(page);
      expect(active.isBody, "focus must not drop to <body>").toBe(false);
      expect(active.ariaLabel, "focus falls back to the preceding row").toBe(previousLabel);
      await expect(page.getByRole("button", { name: previousLabel, exact: true })).toBeFocused();
    } finally {
      await deleteFixturesMatching(page, PDF_LAST_TOKEN).catch(() => {});
    }
  });

  // ── C. Deleting the only visible row → the empty-state heading ────────────

  test("deleting the only visible row focuses the no-results heading", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize(DESKTOP);
    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);

    // The library is *not* empty — the seed owns papers — so the truthful
    // resulting state is the filtered one, not first-run onboarding.
    expect(await getPaperCount(page), "the account still owns other papers").toBeGreaterThan(0);

    await createDisposablePaper(page, `ZZ Post Delete Focus Solo ${PDF_SOLO_TOKEN}`);
    await filterToFixtures(page, PDF_SOLO_TOKEN, 1);

    const [deletedLabel] = await visibleDeleteLabels(page);
    const opener = page.getByRole("button", { name: deletedLabel, exact: true });
    const openerHandle = await opener.elementHandle();
    await opener.click();

    const confirm = page.getByRole("alertdialog");
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.getByRole("alertdialog")).toHaveCount(0, { timeout: 10_000 });

    await expect(rowDeleteButtons(page)).toHaveCount(0, { timeout: 20_000 });
    expect(
      await openerHandle!.evaluate((el) => el.isConnected),
      "the opener leaves the DOM with the table",
    ).toBe(false);

    const heading = page.getByRole("heading", {
      level: 2,
      name: "No papers match your current filters",
      exact: true,
    });
    await expect(heading, "the truthful filtered-empty state is shown").toBeVisible();

    const active = await activeElement(page);
    expect(active.isBody, "focus must not drop to <body>").toBe(false);
    expect(active.tag, "focus lands on the empty-state heading").toBe("H2");
    await expect(heading).toBeFocused();

    // Programmatically focusable, but deliberately not a Tab stop: the next Tab
    // should reach Clear filters, not the heading itself.
    await expect(heading).toHaveAttribute("tabindex", "-1");
  });

  // ── D. Slow removal: restoration first, then the handoff ──────────────────

  /**
   * The two removal timings must both end in the same place.
   *
   * Normally the optimistic removal lands while Radix is still animating the
   * confirmation out, so focus goes straight from the panel to the successor.
   * Delaying the pre-deletion attachment read — a real request, delayed, not
   * stubbed — produces the other order: the confirmation closes first,
   * `useDialogFocusRestore` restores the still-mounted original Delete button,
   * and only then does the row disappear underneath it. Focus must not be left
   * on `<body>` when that happens.
   */
  test("a slow removal restores the opener first and still hands off afterwards", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize(DESKTOP);
    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);

    try {
      for (const name of ["Foxtrot", "Golf"]) {
        await createDisposablePaper(page, `ZZ Post Delete Focus ${name} ${PDF_SLOW_TOKEN}`);
      }
      await filterToFixtures(page, PDF_SLOW_TOKEN, 2);

      const [deletedLabel, nextLabel] = await visibleDeleteLabels(page);

      await page.route(/paper_attachments/, async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 2_500));
        await route.continue();
      });

      const opener = page.getByRole("button", { name: deletedLabel, exact: true });
      await opener.click();
      const confirm = page.getByRole("alertdialog");
      await expect(confirm).toBeVisible();
      await confirm.getByRole("button", { name: "Delete", exact: true }).click();
      await expect(page.getByRole("alertdialog")).toHaveCount(0, { timeout: 10_000 });

      // Close-focus ran while the row was still there: PR #219's restoration
      // put focus back on the opener, which is correct for this instant.
      await expect(rowDeleteButtons(page)).toHaveCount(2);
      await expect(opener).toBeFocused();

      // Now the row — and the focused button with it — is removed.
      await expect(rowDeleteButtons(page)).toHaveCount(1, { timeout: 20_000 });
      const active = await activeElement(page);
      expect(active.isBody, "focus must not drop to <body>").toBe(false);
      expect(active.ariaLabel, "the handoff picks up where restoration left off").toBe(nextLabel);
      await expect(page.getByRole("button", { name: nextLabel, exact: true })).toBeFocused();
    } finally {
      await page.unroute(/paper_attachments/).catch(() => {});
      await deleteFixturesMatching(page, PDF_SLOW_TOKEN).catch(() => {});
    }
  });

  // ── E. The handoff must never take focus the user has moved elsewhere ─────

  /**
   * Deletion is asynchronous: the optimistic cache removal only runs after the
   * pre-deletion attachment read returns, so there is a real window in which
   * the user can move on before the row disappears. Delaying exactly that one
   * PostgREST read — the request still executes, nothing is stubbed — widens
   * the window deterministically instead of racing it.
   */
  test("the handoff does not steal focus the user moved after confirming", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize(DESKTOP);
    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);

    await createDisposablePaper(page, `ZZ Post Delete Focus Theft ${PDF_THEFT_TOKEN}`);
    await filterToFixtures(page, PDF_THEFT_TOKEN, 1);

    await page.route(/paper_attachments/, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      await route.continue();
    });

    try {
      const [deletedLabel] = await visibleDeleteLabels(page);
      await page.getByRole("button", { name: deletedLabel, exact: true }).click();
      const confirm = page.getByRole("alertdialog");
      await expect(confirm).toBeVisible();
      await confirm.getByRole("button", { name: "Delete", exact: true }).click();
      await expect(page.getByRole("alertdialog")).toHaveCount(0, { timeout: 10_000 });

      // The row is still there — the deletion has not settled yet.
      await expect(rowDeleteButtons(page)).toHaveCount(1);

      // The user deliberately moves on to another valid control.
      const addPapers = page.getByRole("button", { name: /add papers/i }).first();
      await addPapers.focus();
      await expect(addPapers).toBeFocused();

      // Now the removal lands. Focus must stay where the user put it.
      await expect(rowDeleteButtons(page)).toHaveCount(0, { timeout: 20_000 });
      const active = await activeElement(page);
      expect(active.isBody, "focus must not drop to <body>").toBe(false);
      await expect(addPapers, "the late handoff must not pull focus back").toBeFocused();
    } finally {
      await page.unroute(/paper_attachments/).catch(() => {});
    }
  });
});
