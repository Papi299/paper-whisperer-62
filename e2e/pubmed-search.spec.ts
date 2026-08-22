import { test, expect, type Page, type Route } from "@playwright/test";
import { getPaperCount, waitForDashboard, createProject, createTag, deleteProject, deleteTag } from "./helpers";

/**
 * PUBMED-IN-APP-SEARCH-001 — in-app PubMed discovery, end to end.
 *
 * Deterministic ONLY at two HTTP boundaries. `page.route` fulfils exactly two
 * endpoints:
 *
 *   • `/functions/v1/search-pubmed`        — the discovery pages
 *   • `/functions/v1/fetch-paper-metadata` — the canonical import metadata
 *
 * Everything on either side of those two responses is the real product: the
 * real Add Papers dialog, the real four-tab layout, the real result list and
 * its geometry, the real selection state, the real session and Authorization
 * header, the real `supabase.functions.invoke` calls, the real
 * `bulkImportPapers`, the real normalization worker, the real
 * `safe_bulk_insert_papers` against the ephemeral local database, the real
 * duplicate handling, the real Project/Tag assignment and the real refetch.
 * CI therefore never touches NCBI, and no served local Edge Function is needed.
 *
 * ## The architectural regression this file exists to protect
 *
 * `assertCanonicalImport` captures what the **metadata** function receives. If
 * someone ever changes PubMed Search to insert ESummary objects directly —
 * building a second `safe_bulk_insert_papers` payload, or feeding search
 * summaries to `bulkImportFromParsedData` — the metadata boundary stops seeing
 * the selected PMIDs and these tests fail. That is the point of them.
 */

const SEARCH_FUNCTION_PATH = "/functions/v1/search-pubmed";
const METADATA_FUNCTION_PATH = "/functions/v1/fetch-paper-metadata";

/**
 * CORS headers for the stand-in responses. The app (loopback Vite) and the
 * local Supabase API are different origins, so a fulfilled cross-origin
 * response still has to satisfy the browser's CORS check. Local test
 * scaffolding, not a copy of a production policy.
 */
const STAND_IN_CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/** Hosts the browser must never reach during this spec. */
const PROVIDER_HOSTS = ["eutils.ncbi.nlm.nih.gov", "pubmed.ncbi.nlm.nih.gov", "api.crossref.org", "doi.org"];

// ── Deterministic fixtures ───────────────────────────────────────────────

const COMMITTED_QUERY = "resistance training hypertrophy";
const OTHER_QUERY = '("cardiac rehabilitation"[Title/Abstract]) AND outcomes';

/**
 * Nine-digit PMIDs far above any real PubMed record, so nothing here resolves
 * anywhere and nothing can collide with the deterministic seed (which ships no
 * paper carrying a `pmid` at all).
 */
const PMID_BASE = 900200000;
const pmidAt = (index: number) => String(PMID_BASE + index);

/** The title prefix every fixture paper shares — the cleanup handle. */
const TITLE_PREFIX = "PMS-E2E";

/**
 * Result 1 is deliberately hostile to layout: a 240-character title, a long
 * journal name, long author names and several publication-type strings. It is
 * the row the reachability measurements below are taken on.
 */
const LONG_TITLE =
  `${TITLE_PREFIX}-Long-Row Effects of progressive high-load resistance training on regional skeletal ` +
  "muscle hypertrophy, intramuscular anabolic signalling and maximal voluntary isometric contraction " +
  "in previously untrained middle-aged adults: a multicentre randomised controlled trial";

const LONG_JOURNAL =
  "International Journal of Applied Physiology, Exercise Biochemistry and Musculoskeletal Rehabilitation Science";

const LONG_AUTHORS = [
  "Vandenberghe-Papadopoulos MJ",
  "Schrijver-Hollandsworth AB",
  "Ramanathan-Krishnamurthy VS",
  "Oyelaran-Adebayo TO",
  "Wojciechowska-Zielinska KP",
];

interface SearchFixture {
  pmid: string;
  title: string;
  authors: string[];
  journal: string | null;
  publicationDate: string | null;
  year: number | null;
  publicationTypes: string[];
  doi: string | null;
}

function fixture(index: number, overrides: Partial<SearchFixture> = {}): SearchFixture {
  const pmid = pmidAt(index);
  return {
    pmid,
    title: `${TITLE_PREFIX}-Result-${String(index).padStart(2, "0")}`,
    authors: [`Alpha ${index}A`, `Bravo ${index}B`],
    journal: "Journal of Deterministic Discovery",
    publicationDate: "2024 Mar",
    year: 2024,
    publicationTypes: ["Journal Article"],
    doi: null,
    ...overrides,
  };
}

/** Page 1 — a realistic full page of 20 results. */
const PAGE_ONE: SearchFixture[] = [
  fixture(1, {
    title: LONG_TITLE,
    authors: LONG_AUTHORS,
    journal: LONG_JOURNAL,
    publicationTypes: ["Randomized Controlled Trial", "Multicenter Study", "Research Support, Non-U.S. Gov't"],
    // Present on purpose: the import identifier must STILL be the PMID.
    doi: "10.5555/pms-e2e-long-row-record",
  }),
  ...Array.from({ length: 19 }, (_, i) => fixture(i + 2)),
];

/** Page 2 — the tail of the same 25-match query. */
const PAGE_TWO: SearchFixture[] = Array.from({ length: 5 }, (_, i) => fixture(i + 21));

const TOTAL_MATCHES = 25;

/** A different committed query, with its own disjoint result set. */
const OTHER_RESULTS: SearchFixture[] = [
  fixture(81, { title: `${TITLE_PREFIX}-Other-81` }),
  fixture(82, { title: `${TITLE_PREFIX}-Other-82` }),
];

const ALL_FIXTURES = [...PAGE_ONE, ...PAGE_TWO, ...OTHER_RESULTS];
const FIXTURES_BY_PMID = new Map(ALL_FIXTURES.map((f) => [f.pmid, f]));

const PROJECT_NAME = "PMS-E2E Project";
const TAG_NAME = "PMS-E2E Tag";

// ── Recorded boundary traffic ────────────────────────────────────────────

interface SearchInvocation {
  query: string;
  offset: number;
  limit: number;
  authorizationIsBearer: boolean;
  /** Every key the client actually sent. Proves no identity is smuggled along. */
  bodyKeys: string[];
}

