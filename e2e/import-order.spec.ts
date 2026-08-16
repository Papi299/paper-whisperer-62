import { test, expect, type Page } from "@playwright/test";
import { getPaperCount, waitForDashboard } from "./helpers";

/**
 * D4 — External-metadata import-order regression (deterministic stand-in).
 *
 * Proves the whole PaperLume ordering contract from the authenticated
 * `fetch-paper-metadata` client/Edge boundary onward:
 *
 *   Add Papers UI → Import IDs → metadata response → bulk normalization →
 *   real `safe_bulk_insert_papers` → real `papers.insert_order` → real refetch →
 *   real paper table → refresh persistence.
 *
 * Deterministic ONLY at the HTTP boundary. `page.route` fulfils exactly one
 * endpoint — `/functions/v1/fetch-paper-metadata` — so the browser never needs
 * the local Edge handler and never needs PubMed/Crossref. Everything on either
 * side of that single response is the real product: the real Add Papers dialog,
 * the real session and Authorization header, the real
 * `supabase.functions.invoke` call, the real normalization worker, the real RPC
 * against the ephemeral local database, the real query/refetch and the real
 * table. Nothing is stubbed in JavaScript.
 *
 * Ordering contract under test (insertion order is the default view order,
 * newest first — see `buildPapersQuery`, which falls back to
 * `insert_order DESC` whenever the user has selected no explicit sort):
 *
 *   user input      A → B → C
 *   metadata reply  A → B → C   (the Edge contract: one result per identifier,
 *                                in the order it processed them)
 *   persisted       A → B → C   (monotonically increasing `insert_order`)
 *   default view    C → B → A
 *
 * The predecessor of this spec imported three real PMIDs and asserted exact
 * PubMed article titles, so it could only pass with live provider egress and
 * was therefore excluded from the local lane. No live-provider response is a
 * contract here: every asserted title belongs to a synthetic fixture this file
 * defines, and no fixture depends on a real publication existing.
 */

/** The one endpoint this spec intercepts — the client/Edge metadata boundary. */
const METADATA_FUNCTION_PATH = "/functions/v1/fetch-paper-metadata";

/**
 * CORS headers for the stand-in response. The app (loopback Vite) and the local
 * Supabase API are different origins, so a fulfilled cross-origin response still
 * has to satisfy the browser's CORS check. Mirrors what the real function
 * returns; it is local test scaffolding, not a copy of a production policy.
 */
const STAND_IN_CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/**
 * Metadata-provider hosts the browser must never reach during this regression.
 * This observes the browser's own traffic only — it is a supporting control,
 * not a claim about server-side egress. The architectural proof is that the
 * metadata request is fulfilled before the local Edge handler ever runs.
 */
const PROVIDER_HOSTS = [
  "eutils.ncbi.nlm.nih.gov",
  "pubmed.ncbi.nlm.nih.gov",
  "api.crossref.org",
  "doi.org",
];

/** One deterministic identifier and the `PaperMetadata` record it resolves to. */
interface StandInFixture {
  /** Exactly what the user types into the Add Papers textarea. */
  identifier: string;
  /** Deterministic title, asserted verbatim in the table. */
  title: string;
  /** The success record the stand-in returns, in the real `PaperMetadata` shape. */
  metadata: Record<string, unknown>;
}

/**
 * Synthetic, local-only fixtures. The PMIDs are nine-digit values far above any
 * real PubMed record and the DOI uses the reserved `10.5555` test prefix, so
 * nothing here resolves anywhere. The deterministic seed ships no paper with a
 * `pmid` or `doi` at all, so neither the per-user unique indexes nor any seeded
 * title can collide with these rows.
 */
const ALPHA: StandInFixture = {
  identifier: "900000001",
  title: "D4-E2E-External-Metadata-Alpha",
  metadata: {
    identifier: "900000001",
    title: "D4-E2E-External-Metadata-Alpha",
    authors: ["Alpha, A", "Alpha, B"],
    year: 2021,
    journal: "Journal of Deterministic E2E Metadata",
    pmid: "900000001",
    doi: null,
    abstract:
      "Deterministic stand-in abstract for the D4 external-metadata import-order regression.",
    keywords: ["import order"],
    mesh_terms: ["Reproducibility of Results"],
    substances: [],
    study_type: "Randomized Controlled Trial",
    publication_types: ["Randomized Controlled Trial"],
    pubmed_url: "https://pubmed.ncbi.nlm.nih.gov/900000001/",
    journal_url: null,
    source: "pubmed",
  },
};

