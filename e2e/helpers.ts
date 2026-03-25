import { type Page, expect } from "@playwright/test";

/**
 * Shared E2E test helpers for Paper Whisperer.
 */

/** Locator for the paper count paragraph in the dashboard header (e.g. "107 papers"). */
function paperCountLocator(page: Page) {
  return page.locator("p").filter({ hasText: /^\d+\s+papers?$/ });
}

/** Wait for the dashboard to fully load (paper count visible). */
export async function waitForDashboard(page: Page, timeout = 20_000) {
  await expect(paperCountLocator(page)).toBeVisible({ timeout });
}

/** Extract the paper count number from the dashboard header. */
export async function getPaperCount(page: Page): Promise<number> {
  const text = await paperCountLocator(page).textContent();
  const match = text?.match(/(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}

/**
 * Get the ordered list of paper titles visible at the top of the table.
 * Only reads the first `maxRows` rows to avoid issues with virtualized tables
 * where off-screen rows may not have rendered content.
 */
export async function getVisiblePaperTitles(page: Page, maxRows = 10): Promise<string[]> {
  const rows = page.locator("tbody tr");
  const count = await rows.count();
  const limit = Math.min(count, maxRows);
  const titles: string[] = [];
  for (let i = 0; i < limit; i++) {
    const titleEl = rows.nth(i).locator("td p").first();
    // Only read if visible (virtual rows may not be rendered)
    if (await titleEl.isVisible({ timeout: 1_000 }).catch(() => false)) {
      const title = await titleEl.textContent();
      if (title) titles.push(title.trim());
    }
  }
  return titles;
}

/**
 * Import papers by identifiers (PMIDs/DOIs) via the "Import IDs" tab.
 * Returns once the import toast appears.
 */
export async function importPapersByIds(
  page: Page,
  identifiers: string[],
  options?: { timeout?: number },
) {
  const timeout = options?.timeout ?? 60_000;

  // Open Add Papers dialog
  await page.getByRole("button", { name: /add papers/i }).click();
  await expect(page.getByRole("dialog")).toBeVisible();

  // Ensure "Import IDs" tab is active
  await page.getByRole("tab", { name: /import ids/i }).click();

  // Fill textarea
  const textarea = page.locator("textarea");
  await expect(textarea).toBeVisible();
  await textarea.fill(identifiers.join("\n"));

  // Click Import Papers (button text may include count, e.g. "Import 3 Papers")
  const importBtn = page.getByRole("button", { name: /import.*papers/i });
  await expect(importBtn).toBeEnabled({ timeout: 10_000 });
  await importBtn.click();

  // Wait for the toast indicating completion
  await expect(
    page.getByText("Bulk import complete", { exact: true }),
  ).toBeVisible({ timeout });

  // Close dialog if still open — try multiple approaches
  const dialog = page.getByRole("dialog");
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!(await dialog.isVisible({ timeout: 500 }).catch(() => false))) break;
    // Try clicking the Close button first
    const closeBtn = dialog.getByRole("button", { name: /close/i });
    if (await closeBtn.isVisible({ timeout: 300 }).catch(() => false)) {
      await closeBtn.click();
    } else {
      await page.keyboard.press("Escape");
    }
    await page.waitForTimeout(300);
  }
}

/**
 * Delete papers by selecting their checkboxes and using bulk delete.
 * Matches papers whose title contains any of the given substrings.
 */
export async function deletePapersByTitleSubstrings(
  page: Page,
  titleSubstrings: string[],
) {
  for (const substr of titleSubstrings) {
    const row = page.locator("tbody tr").filter({ hasText: substr });
    const count = await row.count();
    if (count > 0) {
      await row.first().getByRole("checkbox").click();
    }
  }

  // Click bulk delete
  const deleteBtn = page.locator("button").filter({ hasText: /delete/i }).filter({
    has: page.locator("xpath=ancestor-or-self::*[contains(text(), 'selected') or preceding-sibling::*[contains(text(), 'selected')] or following-sibling::*[contains(text(), 'selected')]]"),
  });

  // Simpler approach: find the bar with "N selected" then its Delete button
  const selectedText = page.getByText(/\d+\s+selected/i);
  if (await selectedText.isVisible({ timeout: 2_000 }).catch(() => false)) {
    const toolbar = selectedText.locator("xpath=ancestor::div[1]");
    const delBtn = toolbar.getByRole("button", { name: /delete/i });
    if (await delBtn.isVisible().catch(() => false)) {
      await delBtn.click();
    } else {
      // Fallback: find any delete button that's not in a table row
      await page.locator("button").filter({ hasText: /^Delete$/i }).first().click();
    }
  }

  // Confirm deletion dialog
  const confirmDialog = page.getByRole("dialog").filter({ hasText: /cannot be undone/i });
  if (await confirmDialog.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await confirmDialog.getByRole("button", { name: /^delete$/i }).click();
  }
}

