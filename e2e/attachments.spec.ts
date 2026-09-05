import { test, expect, type Page } from "@playwright/test";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import {
  waitForDashboard,
  openEditPaperDialog,
  collectConsoleErrors,
  deletePapersByTitleSubstrings,
} from "./helpers";

/**
 * Attachment E2E regression tests.
 *
 * Covers the hardened private-bucket / signed-URL attachment flow:
 * - valid upload, visibility, signed URL open, persistence after refresh
 * - delete
 * - invalid type rejection at the client
 * - ATTACHMENT-ORPHAN-CLEANUP-HARDENING-001: a Storage deletion that fails
 *   leaves the logical deletion committed and the cleanup intent durable, and a
 *   later authenticated session finishes the job from that intent alone
 *
 * Uses the first paper in the test account's library, except the paper-deletion
 * case, which owns a disposable paper of its own.
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

/**
 * Wait for attachment data to finish loading inside the edit dialog.
 * The hook fetches rows from paper_attachments then batch-fetches signed URLs.
 * We wait for the drop-zone to appear, then wait for the network to settle.
 */
async function waitForAttachmentsLoaded(page: Page, dialog: ReturnType<Page["getByRole"]>) {
  await expect(dialog.getByText("Drop files here or")).toBeVisible({ timeout: 5_000 });
  // Wait for fetchAttachments to complete — it issues a select then createSignedUrls.
  // networkidle is too strict (Supabase realtime keeps a connection), so we wait for
  // the paper_attachments query response + a buffer for signed URL resolution.
  await page.waitForResponse(
    (res) => res.url().includes("/rest/v1/paper_attachments") && res.status() === 200,
    { timeout: 10_000 },
  ).catch(() => { /* no attachments query if paperId not ready yet */ });
  // Extra buffer for signed URL batch response + React re-render
  await page.waitForTimeout(2_000);
}

/** Delete all attachments named TEST_FILE_NAME from the edit dialog (pre-cleanup). */
async function deleteTestAttachments(page: Page, dialog: ReturnType<Page["getByRole"]>) {
  await waitForAttachmentsLoaded(page, dialog);

  // Delete all cards matching our test file name
  const cards = dialog.locator("div.group").filter({ hasText: TEST_FILE_NAME });
  let count = await cards.count();
  while (count > 0) {
    await cards.first().hover();
    const deleteBtn = cards.first().locator('button[title="Delete"]');
    await expect(deleteBtn).toBeVisible({ timeout: 2_000 });
    await deleteBtn.click();
    await expect(page.getByText("Attachment deleted", { exact: true })).toBeVisible({ timeout: 10_000 });
    // Wait for toast to dismiss and DOM to update
    await page.waitForTimeout(1_000);
    count = await cards.count();
  }
}

// ─── Test Group 1 — Valid attachment upload / open / refresh / delete ─────────

