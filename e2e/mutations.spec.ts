import { test, expect } from "@playwright/test";
import {
  waitForDashboard,
  createProject,
  createTag,
  deleteProject,
  deleteTag,
  deletePapersByTitleSubstrings,
  collectConsoleErrors,
} from "./helpers";

/**
 * Test Group 3 — Mutation regression around taxonomy/cache behavior
 *
 * Verifies that creating projects/tags, assigning them to papers,
 * and refreshing the page all persist correctly.
 */

const TEST_PROJECT = `_e2e_proj_${Date.now()}`;
const TEST_TAG = `_e2e_tag_${Date.now()}`;
const TEST_PAPER = `_e2e_paper_${Date.now()}`;
const TEST_METHODS = "ANOVA, linear regression";

test.describe("Mutation persistence regression", () => {
  test.describe.configure({ mode: "serial" });

  test("should create a new project via sidebar", async ({ page }) => {
    const errors = collectConsoleErrors(page);

    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);

    await createProject(page, TEST_PROJECT);

    // Re-open Manage Projects to verify it's listed
    const gearBtn = page
      .getByText("Projects")
      .first()
      .locator("xpath=ancestor::div[contains(@class, 'justify-between')][1]")
      .locator("button");
    await gearBtn.click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByRole("dialog").getByText(TEST_PROJECT)).toBeVisible();
    await page.keyboard.press("Escape");

    const criticalErrors = errors.filter(
      (e) =>
        !e.includes("favicon") &&
        !e.includes("net::ERR") &&
        !e.includes("[vite]") &&
        !e.includes("CORS"),
    );
    expect(criticalErrors).toHaveLength(0);
  });

  test("should create a new tag via sidebar", async ({ page }) => {
    const errors = collectConsoleErrors(page);

    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);

    await createTag(page, TEST_TAG);

    // Re-open Manage Tags to verify it's listed
    const gearBtn = page
      .getByText("Tags")
      .first()
      .locator("xpath=ancestor::div[contains(@class, 'justify-between')][1]")
      .locator("button");
    await gearBtn.click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByRole("dialog").getByText(TEST_TAG)).toBeVisible();
    await page.keyboard.press("Escape");

    const criticalErrors = errors.filter(
      (e) =>
        !e.includes("favicon") &&
        !e.includes("net::ERR") &&
        !e.includes("[vite]") &&
        !e.includes("CORS"),
    );
    expect(criticalErrors).toHaveLength(0);
  });

  test("should assign project and tag to a paper and verify", async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);
    await page.waitForTimeout(2_000);

    // Click Edit on the first paper
    const firstRow = page.locator("tbody tr").first();
    await firstRow.getByRole("button", { name: /edit/i }).click();
    await expect(page.getByRole("dialog")).toBeVisible();

    // Assign project: click the projects trigger button, search, then select
    const projectTrigger = page
      .getByRole("dialog")
      .locator("button")
      .filter({ hasText: /project/i })
      .first();
    await projectTrigger.click();
    await page.waitForTimeout(500);

    // Type in the search input to filter to our test project
    const projectSearch = page.getByPlaceholder(/search projects/i);
    if (await projectSearch.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await projectSearch.fill(TEST_PROJECT);
      await page.waitForTimeout(300);
    }

    // Click the test project in the filtered list
    const projectItem = page.getByText(TEST_PROJECT).last();
    await projectItem.click({ force: true });

    // Close the project popover
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    // Assign tag: click the tags trigger button, search, then select
    const tagTrigger = page
      .getByRole("dialog")
      .locator("button")
      .filter({ hasText: /tag/i })
      .first();
    await tagTrigger.click();
    await page.waitForTimeout(500);

    // Type in the search input to filter to our test tag
    const tagSearch = page.getByPlaceholder(/search tags/i);
    if (await tagSearch.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await tagSearch.fill(TEST_TAG);
      await page.waitForTimeout(300);
    }

    // Click the test tag via JS dispatch — the cmdk combobox may clip the item
    const tagItem = page.getByText(TEST_TAG).last();
    await tagItem.dispatchEvent("click");

    // Close the tag popover
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    // Save the edit
    const saveBtn = page.getByRole("dialog").getByRole("button", { name: /save/i });
    await saveBtn.click();

    // Wait for dialog to close and changes to persist
    await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 5_000 });
    await page.waitForTimeout(1_000);
  });

  test("should show project in filter dropdown after creation", async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);

    // Open the "All Projects" filter dropdown
    const projectFilter = page.locator("button, select").filter({ hasText: /all projects/i }).first();
    if (await projectFilter.isVisible().catch(() => false)) {
      await projectFilter.click();
      await page.waitForTimeout(500);

      // Our test project should be in the dropdown
      await expect(page.getByText(TEST_PROJECT).first()).toBeVisible({ timeout: 3_000 });
      await page.keyboard.press("Escape");
    }
  });

  test("should show tag in filter dropdown after creation", async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);

    // Open the "All Tags" filter dropdown
    const tagFilter = page.locator("button, select").filter({ hasText: /all tags/i }).first();
    if (await tagFilter.isVisible().catch(() => false)) {
      await tagFilter.click();
      await page.waitForTimeout(500);

      // Our test tag should be in the dropdown
      await expect(page.getByText(TEST_TAG).first()).toBeVisible({ timeout: 3_000 });
      await page.keyboard.press("Escape");
    }
  });

  test("should persist assignment after page refresh", async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);
    await page.waitForTimeout(2_000);

    // Re-open Edit on the same (first) paper that received the assignment in the
    // prior test. This is a real reload — the dialog reflects persisted server state.
    const firstRow = page.locator("tbody tr").first();
    await firstRow.getByRole("button", { name: /edit/i }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // Mandatory persistence assertions, scoped to the edited paper's dialog.
    // Each *selected* project/tag renders a per-badge remove button whose
    // aria-label embeds the exact name (EditPaperDialog.tsx) — these controls
    // exist only for assigned items, so this is a definitive assignment proof
    // and the same stable representation the cleanup test drives. A missing
    // project or tag now FAILS the test instead of passing silently.
    await expect(
      dialog.getByRole("button", { name: `Remove project "${TEST_PROJECT}"` }),
    ).toBeVisible({ timeout: 5_000 });
    await expect(
      dialog.getByRole("button", { name: `Remove tag "${TEST_TAG}"` }),
    ).toBeVisible({ timeout: 5_000 });

    // Close the dialog without mutating anything.
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible({ timeout: 5_000 });
  });

  test("should clean up: remove assignments, delete project and tag", async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);
    await page.waitForTimeout(2_000);

    // First remove the assignment from the paper
    const firstRow = page.locator("tbody tr").first();
    await firstRow.getByRole("button", { name: /edit/i }).click();
    await expect(page.getByRole("dialog")).toBeVisible();

    // Try to unassign the project by clicking its per-badge remove button.
    // The remove button has an explicit aria-label (`Remove project "<name>"`),
    // which is both an a11y improvement and the robust Playwright selector —
    // scoping by text-in-an-ancestor-div matches the entire dialog body and
    // can resolve to a disabled shadcn Button (e.g. the Popover trigger).
    const dialog = page.getByRole("dialog");
    const projRemove = dialog.getByRole("button", {
      name: `Remove project "${TEST_PROJECT}"`,
    });
    if (await projRemove.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await projRemove.click();
    }

    // Same pattern for the tag badge's remove button.
    const tagRemove = dialog.getByRole("button", {
      name: `Remove tag "${TEST_TAG}"`,
    });
    if (await tagRemove.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await tagRemove.click();
    }

    // Dismiss any toast notifications that might block the Save button
    const toastCloseButtons = page.locator('[data-radix-toast-announce-exclude] button, [role="status"] button');
    const toastCount = await toastCloseButtons.count();
    for (let i = 0; i < toastCount; i++) {
      await toastCloseButtons.nth(i).click().catch(() => {});
    }
    await page.waitForTimeout(500);

    // Save
    const saveBtn = page.getByRole("dialog").getByRole("button", { name: /save/i });
    if (await saveBtn.isVisible().catch(() => false)) {
      await saveBtn.click({ force: true });
      await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 5_000 });
    } else {
      await page.keyboard.press("Escape");
    }

    await page.waitForTimeout(1_000);

    // Delete the test project
    await deleteProject(page, TEST_PROJECT);
    await page.waitForTimeout(500);

    // Delete the test tag
    await deleteTag(page, TEST_TAG);
    await page.waitForTimeout(500);
  });
});

