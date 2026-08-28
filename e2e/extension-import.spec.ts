import { test, expect, type Page, type Route } from "@playwright/test";
import { getPaperCount, waitForDashboard, createProject, createTag, deleteProject, deleteTag } from "./helpers";

/**
 * CHROME-EXTENSION-IMPORT-001C1 — the `/extension-import` handoff route.
 *
 * Deterministic ONLY at the metadata HTTP boundary. `page.route` fulfils exactly
 * one endpoint — `/functions/v1/fetch-paper-metadata` — so the browser never
 * needs the local Edge handler and never needs PubMed or Crossref. Everything on
 * either side of that one response is the real product: the real route, the real
 * session, the real `PoolsProvider` and normalization config, the real
 * `bulkImportPapers`, the real `safe_bulk_insert_papers` and the real
 * `bulk_set_paper_projects` / `bulk_set_paper_tags` against the ephemeral local
 * database. Nothing is stubbed in JavaScript.
 *
 * The properties under test are the ones a review cannot establish by reading:
 *
 *   • opening the route never imports — navigation is intent, not instruction;
 *   • an invalid handoff never reaches the importer at all;
 *   • the import intent survives a real sign-in, and the `returnTo` that carries
 *     it cannot become an open redirect;
 *   • a confirmed import goes through the canonical importer and its Project and
 *     Tag selection really lands on the new row — both asserted independently
 *     against persisted state;
 *   • a duplicate is reported as such and the selection is really NOT applied to
 *     the paper already in the library — asserted against the row, not the copy;
 *   • two rapid clicks cannot start two imports;
 *   • an assignment RPC that fails after a successful insert never produces copy
 *     claiming the assignment succeeded (CORRECTION-01, finding 1);
 *   • a normalization-pool read that fails blocks the import entirely rather
 *     than importing against the empty array it left behind, and a pool that is
 *     genuinely empty still imports (CORRECTION-01, finding 2).
 *
 * Every paper and junction row this spec creates is removed again, and the
 * sweeps tolerate finding nothing so they double as pre-flight cleanup after an
 * `E2E_KEEP_LOCAL_STACK=1` debug run.
 */

test.describe.configure({ mode: "serial" });

/** The one endpoint this spec intercepts — the client/Edge metadata boundary. */
const METADATA_FUNCTION_PATH = "/functions/v1/fetch-paper-metadata";

/** Mirrors what the real function returns; local scaffolding, not a policy copy. */
const STAND_IN_CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/** Provider hosts the browser must never reach during this regression. */
const PROVIDER_HOSTS = [
  "eutils.ncbi.nlm.nih.gov",
  "pubmed.ncbi.nlm.nih.gov",
  "api.crossref.org",
  "doi.org",
];

/**
 * Synthetic identifiers. The PMIDs are nine-digit values far above any real
 * PubMed record and the DOIs use the reserved `10.5555` test prefix, so nothing
 * here resolves anywhere. The deterministic seed ships no paper carrying a
 * `pmid` or `doi` at all, so neither per-user unique index can collide with a
 * seeded row.
 */
const PMID = "900000101";
const PMID_TITLE = "C1-E2E-Extension-Import-Alpha";
const DOI = "10.5555/c1-e2e-extension-import-delta";
const DOI_TITLE = "C1-E2E-Extension-Import-Delta";
const RETRY_PMID = "900000102";
const RETRY_TITLE = "C1-E2E-Extension-Import-Echo";
const ASSIGN_FAIL_PMID = "900000103";
const ASSIGN_FAIL_TITLE = "C1-E2E-Extension-Import-Foxtrot";
const CONTEXT_FAIL_PMID = "900000104";
const CONTEXT_FAIL_TITLE = "C1-E2E-Extension-Import-Golf";

const FIXTURE_TITLES = [
  PMID_TITLE,
  DOI_TITLE,
  RETRY_TITLE,
  ASSIGN_FAIL_TITLE,
  // Never imported by a passing run — swept anyway so that a regression which
  // DOES import it is cleaned up rather than leaked into a later spec.
  CONTEXT_FAIL_TITLE,
];