/**
 * Crossref-shaped: a DOI-only record with no structured publication types. The
 * key is deliberately absent rather than null — absence is exactly what a
 * Crossref-only result carries, and `raw_publication_types` must then persist
 * as NULL.
 */
const BRAVO: StandInFixture = {
  identifier: "10.5555/d4-e2e-external-metadata-bravo",
  title: "D4-E2E-External-Metadata-Bravo",
  metadata: {
    identifier: "10.5555/d4-e2e-external-metadata-bravo",
    title: "D4-E2E-External-Metadata-Bravo",
    authors: ["Bravo, C"],
    year: 2022,
    journal: "Journal of Deterministic E2E Metadata",
    pmid: null,
    doi: "10.5555/d4-e2e-external-metadata-bravo",
    abstract: null,
    keywords: [],
    mesh_terms: [],
    substances: [],
    study_type: null,
    journal_url: "https://doi.org/10.5555/d4-e2e-external-metadata-bravo",
    source: "crossref",
  },
};

const CHARLIE: StandInFixture = {
  identifier: "900000003",
  title: "D4-E2E-External-Metadata-Charlie",
  metadata: {
    identifier: "900000003",
    title: "D4-E2E-External-Metadata-Charlie",
    authors: ["Charlie, D"],
    year: 2023,
    journal: "Journal of Deterministic E2E Metadata",
    pmid: "900000003",
    doi: null,
    abstract:
      "Deterministic stand-in abstract for the last identifier in the D4 input batch.",
    keywords: ["insert order"],
    mesh_terms: [],
    substances: [],
    study_type: "Cohort Study",
    publication_types: ["Cohort Study"],
    pubmed_url: "https://pubmed.ncbi.nlm.nih.gov/900000003/",
    journal_url: null,
    source: "pubmed",
  },
};

/** Input order: A → B → C. */
const FIXTURES = [ALPHA, BRAVO, CHARLIE];
const INPUT_IDENTIFIERS = FIXTURES.map((f) => f.identifier);
const FIXTURE_TITLES = FIXTURES.map((f) => f.title);

/** Default view order: reverse input — the last identifier imported is newest. */
const EXPECTED_TABLE_ORDER = [CHARLIE.title, BRAVO.title, ALPHA.title];

const FIXTURES_BY_IDENTIFIER = new Map(FIXTURES.map((f) => [f.identifier, f]));

/**
 * Readable detail for a thrown value. Used only to build the message of the
 * double-failure `AggregateError` below — the thrown values themselves are
 * still carried intact on `.errors`, never replaced by their text.
 */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  return String(error);
}

/** What the route handler observed. The bearer token itself is never stored. */
interface MetadataInvocation {
  method: string;
  identifiers: string[];
  authorizationIsBearer: boolean;
}

/**
 * Read the titles of the top `count` rows in table order. Each rendered row is
 * its own `tbody[data-index]` (the table is virtualized), so the index is the
 * row's true position in the sorted result — never a spacer or an off-screen
 * gap.
 */
async function readTopTitles(page: Page, count: number): Promise<string[]> {
  const titles: string[] = [];
  for (let index = 0; index < count; index++) {
    const titleCell = page.locator(`tbody[data-index="${index}"] td p`).first();
    titles.push((await titleCell.count()) > 0 ? ((await titleCell.textContent()) ?? "").trim() : "");
  }
  return titles;
}

/**
 * Prove the table is presenting the DEFAULT insertion order before any ordering
 * assertion, so the regression can never pass against some other sort. The sort
 * selection lives in component state (`useFilterState`) and is not persisted, so
 * a fresh load always starts here; this asserts that rather than assuming it.
 * An active sort would advertise itself on the column header via `aria-sort`.
 */
async function expectDefaultInsertionSort(page: Page) {
  await expect(
    page.locator('thead th[aria-sort="ascending"], thead th[aria-sort="descending"]'),
  ).toHaveCount(0);
}

/** Load the dashboard and wait for the real paper count to render. */
async function openDashboard(page: Page) {
  await page.goto("/", { waitUntil: "networkidle" });
  await waitForDashboard(page);
}