/**
 * Statistical-methods round-trip (RECON-STATISTICAL-METHODS-001 / C20).
 *
 * Proves the application boundary handles the statistical_methods column
 * correctly against whatever schema production currently has: create a
 * temporary paper, save canonical comma-separated text, verify the table
 * renders one badge per method, refresh, verify persistence, and verify the
 * Edit dialog round-trips the exact text. Cleans up its own paper.
 */
test.describe("Statistical methods round-trip", () => {
  test("should persist statistical methods through edit, table render, and refresh", async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);

    try {
      // ── Create a uniquely named temporary paper via Add Papers → Manual ──
      await page.getByRole("button", { name: /add papers/i }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.getByRole("tab", { name: /manual/i }).click();
      await page.locator("#manual-title").fill(TEST_PAPER);
      await page.getByRole("button", { name: /^add paper$/i }).click();
      await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 10_000 });
      await page.waitForTimeout(1_000);

      // Default sort is insert_order DESC — the new paper is the first row.
      const paperRow = page.locator("tbody tr").filter({ hasText: TEST_PAPER }).first();
      await expect(paperRow).toBeVisible({ timeout: 10_000 });

      // ── Edit: set statistical methods and save ──
      await paperRow.getByRole("button", { name: /edit/i }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.locator("#statisticalMethods").fill(TEST_METHODS);
      await page.getByRole("dialog").getByRole("button", { name: /save/i }).click();
      await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 5_000 });
      await page.waitForTimeout(1_000);

      // ── Enable the Statistical Methods column (hidden by default) ──
      await page.getByRole("button", { name: /columns/i }).click();
      const columnItem = page.getByRole("menuitemcheckbox", { name: /statistical methods/i });
      if (!(await columnItem.getAttribute("aria-checked").then((v) => v === "true"))) {
        await columnItem.click();
      }
      await page.keyboard.press("Escape");

      // Both methods render as individual badges in the paper's row.
      await expect(paperRow.getByText("ANOVA", { exact: true })).toBeVisible({ timeout: 5_000 });
      await expect(paperRow.getByText("linear regression", { exact: true })).toBeVisible();

      // ── Refresh: values persist ──
      await page.reload({ waitUntil: "networkidle" });
      await waitForDashboard(page);
      const rowAfterReload = page.locator("tbody tr").filter({ hasText: TEST_PAPER }).first();
      await expect(rowAfterReload).toBeVisible({ timeout: 10_000 });
      await expect(rowAfterReload.getByText("ANOVA", { exact: true })).toBeVisible({ timeout: 5_000 });
      await expect(rowAfterReload.getByText("linear regression", { exact: true })).toBeVisible();

      // ── Reopen Edit: the field contains the canonical text ──
      await rowAfterReload.getByRole("button", { name: /edit/i }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await expect(page.locator("#statisticalMethods")).toHaveValue(TEST_METHODS);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 5_000 });
    } finally {
      // ── Clean up the temporary paper (leave zero _e2e_ artifacts) ──
      await page.reload({ waitUntil: "networkidle" }).catch(() => {});
      await waitForDashboard(page).catch(() => {});
      await deletePapersByTitleSubstrings(page, [TEST_PAPER]).catch(() => {});
      await page.waitForTimeout(1_000);
      await expect(page.locator("tbody tr").filter({ hasText: TEST_PAPER })).toHaveCount(0);
    }
  });
});