/** Disposable taxonomy. The seed ships none, and the assign section needs some. */
const PROJECT_NAME = "C1-E2E-Ext-Project";
const OTHER_PROJECT_NAME = "C1-E2E-Ext-Other-Project";
const TAG_NAME = "C1-E2E-Ext-Tag";

/** `PaperMetadata` records the stand-in returns, keyed by requested identifier. */
const METADATA_BY_IDENTIFIER: Record<string, Record<string, unknown>> = {
  [PMID]: {
    identifier: PMID,
    title: PMID_TITLE,
    authors: ["Alpha, A"],
    year: 2021,
    journal: "Journal of Deterministic E2E Handoff",
    pmid: PMID,
    doi: null,
    abstract: "Deterministic stand-in abstract for the C1 handoff regression.",
    keywords: ["handoff"],
    mesh_terms: [],
    substances: [],
    study_type: "Randomized Controlled Trial",
    publication_types: ["Randomized Controlled Trial"],
    pubmed_url: `https://pubmed.ncbi.nlm.nih.gov/${PMID}/`,
    journal_url: null,
    source: "pubmed",
  },
  [DOI]: {
    identifier: DOI,
    title: DOI_TITLE,
    authors: ["Delta, D"],
    year: 2022,
    journal: "Journal of Deterministic E2E Handoff",
    pmid: null,
    doi: DOI,
    abstract: null,
    keywords: [],
    mesh_terms: [],
    substances: [],
    study_type: null,
    journal_url: `https://doi.org/${DOI}`,
    source: "crossref",
  },
  [RETRY_PMID]: {
    identifier: RETRY_PMID,
    title: RETRY_TITLE,
    authors: ["Echo, E"],
    year: 2023,
    journal: "Journal of Deterministic E2E Handoff",
    pmid: RETRY_PMID,
    doi: null,
    abstract: null,
    keywords: [],
    mesh_terms: [],
    substances: [],
    study_type: null,
    pubmed_url: `https://pubmed.ncbi.nlm.nih.gov/${RETRY_PMID}/`,
    journal_url: null,
    source: "pubmed",
  },
  [ASSIGN_FAIL_PMID]: {
    identifier: ASSIGN_FAIL_PMID,
    title: ASSIGN_FAIL_TITLE,
    authors: ["Foxtrot, F"],
    year: 2024,
    journal: "Journal of Deterministic E2E Handoff",
    pmid: ASSIGN_FAIL_PMID,
    doi: null,
    abstract: null,
    keywords: [],
    mesh_terms: [],
    substances: [],
    study_type: null,
    pubmed_url: `https://pubmed.ncbi.nlm.nih.gov/${ASSIGN_FAIL_PMID}/`,
    journal_url: null,
    source: "pubmed",
  },
  [CONTEXT_FAIL_PMID]: {
    identifier: CONTEXT_FAIL_PMID,
    title: CONTEXT_FAIL_TITLE,
    authors: ["Golf, G"],
    year: 2025,
    journal: "Journal of Deterministic E2E Handoff",
    pmid: CONTEXT_FAIL_PMID,
    doi: null,
    abstract: null,
    keywords: [],
    mesh_terms: [],
    substances: [],
    study_type: null,
    pubmed_url: `https://pubmed.ncbi.nlm.nih.gov/${CONTEXT_FAIL_PMID}/`,
    journal_url: null,
    source: "pubmed",
  },
};

/** How the stand-in should answer. Mutable so the retry test can flip it. */
type StandInMode = "success" | "error";

interface MetadataStandIn {
  /** One entry per POST the client made. Never stores the bearer token itself. */
  invocations: { identifiers: string[]; authorizationIsBearer: boolean }[];
  /** Requests the browser made to a real provider host. Must stay empty. */
  providerRequests: string[];
  setMode: (mode: StandInMode) => void;
}

/**
 * Install the metadata stand-in on a page.
 *
 * Scoped by exact pathname, so Auth, PostgREST, RPC, Storage, every other Edge
 * Function and Vite are all untouched and run for real.
 */