test.describe("Attachment upload, open, refresh, delete", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(120_000); // generous timeout for cleanup of many leftovers

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
    await waitForAttachmentsLoaded(page, dialog);

    // Upload the PNG fixture via the hidden file input
    const fileInput = dialog.locator('input[type="file"]');
    await fileInput.setInputFiles(PNG_FIXTURE);

    // Wait for "Attachment uploaded" toast
    await expect(page.getByText("Attachment uploaded", { exact: true })).toBeVisible({ timeout: 15_000 });

    // The file name should be visible in the grid
    await expect(dialog.getByText(TEST_FILE_NAME).first()).toBeVisible({ timeout: 5_000 });

    // The attachment thumbnail/link should point to a signed URL (exactly one should exist after cleanup)
    const card = dialog.locator("a[target='_blank']").filter({
      has: page.locator(`img[alt='${TEST_FILE_NAME}']`),
    }).first();
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

    // Get the signed URL href (use .first() for resilience)
    const link = dialog.locator("a[target='_blank']").filter({
      has: page.locator(`img[alt='${TEST_FILE_NAME}']`),
    }).first();
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

    // The signed URL should be a fresh one (still valid) — use .first() for resilience
    const link = dialog.locator("a[target='_blank']").filter({
      has: page.locator(`img[alt='${TEST_FILE_NAME}']`),
    }).first();
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
    await waitForAttachmentsLoaded(page, dialog);

    // Count existing attachments
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

// ─── ATTACHMENT-ORPHAN-CLEANUP-HARDENING-001 — recoverable cleanup ───────────
//
// The proof the whole feature exists for: a Storage deletion that fails must not
// take the cleanup intent with it, and a later authenticated session must be
// able to finish the job from durable state alone.
//
// Deterministic ONLY at the HTTP boundary. `page.route` interferes with exactly
// one request shape per case — the Storage object DELETE, or the finalization
// RPC — and everything else is the real product against the real local Supabase:
// real upload, real RPCs, real queue rows, real binaries. Nothing is stubbed
// inside the application, and no case decides an outcome the SERVER should
// decide: the metadata-rejection case makes the database refuse the row, and the
// lost-response case lets the database commit and then destroys the answer.

/** The Supabase Storage remove endpoint for the attachments bucket. */
const STORAGE_DELETE_URL = "**/storage/v1/object/attachments";

/** The `paper_attachments` REST collection (used for page-side verification). */
const ATTACHMENT_METADATA_URL = "**/rest/v1/paper_attachments*";

/** The upload finalization RPC — the only writer of attachment metadata. */
const FINALIZE_RPC_URL = "**/rest/v1/rpc/finalize_attachment_upload";

/**
 * Runtime path to the Vite-served Supabase client, so page-side probes use the
 * SAME authenticated session and the SAME RLS the product does. Reading the
 * queue and listing Storage through anything else would prove something about a
 * different principal.
 */
const CLIENT_MODULE_PATH = "/src/integrations/supabase/client.ts";

interface QueueRow { id: string; file_path: string; reason: string }

/** The signed-in user's own pending cleanup rows. */
async function readCleanupQueue(page: Page): Promise<QueueRow[]> {
  return page.evaluate(async (modPath) => {
    const mod = await import(modPath);
    const client = (mod as { supabase: { from: (t: string) => { select: (c: string) => { order: (c: string, o: unknown) => Promise<{ data: unknown; error: unknown }> } } } }).supabase;
    const { data, error } = await client
      .from("attachment_cleanup_queue")
      .select("id, file_path, reason")
      .order("created_at", { ascending: true });
    if (error) throw new Error(`cleanup queue read failed: ${JSON.stringify(error)}`);
    return (data ?? []) as { id: string; file_path: string; reason: string }[];
  }, CLIENT_MODULE_PATH);
}

/** Metadata rows for one exact Storage path, read as the signed-in user. */
async function countAttachmentRows(page: Page, filePath: string): Promise<number> {
  return page.evaluate(async ([modPath, path]) => {
    const mod = await import(modPath);
    const client = (mod as { supabase: { from: (t: string) => { select: (c: string) => { eq: (c: string, v: string) => Promise<{ data: unknown[] | null; error: unknown }> } } } }).supabase;
    const { data, error } = await client
      .from("paper_attachments")
      .select("id")
      .eq("file_path", path);
    if (error) throw new Error(`attachment read failed: ${JSON.stringify(error)}`);
    return (data ?? []).length;
  }, [CLIENT_MODULE_PATH, filePath] as const);
}

/**
 * Whether the binary is still in the bucket.
 *
 * `list()` on the object's own directory, filtered to its name — a directory
 * listing is unambiguous about presence in a way a signed-URL probe is not.
 */
async function storageObjectExists(page: Page, filePath: string): Promise<boolean> {
  return page.evaluate(async ([modPath, path]) => {
    const mod = await import(modPath);
    const client = (mod as { supabase: { storage: { from: (b: string) => { list: (p: string, o: unknown) => Promise<{ data: { name: string }[] | null; error: unknown }> } } } }).supabase;
    const lastSlash = path.lastIndexOf("/");
    const dir = path.slice(0, lastSlash);
    const name = path.slice(lastSlash + 1);
    const { data, error } = await client.storage.from("attachments").list(dir, { limit: 100, search: name });
    if (error) throw new Error(`storage list failed: ${JSON.stringify(error)}`);
    return (data ?? []).some((entry) => entry.name === name);
  }, [CLIENT_MODULE_PATH, filePath] as const);
}

/**
 * Remove one attachment completely — metadata and binary — as the signed-in
 * user, through the same durable RPC the product uses.
 *
 * Housekeeping for the lost-response case, which deliberately ends with a saved
 * attachment rather than an orphan. Written page-side rather than through the UI
 * because the dialog it was uploaded into has already been dismissed.
 *
 * The RPC only queues the intent; the product's own recovery pass performs the
 * physical removal and acknowledges the row, so that is what finishes the job
 * here too rather than a second copy of the drain.
 */
async function deleteAttachmentByPath(page: Page, filePath: string): Promise<void> {
  await page.evaluate(async ([modPath, path]) => {
    const mod = await import(modPath);
    const client = (mod as {
      supabase: {
        from: (t: string) => { select: (c: string) => { eq: (c: string, v: string) => Promise<{ data: { id: string }[] | null; error: unknown }> } };
        rpc: (fn: string, args: Record<string, unknown>) => Promise<{ error: unknown }>;
      };
    }).supabase;
    const { data } = await client.from("paper_attachments").select("id").eq("file_path", path);
    for (const row of data ?? []) {
      const { error } = await client.rpc("delete_attachment_with_cleanup", { p_attachment_id: row.id });
      if (error) throw new Error(`cleanup delete failed: ${JSON.stringify(error)}`);
    }
  }, [CLIENT_MODULE_PATH, filePath] as const);
  await recoverThroughNewSession(page);
}

/**
 * Upload the PNG fixture through the real UI and return the Storage key it
 * landed on, read off the upload request itself rather than reconstructed.
 */
async function uploadAndCapturePath(page: Page, dialog: ReturnType<Page["getByRole"]>): Promise<string> {
  const uploadRequest = page.waitForRequest(
    (req) => req.method() === "POST" && /\/storage\/v1\/object\/attachments\//.test(req.url()),
    { timeout: 20_000 },
  );
  await dialog.locator('input[type="file"]').setInputFiles(PNG_FIXTURE);
  const request = await uploadRequest;
  await expect(page.getByText("Attachment uploaded", { exact: true })).toBeVisible({ timeout: 15_000 });

  const marker = "/storage/v1/object/attachments/";
  const url = new URL(request.url());
  const path = decodeURIComponent(url.pathname.slice(url.pathname.indexOf(marker) + marker.length));
  expect(path).toMatch(/^[0-9a-f-]{36}\/[0-9a-f-]{36}\/.+$/);
  return path;
}

/** Fail every Storage object DELETE until the returned disposer is called. */
async function failStorageDeletes(page: Page) {
  const handler = async (route: import("@playwright/test").Route) => {
    if (route.request().method() !== "DELETE") return route.fallback();
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ statusCode: "503", error: "ServiceUnavailable", message: "forced by test" }),
    });
  };
  await page.route(STORAGE_DELETE_URL, handler);
  return { dispose: () => page.unroute(STORAGE_DELETE_URL, handler) };
}

