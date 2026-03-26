import { test, expect, type Page } from "@playwright/test";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import {
  waitForDashboard,
  openEditPaperDialog,
  collectConsoleErrors,
} from "./helpers";

/**
 * Attachment E2E regression tests.
 *
 * Covers the hardened private-bucket / signed-URL attachment flow:
 * - valid upload, visibility, signed URL open, persistence after refresh
 * - delete
 * - invalid type rejection at the client
 *
 * Uses the first paper in the test account's library.
 * Cleanup: every uploaded attachment is deleted within the test group.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PNG_FIXTURE = resolve(__dirname, "fixtures/test-attachment.png");
const SVG_FIXTURE = resolve(__dirname, "fixtures/test-invalid.svg");
const TEST_FILE_NAME = "test-attachment.png";

/** Filter out known-harmless console noise. */
function criticalOnly(errors: string[]) {
  return errors.filter(
    (e) =>
      !e.includes("favicon") &&
      !e.includes("net::ERR") &&
      !e.includes("[vite]") &&
      !e.includes("CORS"),
  );
}

/** Delete all attachments named TEST_FILE_NAME from the edit dialog (pre-cleanup). */
async function deleteTestAttachments(page: Page, dialog: ReturnType<Page["getByRole"]>) {
  // Wait for attachment section to render
  await expect(dialog.getByText("Drop files here or")).toBeVisible({ timeout: 5_000 });
  await page.waitForTimeout(1_500); // let signed URLs resolve

  // Delete all cards matching our test file name
  const cards = dialog.locator("div.group").filter({ hasText: TEST_FILE_NAME });
  let count = await cards.count();
  while (count > 0) {
    await cards.first().hover();
    const deleteBtn = cards.first().locator('button[title="Delete"]');
    await expect(deleteBtn).toBeVisible({ timeout: 2_000 });
    await deleteBtn.click();
    await expect(page.getByText("Attachment deleted", { exact: true })).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(500);
    count = await cards.count();
  }
}

// ─── Test Group 1 — Valid attachment upload / open / refresh / delete ─────────

