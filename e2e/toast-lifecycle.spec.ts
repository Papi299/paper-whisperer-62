import { test, expect, type Locator, type Page } from "@playwright/test";
import { waitForDashboard } from "./helpers";
import { TOAST_DURATION_MS } from "../src/lib/toastPolicy";

/**
 * UI-TOAST-LIFECYCLE-CONSISTENCY-001 — notification lifecycle in a real browser.
 *
 * The owner saw "Bulk import complete", "Keywords updated" and "Paper deleted"
 * stay on screen until clicked. The cause was the previous Radix toaster's
 * provider-wide pause flag: closing a notification by hand, with the pointer
 * over it and outside any dialog, left the flag set after the last toast
 * unmounted, so the NEXT notification never started its timer. This spec drives
 * the three reported paths through the real app and requires each one to close
 * on its own, including straight after a notification was closed by hand.
 *
 * Deterministic and local. Two HTTP boundaries are fulfilled by Playwright and
 * nothing else is stubbed:
 *
 *   - `fetch-paper-metadata` returns synthetic records for two nine-digit PMIDs
 *     no other spec uses, so the import needs no Edge Function and no
 *     PubMed/Crossref egress. Both imported papers are deleted again.
 *   - `rpc/bulk_update_keywords` is answered without reaching the database.
 *     The seed stores `keywords` with an empty `raw_keywords`, so a real
 *     re-evaluation would rewrite every seeded paper's keywords; fulfilling the
 *     write keeps the database as it was while the real hook still fetches,
 *     computes, calls and notifies.
 *
 * The synonym added is one that appears in every seeded primary abstract
 * ("Deterministic abstract for …"), so its unique canonical term changes every
 * one of those papers whatever earlier specs did to their stored keywords —
 * `scrollarea-reachability` runs a real re-evaluation before this spec does.
 */

/** Time allowed on top of the policy for render, polling and the exit transition. */
const DISMISS_SLACK_MS = 4_000;
/**
 * How much earlier than the policy a notification may be seen to close.
 * `shownAt` is taken when the assertion first sees the notification, which can
 * lag its real appearance by a polling interval.
 */
const OBSERVATION_LAG_MS = 1_500;

const METADATA_FUNCTION_PATH = "/functions/v1/fetch-paper-metadata";
const KEYWORD_WRITE_PATH = "/rest/v1/rpc/bulk_update_keywords";

/** The app and the local API are different origins, so fulfilled responses need CORS. */
const STAND_IN_CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, content-profile, accept-profile, prefer",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface Fixture {
  identifier: string;
  title: string;
}

const FIRST: Fixture = { identifier: "900000301", title: "E2E Toast Lifecycle Paper One" };
const SECOND: Fixture = { identifier: "900000302", title: "E2E Toast Lifecycle Paper Two" };
const FIXTURES = [FIRST, SECOND];

/** Canonical-term prefix for the one synonym group this spec creates and removes. */
const SYNONYM_PREFIX = "E2E Toast Lifecycle";
/** Opens every seeded primary abstract, so the group always changes the library. */
const SEEDED_ABSTRACT_SYNONYM = "[deterministic abstract]";
/** The app's own Supabase client, imported through Vite so calls run as the signed-in user. */
const CLIENT_MODULE_PATH = "/src/integrations/supabase/client.ts";

function metadataFor(fixture: Fixture) {
  return {
    identifier: fixture.identifier,
    title: fixture.title,
    authors: ["Lifecycle, A"],
    year: 2024,
    journal: "Journal of Deterministic E2E Notifications",
    pmid: fixture.identifier,
    doi: null,
    abstract: "Deterministic stand-in abstract for the notification lifecycle regression.",
    keywords: [],
    mesh_terms: [],
    substances: [],
    study_type: null,
    publication_types: [],
    pubmed_url: `https://pubmed.ncbi.nlm.nih.gov/${fixture.identifier}/`,
    journal_url: null,
    source: "pubmed",
  };
}

/** The app's one notification region — Sonner's labelled `<section>`. */
function notificationRegion(page: Page): Locator {
  return page.getByRole("region", { name: /^Notifications\b/ });
}

/** A single notification, matched by its exact title. */
function notification(page: Page, title: string): Locator {
  return notificationRegion(page)
    .getByRole("listitem")
    .filter({ has: page.getByText(title, { exact: true }) });
}

/**
 * Require a notification to close without anyone touching it, no sooner than
 * the policy allows, and to leave nothing behind that could take a click.
 */