interface MetadataInvocation {
  identifiers: string[];
  authorizationIsBearer: boolean;
  /** The whole request body as text, so a leaked summary object is detectable. */
  rawBody: string;
}

interface Recorder {
  searches: SearchInvocation[];
  metadata: MetadataInvocation[];
  providerRequests: string[];
}

/**
 * Install both stand-ins plus the provider-egress watch.
 *
 * `searchBehaviour` lets a test make one page fail without changing any other
 * behaviour; it returns `"fail"` to answer 502 the way the real function would.
 */
async function installStandIns(
  page: Page,
  options: { searchBehaviour?: (invocation: SearchInvocation) => "ok" | "fail" } = {},
): Promise<Recorder> {
  const recorder: Recorder = { searches: [], metadata: [], providerRequests: [] };

  page.on("request", (request) => {
    let hostname: string;
    try {
      hostname = new URL(request.url()).hostname.toLowerCase();
    } catch {
      return; // data:/blob: carry no host to check
    }
    if (PROVIDER_HOSTS.some((host) => hostname === host || hostname.endsWith(`.${host}`))) {
      recorder.providerRequests.push(request.url());
    }
  });

  await page.route(
    (url) => url.pathname === SEARCH_FUNCTION_PATH,
    async (route: Route) => {
      const request = route.request();
      if (request.method() === "OPTIONS") {
        await route.fulfill({ status: 204, headers: STAND_IN_CORS_HEADERS, body: "" });
        return;
      }

      const body = (request.postDataJSON() ?? {}) as Record<string, unknown>;
      const invocation: SearchInvocation = {
        query: String(body.query ?? ""),
        offset: Number(body.offset ?? 0),
        limit: Number(body.limit ?? 0),
        // Only the SHAPE of the credential is recorded — never the token value.
        authorizationIsBearer: /^Bearer \S+$/.test(request.headers()["authorization"] ?? ""),
        bodyKeys: Object.keys(body).sort(),
      };
      recorder.searches.push(invocation);

      if (options.searchBehaviour?.(invocation) === "fail") {
        await route.fulfill({
          status: 502,
          contentType: "application/json",
          headers: STAND_IN_CORS_HEADERS,
          body: JSON.stringify({
            error: "upstream_unavailable",
            message: "PubMed could not be reached right now. Please try again in a moment.",
          }),
        });
        return;
      }

      const { results, total } = pageFor(invocation.query, invocation.offset);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: STAND_IN_CORS_HEADERS,
        body: JSON.stringify({
          query: invocation.query,
          total,
          offset: invocation.offset,
          limit: invocation.limit,
          results,
        }),
      });
    },
  );

  await page.route(
    (url) => url.pathname === METADATA_FUNCTION_PATH,
    async (route: Route) => {
      const request = route.request();
      if (request.method() === "OPTIONS") {
        await route.fulfill({ status: 204, headers: STAND_IN_CORS_HEADERS, body: "" });
        return;
      }

      const raw = request.postData() ?? "";
      const body = (request.postDataJSON() ?? {}) as { identifiers?: unknown };
      const identifiers = Array.isArray(body.identifiers) ? body.identifiers.map(String) : [];
      recorder.metadata.push({
        identifiers,
        authorizationIsBearer: /^Bearer \S+$/.test(request.headers()["authorization"] ?? ""),
        rawBody: raw,
      });

      // One result per identifier, in request order — the contract the real
      // Edge Function implements. An unknown identifier yields an error record
      // rather than a silent success, so a drifted request cannot go green.
      const results = identifiers.map((identifier) => {
        const found = FIXTURES_BY_PMID.get(identifier);
        return found
          ? {
              identifier,
              title: found.title,
              authors: found.authors,
              year: found.year,
              journal: found.journal,
              pmid: found.pmid,
              doi: found.doi,
              abstract: `Deterministic stand-in abstract for ${found.pmid}.`,
              keywords: [],
              mesh_terms: [],
              substances: [],
              study_type: found.publicationTypes.join(", ") || null,
              publication_types: found.publicationTypes,
              pubmed_url: `https://pubmed.ncbi.nlm.nih.gov/${found.pmid}/`,
              journal_url: null,
              source: "pubmed",
            }
          : { identifier, error: "No deterministic PMS-E2E fixture for this identifier" };
      });

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: STAND_IN_CORS_HEADERS,
        body: JSON.stringify({ results }),
      });
    },
  );

  return recorder;
}

function pageFor(query: string, offset: number): { results: SearchFixture[]; total: number } {
  if (query === OTHER_QUERY) {
    return { results: offset === 0 ? OTHER_RESULTS : [], total: OTHER_RESULTS.length };
  }
  if (offset === 0) return { results: PAGE_ONE, total: TOTAL_MATCHES };
  if (offset === 20) return { results: PAGE_TWO, total: TOTAL_MATCHES };
  return { results: [], total: TOTAL_MATCHES };
}

// ── Page interaction helpers ─────────────────────────────────────────────

async function openDashboard(page: Page) {
  await page.goto("/", { waitUntil: "networkidle" });
  await waitForDashboard(page);
}

const dialogOf = (page: Page) => page.getByRole("dialog", { name: "Add Papers" });

async function openPubMedTab(page: Page) {
  await page.getByRole("button", { name: /add papers/i }).click();
  const dialog = dialogOf(page);
  await expect(dialog).toBeVisible();
  await dialog.getByRole("tab", { name: "PubMed Search" }).click();
  await expect(dialog.getByLabel("Search PubMed")).toBeVisible();
  return dialog;
}

async function runSearch(page: Page, query = COMMITTED_QUERY) {
  const dialog = dialogOf(page);
  await dialog.getByLabel("Search PubMed").fill(query);
  await dialog.getByRole("button", { name: "Search" }).click();
  await expect(dialog.getByRole("list", { name: "PubMed search results" })).toBeVisible();
  return dialog;
}

const resultCheckbox = (page: Page, pmid: string) =>
  dialogOf(page).getByRole("checkbox", { name: new RegExp(`^Select PMID ${pmid} — `) });

const importSelectedButton = (page: Page) =>
  dialogOf(page).getByRole("button", { name: /^Import( \d+)? Selected$/ });

/** Close the Add Papers dialog through its own footer control. */
async function closeDialog(page: Page) {
  const dialog = dialogOf(page);
  if (!(await dialog.isVisible().catch(() => false))) return;
  await dialog.getByRole("button", { name: "Close", exact: true }).first().click();
  await expect(dialog).toBeHidden({ timeout: 10_000 });
}