/**
 * Delete every D4 fixture paper through the real bulk-delete UI and return how
 * many rows were removed. Tolerates finding none, so it doubles as the
 * pre-flight sweep for residue left by an `E2E_KEEP_LOCAL_STACK=1` debug run.
 * Seed papers are never selected: rows are chosen by the exact accessible name
 * of their own checkbox.
 */
async function removeFixturePapers(page: Page): Promise<number> {
  let selected = 0;
  for (const title of FIXTURE_TITLES) {
    const checkbox = page.getByRole("checkbox", { name: `Select ${title}`, exact: true });
    if ((await checkbox.count()) === 0) continue;
    await checkbox.first().click();
    selected++;
  }
  if (selected === 0) return 0;

  const selectionSummary = page.getByText(/\d+\s+selected/i);
  await expect(selectionSummary).toBeVisible();
  await selectionSummary
    .locator("xpath=ancestor::div[1]")
    .getByRole("button", { name: /delete/i })
    .click();

  const confirmDialog = page.getByRole("dialog").filter({ hasText: /cannot be undone/i });
  await expect(confirmDialog).toBeVisible();
  await confirmDialog.getByRole("button", { name: /^delete$/i }).click();
  await expect(confirmDialog).toBeHidden();

  // Removal is proven by the rows being gone, not by waiting a fixed interval.
  for (const title of FIXTURE_TITLES) {
    await expect(
      page.getByRole("checkbox", { name: `Select ${title}`, exact: true }),
    ).toHaveCount(0);
  }
  return selected;
}