async function installMetadataStandIn(page: Page): Promise<MetadataStandIn> {
  const invocations: MetadataStandIn["invocations"] = [];
  const providerRequests: string[] = [];
  let mode: StandInMode = "success";

  page.on("request", (request) => {
    let hostname: string;
    try {
      hostname = new URL(request.url()).hostname.toLowerCase();
    } catch {
      return; // non-URL schemes carry no host to check
    }
    if (PROVIDER_HOSTS.some((host) => hostname === host || hostname.endsWith(`.${host}`))) {
      providerRequests.push(request.url());
    }
  });

  await page.route(
    (url) => url.pathname === METADATA_FUNCTION_PATH,
    async (route) => {
      const request = route.request();

      if (request.method() === "OPTIONS") {
        await route.fulfill({ status: 204, headers: STAND_IN_CORS_HEADERS, body: "" });
        return;
      }

      const body = request.postDataJSON() as { identifiers?: unknown } | null;
      const identifiers = Array.isArray(body?.identifiers) ? body.identifiers.map(String) : [];

      // Only the SHAPE of the credential is recorded; the token value is never
      // stored, logged or asserted on.
      const authorization = request.headers()["authorization"] ?? "";
      invocations.push({
        identifiers,
        authorizationIsBearer: /^Bearer \S+$/.test(authorization),
      });

      const results = identifiers.map((identifier) => {
        if (mode === "error") {
          return { identifier, error: "Deterministic C1 stand-in failure" };
        }
        const metadata = METADATA_BY_IDENTIFIER[identifier];
        // An unknown identifier yields an error record rather than a silent
        // success, so a drifted request can never produce a green run.
        return metadata ?? { identifier, error: "No deterministic C1 fixture for this identifier" };
      });

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: STAND_IN_CORS_HEADERS,
        body: JSON.stringify({ results }),
      });
    },
  );

  return {
    invocations,
    providerRequests,
    setMode: (next) => {
      mode = next;
    },
  };
}

/**
 * Fail one PostgREST RPC and count the attempts.
 *
 * The injection point is the HTTP boundary, so everything else in the run stays
 * real: the real importer still fetches metadata, still calls
 * `safe_bulk_insert_papers`, and still inserts the row. Only the one assignment
 * RPC named here answers 500, which is exactly the partial success the canonical
 * importer is designed to tolerate — the paper is inserted and stays in
 * `addedIds` while its taxonomy never lands.
 */
async function failRpc(page: Page, rpcName: string): Promise<{ attempts: number }> {
  const state = { attempts: 0 };
  const suffix = `/rpc/${rpcName}`;

  await page.route(
    (url) => url.pathname.endsWith(suffix),
    async (route) => {
      if (route.request().method() === "OPTIONS") {
        await route.fulfill({ status: 204, headers: STAND_IN_CORS_HEADERS, body: "" });
        return;
      }
      state.attempts++;
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        headers: STAND_IN_CORS_HEADERS,
        body: JSON.stringify({
          code: "XX000",
          message: `Deterministic C1 failure of ${rpcName}`,
          details: null,
          hint: null,
        }),
      });
    },
  );

  return state;
}

/** The PostgREST tables that back the three normalization pools. */
const NORMALIZATION_POOL_TABLES = ["keyword_pool", "study_type_pool", "synonym_pool"];

/**
 * Answer one normalization-pool table with `mode`, and count the reads.
 *
 * Two modes, because the correction has two halves to prove and they differ
 * only in the status code:
 *
 *   "fail"  → 500. React Query exhausts its retries and settles with
 *             `isLoading` false and `data` back at its default `[]` — the exact
 *             state that used to read as a loaded, merely empty, pool.
 *   "empty" → 200 `[]`. A successful read of a pool the user genuinely left
 *             empty, which must remain importable.
 *
 * Returns a handle whose `mode` is mutable, so one test can prove the failure
 * blocks the import and then prove the explicit retry recovers.
 */