/**
 * Every fixture paper this spec can create, removed through the real bulk-delete
 * UI. Tolerates finding none, so it doubles as the pre-flight sweep for residue
 * left by an `E2E_KEEP_LOCAL_STACK=1` debug run and as the afterEach teardown.
 */
async function removeFixturePapers(page: Page): Promise<number> {
  const rows = page.locator("tbody tr").filter({ hasText: TITLE_PREFIX });
  if ((await rows.count()) === 0) return 0;

  let selected = 0;
  // Re-read each pass: the list re-renders as rows are checked.
  for (let guard = 0; guard < 40; guard++) {
    const unchecked = page
      .locator("tbody tr")
      .filter({ hasText: TITLE_PREFIX })
      .locator('[role="checkbox"][aria-checked="false"]');
    if ((await unchecked.count()) === 0) break;
    await unchecked.first().click();
    selected++;
  }
  if (selected === 0) return 0;

  const selectionSummary = page.getByText(/\d+\s+selected/i);
  await expect(selectionSummary).toBeVisible();
  await selectionSummary.locator("xpath=ancestor::div[1]").getByRole("button", { name: /delete/i }).click();

  const confirmDialog = page.getByRole("dialog").filter({ hasText: /cannot be undone/i });
  await expect(confirmDialog).toBeVisible();
  await confirmDialog.getByRole("button", { name: /^delete$/i }).click();
  await expect(confirmDialog).toBeHidden();

  await expect(page.locator("tbody tr").filter({ hasText: TITLE_PREFIX })).toHaveCount(0, { timeout: 30_000 });
  return selected;
}

/**
 * Geometry of one element relative to a scrolling ancestor, read in the real
 * browser. `toBeVisible()` and `.click()` both pass for controls no human can
 * reach — `.click()` sets `scrollLeft` programmatically even where no scrollbar
 * exists — so reachability is measured, not asserted through Playwright's
 * actionability model (the lesson of PRs #233–#236).
 */
async function measureRow(page: Page, pmid: string) {
  return page.evaluate((targetPmid) => {
    // Scoped to the dialog holding the result list. An unscoped
    // querySelector would find the sidebar's scroller, which is short, static
    // and always contained — it would pass while proving nothing.
    const dialog = [...document.querySelectorAll('[role="dialog"]')].find((element) =>
      element.querySelector('ul[aria-label="PubMed search results"]'),
    );
    if (!dialog) throw new Error("Add Papers dialog with a PubMed result list not found");

    const list = dialog.querySelector('ul[aria-label="PubMed search results"]') as HTMLElement;
    const checkbox = dialog.querySelector(
      `[role="checkbox"][aria-label^="Select PMID ${targetPmid} "]`,
    ) as HTMLElement | null;
    if (!checkbox) throw new Error(`No checkbox for PMID ${targetPmid}`);
    const row = checkbox.closest("li") as HTMLElement;
    const link = row.querySelector("a[href^='https://pubmed.ncbi.nlm.nih.gov/']") as HTMLElement;

    // The two axes are NOT equivalent and must not be asserted together.
    // Vertical position is something a user can change by scrolling, so a
    // control below the fold is reachable. Horizontal position is not: these
    // surfaces mount no horizontal scrollbar, so a control whose centre sits
    // outside the viewport width is reachable by script and by nobody else.
    const horizontal = (element: HTMLElement) => {
      const rect = element.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      return {
        centreX: x,
        centreY: rect.top + rect.height / 2,
        width: rect.width,
        height: rect.height,
        insideHorizontally: x >= 0 && x <= window.innerWidth,
        rightEdgeInside: rect.right <= window.innerWidth + 1,
      };
    };

    return {
      documentScrollWidth: document.documentElement.scrollWidth,
      documentClientWidth: document.documentElement.clientWidth,
      dialogScrollWidth: (dialog as HTMLElement).scrollWidth,
      dialogClientWidth: (dialog as HTMLElement).clientWidth,
      dialogScrollLeft: (dialog as HTMLElement).scrollLeft,
      listScrollWidth: list.scrollWidth,
      listClientWidth: list.clientWidth,
      listScrollHeight: list.scrollHeight,
      listClientHeight: list.clientHeight,
      listScrollLeft: list.scrollLeft,
      listRect: list.getBoundingClientRect().toJSON(),
      rowRect: row.getBoundingClientRect().toJSON(),
      checkboxRect: checkbox.getBoundingClientRect().toJSON(),
      checkbox: horizontal(checkbox),
      link: horizontal(link),
      titleWhiteSpace: getComputedStyle(row.querySelector("p") as HTMLElement).whiteSpace,
    };
  }, pmid);
}

/**
 * Prove a control is really painted where it is drawn, after the user has done
 * the one thing they legitimately can — scroll vertically to it.
 *
 * `document.elementFromPoint` at the centre must return the control (or
 * something inside it). It returned `null` for the stranded control in PR #233,
 * because nothing was painted there at all.
 */
async function probeCentreAfterVerticalScroll(page: Page, pmid: string, target: "checkbox" | "link") {
  return page.evaluate(
    ({ targetPmid, which }) => {
      const dialog = [...document.querySelectorAll('[role="dialog"]')].find((element) =>
        element.querySelector('ul[aria-label="PubMed search results"]'),
      );
      if (!dialog) throw new Error("Add Papers dialog with a PubMed result list not found");
      const checkbox = dialog.querySelector(
        `[role="checkbox"][aria-label^="Select PMID ${targetPmid} "]`,
      ) as HTMLElement;
      const row = checkbox.closest("li") as HTMLElement;
      const element =
        which === "checkbox"
          ? checkbox
          : (row.querySelector("a[href^='https://pubmed.ncbi.nlm.nih.gov/']") as HTMLElement);

      element.scrollIntoView({ block: "nearest" });
      const list = dialog.querySelector('ul[aria-label="PubMed search results"]') as HTMLElement;
      const rect = element.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      return {
        ownsCentre: Boolean(hit && (hit === element || element.contains(hit) || hit.contains(element))),
        insideViewport: x >= 0 && y >= 0 && x <= window.innerWidth && y <= window.innerHeight,
        // No sideways scrolling was needed to get there.
        listScrollLeft: list.scrollLeft,
        dialogScrollLeft: (dialog as HTMLElement).scrollLeft,
        width: rect.width,
        height: rect.height,
      };
    },
    { targetPmid: pmid, which: target },
  );
}

