import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { unzipSync, strFromU8 } from "fflate";
import { openAccountDialog, waitForDashboard } from "./helpers";

/**
 * Account → Account data: full account export (PFA-C02).
 *
 * Read-only end to end. The spec signs in as the deterministic local primary
 * fixture, opens Account menu → Account, triggers the export, and inspects the
 * ZIP the browser actually downloaded. It never writes a row, uploads an object, or
 * mutates any backend state — every assertion is about data the seed already
 * created.
 *
 * Fixture expectations: the primary user holds 125 seeded papers — the 120-row
 * generated library plus the five AUTHOR-IDENTITY-RESOLUTION-001C fixtures — and
 * no binary
 * attachment. A zero-attachment account is a valid and important case here —
 * it proves the archive is complete and well-formed without binaries. Exact
 * binary handling (bytes, paths, collisions, traversal, failure) is covered in
 * depth by the Vitest suites against a controlled Storage mock, so the global
 * seed is deliberately left unchanged.
 */

/** The whole seeded library: 120 generated rows + 5 identity fixtures. */
const PRIMARY_PAPER_COUNT = 125;

/** Every JSON path the archive contract requires, empty collections included. */
const EXPECTED_JSON_PATHS = [
  "manifest.json",
  "data/profile.json",
  "data/papers.json",
  "data/projects.json",
  "data/paper_projects.json",
  "data/tags.json",
  "data/paper_tags.json",
  "data/filter_presets.json",
  "data/keyword_pool.json",
  "data/synonym_pool.json",
  "data/study_type_pool.json",
  "data/keyword_exclusion_pool.json",
  "data/study_type_exclusion_pool.json",
  "data/paper_attachments.json",
  // AUTHOR-IDENTITY-RESOLUTION-001C. Four additive category files; no existing
  // file changed shape, which is why the manifest version stays 2.
  "data/author_identities.json",
  "data/author_identity_aliases.json",
  "data/author_identity_links.json",
  "data/author_identity_merges.json",
];

interface Manifest {
  format: string;
  version: number;
  generated_at: string;
  user_id: string;
  categories: Record<string, { count: number; path: string }>;
  attachments: { count: number; total_bytes: number };
}

