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

/**
 * The coarse-pointer minimum this repository holds every touch target to.
 *
 * Asserted exactly, with no tolerance: every target measured here is built from
 * whole-pixel rules (`min-h-10` = 40px; a 16px box plus 12px of hit region on
 * each side = 40px), so a fractional result would itself be the bug.
 */
const COARSE_POINTER_TARGET_PX = 40;

const dialogOf = (page: Page) => page.getByRole("dialog", { name: "Add Papers" });

/**
 * Wait until the Add Papers dialog has finished animating, before measuring
 * anything inside it.
 *
 * This is not a politeness `waitForTimeout`; it is the difference between
 * measuring the layout and measuring an animation frame. `DialogContent`
 * carries `data-[state=open]:zoom-in-95 duration-200`, i.e. a CSS transform
 * that scales the entire dialog subtree from 0.95 up to 1.
 * `getBoundingClientRect()` reports the *transformed* box, so every length
 * inside reads about 5% small until it lands: a 40px touch target measures
 * 38.08, and a 16px checkbox measures 15.2.
 *
 * That artifact is why the thresholds this remediation replaced were able to
 * pass. `>= 32` on a tab and `>= 14` on the checkbox both survive a 0.95 scale
 * comfortably, so nothing ever forced the question of *when* the measurement
 * was taken. Asserting the real 40px contract does force it — the first run of
 * the corrected assertions failed at 38.0767 and 38 respectively, mid-zoom.
 *
 * The settled transform is a translate, not the identity: the dialog is centred
 * with `translate-x-[-50%] translate-y-[-50%]`. Only the scale/skew components
 * must be identity, which is what the matrix test below checks.
 */
async function waitForDialogSettled(page: Page) {
  await page.waitForFunction(() => {
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement | null;
    if (!dialog) return false;
    // No keyframe animation still in flight anywhere in the dialog.
    if (dialog.getAnimations({ subtree: true }).some((animation) => animation.playState === "running")) {
      return false;
    }
    // …and no ancestor is still scaling it.
    for (let node: Element | null = dialog; node; node = node.parentElement) {
      const transform = getComputedStyle(node).transform;
      if (transform !== "none" && !/^matrix\(1, 0, 0, 1[,)]/.test(transform)) return false;
    }
    return true;
  });
}

/**
 * The scale/skew part of a dialog's transform, as the measurement saw it.
 * `"none"` or a pure translate means the geometry beside it is real.
 */
const DIALOG_SETTLED = /^(none|matrix\(1, 0, 0, 1[,)])/;