/**
 * A real touch drag inside the results list.
 *
 * `page.touchscreen` only taps, and `Input.synthesizeScrollGesture` is a silent
 * no-op on CI's headless Linux Chromium (measured on PR #236: green on macOS,
 * `scrollTop: 0` on CI three times). `Input.dispatchTouchEvent` is the same raw
 * input path `touchscreen.tap` uses and drives scrolling on both.
 */
async function touchDragResults(page: Page, deltaY: number) {
  // The gesture starts at the midpoint of the list's VISIBLE part, in integer
  // coordinates — the same shape `e2e/scrollarea-reachability.spec.ts` uses,
  // which is the version measured working on both macOS and CI headless Linux.
  const point = await page.evaluate(() => {
    const dialog = [...document.querySelectorAll('[role="dialog"]')].find((element) =>
      element.querySelector('ul[aria-label="PubMed search results"]'),
    )!;
    const list = dialog.querySelector('ul[aria-label="PubMed search results"]') as HTMLElement;
    const rect = list.getBoundingClientRect();
    return {
      x: Math.round(rect.x + rect.width / 2),
      y: Math.round((Math.max(rect.top, 0) + Math.min(rect.bottom, window.innerHeight)) / 2),
    };
  });

  const client = await page.context().newCDPSession(page);
  const at = (y: number) => [{ x: point.x, y, radiusX: 5, radiusY: 5, force: 1 }];
  const clamp = (y: number) => Math.max(1, Math.min(y, point.y + Math.abs(deltaY)));

  await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: at(point.y) });
  const steps = 10;
  for (let step = 1; step <= steps; step++) {
    await client.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: at(clamp(point.y + Math.round((deltaY * step) / steps))),
    });
  }
  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await client.detach();
  // The gesture is applied asynchronously in the renderer; without this the
  // very next `scrollTop` read is taken before the scroll has happened.
  await page.waitForTimeout(150);
}

// ══════════════════════════════════════════════════════════════════════════