/**
 * Reload into a fresh authenticated session and wait for the session-start
 * recovery pass to empty the queue.
 *
 * This is the mechanism under test, not a test convenience: nothing else in the
 * product retries, so if the reload does not clear the queue then the feature
 * does not recover.
 */
async function recoverThroughNewSession(page: Page) {
  await page.goto("/", { waitUntil: "networkidle" });
  await waitForDashboard(page);
  await expect.poll(() => readCleanupQueue(page), { timeout: 20_000, intervals: [250, 500, 1000] })
    .toEqual([]);
}

test.describe("Attachment cleanup is recoverable", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(150_000);

  test.beforeEach(async ({ page }) => {
    // Every case starts from an empty queue, so a row observed later provably
    // belongs to the action under test.
    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);
    await expect.poll(() => readCleanupQueue(page), { timeout: 20_000 }).toEqual([]);
  });

  test("a failed Storage delete leaves the attachment logically deleted and the cleanup queued", async ({ page }) => {
    const errors = collectConsoleErrors(page);

    const firstRow = page.locator("tbody tr").first();
    const paperTitle = (await firstRow.locator("td p").first().textContent())!.trim();
    await openEditPaperDialog(page, paperTitle);
    const dialog = page.getByRole("dialog");
    await deleteTestAttachments(page, dialog);

    const filePath = await uploadAndCapturePath(page, dialog);
    expect(await storageObjectExists(page, filePath)).toBe(true);

    const forcedFailure = await failStorageDeletes(page);

    const card = dialog.locator("div.group").filter({ hasText: TEST_FILE_NAME }).first();
    await card.hover();
    await card.locator('button[title="Delete"]').click();

    // The delete is reported as what it is: done, with cleanup outstanding.
    await expect(page.getByText("Attachment deleted", { exact: true }).first()).toBeVisible({ timeout: 15_000 });
    // The toast description is rendered twice — visibly, and again inside the
    // aria-live status region as one concatenated string. Either is proof it was
    // shown, so the assertion takes the first match rather than requiring one.
    await expect(
      page.getByText(/File cleanup is pending and will retry automatically/i).first(),
    ).toBeVisible({ timeout: 5_000 });
    await expect(dialog.getByText(TEST_FILE_NAME)).not.toBeVisible({ timeout: 5_000 });

    // The logical deletion committed …
    expect(await countAttachmentRows(page, filePath)).toBe(0);
    // … the intent survived it …
    const queued = await readCleanupQueue(page);
    expect(queued.map((row) => ({ file_path: row.file_path, reason: row.reason }))).toEqual([
      { file_path: filePath, reason: "attachment_delete" },
    ]);
    // … and the binary really is still there, so the queue row is describing a
    // real object rather than a phantom.
    expect(await storageObjectExists(page, filePath)).toBe(true);

    await page.keyboard.press("Escape");
    await forcedFailure.dispose();

    // The recovery mechanism, end to end.
    await recoverThroughNewSession(page);
    expect(await storageObjectExists(page, filePath)).toBe(false);

    // Nothing broke beyond the failure this test deliberately caused. The forced
    // Storage 503 IS logged by the browser as a failed resource load — that is
    // the interception working — so it is excluded by name rather than by
    // dropping the assertion, which would stop it noticing a real fault.
    const unexpected = criticalOnly(errors).filter((e) => !/503/.test(e));
    expect(unexpected).toHaveLength(0);
  });

  test("a metadata rejection queues the orphan and a later session removes it", async ({ page }) => {
    const firstRow = page.locator("tbody tr").first();
    const paperTitle = (await firstRow.locator("td p").first().textContent())!.trim();
    await openEditPaperDialog(page, paperTitle);
    const dialog = page.getByRole("dialog");
    await waitForAttachmentsLoaded(page, dialog);

    // The upload succeeds and the finalization RPC really runs — but with a NULL
    // file name, which its INSERT cannot satisfy. So the DATABASE refuses the
    // metadata, rolls the row and its quota back inside the function's
    // subtransaction, and commits the cleanup intent in the same transaction.
    // Nothing here fakes the answer: the rejection and the queue row are the
    // server's, produced by the same code path a real quota refusal takes.
    const finalizeHandler = async (route: import("@playwright/test").Route) => {
      if (route.request().method() !== "POST") return route.fallback();
      const body = route.request().postDataJSON() as Record<string, unknown>;
      await route.continue({ postData: JSON.stringify({ ...body, p_file_name: null }) });
    };
    await page.route(FINALIZE_RPC_URL, finalizeHandler);
    const forcedFailure = await failStorageDeletes(page);

    const uploadRequest = page.waitForRequest(
      (req) => req.method() === "POST" && /\/storage\/v1\/object\/attachments\//.test(req.url()),
      { timeout: 20_000 },
    );
    await dialog.locator('input[type="file"]').setInputFiles(PNG_FIXTURE);
    const request = await uploadRequest;
    const marker = "/storage/v1/object/attachments/";
    const url = new URL(request.url());
    const filePath = decodeURIComponent(url.pathname.slice(url.pathname.indexOf(marker) + marker.length));

    // The save failed and cleanup could not complete — said plainly.
    await expect(page.getByText(/Failed to save/i).first()).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByText(/cleanup will retry automatically/i).first(),
    ).toBeVisible({ timeout: 5_000 });

    await page.unroute(FINALIZE_RPC_URL, finalizeHandler);

    // Intent persisted, binary still present, no metadata row anywhere.
    const queued = await readCleanupQueue(page);
    expect(queued.map((row) => ({ file_path: row.file_path, reason: row.reason }))).toEqual([
      { file_path: filePath, reason: "upload_compensation" },
    ]);
    expect(await storageObjectExists(page, filePath)).toBe(true);
    expect(await countAttachmentRows(page, filePath)).toBe(0);

    await page.keyboard.press("Escape");
    await forcedFailure.dispose();

    await recoverThroughNewSession(page);
    expect(await storageObjectExists(page, filePath)).toBe(false);
  });

  test("a finalization whose response is lost still saves the attachment", async ({ page }) => {
    // The case ATTACHMENT-ORPHAN-CLEANUP-HARDENING-001-CORRECTION-01 exists for,
    // reproduced at the real HTTP boundary with no timing anywhere in it.
    //
    // The first finalization request is DELIVERED — the database receives it and
    // commits the metadata — and then its response is destroyed, so the browser
    // sees a transport failure for a call that actually succeeded. Under the
    // superseded protocol that observation is what removed the object.
    //
    // Here the browser may only repeat the idempotent call, and the server
    // answers with the row it already holds.
    const firstRow = page.locator("tbody tr").first();
    const paperTitle = (await firstRow.locator("td p").first().textContent())!.trim();
    await openEditPaperDialog(page, paperTitle);
    const dialog = page.getByRole("dialog");
    await waitForAttachmentsLoaded(page, dialog);

    let swallowed = false;
    let finalizeRequests = 0;
    const lossHandler = async (route: import("@playwright/test").Route) => {
      if (route.request().method() !== "POST") return route.fallback();
      finalizeRequests += 1;
      if (swallowed) return route.fallback();
      swallowed = true;
      // Perform the request for real, then abort instead of fulfilling: the
      // transaction commits and the answer never arrives.
      await route.fetch();
      await route.abort("connectionfailed");
    };
    await page.route(FINALIZE_RPC_URL, lossHandler);

    const uploadRequest = page.waitForRequest(
      (req) => req.method() === "POST" && /\/storage\/v1\/object\/attachments\//.test(req.url()),
      { timeout: 20_000 },
    );
    await dialog.locator('input[type="file"]').setInputFiles(PNG_FIXTURE);
    const request = await uploadRequest;
    const marker = "/storage/v1/object/attachments/";
    const url = new URL(request.url());
    const filePath = decodeURIComponent(url.pathname.slice(url.pathname.indexOf(marker) + marker.length));

    // The attachment is saved, not lost and not reported as failed.
    await expect(page.getByText(/Attachment uploaded/i).first()).toBeVisible({ timeout: 20_000 });
    await page.unroute(FINALIZE_RPC_URL, lossHandler);

    // Two attempts: the one whose answer vanished, and the reconciling retry.
    expect(finalizeRequests).toBe(2);
    // Exactly one metadata row — the retry reported the committed one rather
    // than creating a second.
    expect(await countAttachmentRows(page, filePath)).toBe(1);
    // And the file is still there: nothing was scheduled for deletion, and
    // nothing was deleted on the strength of a lost response.
    expect(await storageObjectExists(page, filePath)).toBe(true);
    expect(await readCleanupQueue(page)).toEqual([]);

    // Clean up the attachment this case deliberately kept.
    await page.keyboard.press("Escape");
    await deleteAttachmentByPath(page, filePath);
  });

  test("a stale client cannot delete the binary of a live attachment", async ({ page }) => {
    // The post-migration fence, exercised through the real Storage API.
    //
    // A browser tab that loaded the pre-migration bundle is still running the
    // old upload compensation: on any error it observed from its own metadata
    // INSERT — including one that actually committed — it removes the object it
    // just uploaded. That is the ordering this feature exists to retire, and no
    // amount of new client code can reach a client that has already shipped.
    //
    // So this uploads normally, then performs exactly that removal as the
    // signed-in user, and requires the file and its metadata row to survive.
    const firstRow = page.locator("tbody tr").first();
    const paperTitle = (await firstRow.locator("td p").first().textContent())!.trim();
    await openEditPaperDialog(page, paperTitle);
    const dialog = page.getByRole("dialog");
    await waitForAttachmentsLoaded(page, dialog);

    const filePath = await uploadAndCapturePath(page, dialog);
    expect(await countAttachmentRows(page, filePath)).toBe(1);

    await page.keyboard.press("Escape");

    // Byte for byte what the old bundle did, through the same client the product
    // uses, as the same authenticated user.
    const removed = await page.evaluate(async ([modPath, path]) => {
      const mod = await import(modPath);
      const client = (mod as {
        supabase: { storage: { from: (b: string) => { remove: (paths: string[]) => Promise<{ data: unknown[] | null; error: unknown }> } } };
      }).supabase;
      const { data, error } = await client.storage.from("attachments").remove([path]);
      return { deleted: (data ?? []).length, errored: Boolean(error) };
    }, [CLIENT_MODULE_PATH, filePath] as const);

    // Storage RLS refuses the row, so nothing is deleted. Whether that surfaces
    // as an error or as an empty result is the Storage API's business; what
    // matters is the object.
    expect(removed.deleted).toBe(0);
    expect(await storageObjectExists(page, filePath)).toBe(true);
    expect(await countAttachmentRows(page, filePath)).toBe(1);

    // And the corrected path still works: metadata first, then the object.
    await deleteAttachmentByPath(page, filePath);
    expect(await storageObjectExists(page, filePath)).toBe(false);
  });

  test("deleting a paper keeps its attachment's cleanup recoverable", async ({ page }) => {
    const disposableTitle = `_e2e_cleanup_paper_${Date.now()}`;
    let filePath = "";

    try {
      // ── A disposable paper of this test's own, created through the real UI ──
      await page.getByRole("button", { name: /add papers/i }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.getByRole("tab", { name: /manual/i }).click();
      await page.locator("#manual-title").fill(disposableTitle);
      await page.getByRole("button", { name: /^add paper$/i }).click();
      await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 10_000 });

      const row = page.locator("tbody tr").filter({ hasText: disposableTitle }).first();
      await expect(row).toBeVisible({ timeout: 15_000 });

      await openEditPaperDialog(page, disposableTitle);
      const dialog = page.getByRole("dialog");
      await waitForAttachmentsLoaded(page, dialog);
      filePath = await uploadAndCapturePath(page, dialog);
      // Close through the dialog's own control. Escape can land on the toast or
      // the file input instead of the dialog right after an upload.
      await dialog.getByRole("button", { name: /cancel/i }).click();
      await expect(dialog).not.toBeVisible({ timeout: 10_000 });

      const forcedFailure = await failStorageDeletes(page);

      await row.getByRole("button", { name: `Delete ${disposableTitle}` }).click();
      const confirm = page.getByRole("alertdialog").filter({ hasText: /cannot be undone/i });
      await expect(confirm).toBeVisible({ timeout: 5_000 });
      await confirm.getByRole("button", { name: /^delete$/i }).click();

      // The paper deletion committed; only the file cleanup is outstanding.
      await expect(page.getByText("Paper deleted", { exact: true }).first()).toBeVisible({ timeout: 15_000 });
      await expect(
        page.getByText(/Attachment file cleanup is pending and will retry automatically/i).first(),
      ).toBeVisible({ timeout: 5_000 });
      // The row is NOT restored — a rollback here would contradict the database.
      await expect(page.locator("tbody tr").filter({ hasText: disposableTitle })).toHaveCount(0);

      expect(await countAttachmentRows(page, filePath)).toBe(0);
      const queued = await readCleanupQueue(page);
      expect(queued.map((r) => ({ file_path: r.file_path, reason: r.reason }))).toEqual([
        { file_path: filePath, reason: "paper_delete" },
      ]);
      expect(await storageObjectExists(page, filePath)).toBe(true);

      await forcedFailure.dispose();
      await recoverThroughNewSession(page);
      expect(await storageObjectExists(page, filePath)).toBe(false);
    } finally {
      // Order-independent: tolerate finding nothing, because the happy path has
      // already deleted the paper by the time this runs.
      await page.unroute(STORAGE_DELETE_URL).catch(() => {});
      await page.goto("/", { waitUntil: "networkidle" }).catch(() => {});
      await waitForDashboard(page).catch(() => {});
      await deletePapersByTitleSubstrings(page, [disposableTitle]).catch(() => {});
    }
  });
});