async function expectClosesOnItsOwn(page: Page, item: Locator, shownAt: number, durationMs: number) {
  // Hovering pauses a notification by design; this asserts the unattended case,
  // so the pointer is parked away from the toaster (one jump, crossing nothing).
  await page.mouse.move(0, 0);
  const box = await item.boundingBox();
  await expect(item).toBeHidden({ timeout: durationMs + DISMISS_SLACK_MS });
  expect(Date.now() - shownAt).toBeGreaterThanOrEqual(durationMs - OBSERVATION_LAG_MS);

  // Where the notification was, a click now lands on the page, not the toaster.
  if (box) {
    const hitsToaster = await page.evaluate(
      ({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest("[data-sonner-toaster]")),
      { x: box.x + box.width / 2, y: box.y + box.height / 2 },
    );
    expect(hitsToaster).toBe(false);
  }
}

/** Hover a notification and close it with its own labelled button. */
async function closeByHand(item: Locator) {
  await item.hover();
  await item.getByRole("button", { name: "Close toast" }).click();
  await expect(item).toBeHidden({ timeout: 2_000 });
}

async function openDashboard(page: Page) {
  await page.goto("/", { waitUntil: "networkidle" });
  await waitForDashboard(page);
}

async function routeMetadataStandIn(page: Page) {
  const byIdentifier = new Map(FIXTURES.map((f) => [f.identifier, f]));
  await page.route(
    (url) => url.pathname === METADATA_FUNCTION_PATH,
    async (route) => {
      if (route.request().method() === "OPTIONS") {
        await route.fulfill({ status: 204, headers: STAND_IN_CORS_HEADERS, body: "" });
        return;
      }
      const body = route.request().postDataJSON() as { identifiers?: unknown } | null;
      const identifiers = Array.isArray(body?.identifiers) ? body.identifiers.map(String) : [];
      const results = identifiers.map((identifier) => {
        const fixture = byIdentifier.get(identifier);
        return fixture ? metadataFor(fixture) : { identifier, error: "No lifecycle fixture for this identifier" };
      });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: STAND_IN_CORS_HEADERS,
        body: JSON.stringify({ results }),
      });
    },
  );
}

/** Import one fixture through Add Papers and return the still-open dialog. */
async function importOne(page: Page, fixture: Fixture): Promise<Locator> {
  await page.getByRole("button", { name: /add papers/i }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("tab", { name: /import ids/i }).click();
  await dialog.locator("textarea").fill(fixture.identifier);
  await dialog.getByRole("button", { name: /^import 1 paper/i }).click();
  await expect(dialog.getByText("Import Results Summary")).toBeVisible({ timeout: 60_000 });
  await expect(dialog.getByText("Added (1)")).toBeVisible();
  return dialog;
}

async function closeImportDialog(dialog: Locator) {
  await dialog.getByRole("button", { name: "Close", exact: true }).first().click();
  await expect(dialog).toBeHidden({ timeout: 10_000 });
}

/** Delete one paper through its own row control and the confirmation dialog. */
async function deleteFromRow(page: Page, title: string) {
  await page.getByRole("button", { name: `Delete ${title}`, exact: true }).click();
  const confirm = page.getByRole("alertdialog").filter({ hasText: /cannot be undone/i });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: /^delete$/i }).click();
  await expect(confirm).toBeHidden();
  await expect(page.getByRole("checkbox", { name: `Select ${title}`, exact: true })).toHaveCount(0);
}

/** Remove any fixture paper still present. Tolerates finding none. */
async function removeFixturePapers(page: Page) {
  for (const { title } of FIXTURES) {
    if ((await page.getByRole("checkbox", { name: `Select ${title}`, exact: true }).count()) > 0) {
      await deleteFromRow(page, title);
    }
  }
}

async function openSynonyms(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Manage synonyms", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Manage Synonyms" });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function closeSynonyms(dialog: Locator) {
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).toBeHidden();
}

/**
 * Delete every synonym group this spec owns, as the signed-in user, through the
 * Data API rather than the modal. Closing the modal after a deletion would run
 * another full-library re-evaluation; this runs none.
 */
async function deleteOwnedSynonymGroups(page: Page) {
  await page.evaluate(
    async ([modPath, prefix]) => {
      const mod = await import(modPath);
      const client = (mod as {
        supabase: { from: (t: string) => { delete: () => { like: (c: string, v: string) => Promise<{ error: unknown }> } } };
      }).supabase;
      const { error } = await client.from("synonym_pool").delete().like("canonical_term", `${prefix}%`);
      if (error) throw new Error(`synonym clean-up failed: ${JSON.stringify(error)}`);
    },
    [CLIENT_MODULE_PATH, SYNONYM_PREFIX] as const,
  );
}