async function openPubMedTab(page: Page) {
  await page.getByRole("button", { name: /add papers/i }).click();
  const dialog = dialogOf(page);
  await expect(dialog).toBeVisible();
  await waitForDialogSettled(page);
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
 * Measure the selection control's REAL tappable region.
 *
 * `getBoundingClientRect()` is the wrong instrument here and that is the whole
 * point of this helper. The visible checkbox is 16x16 and stays 16x16; the
 * touch target is a transparent `::before` that extends the hit region to
 * 40x40. A pseudo-element has no box of its own to measure — it is hit-tested
 * as its originating element — so the only honest measurement is to ask the
 * renderer what it would actually deliver a tap to.
 *
 * So: walk outwards from the control's centre one CSS pixel at a time and find
 * the longest contiguous run in each direction that `elementFromPoint` still
 * resolves to this checkbox. That is, by construction, the region a finger can
 * land in. It would report ~16 for the bare primitive and ~40 for the fixed
 * one, which is exactly the distinction the previous version of this test could
 * not make.
 */
async function measureSelectionHitTarget(page: Page, pmid: string) {
  return page.evaluate((targetPmid) => {
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

    // Put the row in a defined scroll state before measuring, by moving the
    // LIST only — never `scrollIntoView`, which aligns the element's own 16x16
    // box and knows nothing about the hit region hanging 14px above it. Aligned
    // that way, the row ends up flush with the list's top edge and the list
    // (an `overflow-y-auto` box) clips the top of the target: measured 43 on
    // macOS, where the preceding probe happened not to scroll at all, and 36 on
    // CI's headless Linux, where taller rows meant it did. Scrolling the list
    // itself, with clearance, makes the measurement independent of both the
    // renderer's font metrics and whatever ran before it.
    const listTop = list.getBoundingClientRect().top;
    const rowOffset = row.getBoundingClientRect().top - listTop + list.scrollTop;
    list.scrollTop = Math.max(0, rowOffset - 24);

    const visual = checkbox.getBoundingClientRect();
    const centreX = Math.round(visual.left + visual.width / 2);
    const centreY = Math.round(visual.top + visual.height / 2);

    /** Does a tap at this viewport point reach the checkbox? */
    const owns = (x: number, y: number) => {
      if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) return false;
      const hit = document.elementFromPoint(x, y);
      return Boolean(hit && (hit === checkbox || checkbox.contains(hit)));
    };

    // Bounded so a bug that makes the whole page hit-test to the checkbox
    // cannot spin: no legitimate target here is anywhere near 120px.
    const LIMIT = 120;
    const reach = (dx: number, dy: number) => {
      let steps = 0;
      while (steps < LIMIT && owns(centreX + dx * (steps + 1), centreY + dy * (steps + 1))) steps++;
      return steps;
    };

    const left = reach(-1, 0);
    const right = reach(1, 0);
    const up = reach(0, -1);
    const down = reach(0, 1);

    // Representative points spread across the enlarged region — deliberately
    // OUTSIDE the 16x16 visual box (which reaches only 8px from the centre), so
    // none of them can pass on the strength of the primitive alone.
    const probes: Record<string, boolean> = {
      centre: owns(centreX, centreY),
      left12: owns(centreX - 12, centreY),
      right12: owns(centreX + 12, centreY),
      up12: owns(centreX, centreY - 12),
      down12: owns(centreX, centreY + 12),
      topLeft: owns(centreX - 11, centreY - 11),
      topRight: owns(centreX + 11, centreY - 11),
      bottomLeft: owns(centreX - 11, centreY + 11),
      bottomRight: owns(centreX + 11, centreY + 11),
    };

    const hitBox = {
      left: centreX - left,
      right: centreX + right,
      top: centreY - up,
      bottom: centreY + down,
    };

    const linkRect = link.getBoundingClientRect();
    const linkCentreX = linkRect.left + linkRect.width / 2;
    const linkCentreY = linkRect.top + linkRect.height / 2;
    const linkHit = document.elementFromPoint(linkCentreX, linkCentreY);

    return {
      // Proof the numbers below are layout, not an animation frame.
      dialogTransform: getComputedStyle(dialog as HTMLElement).transform,
      // The visible control is unchanged and deliberately still compact.
      visualWidth: visual.width,
      visualHeight: visual.height,
      // The measured tappable region.
      hitWidth: left + right + 1,
      hitHeight: up + down + 1,
      hitBox,
      insideViewport:
        hitBox.left >= 0 &&
        hitBox.top >= 0 &&
        hitBox.right <= window.innerWidth &&
        hitBox.bottom <= window.innerHeight,
      probes,
      // Whether the list's own clip edge trimmed the target. At rest the first
      // row sits flush with the list's content top and the target still fits
      // entirely inside the row, so this stays false.
      clippedByList: hitBox.top < list.getBoundingClientRect().top - 1,
      listScrollTop: list.scrollTop,
      // Reaching it must never have required sideways movement.
      listScrollLeft: list.scrollLeft,
      dialogScrollLeft: (dialog as HTMLElement).scrollLeft,
      // The enlarged target must not have swallowed the external link.
      linkOwnsCentre: Boolean(linkHit && (linkHit === link || link.contains(linkHit))),
      linkOverlapsHitBox:
        linkRect.left < hitBox.right &&
        linkRect.right > hitBox.left &&
        linkRect.top < hitBox.bottom &&
        linkRect.bottom > hitBox.top,
    };
  }, pmid);
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
      // Measure the layout, not the open animation — see waitForDialogSettled.
      await waitForDialogSettled(page);

      const tabGeometry = await page.evaluate(() => {
        const list = document.querySelector('[role="tablist"]') as HTMLElement;
        const listRect = list.getBoundingClientRect();
        const dialogEl = list.closest('[role="dialog"]') as HTMLElement;
        return {
          dialogTransform: getComputedStyle(dialogEl).transform,
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
      // The heights below are only meaningful if the dialog was not mid-zoom.
      expect(tabGeometry.dialogTransform, "tabs were measured mid-animation").toMatch(DIALOG_SETTLED);
      // No hidden horizontal scroll is required to reach any mode.
      expect(tabGeometry.listScrollWidth).toBeLessThanOrEqual(tabGeometry.listClientWidth + 1);
      for (const tab of tabGeometry.tabs) {
        expect(tab.containedHorizontally, `${tab.name} is clipped by the tab list`).toBe(true);
        expect(tab.insideViewport, `${tab.name} is outside the viewport`).toBe(true);
        expect(tab.ownsCentre, `${tab.name} does not own its own centre point`).toBe(true);
        expect(tab.labelFits, `${tab.name} label is truncated`).toBe(true);
        // The repository's coarse-pointer minimum, asserted at its real value.
        // `min-h-10` on the trigger is what holds this: releasing the tab
        // list's fixed `h-10` for the 2x2 phone grid measured 30.46px here, and
        // an earlier version of this assertion accepted >= 32 — which is exactly
        // the height the triggers collapse to without the minimum, so it would
        // have let the whole regression back in without failing.
        expect(tab.height, `${tab.name} is below the 40px coarse-pointer target`).toBeGreaterThanOrEqual(
          COARSE_POINTER_TARGET_PX,
        );
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

      // ── TOUCH USABILITY, which reachability does not imply ──
      // Everything above proves the selection control is painted where it is
      // drawn. None of it proves a finger can hit it: the shared primitive is
      // 16x16, and a control can be perfectly reachable and still be a quarter
      // of the area a coarse pointer needs. This measures the region the
      // renderer would really deliver a tap to, not the visible box.
      const touch = await measureSelectionHitTarget(page, pmidAt(1));

      expect(touch.dialogTransform, "the target was measured mid-animation").toMatch(DIALOG_SETTLED);
      expect(touch.hitWidth, "selection touch target is too narrow").toBeGreaterThanOrEqual(
        COARSE_POINTER_TARGET_PX,
      );
      expect(touch.hitHeight, "selection touch target is too short").toBeGreaterThanOrEqual(
        COARSE_POINTER_TARGET_PX,
      );
      expect(touch.insideViewport, "the selection touch target is not fully on screen").toBe(true);
      expect(touch.clippedByList, "the results list clipped the selection target").toBe(false);
      expect(touch.listScrollLeft).toBe(0);
      expect(touch.dialogScrollLeft).toBe(0);

      // Every representative point across the enlarged region belongs to the
      // checkbox — the target is one contiguous area, not a 16x16 box with a
      // decorative halo. Each probe sits at least 11px from the centre, so the
      // bare primitive (which reaches 8px) could not satisfy any of them.
      for (const [where, owned] of Object.entries(touch.probes)) {
        expect(owned, `a tap at the ${where} of the selection target misses the checkbox`).toBe(true);
      }

      // The visible control stays deliberately compact beside 240 characters of
      // title: the target grew, the design did not.
      expect(touch.visualWidth).toBeGreaterThanOrEqual(14);
      expect(touch.visualWidth).toBeLessThanOrEqual(20);
      expect(geometry.checkboxRect.width).toBeGreaterThanOrEqual(14);

      // ── The two actions in a row stay independent ──
      // The row is deliberately NOT one click target, because it contains an
      // external link. Enlarging the selection target must not have quietly
      // undone that.
      expect(touch.linkOwnsCentre, "the enlarged target covers the PubMed link").toBe(true);
      expect(touch.linkOverlapsHitBox, "the selection target overlaps the PubMed link").toBe(false);

      // Activating the link must reach PubMed and nothing else. Routed at the
      // context so the popup is served locally — CI never calls NCBI.
      await context.route("**://pubmed.ncbi.nlm.nih.gov/**", (route) =>
        route.fulfill({ status: 200, contentType: "text/html", body: "<html><body>stand-in</body></html>" }),
      );
      let popupCount = 0;
      page.on("popup", () => {
        popupCount += 1;
      });

      const firstCheckbox = resultCheckbox(page, pmidAt(1));
      await expect(firstCheckbox).not.toBeChecked();

      // Tap the enlarged region well outside the visible 16x16 box. This is the
      // tap that had nowhere to land before the fix.
      await page.touchscreen.tap(
        touch.hitBox.left + 2,
        Math.round((touch.hitBox.top + touch.hitBox.bottom) / 2),
      );
      await expect(firstCheckbox, "a tap inside the enlarged target did not select").toBeChecked();
      expect(popupCount, "selecting a result opened PubMed").toBe(0);

      // …and activating the link leaves the selection exactly as it was.
      const popup = await Promise.all([
        page.waitForEvent("popup"),
        dialog.getByRole("link", { name: /Open in PubMed/ }).nth(0).click(),
      ]).then(([opened]) => opened);
      expect(popup.url()).toContain(`/${pmidAt(1)}/`);
      await popup.close();
      await expect(firstCheckbox, "opening PubMed changed the selection").toBeChecked();
      expect(popupCount).toBe(1);

      // Restore the pre-probe selection state for the rest of the test.
      await firstCheckbox.click();
      await expect(firstCheckbox).not.toBeChecked();

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

      // …and it is not merely reachable but tappable. The contract is "each
      // result's selection control", not "the first one": this row exists only
      // after scrolling, which is the state that exposed the clipping bug the
      // measurement helper now controls for.
      const lastTouch = await measureSelectionHitTarget(page, pmidAt(20));
      expect(lastTouch.listScrollTop, "row 20 was measured without scrolling").toBeGreaterThan(0);
      expect(lastTouch.hitWidth, "the last row's target is too narrow").toBeGreaterThanOrEqual(
        COARSE_POINTER_TARGET_PX,
      );
      expect(lastTouch.hitHeight, "the last row's target is too short").toBeGreaterThanOrEqual(
        COARSE_POINTER_TARGET_PX,
      );
      expect(lastTouch.clippedByList, "the list clipped the last row's target").toBe(false);
      expect(lastTouch.insideViewport).toBe(true);
      for (const [where, owned] of Object.entries(lastTouch.probes)) {
        expect(owned, `a tap at the ${where} of row 20's target misses the checkbox`).toBe(true);
      }

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

  test("negative control — removing the touch enlargements reproduces the sub-40px targets", async ({
    browser,
  }) => {
    // The companion to the nowrap control above. That one guards a *layout*
    // rule; this one guards two *touch* rules, and the previous version of this
    // suite had no equivalent — it asserted only that a checkbox existed, was
    // ~16px and was painted, all of which stayed true while the control was
    // unusably small on a phone.
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
      const dialog = await openPubMedTab(page);
      await runSearch(page);

      // ── Part 1: the selection target ──

      // Green with the real classes, so the assertion below is not vacuous.
      const before = await measureSelectionHitTarget(page, pmidAt(1));
      expect(before.dialogTransform, "measured mid-animation").toMatch(DIALOG_SETTLED);
      expect(before.hitWidth).toBeGreaterThanOrEqual(COARSE_POINTER_TARGET_PX);
      expect(before.hitHeight).toBeGreaterThanOrEqual(COARSE_POINTER_TARGET_PX);

      // Remove ONLY the enlargement, leaving the otherwise-correct row alone:
      // no layout rule, no class on the row, nothing about wrapping. `content:
      // none` is what suppresses a pseudo-element outright, and `!important`
      // is required — a Tailwind utility is a real rule that plain injected CSS
      // does not automatically outrank.
      const selectionControl = await page.addStyleTag({
        content: `
          ul[aria-label="PubMed search results"] [role="checkbox"]::before {
            content: none !important;
          }
        `,
      });

      await waitForDialogSettled(page);

      // Prove the control took effect before trusting the failure it should
      // cause. A control that reproduces nothing proves nothing.
      const suppressed = await page.evaluate(() => {
        const list = document.querySelector('ul[aria-label="PubMed search results"]') as HTMLElement;
        const checkbox = list.querySelector('[role="checkbox"]') as HTMLElement;
        return getComputedStyle(checkbox, "::before").content;
      });
      expect(suppressed, "the negative control did not suppress the pseudo-element").toBe("none");

      // …and the defect is back: the target falls all the way to the bare
      // 16x16 primitive, in both axes.
      const withoutTarget = await measureSelectionHitTarget(page, pmidAt(1));
      expect(withoutTarget.hitWidth).toBeLessThan(COARSE_POINTER_TARGET_PX);
      expect(withoutTarget.hitHeight).toBeLessThan(COARSE_POINTER_TARGET_PX);
      expect(withoutTarget.hitWidth).toBeLessThanOrEqual(withoutTarget.visualWidth + 1);
      expect(withoutTarget.hitHeight).toBeLessThanOrEqual(withoutTarget.visualHeight + 1);
      // The visible box never changed — which is precisely why a
      // `getBoundingClientRect()` assertion could not have caught this.
      expect(withoutTarget.visualWidth).toBe(before.visualWidth);
      expect(withoutTarget.visualHeight).toBe(before.visualHeight);
      // Points a finger would land on are now dead.
      expect(withoutTarget.probes.left12).toBe(false);
      expect(withoutTarget.probes.up12).toBe(false);

      // Restore the real implementation and re-prove green.
      await selectionControl.evaluate((element) => element.remove());
      await waitForDialogSettled(page);
      const restored = await measureSelectionHitTarget(page, pmidAt(1));
      expect(restored.hitWidth).toBeGreaterThanOrEqual(COARSE_POINTER_TARGET_PX);
      expect(restored.hitHeight).toBeGreaterThanOrEqual(COARSE_POINTER_TARGET_PX);
      for (const owned of Object.values(restored.probes)) expect(owned).toBe(true);

      // ── Part 2: the tab minimum ──
      // `min-h-10` on the trigger is load-bearing, not decoration: the 2x2
      // phone grid released the tab list's fixed `h-10`, and without the
      // minimum the triggers collapse to their content height.
      const tabHeights = async () =>
        page.evaluate(() => {
          const dialogEl = document.querySelector('[role="dialog"]') as HTMLElement;
          const list = dialogEl.querySelector('[role="tablist"]') as HTMLElement;
          return [...list.querySelectorAll('[role="tab"]')].map((tab) => ({
            name: tab.getAttribute("aria-label"),
            height: tab.getBoundingClientRect().height,
            minHeight: getComputedStyle(tab).minHeight,
          }));
        });

      const tabsBefore = await tabHeights();
      for (const tab of tabsBefore) {
        expect(tab.height, `${tab.name} before the control`).toBeGreaterThanOrEqual(COARSE_POINTER_TARGET_PX);
      }

      const tabControl = await page.addStyleTag({
        content: `[role="dialog"] [role="tablist"] [role="tab"] { min-height: 0 !important; }`,
      });

      // `TabsTrigger` carries `transition-all`, so `min-height` is an animated
      // property: for ~150ms after the rule lands, `getComputedStyle` returns
      // the interpolated value, which still reads 40px. Measuring immediately
      // reported that the control had not taken effect when in fact it had —
      // waiting for the transition is what makes this control honest.
      await waitForDialogSettled(page);
      const tabsWithout = await tabHeights();

      // The control took effect…
      for (const tab of tabsWithout) {
        expect(tab.minHeight, `${tab.name} kept its minimum`).toBe("0px");
      }
      // …and every trigger drops to its 32px content box — the regression
      // `min-h-10` was added to fix.
      for (const tab of tabsWithout) {
        expect(tab.height, `${tab.name} did not shrink`).toBeLessThan(COARSE_POINTER_TARGET_PX);
      }

      await tabControl.evaluate((element) => element.remove());
      await waitForDialogSettled(page);
      for (const tab of await tabHeights()) {
        expect(tab.height, `${tab.name} after restoring`).toBeGreaterThanOrEqual(COARSE_POINTER_TARGET_PX);
      }

      await expect(dialog).toBeVisible();
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