/**
 * The minimum shape of the app's Supabase client needed to replay a
 * pre-migration bundle's network sequence from inside the page.
 *
 * Written out rather than reached for with `any` because the point of these
 * tests is that a specific set of calls is refused — if one of them changes
 * shape, this should stop compiling rather than silently stop testing.
 */
type StaleBundleClient = {
  auth: { getUser: () => Promise<{ data: { user: { id: string } | null } }> };
  from: (table: string) => {
    select: (cols: string) => {
      limit: (n: number) => Promise<{ data: { id: string }[] | null; error: unknown }>;
    };
    insert: (row: Record<string, unknown>) => Promise<{ error: { code?: string; message?: string } | null }>;
    update: (patch: Record<string, unknown>) => {
      eq: (col: string, val: string) => Promise<{ error: { code?: string } | null }>;
    };
    delete: () => {
      eq: (col: string, val: string) => Promise<{ error: { code?: string } | null }>;
      in: (col: string, vals: string[]) => Promise<{ error: { code?: string } | null }>;
    };
  };
  storage: {
    from: (bucket: string) => {
      upload: (path: string, body: Blob, opts: Record<string, unknown>) => Promise<{ error: { message?: string } | null }>;
      remove: (paths: string[]) => Promise<{ data: unknown[] | null; error: unknown }>;
    };
  };
};