test.describe("In-app PubMed discovery", () => {
  test.setTimeout(180_000);

  /**
   * One disposable Project and Tag for the whole file.
   *
   * The deterministic seed ships neither, and the shared assign-on-import
   * section does not render at all when both lists are empty — so without these
   * the phone and tablet tests would be measuring a section that is not there.
   * Created through the real management modals on a desktop viewport (the
   * sidebar gear is a drawer control below `md`), and removed in `afterAll`.
   */
  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({ storageState: "e2e/.auth/user.json" });
    const page = await context.newPage();
    try {
      await openDashboard(page);
      // Tolerate residue from a previous `E2E_KEEP_LOCAL_STACK=1` debug run.
      await removeFixturePapers(page);
      await deleteProject(page, PROJECT_NAME);
      await deleteTag(page, TAG_NAME);
      await createProject(page, PROJECT_NAME);
      await createTag(page, TAG_NAME);
    } finally {
      await context.close();
    }
  });

  test.afterAll(async ({ browser }) => {
    const context = await browser.newContext({ storageState: "e2e/.auth/user.json" });
    const page = await context.newPage();
    try {
      await openDashboard(page);
      await removeFixturePapers(page);
      await deleteProject(page, PROJECT_NAME);
      await deleteTag(page, TAG_NAME);
    } finally {
      await context.close();
    }
  });

  test.afterEach(async ({ page }) => {
    // Order-independence: the shared local lifecycle expects the deterministic
    // seed back, whatever this test did or how it failed.
    await page.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});
    await openDashboard(page);
    await removeFixturePapers(page);
  });

  // ────────────────────────────────────────────────────────────────────────
  // The canonical path
  // ────────────────────────────────────────────────────────────────────────

  test("imports selected results through the canonical identifier path, with assignments and duplicate handling", async ({
    page,
  }) => {
    const recorder = await installStandIns(page);
    await openDashboard(page);
    await removeFixturePapers(page);

    const initialCount = await getPaperCount(page);
    expect(initialCount).toBeGreaterThan(0);

    const dialog = await openPubMedTab(page);
    {
      await runSearch(page);

      // ── The search request itself ──
      expect(recorder.searches).toHaveLength(1);
      expect(recorder.searches[0]).toMatchObject({
        query: COMMITTED_QUERY,
        offset: 0,
        limit: 20,
        authorizationIsBearer: true,
      });
      // No caller identity is sent: the function derives the user from the token.
      expect(recorder.searches[0].bodyKeys).toEqual(["limit", "offset", "query"]);

      // ── Result presentation ──
      await expect(dialog.getByText("1–20 of 25")).toBeVisible();
      await expect(dialog.getByRole("list", { name: "PubMed search results" }).locator("li")).toHaveCount(20);
      await expect(dialog.getByText(LONG_TITLE)).toBeVisible();
      // Compact author summary — three named, the rest counted.
      await expect(
        dialog.getByText(`${LONG_AUTHORS[0]}, ${LONG_AUTHORS[1]}, ${LONG_AUTHORS[2]} +2`),
      ).toBeVisible();
      await expect(dialog.getByText(`PMID ${pmidAt(1)}`)).toBeVisible();
      await expect(
        dialog.getByRole("link", { name: /Open in PubMed/ }).first(),
      ).toHaveAttribute("href", `https://pubmed.ncbi.nlm.nih.gov/${pmidAt(1)}/`);

      // Searching alone imports nothing.
      expect(recorder.metadata).toHaveLength(0);
      expect(await getPaperCount(page)).toBe(initialCount);

      // ── Select, assign, import ──
      await resultCheckbox(page, pmidAt(1)).click();
      await resultCheckbox(page, pmidAt(2)).click();
      await expect(dialog.getByText("2 papers selected")).toBeVisible();

      await dialog.getByRole("button", { name: /^Projects$/ }).click();
      await page.getByRole("option", { name: new RegExp(PROJECT_NAME) }).click();
      await page.keyboard.press("Escape");
      await dialog.getByRole("button", { name: /^Tags$/ }).click();
      await page.getByRole("option", { name: new RegExp(TAG_NAME) }).click();
      await page.keyboard.press("Escape");

      await importSelectedButton(page).click();
      await expect(dialog.getByText("PubMed Import Results")).toBeVisible({ timeout: 60_000 });
      await expect(dialog.getByText("Added (2)")).toBeVisible();

      // ── THE ARCHITECTURAL ASSERTION ──
      // The canonical metadata function received exactly the selected PMIDs.
      expect(recorder.metadata).toHaveLength(1);
      expect(recorder.metadata[0].identifiers).toEqual([pmidAt(1), pmidAt(2)]);
      expect(recorder.metadata[0].authorizationIsBearer).toBe(true);
      // The record carried a DOI; the PMID is still what was imported.
      expect(recorder.metadata[0].rawBody).not.toContain("10.5555/pms-e2e-long-row-record");
      // No discovery summary crossed into the import pipeline.
      for (const leak of [LONG_JOURNAL, LONG_AUTHORS[0], "publicationTypes", "Multicenter Study"]) {
        expect(recorder.metadata[0].rawBody).not.toContain(leak);
      }

      // ── Post-import state ──
      // The just-imported selection is gone; the query and results remain.
      await expect(dialog.getByText(/papers? selected/)).toHaveCount(0);
      await expect(dialog.getByLabel("Search PubMed")).toHaveValue(COMMITTED_QUERY);
      await expect(dialog.getByText("1–20 of 25")).toBeVisible();
      await expect(dialog.getByText("Assignments for next import")).toBeVisible();

      // ── Duplicate handling by the canonical importer ──
      // Result 2 is already in the library; result 3 is not.
      await resultCheckbox(page, pmidAt(2)).click();
      await resultCheckbox(page, pmidAt(3)).click();
      await importSelectedButton(page).click();
      await expect(dialog.getByText("Added (1)")).toBeVisible({ timeout: 60_000 });
      await expect(dialog.getByText("Skipped — Duplicates (1)")).toBeVisible();
      await expect(dialog.getByText(pmidAt(2), { exact: true })).toBeVisible();

      // Two runs, two metadata calls — no third insert path anywhere.
      expect(recorder.metadata).toHaveLength(2);
      expect(recorder.metadata[1].identifiers).toEqual([pmidAt(2), pmidAt(3)]);

      await closeDialog(page);

      // ── The library ──
      // Three distinct papers: the duplicate created no second row.
      await expect
        .poll(() => getPaperCount(page), { timeout: 30_000 })
        .toBe(initialCount + 3);

      const importedRow = page.locator("tbody tr").filter({ hasText: LONG_TITLE });
      await expect(importedRow).toHaveCount(1);
      // Assignment happened through the canonical importer, not through a
      // PubMed-specific path.
      await expect(importedRow.getByText(PROJECT_NAME)).toBeVisible();
      await expect(importedRow.getByText(TAG_NAME)).toBeVisible();

      // Nothing in the browser ever reached a metadata provider.
      expect(recorder.providerRequests).toEqual([]);
    }
  });

  // ────────────────────────────────────────────────────────────────────────
  // Pagination
  // ────────────────────────────────────────────────────────────────────────

  test("keeps a selection across pages of the same committed query and imports it exactly once", async ({
    page,
  }) => {
    const recorder = await installStandIns(page);
    await openDashboard(page);
    await removeFixturePapers(page);

    const dialog = await openPubMedTab(page);
    await runSearch(page);

    await resultCheckbox(page, pmidAt(1)).click();
    await expect(dialog.getByText("1 paper selected")).toBeVisible();
    await expect(dialog.getByRole("button", { name: /Previous/ })).toBeDisabled();

    await dialog.getByRole("button", { name: /Next/ }).click();
    await expect(dialog.getByText("21–25 of 25")).toBeVisible();
    expect(recorder.searches[1]).toMatchObject({ query: COMMITTED_QUERY, offset: 20 });

    // The page-1 selection is invisible but still counted.
    await expect(dialog.getByText("1 paper selected")).toBeVisible();
    await resultCheckbox(page, pmidAt(21)).click();
    await expect(dialog.getByText("2 papers selected")).toBeVisible();
    await expect(dialog.getByRole("button", { name: /Next/ })).toBeDisabled();

    await dialog.getByRole("button", { name: /Previous/ }).click();
    await expect(dialog.getByText("1–20 of 25")).toBeVisible();
    // The first result is still checked after the round trip.
    await expect(resultCheckbox(page, pmidAt(1))).toBeChecked();
    await expect(dialog.getByText("2 papers selected")).toBeVisible();

    await importSelectedButton(page).click();
    await expect(dialog.getByText("PubMed Import Results")).toBeVisible({ timeout: 60_000 });

    // Both pages' PMIDs, each exactly once, in selection order.
    expect(recorder.metadata).toHaveLength(1);
    expect(recorder.metadata[0].identifiers).toEqual([pmidAt(1), pmidAt(21)]);
    await closeDialog(page);
  });

  // ────────────────────────────────────────────────────────────────────────
  // Draft vs committed query
  // ────────────────────────────────────────────────────────────────────────

  test("separates the draft query from the committed one", async ({ page }) => {
    const recorder = await installStandIns(page);
    await openDashboard(page);

    const dialog = await openPubMedTab(page);
    await runSearch(page);
    await dialog.getByRole("button", { name: /Next/ }).click();
    await expect(dialog.getByText("21–25 of 25")).toBeVisible();
    await resultCheckbox(page, pmidAt(21)).click();
    await expect(dialog.getByText("1 paper selected")).toBeVisible();

    // Type a different query WITHOUT submitting it.
    await dialog.getByLabel("Search PubMed").fill(OTHER_QUERY);
    await expect(dialog.getByText("21–25 of 25")).toBeVisible();
    await expect(dialog.getByText("1 paper selected")).toBeVisible();
    await expect(resultCheckbox(page, pmidAt(21))).toBeChecked();
    // Two requests so far — the search and the page move. Typing added none.
    expect(recorder.searches).toHaveLength(2);

    // Now submit it.
    await dialog.getByRole("button", { name: "Search" }).click();
    await expect(dialog.getByText(`${TITLE_PREFIX}-Other-81`)).toBeVisible();

    // Page reset to the first, results replaced, and the old selection gone —
    // selections from unrelated searches are never mixed into one import.
    await expect(dialog.getByText("1–2 of 2")).toBeVisible();
    await expect(dialog.getByText(/papers? selected/)).toHaveCount(0);
    await expect(importSelectedButton(page)).toBeDisabled();
    // PubMed syntax reached the function untouched.
    expect(recorder.searches[2]).toMatchObject({ query: OTHER_QUERY, offset: 0 });
    expect(recorder.metadata).toHaveLength(0);

    await closeDialog(page);
  });

  // ────────────────────────────────────────────────────────────────────────
  // Failure isolation
  // ────────────────────────────────────────────────────────────────────────

  test("fails gracefully and leaves every existing import mode usable", async ({ page }) => {
    await installStandIns(page, { searchBehaviour: () => "fail" });
    await openDashboard(page);

    const dialog = await openPubMedTab(page);
    await dialog.getByLabel("Search PubMed").fill(COMMITTED_QUERY);
    await dialog.getByRole("button", { name: "Search" }).click();

    const alert = dialog.getByRole("alert");
    await expect(alert).toBeVisible();
    await expect(alert).toContainText("PubMed could not be reached right now");
    // No key, no upstream body, no stack trace.
    await expect(alert).not.toContainText("api_key");
    await expect(alert).not.toContainText("eutils");
    // Retry is available, and nothing was imported.
    await expect(dialog.getByRole("button", { name: "Search" })).toBeEnabled();
    await expect(importSelectedButton(page)).toBeDisabled();

    // Every pre-existing mode still works.
    await dialog.getByRole("tab", { name: "Import IDs" }).click();
    await expect(dialog.getByLabel("Paste PMIDs or DOIs, or drop a .txt/.csv file")).toBeEnabled();
    await dialog.getByRole("tab", { name: "Import File" }).click();
    await expect(dialog.getByRole("button", { name: "Choose a file to import" })).toBeVisible();
    await dialog.getByRole("tab", { name: "Manual" }).click();
    await expect(dialog.getByLabel("Title *")).toBeEnabled();

    await page.keyboard.press("Escape");
  });

  // ────────────────────────────────────────────────────────────────────────
  // Keyboard
  // ────────────────────────────────────────────────────────────────────────

  test("is operable by keyboard alone, with focus staying inside the modal", async ({ page }) => {
    const recorder = await installStandIns(page);
    await openDashboard(page);
    await removeFixturePapers(page);

    await page.getByRole("button", { name: /add papers/i }).click();
    const dialog = dialogOf(page);
    await expect(dialog).toBeVisible();

    /** Tab until the predicate holds, proving focus stayed inside the dialog. */
    const tabUntil = async (predicate: (info: { role: string | null; name: string }) => boolean) => {
      for (let step = 0; step < 80; step++) {
        await page.keyboard.press("Tab");
        const info = await page.evaluate(() => {
          const active = document.activeElement as HTMLElement | null;
          const modal = [...document.querySelectorAll('[role="dialog"]')].find((d) =>
            d.getAttribute("aria-label") === "Add Papers" || d.querySelector("h2")?.textContent === "Add Papers",
          );
          return {
            role: active?.getAttribute("role") ?? active?.tagName.toLowerCase() ?? null,
            name: active?.getAttribute("aria-label") ?? active?.textContent?.trim() ?? "",
            insideModal: Boolean(modal && active && modal.contains(active)),
            hasFocusRing: Boolean(active && active !== document.body),
          };
        });
        // Focus must never escape the modal or land on <body>.
        expect(info.insideModal, `focus left the modal at step ${step} (on "${info.name}")`).toBe(true);
        expect(info.hasFocusRing).toBe(true);
        if (predicate(info)) return info;
      }
      throw new Error("target never received focus within 80 Tab presses");
    };

    // Reach the PubMed Search tab and activate it from the keyboard. Radix
    // roving tabindex moves between tabs with arrows, not Tab.
    await tabUntil((info) => info.role === "tab");
    await page.keyboard.press("Home");
    await expect(dialog.getByRole("tab", { name: "PubMed Search" })).toBeFocused();
    await expect(dialog.getByLabel("Search PubMed")).toBeVisible();

    // Focus the field, type, and submit with a REAL Enter keystroke.
    await tabUntil((info) => info.name === "" && info.role === "input");
    await expect(dialog.getByLabel("Search PubMed")).toBeFocused();
    await page.keyboard.type(COMMITTED_QUERY);
    expect(recorder.searches).toHaveLength(0); // typing alone searches nothing
    await page.keyboard.press("Enter");
    await expect(dialog.getByRole("list", { name: "PubMed search results" })).toBeVisible();
    expect(recorder.searches).toHaveLength(1);

    // Focus is not stolen by the arriving results.
    await expect(dialog.getByLabel("Search PubMed")).toBeFocused();

    // Reach the first result checkbox and select it with Space.
    await tabUntil((info) => info.name.startsWith(`Select PMID ${pmidAt(1)} `));
    await page.keyboard.press("Space");
    await expect(resultCheckbox(page, pmidAt(1))).toBeChecked();
    await expect(dialog.getByText("1 paper selected")).toBeVisible();

    // Reach Import and activate it.
    await tabUntil((info) => /^Import( \d+)? Selected$/.test(info.name));
    await page.keyboard.press("Enter");
    await expect(dialog.getByText("PubMed Import Results")).toBeVisible({ timeout: 60_000 });
    expect(recorder.metadata).toHaveLength(1);
    expect(recorder.metadata[0].identifiers).toEqual([pmidAt(1)]);

    await closeDialog(page);
  });

  // ────────────────────────────────────────────────────────────────────────
  // Phone geometry
  // ────────────────────────────────────────────────────────────────────────

  test("is fully reachable at 390×844", async ({ browser }) => {
    // The viewport is set BEFORE navigating: resizing mid-test unmounts
    // desktop-only surfaces rather than reflowing them.
    const context = await browser.newContext({
      storageState: "e2e/.auth/user.json",
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
    const page = await context.newPage();

    try {
      await installStandIns(page);
      await openDashboard(page);

      // ── All four modes reachable, none clipped, no sideways scroll ──
      await page.getByRole("button", { name: /add papers/i }).click();
      const dialog = dialogOf(page);
      await expect(dialog).toBeVisible();

      const tabGeometry = await page.evaluate(() => {
        const list = document.querySelector('[role="tablist"]') as HTMLElement;
        const listRect = list.getBoundingClientRect();
        return {
          listScrollWidth: list.scrollWidth,
          listClientWidth: list.clientWidth,
          tabs: [...list.querySelectorAll('[role="tab"]')].map((tab) => {
            const rect = tab.getBoundingClientRect();
            const x = rect.left + rect.width / 2;
            const y = rect.top + rect.height / 2;
            const hit = document.elementFromPoint(x, y);
            return {
              name: tab.getAttribute("aria-label"),
              width: rect.width,
              height: rect.height,
              // Fully inside the tab list — never clipped by it.
              containedHorizontally: rect.left >= listRect.left - 1 && rect.right <= listRect.right + 1,
              insideViewport:
                rect.left >= 0 && rect.right <= window.innerWidth && rect.top >= 0 && rect.bottom <= window.innerHeight,
              // A finger landing on the centre hits this tab, not something else.
              ownsCentre: Boolean(hit && (hit === tab || tab.contains(hit))),
              // The label is not visually truncated inside its own box.
              labelFits: tab.scrollWidth <= tab.clientWidth + 1,
            };
          }),
        };
      });

      expect(tabGeometry.tabs.map((t) => t.name)).toEqual([
        "PubMed Search",
        "Import IDs",
        "Import File",
        "Manual",
      ]);
      // No hidden horizontal scroll is required to reach any mode.
      expect(tabGeometry.listScrollWidth).toBeLessThanOrEqual(tabGeometry.listClientWidth + 1);
      for (const tab of tabGeometry.tabs) {
        expect(tab.containedHorizontally, `${tab.name} is clipped by the tab list`).toBe(true);
        expect(tab.insideViewport, `${tab.name} is outside the viewport`).toBe(true);
        expect(tab.ownsCentre, `${tab.name} does not own its own centre point`).toBe(true);
        expect(tab.labelFits, `${tab.name} label is truncated`).toBe(true);
        // Comfortable touch targets in both axes.
        expect(tab.height).toBeGreaterThanOrEqual(32);
        expect(tab.width).toBeGreaterThanOrEqual(120);
      }

      await dialog.getByRole("tab", { name: "PubMed Search" }).click();
      await runSearch(page);

      // ── The hostile row ──
      const geometry = await measureRow(page, pmidAt(1));

      // Nothing anywhere requires sideways scrolling.
      expect(geometry.documentScrollWidth).toBeLessThanOrEqual(geometry.documentClientWidth + 1);
      expect(geometry.dialogScrollWidth).toBeLessThanOrEqual(geometry.dialogClientWidth + 1);
      expect(geometry.listScrollWidth).toBeLessThanOrEqual(geometry.listClientWidth + 1);
      expect(geometry.dialogScrollLeft).toBe(0);
      expect(geometry.listScrollLeft).toBe(0);

      // The long title wrapped rather than setting the row's min-content width.
      expect(geometry.titleWhiteSpace).not.toBe("nowrap");
      expect(geometry.rowRect.width).toBeLessThanOrEqual(geometry.listRect.width + 1);

      // HORIZONTAL — must already be inside, with no scrolling of any kind,
      // because these surfaces mount no horizontal scrollbar.
      expect(geometry.checkbox.insideHorizontally).toBe(true);
      expect(geometry.checkbox.rightEdgeInside).toBe(true);
      expect(geometry.link.insideHorizontally).toBe(true);
      expect(geometry.link.rightEdgeInside).toBe(true);
      // The checkbox kept its size beside 240 characters of title.
      expect(geometry.checkboxRect.width).toBeGreaterThanOrEqual(14);

      // VERTICAL — a user can scroll, so reachability is measured after they
      // have. Both controls must then actually be PAINTED at their centre:
      // `toBeVisible()` and `.click()` would both pass for a control nothing
      // paints, which is exactly how the PR #233 defect hid behind a green test.
      for (const target of ["checkbox", "link"] as const) {
        const probe = await probeCentreAfterVerticalScroll(page, pmidAt(1), target);
        expect(probe.ownsCentre, `${target} is not painted at its own centre`).toBe(true);
        expect(probe.insideViewport, `${target} is off screen after scrolling to it`).toBe(true);
        // Reaching it required no sideways movement.
        expect(probe.listScrollLeft).toBe(0);
        expect(probe.dialogScrollLeft).toBe(0);
      }

      // ── The list really scrolls, with a real finger ──
      expect(geometry.listScrollHeight).toBeGreaterThan(geometry.listClientHeight);
      // Negative drags the content up, i.e. scrolls the list down.
      await touchDragResults(page, -Math.round(geometry.listRect.height * 0.6));

      const scrolled = await page.evaluate(() => {
        const dialogEl = [...document.querySelectorAll('[role="dialog"]')].find((element) =>
          element.querySelector('ul[aria-label="PubMed search results"]'),
        )!;
        const list = dialogEl.querySelector('ul[aria-label="PubMed search results"]') as HTMLElement;
        return { top: list.scrollTop, left: list.scrollLeft };
      });
      expect(scrolled.top).toBeGreaterThan(0);
      // Vertical panning must not have dragged the content sideways.
      expect(scrolled.left).toBe(0);

      // The last result on the page is reachable by that same panning.
      const lastRow = await probeCentreAfterVerticalScroll(page, pmidAt(20), "checkbox");
      expect(lastRow.ownsCentre, "the last result's checkbox is not reachable").toBe(true);
      expect(lastRow.insideViewport).toBe(true);
      expect(lastRow.listScrollLeft).toBe(0);

      // ── Select, then reach every control below the list ──
      await resultCheckbox(page, pmidAt(20)).click();
      const belowList = await page.evaluate(() => {
        const dialogEl = [...document.querySelectorAll('[role="dialog"]')].find((element) =>
          element.querySelector('ul[aria-label="PubMed search results"]'),
        )!;
        const named = (selector: string) => dialogEl.querySelector(selector) as HTMLElement | null;
        const measure = (element: HTMLElement | null) => {
          if (!element) return null;
          element.scrollIntoView({ block: "nearest" });
          const rect = element.getBoundingClientRect();
          const x = rect.left + rect.width / 2;
          const y = rect.top + rect.height / 2;
          const hit = document.elementFromPoint(x, y);
          return {
            insideViewport: x >= 0 && y >= 0 && x <= window.innerWidth && y <= window.innerHeight,
            ownsCentre: Boolean(hit && (hit === element || element.contains(hit))),
            width: rect.width,
            height: rect.height,
          };
        };
        return {
          selectionSummary: measure(named('[aria-live="polite"].text-sm.font-medium')),
          projects: measure(
            [...dialogEl.querySelectorAll("button")].find((b) => /project/i.test(b.textContent ?? "")) ?? null,
          ),
          tags: measure(
            [...dialogEl.querySelectorAll("button")].find((b) => /^tags?$|\d+ tags?/i.test(b.textContent ?? "")) ?? null,
          ),
          importButton: measure(
            [...dialogEl.querySelectorAll("button")].find((b) => /^Import( \d+)? Selected$/.test((b.textContent ?? "").trim())) ?? null,
          ),
        };
      });

      for (const [label, control] of Object.entries(belowList)) {
        expect(control, `${label} was not found`).not.toBeNull();
        expect(control!.insideViewport, `${label} is off screen`).toBe(true);
        expect(control!.ownsCentre, `${label} is covered at its centre`).toBe(true);
      }
      // Touch minimum on the primary action.
      expect(belowList.importButton!.height).toBeGreaterThanOrEqual(36);
    } finally {
      await openDashboard(page).catch(() => {});
      await removeFixturePapers(page).catch(() => {});
      await context.close();
    }
  });

  // ────────────────────────────────────────────────────────────────────────
  // Negative control
  // ────────────────────────────────────────────────────────────────────────

  test("negative control — restoring the nowrap/min-content shape breaks the row at 390px", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      storageState: "e2e/.auth/user.json",
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
    const page = await context.newPage();

    try {
      await installStandIns(page);
      await openDashboard(page);
      await openPubMedTab(page);
      await runSearch(page);

      // Green with the real classes — the assertion is not vacuous.
      const before = await measureRow(page, pmidAt(1));
      expect(before.listScrollWidth).toBeLessThanOrEqual(before.listClientWidth + 1);
      expect(before.titleWhiteSpace).not.toBe("nowrap");

      // Reintroduce ONLY the layout cause the row's classes exist to prevent:
      // a nowrap title (min-content width = full line length) inside a text
      // column that is no longer allowed to shrink below its content.
      await page.addStyleTag({
        content: `
          ul[aria-label="PubMed search results"] li > div > div {
            min-width: auto !important;
          }
          ul[aria-label="PubMed search results"] li > div > div > p {
            white-space: nowrap !important;
            overflow-wrap: normal !important;
            word-break: normal !important;
          }
        `,
      });

      const after = await measureRow(page, pmidAt(1));

      // Prove the injected rule actually took effect before trusting the
      // failure it is supposed to cause — a control that reproduces nothing
      // proves nothing.
      expect(after.titleWhiteSpace).toBe("nowrap");

      // …and the defect is back, in the exact shape PRs #233–#236 fixed.
      // Measured at 390×844: the row's min-content width is now its full line
      // length, so the list is laid out 1877px wide inside a 388px dialog and
      // the dialog acquires a 1539px horizontal overflow with no scrollbar.
      expect(after.listClientWidth).toBeGreaterThan(before.listClientWidth * 2);
      expect(after.dialogScrollWidth).toBeGreaterThan(after.dialogClientWidth + 1);
      expect(after.rowRect.width).toBeGreaterThan(before.rowRect.width * 2);

      // The user-visible harm: the PubMed link's centre is now outside the
      // viewport width, on an axis with no scrollbar — reachable by script and
      // by nobody else.
      expect(before.link.insideHorizontally).toBe(true);
      expect(after.link.insideHorizontally).toBe(false);
      expect(after.link.centreX).toBeGreaterThan(390);
    } finally {
      await context.close();
    }
  });

  // ────────────────────────────────────────────────────────────────────────
  // Tablet / narrow desktop
  // ────────────────────────────────────────────────────────────────────────

  test("does not regress the tablet dialog at 1024×800", async ({ browser }) => {
    const context = await browser.newContext({
      storageState: "e2e/.auth/user.json",
      viewport: { width: 1024, height: 800 },
      hasTouch: true,
    });
    const page = await context.newPage();

    try {
      await installStandIns(page);
      await openDashboard(page);
      const dialog = await openPubMedTab(page);
      await runSearch(page);

      // Four tabs on one row here, all reachable and unclipped.
      const tabs = await page.evaluate(() => {
        const list = document.querySelector('[role="tablist"]') as HTMLElement;
        const listRect = list.getBoundingClientRect();
        return {
          rows: new Set(
            [...list.querySelectorAll('[role="tab"]')].map((tab) => Math.round(tab.getBoundingClientRect().top)),
          ).size,
          overflows: list.scrollWidth > list.clientWidth + 1,
          allInside: [...list.querySelectorAll('[role="tab"]')].every((tab) => {
            const rect = tab.getBoundingClientRect();
            return rect.left >= listRect.left - 1 && rect.right <= listRect.right + 1;
          }),
        };
      });
      expect(tabs.rows).toBe(1);
      expect(tabs.overflows).toBe(false);
      expect(tabs.allInside).toBe(true);

      const geometry = await measureRow(page, pmidAt(1));
      expect(geometry.listScrollWidth).toBeLessThanOrEqual(geometry.listClientWidth + 1);
      expect(geometry.dialogScrollLeft).toBe(0);
      expect(geometry.checkbox.insideHorizontally).toBe(true);
      expect(geometry.checkbox.rightEdgeInside).toBe(true);
      expect(geometry.link.insideHorizontally).toBe(true);
      expect(geometry.link.rightEdgeInside).toBe(true);
      for (const target of ["checkbox", "link"] as const) {
        const probe = await probeCentreAfterVerticalScroll(page, pmidAt(1), target);
        expect(probe.ownsCentre, `${target} is not painted at its own centre`).toBe(true);
        expect(probe.dialogScrollLeft).toBe(0);
      }

      // The assignment selector still opens fully on screen on a coarse pointer
      // — the collision behaviour PR #232 fixed, with the taller PubMed content
      // above it.
      await dialog.getByRole("button", { name: /^Projects$/ }).click();
      const popover = page.locator('[data-radix-popper-content-wrapper]');
      await expect(popover).toBeVisible();
      const panel = await popover.boundingBox();
      expect(panel).not.toBeNull();
      expect(panel!.y).toBeGreaterThanOrEqual(0);
      expect(panel!.y + panel!.height).toBeLessThanOrEqual(800 + 1);
      // Touch-safe initial focus: opening it must not focus the search input.
      const focusedTag = await page.evaluate(() => document.activeElement?.tagName.toLowerCase() ?? "");
      expect(focusedTag).not.toBe("input");
      await page.keyboard.press("Escape");
    } finally {
      await context.close();
    }
  });
});