async function interceptPoolTable(
  page: Page,
  table: string,
): Promise<{
  setMode: (mode: "fail" | "empty") => void;
  reads: number;
  dispose: () => Promise<void>;
}> {
  const state = { reads: 0, mode: "fail" as "fail" | "empty" };
  const pathname = `/rest/v1/${table}`;

  // Held as named references so the interception can be lifted again: Playwright
  // matches `unroute` by identity, and a freshly written arrow would remove
  // nothing while appearing to succeed.
  const matcher = (url: URL) => url.pathname === pathname;
  const handler = async (route: Route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: STAND_IN_CORS_HEADERS, body: "" });
      return;
    }
    state.reads++;
    if (state.mode === "empty") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: STAND_IN_CORS_HEADERS,
        body: "[]",
      });
      return;
    }
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      headers: STAND_IN_CORS_HEADERS,
      body: JSON.stringify({
        code: "XX000",
        message: `Deterministic C1 failure reading ${table}`,
        details: null,
        hint: null,
      }),
    });
  };

  await page.route(matcher, handler);

  return {
    setMode: (mode) => {
      state.mode = mode;
    },
    get reads() {
      return state.reads;
    },
    dispose: () => page.unroute(matcher, handler),
  };
}

/** Build the handoff path exactly as the future extension will. */
function handoffPath(kind: "pmid" | "doi", value: string): string {
  return `/extension-import?${new URLSearchParams({ kind, value }).toString()}`;
}

/** The handoff page's own controls, addressed by their stable test ids. */
const identifierValue = (page: Page) => page.getByTestId("handoff-identifier");
const importButton = (page: Page) => page.getByTestId("handoff-import");
const retryButton = (page: Page) => page.getByTestId("handoff-retry");
const contextError = (page: Page) => page.getByTestId("handoff-context-error");
const contextRetryButton = (page: Page) => page.getByTestId("handoff-context-retry");

/** Open the handoff route and wait for the confirm control to become usable. */
async function openReadyHandoff(page: Page, kind: "pmid" | "doi", value: string) {
  await page.goto(handoffPath(kind, value), { waitUntil: "networkidle" });
  await expect(page.getByText("Paper detected")).toBeVisible({ timeout: 20_000 });
  // Enabled only once the pools and taxonomy have loaded — the gate that keeps
  // an unnormalized import from being possible.
  await expect(importButton(page)).toBeEnabled({ timeout: 20_000 });
}

/**
 * Delete every fixture paper through the real bulk-delete UI and return how many
 * rows were removed.
 *
 * The selection/confirm sequence is the one `import-order.spec.ts` already
 * proves against this UI. Rows are chosen by the exact accessible name of their
 * own checkbox, so a seeded paper can never be caught up in it, and finding none
 * is tolerated — this doubles as the pre-flight sweep for residue left by an
 * `E2E_KEEP_LOCAL_STACK=1` debug run.
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

/** The rendered row for a fixture paper, located by its exact title text. */
function paperRow(page: Page, title: string) {
  return page.locator("tbody tr").filter({ hasText: title });
}

