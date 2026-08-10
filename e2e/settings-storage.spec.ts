import { test, expect } from "@playwright/test";
import { waitForDashboard } from "./helpers";

/**
 * Settings → Storage usage indicator (PFA-C05).
 *
 * Read-only: the spec opens Settings and asserts the rendered gauge. It never
 * uploads, deletes, or otherwise mutates any row — the numbers it checks come
 * entirely from the deterministic local fixture.
 *
 * Fixture expectation: `handle_new_user` seeds a Free `user_entitlements` row
 * (`storage_quota_bytes` default `524288000` = 500 MB) and deliberately does
 * **not** create a `user_storage_usage` row — that row is created lazily by the
 * first attachment upload. The seeded user has no attachments, so the missing
 * usage row must render as **0 B used** against the real entitlement quota,
 * not as an error.
 */

const EXPECTED_USAGE_TEXT = "0 B of 500 MB used";
const EXPECTED_REMAINING_TEXT = "500 MB remaining";

test.describe("Settings storage usage indicator", () => {
  test("renders used/quota/remaining from the seeded entitlement with no usage row", async ({
    page,
  }) => {
    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);

    await page.getByRole("button", { name: "Settings", exact: true }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "Storage" })).toBeVisible();

    // Used / quota, then remaining — both human-readable, never raw bytes.
    await expect(dialog.getByText(EXPECTED_USAGE_TEXT)).toBeVisible({ timeout: 10_000 });
    await expect(dialog.getByText(EXPECTED_REMAINING_TEXT)).toBeVisible();
    await expect(dialog.getByText("Storage usage unavailable.")).toHaveCount(0);

    // The bar is accessible: named, with value text carrying the same state.
    const bar = dialog.getByRole("progressbar");
    await expect(bar).toHaveAttribute("aria-label", "Storage usage");
    await expect(bar).toHaveAttribute("aria-valuetext", EXPECTED_USAGE_TEXT);
    await expect(bar).toHaveAttribute("aria-valuenow", "0");

    // Transparency only — the gauge carries no upgrade/checkout path.
    await expect(dialog.getByRole("button", { name: /upgrade|buy|subscribe/i })).toHaveCount(0);

    // The existing PubMed control is unaffected and still usable.
    await expect(dialog.getByLabel("PubMed API Key (NCBI)")).toBeEnabled();

    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible({ timeout: 5_000 });
  });
});