/** Run one real import of the three fixtures and assert the product's own summary. */
async function importFixtures(page: Page) {
  await page.getByRole("button", { name: /add papers/i }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  await dialog.getByRole("tab", { name: /import ids/i }).click();
  const textarea = dialog.locator("textarea");
  await expect(textarea).toBeVisible();
  await textarea.fill(INPUT_IDENTIFIERS.join("\n"));
  await expect(dialog.getByText("3 identifiers detected")).toBeVisible();

  await dialog.getByRole("button", { name: "Import 3 Papers", exact: true }).click();

  // Completion is the product's own result summary — never a sleep, and never
  // merely "a toast appeared".
  await expect(dialog.getByText("Import Results Summary")).toBeVisible({ timeout: 60_000 });
  await expect(dialog.getByText("Added (3)")).toBeVisible();
  await expect(dialog.getByText(/Skipped/)).toHaveCount(0);
  await expect(dialog.getByText(/Failed \(/)).toHaveCount(0);
  await expect(page.getByText("Bulk import complete", { exact: true })).toBeVisible();
  await expect(
    page.getByText("3 added, 0 skipped (duplicates), 0 failed.", { exact: true }),
  ).toBeVisible();

  // Close through the dialog's own completion action. (Two controls carry the
  // accessible name "Close" once the summary is shown — the footer button and
  // the header's icon button — and either one runs the same close path.)
  await dialog.getByRole("button", { name: "Close", exact: true }).first().click();
  await expect(dialog).toBeHidden({ timeout: 10_000 });
}

test.describe("External-metadata import order (deterministic stand-in)", () => {
  test.setTimeout(180_000);

  test("imports in input order and shows exact reverse order, stable across refreshes", async ({
    page,
  }) => {
    const invocations: MetadataInvocation[] = [];
    const providerRequests: string[] = [];

    page.on("request", (request) => {
      let hostname: string;
      try {
        hostname = new URL(request.url()).hostname.toLowerCase();
      } catch {
        return; // non-URL schemes (data:, blob:) carry no host to check
      }
      if (PROVIDER_HOSTS.some((host) => hostname === host || hostname.endsWith(`.${host}`))) {
        providerRequests.push(request.url());
      }
    });

    // The ONLY interception in this spec. Scoped by exact pathname so Auth,
    // PostgREST, RPC, Storage, other Edge Functions and Vite are all untouched.
    await page.route(
      (url) => url.pathname === METADATA_FUNCTION_PATH,
      async (route) => {
        const request = route.request();

        // Handle only this function's preflight, and never record it as a
        // metadata invocation. (Chromium satisfies the preflight through the
        // interception itself, so this is a defensive branch.)
        if (request.method() === "OPTIONS") {
          await route.fulfill({ status: 204, headers: STAND_IN_CORS_HEADERS, body: "" });
          return;
        }

        const body = request.postDataJSON() as { identifiers?: unknown } | null;
        const identifiers = Array.isArray(body?.identifiers) ? body.identifiers.map(String) : [];

        // Only the SHAPE of the credential is recorded. The token value is never
        // stored, logged, asserted on, or written anywhere.
        const authorization = request.headers()["authorization"] ?? "";
        invocations.push({
          method: request.method(),
          identifiers,
          authorizationIsBearer: /^Bearer \S+$/.test(authorization),
        });

        // Results come back in the order they were requested, one per
        // identifier — the contract the real Edge Function implements. An
        // unknown identifier yields an error record rather than a silent
        // success, so a drifted request can never produce a green run.
        const results = identifiers.map((identifier) => {
          const fixture = FIXTURES_BY_IDENTIFIER.get(identifier);
          return fixture
            ? fixture.metadata
            : { identifier, error: "No deterministic D4 fixture for this identifier" };
        });

        await route.fulfill({
          status: 200,
          contentType: "application/json",
          headers: STAND_IN_CORS_HEADERS,
          body: JSON.stringify({ results }),
        });
      },
    );

    await openDashboard(page);

    // Tolerate residue from a previous debug run that kept the local stack.
    await removeFixturePapers(page);

    const initialCount = await getPaperCount(page);
    expect(initialCount).toBeGreaterThan(0);

    let primaryError: unknown = null;
    try {
      await importFixtures(page);

      // ── Metadata boundary ────────────────────────────────────────────────
      // Exactly one POST for a three-item batch (the Edge batch size is 10),
      // carrying an authenticated request whose identifiers are in exact user
      // input order. A zero here would mean the stand-in never ran.
      expect(invocations).toHaveLength(1);
      expect(invocations[0].method).toBe("POST");
      expect(invocations[0].authorizationIsBearer).toBe(true);
      expect(invocations[0].identifiers).toEqual(INPUT_IDENTIFIERS);

      // ── Count ────────────────────────────────────────────────────────────
      await expect.poll(() => getPaperCount(page), { timeout: 30_000 }).toBe(initialCount + 3);

      // ── Default-sort ordering ────────────────────────────────────────────
      await expectDefaultInsertionSort(page);
      await expect
        .poll(() => readTopTitles(page, 3), { timeout: 30_000 })
        .toEqual(EXPECTED_TABLE_ORDER);

      // ── First refresh ────────────────────────────────────────────────────
      await openDashboard(page);
      await expectDefaultInsertionSort(page);
      await expect
        .poll(() => readTopTitles(page, 3), { timeout: 30_000 })
        .toEqual(EXPECTED_TABLE_ORDER);

      // ── Second refresh ───────────────────────────────────────────────────
      await openDashboard(page);
      await expectDefaultInsertionSort(page);
      await expect
        .poll(() => readTopTitles(page, 3), { timeout: 30_000 })
        .toEqual(EXPECTED_TABLE_ORDER);

      // Both refreshes were served from the database: the metadata boundary was
      // never touched again, so the order is persisted, not an optimistic
      // in-memory arrangement.
      expect(invocations).toHaveLength(1);
      expect(providerRequests).toEqual([]);
    } catch (error) {
      primaryError = error;
    }

    // Cleanup always runs — the rest of the shared local lifecycle expects the
    // deterministic seed back, so it must not be skipped just because the
    // regression above failed.
    let cleanupError: unknown = null;
    try {
      await openDashboard(page);
      const removed = await removeFixturePapers(page);
      expect(removed).toBe(3);
      await expect.poll(() => getPaperCount(page), { timeout: 30_000 }).toBe(initialCount);
    } catch (error) {
      cleanupError = error;
    }

    // BOTH failures are preserved when both happen — the same contract
    // `cmdRun` in scripts/e2e-local.mjs uses for a lifecycle failure that is
    // followed by a teardown failure. A cleanup failure must never hide the
    // regression failure, and a regression failure must never hide the fact
    // that D4 fixtures were left behind for every spec that follows.
    // The reporter prints only the thrown error's own message, so both
    // underlying messages are restated there too — otherwise a double failure
    // would name the two failures without saying what either one was.
    if (primaryError && cleanupError) {
      throw new AggregateError(
        [primaryError, cleanupError],
        [
          "D4 import-order regression failed AND fixture cleanup failed:",
          `[1/2] regression: ${describeError(primaryError)}`,
          `[2/2] fixture cleanup: ${describeError(cleanupError)}`,
        ].join("\n\n"),
      );
    }
    if (primaryError) throw primaryError;
    if (cleanupError) throw cleanupError;
  });
});