test.describe("Account data export", () => {
  test("downloads a complete, credential-free account archive", async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);

    const dialog = await openAccountDialog(page);
    await expect(dialog.getByRole("heading", { name: "Account data" })).toBeVisible();

    const exportButton = dialog.getByRole("button", { name: "Export account data" });
    await expect(exportButton).toBeEnabled();

    const downloadPromise = page.waitForEvent("download", { timeout: 60_000 });
    await exportButton.click();

    // Note: the in-progress disabled/spinner state is deliberately not asserted
    // here. A fixture with no attachments can complete before Playwright polls,
    // which would make the assertion racy; that behaviour is covered
    // deterministically by the Vitest Account dialog tests instead.
    const download = await downloadPromise;

    // Deterministic, product-prefixed, UTC filename with no personal identifier.
    expect(download.suggestedFilename()).toMatch(
      /^paperlume-account-export-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.zip$/,
    );
    expect(download.suggestedFilename()).not.toContain("@");

    const archivePath = await download.path();
    expect(archivePath).toBeTruthy();

    // The archive opens as a real ZIP.
    const entries = unzipSync(new Uint8Array(readFileSync(archivePath!)));
    const paths = Object.keys(entries);

    // Every expected category file exists, empty ones included.
    for (const expected of EXPECTED_JSON_PATHS) {
      expect(paths, `${expected} must be in the archive`).toContain(expected);
    }

    const readJson = (path: string) => JSON.parse(strFromU8(entries[path]));

    const manifest = readJson("manifest.json") as Manifest;
    expect(manifest.format).toBe("paperlume-account-export");
    // 2 since papers gained the persisted `author_provenance` field — a reshape
    // of an existing archive file, which a reader must be able to notice.
    // Literal on purpose, so a version change has to be made deliberately here.
    expect(manifest.version).toBe(2);
    expect(manifest.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(manifest.user_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );

    // Papers from the deterministic fixture are present and complete.
    const papers = readJson("data/papers.json") as Record<string, unknown>[];
    expect(papers).toHaveLength(PRIMARY_PAPER_COUNT);
    expect(manifest.categories.papers.count).toBe(PRIMARY_PAPER_COUNT);
    expect(papers.every((paper) => typeof paper.title === "string")).toBe(true);
    // Notes ship as a papers column, not a separate category.
    expect(papers.some((paper) => typeof paper.notes === "string" && paper.notes)).toBe(true);

    // The archive belongs to the signed-in fixture account, and to it only.
    const profile = readJson("data/profile.json") as Record<string, unknown> | null;
    expect(profile).not.toBeNull();
    expect(profile!.user_id).toBe(manifest.user_id);
    expect(profile!.email).toBe("e2e-primary@paperlume.test");
    const ownerIds = new Set(papers.map((paper) => paper.user_id));
    expect([...ownerIds]).toEqual([manifest.user_id]);

    // No credential field anywhere — checked on the profile and on every byte.
    expect(Object.keys(profile!)).not.toContain("pubmed_api_key");
    const archiveText = Object.values(entries)
      .map((bytes) => strFromU8(bytes))
      .join("\n");
    for (const forbidden of [
      "pubmed_api_key",
      "access_token",
      "refresh_token",
      "service_role",
      "apikey",
    ]) {
      expect(archiveText, `${forbidden} must not appear in the archive`).not.toContain(forbidden);
    }

    // Attachment metadata is a valid collection and reconciles with the manifest.
    const attachments = readJson("data/paper_attachments.json") as Record<string, unknown>[];
    expect(Array.isArray(attachments)).toBe(true);
    expect(attachments).toHaveLength(manifest.attachments.count);
    const binaryEntries = paths.filter((path) => path.startsWith("attachments/"));
    expect(binaryEntries).toHaveLength(manifest.attachments.count);

    // Every declared count matches the file it points at.
    for (const [key, category] of Object.entries(manifest.categories)) {
      if (key === "profile") continue;
      expect((readJson(category.path) as unknown[]).length, `${key} count`).toBe(category.count);
    }

    // No archive path can escape its directory.
    for (const path of paths) {
      expect(path.split("/")).not.toContain("..");
      expect(path.startsWith("/")).toBe(false);
    }

    // The UI settles back to a usable state, with the Danger zone beside it
    // untouched — an export neither arms nor disables the destructive action.
    await expect(exportButton).toBeEnabled({ timeout: 30_000 });
    await expect(dialog.getByRole("heading", { name: "Danger zone" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Delete account" })).toBeEnabled();
    await expect(page.getByRole("alertdialog")).toHaveCount(0);

    // Application settings are a separate surface now, not a section of this
    // dialog. Asserted here so the split cannot silently regress.
    await expect(dialog.getByLabel("PubMed API Key (NCBI)")).toHaveCount(0);
    await expect(dialog.getByRole("heading", { name: "Storage" })).toHaveCount(0);

    // Closed via the dialog's own Close control rather than Escape: triggering
    // a browser download moves keyboard focus out of the page, so a synthetic
    // Escape is not reliably delivered afterwards. Clicking the real affordance
    // is both robust and closer to what a user does.
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(dialog).not.toBeVisible({ timeout: 5_000 });

    // Settings still has both of them, and neither account action.
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    await expect(settings.getByLabel("PubMed API Key (NCBI)")).toBeEnabled();
    await expect(settings.getByRole("heading", { name: "Storage" })).toBeVisible();
    await expect(settings.getByRole("button", { name: "Export account data" })).toHaveCount(0);
    await expect(settings.getByRole("heading", { name: "Danger zone" })).toHaveCount(0);
  });
});