test.describe("Attachment upload, open, refresh, delete", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(60_000);

  /** We'll store the title of the paper we attach to, so subsequent tests can reopen it. */
  let paperTitle: string;

  test("pre-cleanup: remove leftover test attachments", async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);

    const firstRow = page.locator("tbody tr").first();
    const titleEl = firstRow.locator("td p").first();
    paperTitle = (await titleEl.textContent())!.trim();

    await openEditPaperDialog(page, paperTitle);
    const dialog = page.getByRole("dialog");

    await deleteTestAttachments(page, dialog);

    await page.keyboard.press("Escape");
  });

  test("upload a valid PNG and verify it appears", async ({ page }) => {
    const errors = collectConsoleErrors(page);

    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);

    await openEditPaperDialog(page, paperTitle);
    const dialog = page.getByRole("dialog");

    // Wait for the attachment section to finish loading
    await expect(dialog.getByText("Drop files here or")).toBeVisible({ timeout: 5_000 });

    // Upload the PNG fixture via the hidden file input
    const fileInput = dialog.locator('input[type="file"]');
    await fileInput.setInputFiles(PNG_FIXTURE);

    // Wait for "Attachment uploaded" toast
    await expect(page.getByText("Attachment uploaded", { exact: true })).toBeVisible({ timeout: 15_000 });

    // The file name should be visible in the grid
    await expect(dialog.getByText(TEST_FILE_NAME).first()).toBeVisible({ timeout: 5_000 });

    // The attachment thumbnail/link should point to a signed URL
    const card = dialog.locator("a[target='_blank']").filter({
      has: page.locator(`img[alt='${TEST_FILE_NAME}']`),
    });
    const href = await card.getAttribute("href");
    expect(href).toBeTruthy();
    expect(href).toContain("/storage/v1/object/sign/");

    // Close dialog
    const cancelBtn = dialog.getByRole("button", { name: /cancel/i });
    if (await cancelBtn.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await cancelBtn.click();
    } else {
      await page.keyboard.press("Escape");
    }
    await expect(dialog).not.toBeVisible({ timeout: 5_000 });

    expect(criticalOnly(errors)).toHaveLength(0);
  });

  test("open the attachment via signed URL", async ({ page }) => {
    const errors = collectConsoleErrors(page);

    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);

    await openEditPaperDialog(page, paperTitle);
    const dialog = page.getByRole("dialog");

    // Find the attachment
    await expect(dialog.getByText(TEST_FILE_NAME).first()).toBeVisible({ timeout: 10_000 });

    // Get the signed URL href
    const link = dialog.locator("a[target='_blank']").filter({
      has: page.locator(`img[alt='${TEST_FILE_NAME}']`),
    });
    const href = await link.getAttribute("href");
    expect(href).toBeTruthy();
    expect(href).toContain("/storage/v1/object/sign/");

    // Verify the signed URL is reachable (fetch in page context to avoid new tab)
    const status = await page.evaluate(async (url) => {
      const resp = await fetch(url!, { method: "HEAD" });
      return resp.status;
    }, href);
    expect(status).toBe(200);

    await page.keyboard.press("Escape");

    expect(criticalOnly(errors)).toHaveLength(0);
  });

  test("attachment persists after page refresh with fresh signed URL", async ({ page }) => {
    const errors = collectConsoleErrors(page);

    // Full page reload
    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);

    await openEditPaperDialog(page, paperTitle);
    const dialog = page.getByRole("dialog");

    // Attachment should still be visible
    await expect(dialog.getByText(TEST_FILE_NAME).first()).toBeVisible({ timeout: 10_000 });

    // The signed URL should be a fresh one (still valid)
    const link = dialog.locator("a[target='_blank']").filter({
      has: page.locator(`img[alt='${TEST_FILE_NAME}']`),
    });
    const href = await link.getAttribute("href");
    expect(href).toBeTruthy();
    expect(href).toContain("/storage/v1/object/sign/");

    // Verify the fresh signed URL is reachable
    const status = await page.evaluate(async (url) => {
      const resp = await fetch(url!, { method: "HEAD" });
      return resp.status;
    }, href);
    expect(status).toBe(200);

    await page.keyboard.press("Escape");

    expect(criticalOnly(errors)).toHaveLength(0);
  });

  test("delete the attachment and verify it is gone", async ({ page }) => {
    const errors = collectConsoleErrors(page);

    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);

    await openEditPaperDialog(page, paperTitle);
    const dialog = page.getByRole("dialog");

    // Wait for attachment to load
    await expect(dialog.getByText(TEST_FILE_NAME).first()).toBeVisible({ timeout: 10_000 });

    // Find the attachment card that contains our test file, hover to reveal delete, then click
    const card = dialog.locator("div.group").filter({ hasText: TEST_FILE_NAME }).first();
    await card.hover();
    const deleteBtn = card.locator('button[title="Delete"]');
    await expect(deleteBtn).toBeVisible({ timeout: 2_000 });
    await deleteBtn.click();

    // Wait for "Attachment deleted" toast
    await expect(page.getByText("Attachment deleted", { exact: true })).toBeVisible({ timeout: 10_000 });

    // The file name should no longer appear
    await expect(dialog.getByText(TEST_FILE_NAME)).not.toBeVisible({ timeout: 5_000 });

    await page.keyboard.press("Escape");

    expect(criticalOnly(errors)).toHaveLength(0);
  });
});

// ─── Test Group 2 — Invalid type rejection ───────────────────────────────────

test.describe("Attachment invalid type rejection", () => {
  test.setTimeout(30_000);

  test("SVG file is rejected at client-side validation", async ({ page }) => {
    const errors = collectConsoleErrors(page);

    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);

    // Open edit dialog on the first paper
    const firstRow = page.locator("tbody tr").first();
    const titleEl = firstRow.locator("td p").first();
    const paperTitle = (await titleEl.textContent())!.trim();
    await openEditPaperDialog(page, paperTitle);
    const dialog = page.getByRole("dialog");

    // Wait for the attachment section to load
    await expect(dialog.getByText("Drop files here or")).toBeVisible({ timeout: 5_000 });

    // Count existing attachments
    await page.waitForTimeout(1_000);
    const countBefore = await dialog.locator('button[title="Delete"]').count();

    // Upload the SVG fixture
    const fileInput = dialog.locator('input[type="file"]');
    await fileInput.setInputFiles(SVG_FIXTURE);

    // Should see the rejection toast
    await expect(page.getByText(/not a valid type/i).first()).toBeVisible({ timeout: 5_000 });

    // No new attachment should appear
    await page.waitForTimeout(500);
    const countAfter = await dialog.locator('button[title="Delete"]').count();
    expect(countAfter).toBe(countBefore);

    // The "Attachment uploaded" toast should NOT appear
    await expect(page.getByText("Attachment uploaded", { exact: true })).not.toBeVisible({ timeout: 2_000 });

    await page.keyboard.press("Escape");

    expect(criticalOnly(errors)).toHaveLength(0);
  });
});