test.describe("Extension import handoff", () => {
  test.setTimeout(180_000);

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({ storageState: "e2e/.auth/user.json" });
    const page = await context.newPage();
    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);

    await removeFixturePapers(page);

    // The assign-on-import section renders nothing when the user owns no
    // taxonomy, and the seed ships none.
    await createProject(page, PROJECT_NAME);
    await createProject(page, OTHER_PROJECT_NAME);
    await createTag(page, TAG_NAME);

    await context.close();
  });

  test.afterAll(async ({ browser }) => {
    const context = await browser.newContext({ storageState: "e2e/.auth/user.json" });
    const page = await context.newPage();
    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);

    // Papers first: deleting them cascades their junction rows away, so the
    // taxonomy deletes below cannot be affected by ordering.
    await removeFixturePapers(page);
    await deleteProject(page, PROJECT_NAME);
    await deleteProject(page, OTHER_PROJECT_NAME);
    await deleteTag(page, TAG_NAME);

    await context.close();
  });

  test("renders a PMID handoff and imports nothing merely by opening it", async ({ page }) => {
    const standIn = await installMetadataStandIn(page);

    await openReadyHandoff(page, "pmid", PMID);

    await expect(page.getByText("PubMed", { exact: true })).toBeVisible();
    await expect(identifierValue(page)).toHaveText(PMID);

    // The load-bearing assertion: navigation is intent, not instruction.
    expect(standIn.invocations).toHaveLength(0);
    expect(standIn.providerRequests).toEqual([]);
    await expect(page.getByText(/Nothing is added until you choose Import/i)).toBeVisible();
  });

  test("renders a DOI handoff with the DOI name intact", async ({ page }) => {
    const standIn = await installMetadataStandIn(page);

    await openReadyHandoff(page, "doi", DOI);

    await expect(page.getByText("DOI", { exact: true }).first()).toBeVisible();
    await expect(identifierValue(page)).toHaveText(DOI);
    expect(standIn.invocations).toHaveLength(0);
  });

  test("refuses an invalid handoff and never reaches the importer", async ({ page }) => {
    const standIn = await installMetadataStandIn(page);

    const invalidHandoffs = [
      "/extension-import",
      "/extension-import?kind=pmid",
      "/extension-import?kind=pmid&value=not-a-pmid",
      "/extension-import?kind=title&value=Effects+of+vitamin+D",
      `/extension-import?kind=doi&value=${encodeURIComponent("https://doi.org/10.1000/example")}`,
      "/extension-import?kind=pmid&value=1&value=2",
    ];

    for (const path of invalidHandoffs) {
      await page.goto(path, { waitUntil: "networkidle" });
      await expect(page.getByText("Import link not recognised")).toBeVisible({ timeout: 15_000 });
      // No confirm control exists at all in this state — there is nothing to
      // press, rather than something pressed that does nothing.
      await expect(importButton(page)).toHaveCount(0);
    }

    expect(standIn.invocations).toHaveLength(0);
  });

  test("preserves the import intent through a real sign-in", async ({ browser }) => {
    const email = process.env.TEST_USER_EMAIL;
    const password = process.env.TEST_USER_PASSWORD;
    if (!email || !password) {
      throw new Error("Missing TEST_USER_EMAIL or TEST_USER_PASSWORD. Run `npm run test:e2e:local`.");
    }

    const context = await browser.newContext({ storageState: undefined });
    const page = await context.newPage();
    const standIn = await installMetadataStandIn(page);

    try {
      await page.goto(handoffPath("pmid", PMID), { waitUntil: "networkidle" });

      // Bounced to sign-in, carrying the intent — and carrying only the intent.
      await expect(page).toHaveURL(/\/auth\?returnTo=/, { timeout: 15_000 });
      const returnTo = new URL(page.url()).searchParams.get("returnTo");
      expect(returnTo).toBe(handoffPath("pmid", PMID));

      await expect(page.getByText("Manage your scientific paper collections")).toBeVisible({
        timeout: 10_000,
      });
      await page.getByPlaceholder("you@example.com").fill(email);
      await page.getByPlaceholder("••••••••").fill(password);
      await page.getByRole("button", { name: /^sign in$/i }).click();

      // Back on the exact handoff, with the identifier intact.
      await expect(page).toHaveURL(/\/extension-import\?/, { timeout: 20_000 });
      await expect(identifierValue(page)).toHaveText(PMID, { timeout: 20_000 });

      // Signing in must not have imported anything either.
      expect(standIn.invocations).toHaveLength(0);
    } finally {
      await context.close();
    }
  });

  test("rejects an open-redirect returnTo and falls back safely", async ({ browser }) => {
    const email = process.env.TEST_USER_EMAIL;
    const password = process.env.TEST_USER_PASSWORD;
    if (!email || !password) {
      throw new Error("Missing TEST_USER_EMAIL or TEST_USER_PASSWORD. Run `npm run test:e2e:local`.");
    }

    const context = await browser.newContext({ storageState: undefined });
    const page = await context.newPage();

    try {
      await page.goto(`/auth?returnTo=${encodeURIComponent("https://evil.example/")}`, {
        waitUntil: "networkidle",
      });
      await page.getByPlaceholder("you@example.com").fill(email);
      await page.getByPlaceholder("••••••••").fill(password);
      await page.getByRole("button", { name: /^sign in$/i }).click();

      // Lands on the application's own default destination, never off-origin.
      await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 });
      expect(new URL(page.url()).hostname).not.toBe("evil.example");
    } finally {
      await context.close();
    }
  });

  test("imports on explicit confirmation and assigns the selected project and tag", async ({ page }) => {
    const standIn = await installMetadataStandIn(page);

    await openReadyHandoff(page, "pmid", PMID);

    // Select one existing Project and one existing Tag in the shared selector.
    await page.getByRole("button", { name: /^Projects/ }).click();
    await page.getByRole("option", { name: PROJECT_NAME }).click();
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: /^Tags/ }).click();
    await page.getByRole("option", { name: TAG_NAME }).click();
    await page.keyboard.press("Escape");

    await importButton(page).click();

    await expect(page.getByText("Added to your library")).toBeVisible({ timeout: 60_000 });

    // The page states the insertion, which the progress snapshot proves, and
    // never that the assignment succeeded, which it cannot know — Phase 5 runs
    // after that snapshot and is allowed to fail without disowning the paper.
    await expect(page.getByText(/selection was sent with the import/i)).toBeVisible();
    await expect(page.getByText(/Assigned to/i)).toHaveCount(0);

    // ── The canonical importer really ran, once, authenticated ─────────────
    expect(standIn.invocations).toHaveLength(1);
    expect(standIn.invocations[0].identifiers).toEqual([PMID]);
    expect(standIn.invocations[0].authorizationIsBearer).toBe(true);
    expect(standIn.providerRequests).toEqual([]);

    // ── Both assignments really landed, each asserted independently ────────
    // Proving only the Project would leave a broken Tag path green, and the two
    // are separate RPCs that fail separately.
    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);
    const row = paperRow(page, PMID_TITLE);
    await expect(row).toHaveCount(1, { timeout: 30_000 });
    await expect(row.getByText(PROJECT_NAME)).toBeVisible();
    await expect(row.getByText(TAG_NAME)).toBeVisible();
  });

  test("never claims an assignment succeeded when its RPC failed", async ({ page }) => {
    // CORRECTION-01, finding 1. `addedIds` proves the paper was inserted in
    // Phase 4; it proves nothing about the Phase 5 assignment that runs after
    // the progress snapshot and is permitted to fail non-fatally. Before the
    // correction this exact run rendered "Assigned to 1 project and 1 tag"
    // while the project assignment had failed outright.
    const standIn = await installMetadataStandIn(page);
    const projectRpc = await failRpc(page, "bulk_set_paper_projects");

    await openReadyHandoff(page, "pmid", ASSIGN_FAIL_PMID);

    await page.getByRole("button", { name: /^Projects/ }).click();
    await page.getByRole("option", { name: PROJECT_NAME }).click();
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: /^Tags/ }).click();
    await page.getByRole("option", { name: TAG_NAME }).click();
    await page.keyboard.press("Escape");

    await importButton(page).click();

    // 1. The paper is still recognised as successfully added — a failed
    //    assignment must not be reported as a failed import.
    await expect(page.getByText("Added to your library")).toBeVisible({ timeout: 60_000 });

    // 2. And the page does NOT say the assignment succeeded.
    await expect(page.getByText(/Assigned to/i)).toHaveCount(0);

    // 3. The importer's own warning is still surfaced, not suppressed. `.first()`
    //    because the toast renders its description and an aria-live announcement
    //    of the same text, and both matching is the correct outcome.
    await expect(page.getByText(/project assignment failed/i).first()).toBeVisible({
      timeout: 30_000,
    });

    // 4. One import attempt. 5. One assignment attempt — the page invents no
    //    second call of its own to "fix" or verify the failure.
    expect(standIn.invocations).toHaveLength(1);
    expect(standIn.invocations[0].identifiers).toEqual([ASSIGN_FAIL_PMID]);
    expect(projectRpc.attempts).toBe(1);

    // The reality the old copy misdescribed, asserted against the row: the
    // paper is there, the tag landed, the project did not.
    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);
    const row = paperRow(page, ASSIGN_FAIL_TITLE);
    await expect(row).toHaveCount(1, { timeout: 30_000 });
    await expect(row.getByText(TAG_NAME)).toBeVisible();
    await expect(row.getByText(PROJECT_NAME)).toHaveCount(0);
  });

  test("blocks the import when a normalization pool read fails, and recovers on retry", async ({
    page,
  }) => {
    // CORRECTION-01, finding 2. A pool query that has exhausted its retries
    // settles at `isLoading === false` with `data` back at its default `[]` —
    // indistinguishable from a pool the user genuinely left empty. Readiness
    // used to be `!loading`, so this state enabled the confirm button and let
    // the canonical importer run with an incomplete configuration, which it
    // treats as "skip normalization" rather than as an error.
    const standIn = await installMetadataStandIn(page);
    const keywordPool = await interceptPoolTable(page, "keyword_pool");
    keywordPool.setMode("fail");

    await page.goto(handoffPath("pmid", CONTEXT_FAIL_PMID), { waitUntil: "networkidle" });
    await expect(page.getByText("Paper detected")).toBeVisible({ timeout: 20_000 });

    // 1. The route reaches an explicit error state rather than a ready one.
    await expect(contextError(page)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/couldn.t load your import settings/i)).toBeVisible();

    // 2. The Import control is not usable — it does not exist at all, so there
    //    is nothing to press rather than something pressed that does nothing.
    await expect(importButton(page)).toHaveCount(0);
    await expect(retryButton(page)).toHaveCount(0);

    // 3. No metadata call, and 4. therefore nothing inserted. The read really
    //    was attempted — this is a failure, not a query that never ran.
    expect(keywordPool.reads).toBeGreaterThan(0);
    expect(standIn.invocations).toHaveLength(0);
    expect(standIn.providerRequests).toEqual([]);

    // 5. The empty array the failed query left behind was never treated as a
    //    successfully loaded empty pool: flipping the SAME endpoint to a 200
    //    with the SAME empty body — the only difference being that it
    //    succeeded — makes the route importable again.
    keywordPool.setMode("empty");
    await contextRetryButton(page).click();

    await expect(importButton(page)).toBeEnabled({ timeout: 30_000 });
    await expect(contextError(page)).toHaveCount(0);

    // Recovery is a re-read, not an import: still nothing fetched or written.
    expect(standIn.invocations).toHaveLength(0);

    // And the fixture never entered the library.
    await keywordPool.dispose();
    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);
    await expect(paperRow(page, CONTEXT_FAIL_TITLE)).toHaveCount(0);
  });

  test("still imports when every normalization pool loads and is genuinely empty", async ({
    page,
  }) => {
    // The guardrail against over-correcting finding 2. A user who has added no
    // keywords, study types or synonyms has a valid — if minimal —
    // configuration, and must keep being able to import. All three pools answer
    // 200 with an empty body, so the arrays are identical to the failure case
    // above and only the outcome of the read differs.
    const standIn = await installMetadataStandIn(page);
    for (const table of NORMALIZATION_POOL_TABLES) {
      const pool = await interceptPoolTable(page, table);
      pool.setMode("empty");
    }

    await openReadyHandoff(page, "pmid", CONTEXT_FAIL_PMID);

    await expect(contextError(page)).toHaveCount(0);
    await expect(importButton(page)).toBeEnabled();

    // Ready, and still inert until asked.
    expect(standIn.invocations).toHaveLength(0);
  });

  test("reports a duplicate and does not assign the selection to the existing paper", async ({ page }) => {
    const standIn = await installMetadataStandIn(page);

    await openReadyHandoff(page, "pmid", PMID);

    // A DIFFERENT project this time, so the assertion below distinguishes
    // "assignment was skipped" from "assignment happened to be the same".
    await page.getByRole("button", { name: /^Projects/ }).click();
    await page.getByRole("option", { name: OTHER_PROJECT_NAME }).click();
    await page.keyboard.press("Escape");

    await importButton(page).click();

    await expect(page.getByText("This paper is already in your library")).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByText(/not applied/i)).toBeVisible();

    // The importer ran and answered duplicate — it was not short-circuited.
    expect(standIn.invocations).toHaveLength(1);

    // The existing paper keeps its original project and gains nothing.
    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);
    const row = paperRow(page, PMID_TITLE);
    await expect(row).toHaveCount(1, { timeout: 30_000 });
    await expect(row.getByText(PROJECT_NAME)).toBeVisible();
    await expect(row.getByText(OTHER_PROJECT_NAME)).toHaveCount(0);
  });

  test("a double click cannot start two imports", async ({ page }) => {
    const standIn = await installMetadataStandIn(page);

    await openReadyHandoff(page, "doi", DOI);

    // Two clicks in the SAME TICK, before React can re-render the button as
    // disabled — the exact race the in-flight ref exists for, and the one a
    // disabled attribute alone cannot win. Dispatched in the page rather than
    // through two Playwright clicks: the second `click()` would wait for
    // actionability on a button that is already disabled and time out, testing
    // Playwright's patience instead of the latch.
    await page.evaluate(() => {
      const button = document.querySelector<HTMLButtonElement>(
        '[data-testid="handoff-import"]',
      );
      button?.click();
      button?.click();
    });

    await expect(page.getByText("Added to your library")).toBeVisible({ timeout: 60_000 });

    // One metadata call means one import attempt, not two racing ones.
    expect(standIn.invocations).toHaveLength(1);
    expect(standIn.invocations[0].identifiers).toEqual([DOI]);

    // And exactly one row exists.
    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);
    await expect(paperRow(page, DOI_TITLE)).toHaveCount(1, { timeout: 30_000 });
  });

  test("a failed import reports the failure and can be retried explicitly", async ({ page }) => {
    const standIn = await installMetadataStandIn(page);
    standIn.setMode("error");

    await openReadyHandoff(page, "pmid", RETRY_PMID);
    await importButton(page).click();

    await expect(page.getByText("This paper could not be imported")).toBeVisible({
      timeout: 60_000,
    });
    expect(standIn.invocations).toHaveLength(1);

    // Nothing retries on its own — the second attempt happens only because the
    // user asks for it.
    await page.waitForTimeout(1_500);
    expect(standIn.invocations).toHaveLength(1);

    standIn.setMode("success");
    await retryButton(page).click();

    await expect(page.getByText("Added to your library")).toBeVisible({ timeout: 60_000 });
    expect(standIn.invocations).toHaveLength(2);
  });

  test("a hard refresh returns to ready and replays nothing", async ({ page }) => {
    const standIn = await installMetadataStandIn(page);

    // A direct hard navigation to a deep route — the SPA-fallback path Vercel
    // serves in production and Vite serves here.
    await openReadyHandoff(page, "pmid", PMID);
    await expect(identifierValue(page)).toHaveText(PMID);

    await page.reload({ waitUntil: "networkidle" });
    await expect(page.getByText("Paper detected")).toBeVisible({ timeout: 20_000 });
    await expect(identifierValue(page)).toHaveText(PMID);
    await expect(importButton(page)).toBeEnabled({ timeout: 20_000 });

    // A reload is not a replayed mutation.
    expect(standIn.invocations).toHaveLength(0);
  });

  test("the library is left exactly as this spec found it", async ({ page }) => {
    // A terminal accounting test rather than a silent afterAll: if cleanup
    // regresses, this names it instead of leaking rows into a later spec.
    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);

    const before = await getPaperCount(page);
    expect(before).toBeGreaterThan(0);

    const removed = await removeFixturePapers(page);
    expect(removed).toBeGreaterThan(0);

    await expect.poll(() => getPaperCount(page), { timeout: 30_000 }).toBe(before - removed);
    for (const title of FIXTURE_TITLES) {
      await expect(paperRow(page, title)).toHaveCount(0);
    }
  });
});