/**
 * Create a project via the sidebar Manage Projects modal.
 * Returns the project name.
 */
export async function createProject(page: Page, name: string) {
  // Click the gear button next to "Projects" in the sidebar
  const gearBtn = page
    .getByText("Projects")
    .first()
    .locator("xpath=ancestor::div[contains(@class, 'justify-between')][1]")
    .locator("button");
  await gearBtn.click();
  await expect(page.getByRole("dialog")).toBeVisible();

  // Fill in new project name and click Add
  await page.getByPlaceholder(/new project name/i).fill(name);
  await page.getByRole("button", { name: /^add$/i }).click();

  // Verify it appears in the list
  await expect(page.getByRole("dialog").getByText(name)).toBeVisible({ timeout: 5_000 });

  // Close dialog
  await page.keyboard.press("Escape");
}

/**
 * Create a tag via the sidebar Manage Tags modal.
 * Returns the tag name.
 */
export async function createTag(page: Page, name: string) {
  // Click the gear button next to "Tags" in the sidebar
  const gearBtn = page
    .getByText("Tags")
    .first()
    .locator("xpath=ancestor::div[contains(@class, 'justify-between')][1]")
    .locator("button");
  await gearBtn.click();
  await expect(page.getByRole("dialog")).toBeVisible();

  // Fill in new tag name and click Add
  await page.getByPlaceholder(/new tag name/i).fill(name);
  await page.getByRole("button", { name: /^add$/i }).click();

  // Verify it appears in the list
  await expect(page.getByRole("dialog").getByText(name)).toBeVisible({ timeout: 5_000 });

  // Close dialog
  await page.keyboard.press("Escape");
}

/**
 * Delete a project by name via the Manage Projects modal.
 */
export async function deleteProject(page: Page, name: string) {
  const gearBtn = page
    .getByText("Projects")
    .first()
    .locator("xpath=ancestor::div[contains(@class, 'justify-between')][1]")
    .locator("button");
  await gearBtn.click();
  await expect(page.getByRole("dialog")).toBeVisible();

  // Find the project row and click its delete button
  const projectRow = page.getByRole("dialog").locator("div").filter({ hasText: name });
  const deleteBtn = projectRow.locator('button:has(svg)').last();
  await deleteBtn.click();

  // Confirm if needed
  const confirmBtn = page.getByRole("button", { name: /^delete$/i });
  if (await confirmBtn.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await confirmBtn.click();
  }

  // Close dialog
  await page.keyboard.press("Escape");
}

/**
 * Delete a tag by name via the Manage Tags modal.
 */
export async function deleteTag(page: Page, name: string) {
  const gearBtn = page
    .getByText("Tags")
    .first()
    .locator("xpath=ancestor::div[contains(@class, 'justify-between')][1]")
    .locator("button");
  await gearBtn.click();
  await expect(page.getByRole("dialog")).toBeVisible();

  // Find the tag row and click its delete button
  const tagRow = page.getByRole("dialog").locator("div").filter({ hasText: name });
  const deleteBtn = tagRow.locator('button:has(svg)').last();
  await deleteBtn.click();

  // Confirm if needed
  const confirmBtn = page.getByRole("button", { name: /^delete$/i });
  if (await confirmBtn.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await confirmBtn.click();
  }

  // Close dialog
  await page.keyboard.press("Escape");
}

/**
 * Open the Edit dialog for a paper matching the given title substring.
 */
export async function openEditPaperDialog(page: Page, titleSubstring: string) {
  const row = page.locator("tbody tr").filter({ hasText: titleSubstring }).first();
  await row.getByRole("button", { name: /edit/i }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
}

/**
 * Collect console errors from page. Call this with page.on('console') pattern.
 */
export function collectConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      errors.push(msg.text());
    }
  });
  return errors;
}