test.describe("Notification lifecycle", () => {
  test.setTimeout(150_000);

  test("mounts exactly one notification region", async ({ page }) => {
    await openDashboard(page);
    await expect(notificationRegion(page)).toHaveCount(1);
  });

  test("Bulk import complete and Paper deleted close on their own, including right after a manual close", async ({
    page,
  }) => {
    await routeMetadataStandIn(page);
    await openDashboard(page);
    await removeFixturePapers(page);

    try {
      // ── A notification pressed over an open dialog closes; the dialog stays ──
      const firstDialog = await importOne(page, FIRST);
      const firstImport = notification(page, "Bulk import complete");
      await expect(firstImport).toBeVisible();
      await closeByHand(firstImport);
      await expect(firstDialog).toBeVisible();
      await closeImportDialog(firstDialog);

      // ── Bulk import complete: closes by itself ────────────────────────────────
      const secondDialog = await importOne(page, SECOND);
      const secondImport = notification(page, "Bulk import complete");
      await expect(secondImport).toBeVisible();
      const importShownAt = Date.now();
      await closeImportDialog(secondDialog);
      await expectClosesOnItsOwn(page, secondImport, importShownAt, TOAST_DURATION_MS.default);

      // ── Paper deleted: closed by hand in ordinary use, outside any dialog ─────
      await deleteFromRow(page, FIRST.title);
      const firstDeleted = notification(page, "Paper deleted");
      await expect(firstDeleted).toBeVisible();
      await closeByHand(firstDeleted);

      // ── …and the NEXT notification still closes by itself ────────────────────
      // This is the owner-reported defect: before the fix it stayed until clicked.
      await deleteFromRow(page, SECOND.title);
      const secondDeleted = notification(page, "Paper deleted");
      await expect(secondDeleted).toBeVisible();
      const deletedShownAt = Date.now();
      await expectClosesOnItsOwn(page, secondDeleted, deletedShownAt, TOAST_DURATION_MS.default);
    } finally {
      await removeFixturePapers(page);
    }
  });

  test("Keywords updated after a synonym change comes from the same toaster and closes on its own", async ({
    page,
  }) => {
    const keywordWrites: number[] = [];
    await page.route(
      (url) => url.pathname === KEYWORD_WRITE_PATH,
      async (route) => {
        if (route.request().method() === "OPTIONS") {
          await route.fulfill({ status: 204, headers: STAND_IN_CORS_HEADERS, body: "" });
          return;
        }
        const body = route.request().postDataJSON() as { updates?: unknown[] } | null;
        keywordWrites.push(Array.isArray(body?.updates) ? body.updates.length : 0);
        // Never forwarded: the seeded papers' keywords are left exactly as seeded.
        await route.fulfill({ status: 204, headers: STAND_IN_CORS_HEADERS, body: "" });
      },
    );

    await openDashboard(page);
    // Residue from a previous debug run. The new group's canonical term is
    // unique per run, so a stale copy in the app's cache changes nothing.
    await deleteOwnedSynonymGroups(page);

    const dialog = await openSynonyms(page);
    const canonical = `${SYNONYM_PREFIX} ${Date.now()}`;
    await dialog.getByRole("button", { name: "Add Synonym Group" }).click();
    const editor = page.getByRole("dialog", { name: "Add Synonym Group" });
    await editor.getByLabel("Display Name (Canonical Term)").fill(canonical);
    await editor.getByLabel(/^Synonyms/).fill(SEEDED_ABSTRACT_SYNONYM);
    await editor.getByRole("button", { name: "Add", exact: true }).click();
    await expect(notification(page, `Synonym group "${canonical}" added`)).toBeVisible();

    try {
      // Closing the pool modal runs the full-library re-evaluation.
      const writesBefore = keywordWrites.length;
      await closeSynonyms(dialog);
      const updated = notification(page, "Keywords updated");
      await expect(updated).toBeVisible({ timeout: 30_000 });
      const shownAt = Date.now();
      await expect(updated).toContainText(/Updated keywords for \d+ paper\(s\)\./);
      expect(keywordWrites.length).toBeGreaterThan(writesBefore);
      await expectClosesOnItsOwn(page, updated, shownAt, TOAST_DURATION_MS.default);
    } finally {
      await deleteOwnedSynonymGroups(page);
    }
  });
});