test.describe("The attachment lifecycle boundary", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeEach(async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);
  });

  test("a stale bundle's upload can no longer create metadata, and its own cleanup still works", async ({ page }) => {
    // The pre-migration upload sequence, replayed byte for byte against the
    // post-migration schema: PUT the object, then INSERT the metadata row
    // directly. After 20260904120000 that INSERT is refused at the ACL, so the
    // damaged half-state this feature exists to prevent — a committed metadata
    // row whose binary the same tab then deletes — cannot be produced at all.
    //
    // What the old bundle does next is its own compensation, and that still
    // works, because no metadata row names the object: it removes the file and
    // nothing is left behind. That is the good case, and it is deliberately not
    // the only one — see the assertions about durable intent at the end.
    const staged = await page.evaluate(async (modPath) => {
      const mod = await import(modPath);
      const client = (mod as { supabase: StaleBundleClient }).supabase;
      const { data: userData } = await client.auth.getUser();
      const uid = userData.user?.id ?? "";
      const { data: papers } = await client.from("papers").select("id").limit(1);
      const paperId = (papers ?? [])[0]?.id ?? "";
      const path = `${uid}/${paperId}/stale-upload-${Date.now()}.png`;

      const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const upload = await client.storage
        .from("attachments")
        .upload(path, new Blob([bytes], { type: "image/png" }), { contentType: "image/png", upsert: false });

      // Exactly the call `legacyFinalizeUpload` makes on a pre-migration database.
      const insert = await client.from("paper_attachments").insert({
        paper_id: paperId,
        user_id: uid,
        file_path: path,
        file_name: "stale-upload.png",
        file_type: "image/png",
        size_bytes: bytes.length,
      });

      return {
        path,
        uploadFailed: Boolean(upload.error),
        insertCode: insert.error?.code ?? null,
        insertFailed: Boolean(insert.error),
      };
    }, CLIENT_MODULE_PATH);

    expect(staged.uploadFailed).toBe(false);
    // 42501 — insufficient_privilege. Not a trigger, not RLS: the row never gets
    // as far as being evaluated.
    expect(staged.insertFailed).toBe(true);
    expect(staged.insertCode).toBe("42501");
    expect(await countAttachmentRows(page, staged.path)).toBe(0);
    // The binary is still there — which is the whole reason the old bundle has a
    // compensation step at all.
    expect(await storageObjectExists(page, staged.path)).toBe(true);

    // Its compensation, unchanged. The fence only refuses objects a live
    // metadata row names, and this one has none, so the removal is allowed.
    const removed = await page.evaluate(async ([modPath, path]) => {
      const mod = await import(modPath);
      const client = (mod as { supabase: StaleBundleClient }).supabase;
      const { data, error } = await client.storage.from("attachments").remove([path]);
      return { deleted: (data ?? []).length, errored: Boolean(error) };
    }, [CLIENT_MODULE_PATH, staged.path] as const);

    expect(removed.errored).toBe(false);
    expect(removed.deleted).toBe(1);
    expect(await storageObjectExists(page, staged.path)).toBe(false);

    // …and nothing durable was recorded, because a bundle that predates this
    // feature cannot call functionality it does not know exists. If that removal
    // had ALSO failed, the binary would have stayed until account deletion. That
    // is the honest residual limitation of a stale client, and it is documented
    // rather than papered over.
    expect(await readCleanupQueue(page)).toEqual([]);
  });

  test("a stale bundle cannot delete a paper around the lifecycle, single or bulk", async ({ page }) => {
    // The parent door. `paper_attachments.paper_id` cascades from `papers`, so a
    // direct paper deletion removes attachment metadata without any statement
    // naming it — the same bypass through a different table, and the one an old
    // bundle actually uses, because it deletes papers with a raw Data API
    // DELETE.
    //
    // After 20260904120000 that DELETE is refused. What matters is not only the
    // refusal but its ORDER: the old bundle reads the attachment paths, deletes
    // the papers, and only then asks Storage to remove the binaries. Because the
    // database refuses at step two, step three never runs, so a stale tab cannot
    // strip the files off papers it did not manage to delete.
    const firstRow = page.locator("tbody tr").first();
    const paperTitle = (await firstRow.locator("td p").first().textContent())!.trim();
    await openEditPaperDialog(page, paperTitle);
    const dialog = page.getByRole("dialog");
    await waitForAttachmentsLoaded(page, dialog);
    const filePath = await uploadAndCapturePath(page, dialog);
    await dialog.getByRole("button", { name: /cancel/i }).click();
    await expect(dialog).not.toBeVisible({ timeout: 10_000 });

    const attempts = await page.evaluate(async ([modPath, path]) => {
      const mod = await import(modPath);
      const client = (mod as { supabase: StaleBundleClient }).supabase;
      const { data: rows } = await client.from("paper_attachments").select("paper_id");
      // The paper this attachment belongs to, read the way the old bundle reads it.
      const { data: papers } = await client.from("papers").select("id").limit(1);
      const paperId = (papers ?? [])[0]?.id ?? "";
      const single = await client.from("papers").delete().eq("id", paperId);
      const bulk = await client.from("papers").delete().in("id", [paperId]);
      return {
        paperId,
        rows: (rows ?? []).length,
        singleCode: single.error?.code ?? null,
        bulkCode: bulk.error?.code ?? null,
        path,
      };
    }, [CLIENT_MODULE_PATH, filePath] as const);

    expect(attempts.singleCode).toBe("42501");
    expect(attempts.bulkCode).toBe("42501");
    // Nothing was destroyed on either attempt: the paper, its metadata and its
    // binary all survive, and no cleanup intent was recorded because none was
    // needed.
    expect(await countAttachmentRows(page, filePath)).toBe(1);
    expect(await storageObjectExists(page, filePath)).toBe(true);
    expect(await readCleanupQueue(page)).toEqual([]);

    // The corrected path still removes both halves, in the order that keeps the
    // Storage object reachable from the database until it is actually gone.
    await deleteAttachmentByPath(page, filePath);
    expect(await countAttachmentRows(page, filePath)).toBe(0);
    expect(await storageObjectExists(page, filePath)).toBe(false);
  });

  test("a live attachment's metadata cannot be altered or removed directly", async ({ page }) => {
    // The deletion half of the same boundary. A stale tab — or a hand-written
    // Data API request — cannot make attachment metadata change or disappear
    // without going through the RPC that records Storage cleanup intent in the
    // same transaction. That is what turns "cleanup intent is always recorded"
    // from a property of the current React bundle into a property of the
    // database.
    const firstRow = page.locator("tbody tr").first();
    const paperTitle = (await firstRow.locator("td p").first().textContent())!.trim();
    await openEditPaperDialog(page, paperTitle);
    const dialog = page.getByRole("dialog");
    await waitForAttachmentsLoaded(page, dialog);

    const filePath = await uploadAndCapturePath(page, dialog);
    expect(await countAttachmentRows(page, filePath)).toBe(1);
    await dialog.getByRole("button", { name: /cancel/i }).click();
    await expect(dialog).not.toBeVisible({ timeout: 10_000 });

    const attempts = await page.evaluate(async ([modPath, path]) => {
      const mod = await import(modPath);
      const client = (mod as { supabase: StaleBundleClient }).supabase;
      const update = await client.from("paper_attachments").update({ file_name: "renamed.png" }).eq("file_path", path);
      const remove = await client.from("paper_attachments").delete().eq("file_path", path);
      return { updateCode: update.error?.code ?? null, deleteCode: remove.error?.code ?? null };
    }, [CLIENT_MODULE_PATH, filePath] as const);

    expect(attempts.updateCode).toBe("42501");
    expect(attempts.deleteCode).toBe("42501");
    // Both halves survive: the row is still there, and so is its file.
    expect(await countAttachmentRows(page, filePath)).toBe(1);
    expect(await storageObjectExists(page, filePath)).toBe(true);
    expect(await readCleanupQueue(page)).toEqual([]);

    // And the authoritative path still removes both, in the order that keeps the
    // Storage object reachable from the database until it is actually gone.
    await deleteAttachmentByPath(page, filePath);
    expect(await countAttachmentRows(page, filePath)).toBe(0);
    expect(await storageObjectExists(page, filePath)).toBe(false);
  });
});
