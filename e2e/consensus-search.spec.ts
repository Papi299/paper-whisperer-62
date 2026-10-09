import { test, expect, type Locator, type Page, type Request, type Route } from "@playwright/test";
import { getPaperCount, waitForDashboard, createProject, createTag, deleteProject, deleteTag } from "./helpers";

/**
 * CONSENSUS-SEARCH-MVP-001A — owner-only Consensus discovery, end to end.
 *
 * Deterministic at three HTTP boundaries, fulfilled by Playwright:
 *
 *   • `/rest/v1/rpc/get_current_user_access` — ONLY in the owner, manager and
 *     fail-closed tests, to present this browser as the owner, a manager or a
 *     failed lookup. The ordinary-user test leaves it alone, so the real local
 *     database answers.
 *   • `/functions/v1/search-consensus`       — the discovery results.
 *   • `/functions/v1/fetch-paper-metadata`   — the canonical import metadata.
 *
 * Everything between them is the real product: the real Add Papers dialog and
 * its source selector, the real result list, selection and shared Project/Tag
 * state, the real `supabase.functions.invoke` calls and Authorization header,
 * the real `bulkImportPapers`, normalization worker and
 * `safe_bulk_insert_papers` against the ephemeral local database, the real
 * duplicate handling and the real refetch. No request ever reaches Consensus,
 * NCBI, Crossref or doi.org — the egress watch below fails the test if one is
 * even attempted — and no Consensus allowance is spent.
 *
 * Presenting the owner role through the client's own RPC response proves the
 * ADVISORY gate only. The server's independent owner check, which no browser
 * can influence, is pinned by `supabase/functions/search-consensus/__tests__`.
 *
 * ## The architectural regression this file exists to protect
 *
 * The canonical metadata stand-in answers with titles that deliberately differ
 * from the Consensus discovery titles. The library rows must show the
 * canonical ones: if Consensus display metadata were ever persisted directly,
 * the discovery wording would appear in the library and these tests fail.
 *
 * ## CONSENSUS-ADVANCED-FILTERS-001A
 *
 * The stand-in answers a request that carries any filter with its own cards,
 * numbered by request (`… filtered discovery 2.1`), so a test can prove which
 * submitted filter snapshot the cards on screen belong to. Every request body is
 * recorded in full, so the exact filters the browser sent are asserted, and the
 * count proves that editing filters sent nothing.
 */

const CONSENSUS_FUNCTION_PATH = "/functions/v1/search-consensus";
const METADATA_FUNCTION_PATH = "/functions/v1/fetch-paper-metadata";
const ACCESS_RPC_PATH = "/rest/v1/rpc/get_current_user_access";

/** Hosts the browser must never reach during this spec (subdomains included). */
const PROVIDER_HOSTS = ["consensus.app", "eutils.ncbi.nlm.nih.gov", "pubmed.ncbi.nlm.nih.gov", "api.crossref.org", "doi.org"];

/** Cleanup handle: every library row this spec can create starts with it. */
const TITLE_PREFIX = "CNS-E2E";
const PROJECT_NAME = "CNS-E2E Project";
const TAG_NAME = "CNS-E2E Tag";

const QUERY = "Does creatine improve working memory in healthy adults?";
const QUOTA_NOTE =
  "Consensus searches use your connected API allowance and run only when you press Search. Your question and any filters you set are sent to Consensus.";
const SETTINGS_CHANGED = "Search settings changed — press Search to apply.";
const FILTER_CHECKBOXES = [
  "Randomized controlled trial (RCT)",
  "Meta-analysis",
  "Systematic review",
  "Cohort study",
  "Human studies only",
  "Exclude preprints",
];

// ── Deterministic fixtures ───────────────────────────────────────────────

/** Reserved test-prefix DOIs: nothing here resolves anywhere. */
const DOI_ALPHA = "10.5555/cns-e2e.alpha";
const DOI_BRAVO = "10.5555/cns-e2e.bravo";
const DOI_CHARLIE = "10.5555/cns-e2e.charlie";

interface ConsensusFixture {
  rank: number;
  title: string;
  authors: string[];
  journal: string | null;
  year: number | null;
  abstract: string | null;
  citationCount: number | null;
  studyType: string | null;
  takeaway: string | null;
  consensusUrl: string | null;
  importDoi: string | null;
}

/** Discovery wording that must never reach the library. */
const DISCOVERY_MARK = "Consensus-only discovery wording";

function fixture(rank: number, importDoi: string | null, overrides: Partial<ConsensusFixture> = {}): ConsensusFixture {
  return {
    rank,
    title: `${DISCOVERY_MARK} ${rank}`,
    authors: ["Ada Fixture", "Ben Placeholder", "Cara Example", "Dan Sample"],
    journal: "Journal of Consensus Discovery Fixtures",
    year: 2024,
    abstract: `Invented Consensus abstract ${rank}: discovery text that is never persisted.`,
    citationCount: 40 + rank,
    studyType: "rct",
    takeaway: `Invented Consensus takeaway ${rank}.`,
    consensusUrl: `https://consensus.app/papers/cns-e2e-${rank}/0123456789abcdef0123456789abcde${rank}/?utm_source=publicapi`,
    importDoi,
    ...overrides,
  };
}

const RESULTS: ConsensusFixture[] = [
  fixture(1, DOI_ALPHA),
  fixture(2, null, { title: `${DISCOVERY_MARK} without an importable DOI` }),
  fixture(3, DOI_BRAVO),
  fixture(4, DOI_CHARLIE),
];

/** Discovery wording for the cards a FILTERED request is answered with. Never persisted either. */
const FILTERED_MARK = "Consensus-only filtered discovery";

/** The answer to the Nth Consensus request when it carries filters: its titles name N. */
function filteredResults(requestNumber: number): ConsensusFixture[] {
  return [
    fixture(1, DOI_ALPHA, { title: `${FILTERED_MARK} ${requestNumber}.1` }),
    fixture(2, null, { title: `${FILTERED_MARK} ${requestNumber}.2 without an importable DOI` }),
    fixture(3, DOI_BRAVO, { title: `${FILTERED_MARK} ${requestNumber}.3` }),
  ];
}

/**
 * DOI_BRAVO is answered the way the live `fetch-paper-metadata` answers a DOI
 * it resolved on PubMed's path: the record is labelled with its PMID, and it
 * carries the record's own DOI (here in another ASCII letter case, which is
 * DOI-equivalent). The importer must still report it under the requested DOI.
 */
const BRAVO_PUBMED_PMID = "900300002";

/** The canonical importer's answer per DOI — titles the library must show. */
const CANONICAL_TITLES: Record<string, string> = {
  [DOI_ALPHA]: `${TITLE_PREFIX} canonical record Alpha`,
  [DOI_BRAVO]: `${TITLE_PREFIX} canonical record Bravo`,
  [DOI_CHARLIE]: `${TITLE_PREFIX} canonical record Charlie`,
};

const OWNER_ACCESS_ROW = {
  role: "owner",
  is_internal: true,
  can_view_provider_quota: true,
  ai_quota_exempt: false,
  plan: null,
  plan_status: null,
  premium_taxonomy_enabled: false,
  labs_team_enabled: false,
  can_select_ai_model: false,
};

// ── Recorded boundary traffic ────────────────────────────────────────────

interface Recorder {
  /** One entry per POST to search-consensus. Never stores the bearer token. */
  consensus: Array<{ query: string; bodyKeys: string[]; authorizationIsBearer: boolean }>;
  /** The full JSON body of each search-consensus POST, in order. */
  consensusBodies: Array<Record<string, unknown>>;
  metadata: Array<{ identifiers: string[]; rawBody: string }>;
  accessRequests: number;
  providerRequests: string[];
}

/** Echo exactly what the browser's CORS preflight asked for. Local scaffolding. */
function corsFor(request: Request): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers":
      request.headers()["access-control-request-headers"] ?? "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

async function installStandIns(
  page: Page,
  options: { access: "owner" | "manager" | "real" | "fail" },
): Promise<Recorder> {
  const recorder: Recorder = { consensus: [], consensusBodies: [], metadata: [], accessRequests: 0, providerRequests: [] };

  page.on("request", (request) => {
    let hostname: string;
    try {
      hostname = new URL(request.url()).hostname.toLowerCase();
    } catch {
      return;
    }
    if (PROVIDER_HOSTS.some((host) => hostname === host || hostname.endsWith(`.${host}`))) {
      recorder.providerRequests.push(request.url());
    }
  });

  if (options.access !== "real") {
    await page.route(
      (url) => url.pathname === ACCESS_RPC_PATH,
      async (route: Route) => {
        const request = route.request();
        if (request.method() === "OPTIONS") {
          await route.fulfill({ status: 204, headers: corsFor(request), body: "" });
          return;
        }
        recorder.accessRequests += 1;
        await route.fulfill(
          options.access === "owner" || options.access === "manager"
            ? {
                status: 200,
                contentType: "application/json",
                headers: corsFor(request),
                body: JSON.stringify([{ ...OWNER_ACCESS_ROW, role: options.access }]),
              }
            : {
                status: 500,
                contentType: "application/json",
                headers: corsFor(request),
                body: JSON.stringify({ code: "XX000", message: "stand-in access failure" }),
              },
        );
      },
    );
  }

  await page.route(
    (url) => url.pathname === CONSENSUS_FUNCTION_PATH,
    async (route: Route) => {
      const request = route.request();
      if (request.method() === "OPTIONS") {
        await route.fulfill({ status: 204, headers: corsFor(request), body: "" });
        return;
      }
      const body = (request.postDataJSON() ?? {}) as Record<string, unknown>;
      recorder.consensus.push({
        query: String(body.query ?? ""),
        bodyKeys: Object.keys(body).sort(),
        authorizationIsBearer: /^Bearer \S+$/.test(request.headers()["authorization"] ?? ""),
      });
      recorder.consensusBodies.push(body);
      const filtered = Object.keys(body).some((key) => key !== "query");
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: corsFor(request),
        body: JSON.stringify({ results: filtered ? filteredResults(recorder.consensus.length) : RESULTS }),
      });
    },
  );

  await page.route(
    (url) => url.pathname === METADATA_FUNCTION_PATH,
    async (route: Route) => {
      const request = route.request();
      if (request.method() === "OPTIONS") {
        await route.fulfill({ status: 204, headers: corsFor(request), body: "" });
        return;
      }
      const raw = request.postData() ?? "";
      const body = (request.postDataJSON() ?? {}) as { identifiers?: unknown };
      const identifiers = Array.isArray(body.identifiers) ? body.identifiers.map(String) : [];
      recorder.metadata.push({ identifiers, rawBody: raw });

      const results = identifiers.map((identifier) =>
        identifier === DOI_BRAVO
          ? {
              identifier: BRAVO_PUBMED_PMID,
              title: CANONICAL_TITLES[DOI_BRAVO],
              authors: ["Canonical, B"],
              year: 2022,
              journal: "Journal of Canonical Records",
              pmid: BRAVO_PUBMED_PMID,
              doi: DOI_BRAVO.toUpperCase(),
              abstract: null,
              keywords: [],
              mesh_terms: [],
              substances: [],
              study_type: null,
              publication_types: [],
              pubmed_url: `https://pubmed.ncbi.nlm.nih.gov/${BRAVO_PUBMED_PMID}/`,
              journal_url: null,
              source: "pubmed",
            }
          : CANONICAL_TITLES[identifier]
          ? {
              identifier,
              title: CANONICAL_TITLES[identifier],
              authors: ["Canonical, A"],
              year: 2023,
              journal: "Journal of Canonical Records",
              pmid: null,
              doi: identifier,
              abstract: null,
              keywords: [],
              mesh_terms: [],
              substances: [],
              study_type: null,
              journal_url: `https://doi.org/${identifier}`,
              source: "crossref",
            }
          : { identifier, error: "No deterministic CNS-E2E fixture for this identifier" },
      );
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: corsFor(request),
        body: JSON.stringify({ results }),
      });
    },
  );

  return recorder;
}

// ── Page helpers ─────────────────────────────────────────────────────────

const COARSE_POINTER_TARGET_PX = 40;

const dialogOf = (page: Page) => page.getByRole("dialog", { name: "Add Papers" });

async function openDashboard(page: Page) {
  await page.goto("/", { waitUntil: "networkidle" });
  await waitForDashboard(page);
}

/** Wait out the dialog's zoom-in animation before measuring anything in it. */
async function waitForDialogSettled(page: Page) {
  await page.waitForFunction(() => {
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement | null;
    if (!dialog) return false;
    if (dialog.getAnimations({ subtree: true }).some((animation) => animation.playState === "running")) return false;
    for (let node: Element | null = dialog; node; node = node.parentElement) {
      const transform = getComputedStyle(node).transform;
      if (transform !== "none" && !/^matrix\(1, 0, 0, 1[,)]/.test(transform)) return false;
    }
    return true;
  });
}

async function openSearchMode(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: /add papers/i }).first().click();
  const dialog = dialogOf(page);
  await expect(dialog).toBeVisible();
  await waitForDialogSettled(page);
  await dialog.getByRole("tab", { name: "Search", exact: true }).click();
  await expect(dialog.getByLabel("Search PubMed")).toBeVisible();
  return dialog;
}

async function closeDialog(page: Page) {
  const dialog = dialogOf(page);
  if (!(await dialog.isVisible().catch(() => false))) return;
  await dialog.getByRole("button", { name: "Close", exact: true }).first().click();
  await expect(dialog).toBeHidden({ timeout: 10_000 });
}

const sourceGroup = (dialog: Locator) => dialog.getByRole("radiogroup", { name: "Search source" });

const resultCheckbox = (dialog: Locator, doi: string) =>
  dialog.getByRole("checkbox", { name: new RegExp(`^Select DOI ${doi.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} — `) });

/**
 * The region a finger can land in for one control, measured by hit-testing —
 * not its box. A filter checkbox draws 16×16 and carries a transparent 44×44
 * `::before` halo, which has no box of its own: walk outwards from the centre
 * one CSS pixel at a time and count how far `elementFromPoint` still resolves
 * to the control. The control's scroll container is moved first (never
 * `scrollIntoView`, which would park the 16px box flush with an edge and clip
 * the halo), so the measurement does not depend on what ran before it.
 */
async function hitExtent(control: Locator): Promise<{ width: number; height: number }> {
  return control.evaluate((element) => {
    for (let node = element.parentElement; node; node = node.parentElement) {
      if (/(auto|scroll)/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight) {
        const offset = element.getBoundingClientRect().top - node.getBoundingClientRect().top + node.scrollTop;
        node.scrollTop = Math.max(0, offset - node.clientHeight / 2);
        break;
      }
    }
    const rect = element.getBoundingClientRect();
    const centreX = Math.round(rect.left + rect.width / 2);
    const centreY = Math.round(rect.top + rect.height / 2);
    const owns = (x: number, y: number) => {
      if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) return false;
      const hit = document.elementFromPoint(x, y);
      return Boolean(hit && (hit === element || element.contains(hit)));
    };
    // Bounded: no legitimate target here is anywhere near 120px.
    const reach = (dx: number, dy: number) => {
      let steps = 0;
      while (steps < 120 && owns(centreX + dx * (steps + 1), centreY + dy * (steps + 1))) steps++;
      return steps;
    };
    if (!owns(centreX, centreY)) return { width: 0, height: 0 };
    return { width: reach(-1, 0) + reach(1, 0) + 1, height: reach(0, -1) + reach(0, 1) + 1 };
  });
}

/** Choose the disposable Project and Tag through the shared assign section. */
async function assignProjectAndTag(page: Page, dialog: Locator, mobile: boolean) {
  if (!mobile) {
    await dialog.getByRole("button", { name: /^Projects$/ }).click();
    await page.getByRole("option", { name: new RegExp(PROJECT_NAME) }).click();
    await page.keyboard.press("Escape");
    await dialog.getByRole("button", { name: /^Tags$/ }).click();
    await page.getByRole("option", { name: new RegExp(TAG_NAME) }).click();
    await page.keyboard.press("Escape");
  } else {
    await dialog.getByRole("button", { name: /^(Projects|\d+ projects?)$/ }).click();
    const projectSheet = page.getByRole("dialog").filter({ has: page.locator('input[aria-label="Search projects"]') });
    await projectSheet.getByRole("checkbox", { name: PROJECT_NAME }).click();
    await projectSheet.getByRole("button", { name: "Done" }).click();
    await expect(projectSheet).toHaveCount(0);
    await dialog.getByRole("button", { name: /^(Tags|\d+ tags?)$/ }).click();
    const tagSheet = page.getByRole("dialog").filter({ has: page.locator('input[aria-label="Search tags"]') });
    await tagSheet.getByRole("checkbox", { name: TAG_NAME }).click();
    await tagSheet.getByRole("button", { name: "Done" }).click();
    await expect(tagSheet).toHaveCount(0);
  }
  await expect(dialog.getByRole("button", { name: "1 project" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "1 tag" })).toBeVisible();
}

/** Every fixture paper this spec can create, removed through the real bulk-delete UI. */
async function removeFixturePapers(page: Page): Promise<number> {
  const rows = page.locator("tbody tr").filter({ hasText: TITLE_PREFIX });
  if ((await rows.count()) === 0) return 0;
  let selected = 0;
  for (let guard = 0; guard < 20; guard++) {
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
 * The owner journey, identical at both viewports: default PubMed, an
 * explicit Consensus search, results with a discovery-only row, selection,
 * shared Project/Tag assignment, the canonical DOI handoff, the summary, and
 * close/reopen returning to PubMed.
 */
async function ownerJourney(page: Page, recorder: Recorder, mobile: boolean) {
  await openDashboard(page);
  await removeFixturePapers(page);
  const initialCount = await getPaperCount(page);
  expect(initialCount).toBeGreaterThan(0);
  expect(recorder.accessRequests).toBeGreaterThan(0);

  let dialog = await openSearchMode(page);

  // ── Default source: PubMed ──
  const source = sourceGroup(dialog);
  await expect(source).toBeVisible();
  await expect(source.getByRole("radio", { name: "PubMed" })).toHaveAttribute("aria-checked", "true");
  await expect(source.getByRole("radio", { name: "Consensus" })).toHaveAttribute("aria-checked", "false");
  await expect(dialog.getByLabel("Search Consensus")).toHaveCount(0);

  if (mobile) {
    // The source choice is a real touch target and fits the phone without
    // sideways scrolling.
    for (const name of ["PubMed", "Consensus"] as const) {
      const box = await source.getByRole("radio", { name }).boundingBox();
      expect(box, `${name} source option has no box`).not.toBeNull();
      expect(box!.height, `${name} source option is below the coarse-pointer target`).toBeGreaterThanOrEqual(
        COARSE_POINTER_TARGET_PX,
      );
      expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    }
  }

  // ── Switching the source issues no request ──
  await source.getByRole("radio", { name: "Consensus" }).click();
  await expect(source.getByRole("radio", { name: "Consensus" })).toHaveAttribute("aria-checked", "true");
  await expect(dialog.getByLabel("Search Consensus")).toBeVisible();
  await expect(dialog.getByText(QUOTA_NOTE)).toBeVisible();
  expect(recorder.consensus).toHaveLength(0);

  // ── Typing issues no request; pressing Search issues exactly one ──
  await dialog.getByLabel("Search Consensus").fill(QUERY);
  expect(recorder.consensus).toHaveLength(0);
  await dialog.getByRole("button", { name: "Search", exact: true }).click();
  const list = dialog.getByRole("list", { name: "Consensus search results" });
  await expect(list).toBeVisible();
  expect(recorder.consensus).toEqual([{ query: QUERY, bodyKeys: ["query"], authorizationIsBearer: true }]);

  // ── Results ──
  await expect(dialog.getByText("Showing 4 Consensus results")).toBeVisible();
  await expect(list.locator(":scope > li")).toHaveCount(4);
  const discoveryOnly = list.locator(":scope > li").filter({ hasText: `${DISCOVERY_MARK} without an importable DOI` });
  await expect(discoveryOnly.getByText("No importable DOI available")).toBeVisible();
  await expect(discoveryOnly.getByRole("checkbox")).toHaveCount(0);
  const firstLink = list.locator(":scope > li").first().getByRole("link", { name: /Open in Consensus/ });
  await expect(firstLink).toHaveAttribute("href", RESULTS[0].consensusUrl as string);
  await expect(firstLink).toHaveAttribute("target", "_blank");
  await expect(firstLink).toHaveAttribute("rel", "noopener noreferrer");

  if (mobile) {
    // The result list never needs sideways scrolling at 390px.
    const overflow = await list.evaluate((element) => ({
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
    // The 16px checkbox carries the same enlarged hit region as PubMed's:
    // taps 16px from its centre in every direction still land on it.
    const probes = await resultCheckbox(dialog, DOI_ALPHA).evaluate((checkbox) => {
      const rect = checkbox.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      return [
        [0, 0],
        [-16, 0],
        [16, 0],
        [0, -16],
        [0, 16],
      ].map(([dx, dy]) => document.elementFromPoint(cx + dx, cy + dy)?.closest('[role="checkbox"]') === checkbox);
    });
    expect(probes).toEqual([true, true, true, true, true]);
  }

  // ── Selection ──
  await resultCheckbox(dialog, DOI_ALPHA).click();
  await resultCheckbox(dialog, DOI_BRAVO).click();
  await expect(dialog.getByText("2 papers selected")).toBeVisible();

  // ── Shared Project/Tag assignment ──
  await assignProjectAndTag(page, dialog, mobile);

  // ── The canonical handoff ──
  await dialog.getByRole("button", { name: "Import 2 Selected" }).click();
  await expect(dialog.getByText("Consensus Import Results")).toBeVisible({ timeout: 60_000 });
  await expect(dialog.getByText("Added (2)")).toBeVisible();
  // The summary lists the DOI strings that were imported — including the one
  // the importer resolved on PubMed's path, never that record's PMID.
  await expect(dialog.getByText(DOI_ALPHA, { exact: true })).toBeVisible();
  await expect(dialog.getByText(DOI_BRAVO, { exact: true })).toBeVisible();
  await expect(dialog.getByText(BRAVO_PUBMED_PMID, { exact: true })).toHaveCount(0);
  // Both imported DOIs left the selection, whichever provider resolved them.
  await expect(dialog.getByText(/papers? selected/)).toHaveCount(0);
  await expect(resultCheckbox(dialog, DOI_ALPHA)).not.toBeChecked();
  await expect(resultCheckbox(dialog, DOI_BRAVO)).not.toBeChecked();

  // THE ARCHITECTURAL ASSERTION: the canonical metadata function received
  // exactly the selected DOI strings, and nothing from Consensus beyond them.
  expect(recorder.metadata).toHaveLength(1);
  expect(recorder.metadata[0].identifiers).toEqual([DOI_ALPHA, DOI_BRAVO]);
  for (const leak of [
    DISCOVERY_MARK,
    "Ada Fixture",
    "Journal of Consensus Discovery Fixtures",
    "Invented Consensus abstract",
    "Invented Consensus takeaway",
    "consensus.app",
    "citationCount",
    "takeaway",
  ]) {
    expect(recorder.metadata[0].rawBody).not.toContain(leak);
  }
  // Importing searched nothing.
  expect(recorder.consensus).toHaveLength(1);

  // ── Close and reopen: back on PubMed, Consensus session cleared ──
  await closeDialog(page);
  dialog = await openSearchMode(page);
  await expect(sourceGroup(dialog).getByRole("radio", { name: "PubMed" })).toHaveAttribute("aria-checked", "true");
  await expect(dialog.getByLabel("Search Consensus")).toHaveCount(0);
  await sourceGroup(dialog).getByRole("radio", { name: "Consensus" }).click();
  await expect(dialog.getByLabel("Search Consensus")).toHaveValue("");
  await expect(dialog.getByRole("list", { name: "Consensus search results" })).toHaveCount(0);
  expect(recorder.consensus).toHaveLength(1);
  await closeDialog(page);

  // ── The library holds the CANONICAL records, never the discovery wording ──
  await expect.poll(() => getPaperCount(page), { timeout: 30_000 }).toBe(initialCount + 2);
  const alphaRow = page.locator("tbody tr").filter({ hasText: CANONICAL_TITLES[DOI_ALPHA] });
  await expect(alphaRow).toHaveCount(1);
  await expect(page.locator("tbody tr").filter({ hasText: CANONICAL_TITLES[DOI_BRAVO] })).toHaveCount(1);
  await expect(page.locator("tbody tr").filter({ hasText: DISCOVERY_MARK })).toHaveCount(0);
  if (!mobile) {
    await expect(alphaRow.getByText(PROJECT_NAME)).toBeVisible();
    await expect(alphaRow.getByText(TAG_NAME)).toBeVisible();
  }

  expect(recorder.providerRequests).toEqual([]);
}

// ══════════════════════════════════════════════════════════════════════════

test.describe("Owner-only Consensus discovery", () => {
  test.setTimeout(180_000);

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({ storageState: "e2e/.auth/user.json" });
    const page = await context.newPage();
    try {
      await openDashboard(page);
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
    // Order-independence: restore the deterministic seed whatever happened.
    await page.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});
    await openDashboard(page);
    await removeFixturePapers(page);
  });

  test("owner: explicit Consensus search, DOI-only canonical import, reset to PubMed (desktop)", async ({ page }) => {
    const recorder = await installStandIns(page, { access: "owner" });
    await ownerJourney(page, recorder, false);
  });

  test("owner: the same journey at 390×844", async ({ browser }) => {
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
      const recorder = await installStandIns(page, { access: "owner" });
      await ownerJourney(page, recorder, true);
    } finally {
      await context.close();
    }
  });

  test("owner: the Consensus source is operable by keyboard alone", async ({ page }) => {
    const recorder = await installStandIns(page, { access: "owner" });
    await openDashboard(page);
    const dialog = await openSearchMode(page);
    const source = sourceGroup(dialog);
    const pubmed = source.getByRole("radio", { name: "PubMed" });
    const consensus = source.getByRole("radio", { name: "Consensus" });

    // Arrow keys move between the sources; they choose nothing and search nothing.
    await pubmed.focus();
    await page.keyboard.press("ArrowRight");
    await expect(consensus).toBeFocused();
    await expect(consensus).toHaveAttribute("aria-checked", "false");
    await page.keyboard.press("Space");
    await expect(consensus).toHaveAttribute("aria-checked", "true");
    expect(recorder.consensus).toHaveLength(0);

    // Tab reaches the question; a REAL Enter is the one explicit submission.
    await page.keyboard.press("Tab");
    const field = dialog.getByLabel("Search Consensus");
    await expect(field).toBeFocused();
    await page.keyboard.type(QUERY);
    expect(recorder.consensus).toHaveLength(0);
    await page.keyboard.press("Enter");
    await expect(dialog.getByRole("list", { name: "Consensus search results" })).toBeVisible();
    expect(recorder.consensus).toEqual([{ query: QUERY, bodyKeys: ["query"], authorizationIsBearer: true }]);
    // Focus the owner placed in the field is not taken away by the results.
    await expect(field).toBeFocused();

    // A result's checkbox toggles from the keyboard.
    const alpha = resultCheckbox(dialog, DOI_ALPHA);
    await alpha.focus();
    await page.keyboard.press("Space");
    await expect(alpha).toBeChecked();
    await expect(dialog.getByText("1 paper selected")).toBeVisible();

    await closeDialog(page);
    expect(recorder.consensus).toHaveLength(1);
    expect(recorder.providerRequests).toEqual([]);
  });

  test("owner: advanced filters — drafts search nothing; one Search sends the exact body; cards follow the committed filters", async ({
    page,
  }) => {
    const recorder = await installStandIns(page, { access: "owner" });
    await openDashboard(page);
    await removeFixturePapers(page);
    const initialCount = await getPaperCount(page);

    let dialog = await openSearchMode(page);
    await sourceGroup(dialog).getByRole("radio", { name: "Consensus" }).click();
    await dialog.getByLabel("Search Consensus").fill(QUERY);

    // ── Collapsed and unset by default; the keyboard opens it ──
    const trigger = dialog.getByRole("button", { name: /^Advanced filters/ });
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(trigger).toHaveAccessibleName("Advanced filters");
    await trigger.focus();
    await page.keyboard.press("Enter");
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    for (const name of FILTER_CHECKBOXES) await expect(dialog.getByRole("checkbox", { name })).not.toBeChecked();

    // ── Edit every filter, by keyboard and pointer. Enter in a year field is not a Search ──
    const fromYear = dialog.getByLabel("From year", { exact: true });
    const toYear = dialog.getByLabel("To year", { exact: true });
    await page.keyboard.press("Tab");
    await expect(fromYear).toBeFocused();
    await page.keyboard.type("2020");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Tab");
    await expect(toYear).toBeFocused();
    await page.keyboard.type("2026");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Tab");
    const rct = dialog.getByRole("checkbox", { name: "Randomized controlled trial (RCT)" });
    await expect(rct).toBeFocused();
    await page.keyboard.press("Space");
    await expect(rct).toBeChecked();
    await dialog.getByRole("checkbox", { name: "Meta-analysis" }).click();
    await dialog.getByRole("checkbox", { name: "Human studies only" }).click();
    // The label is part of the target.
    await dialog.locator("label", { hasText: "Exclude preprints" }).click();
    await expect(dialog.getByRole("checkbox", { name: "Exclude preprints" })).toBeChecked();
    // Four categories set: the years, the designs, human-only and no-preprints.
    await expect(trigger).toHaveAccessibleName("Advanced filters · 4 set");
    expect(recorder.consensus).toHaveLength(0);

    // ── One explicit Search: exactly one request, carrying exactly these filters ──
    await dialog.getByRole("button", { name: "Search", exact: true }).click();
    const list = dialog.getByRole("list", { name: "Consensus search results" });
    await expect(list.getByText(`${FILTERED_MARK} 1.1`, { exact: true })).toBeVisible();
    expect(recorder.consensusBodies).toEqual([
      { query: QUERY, yearMin: 2020, yearMax: 2026, studyTypes: ["rct", "meta-analysis"], human: true, excludePreprints: true },
    ]);
    expect(recorder.consensus[0].authorizationIsBearer).toBe(true);
    const applied = dialog.getByText("Applied filters:", { exact: true }).locator("xpath=..");
    await expect(applied).toHaveText("Applied filters: 2020–2026 · RCT + Meta-analysis · Human only · No preprints");
    await expect(dialog.getByText(SETTINGS_CHANGED)).toHaveCount(0);
    // A filtered search's discovery-only result is still not importable.
    const discoveryOnly = list.locator(":scope > li").filter({ hasText: "without an importable DOI" });
    await expect(discoveryOnly.getByText("No importable DOI available")).toBeVisible();
    await expect(discoveryOnly.getByRole("checkbox")).toHaveCount(0);

    // ── Changing a filter afterwards sends nothing and re-labels nothing ──
    await dialog.getByRole("checkbox", { name: "Human studies only" }).click();
    await expect(dialog.getByText(SETTINGS_CHANGED)).toBeVisible();
    await expect(applied).toHaveText("Applied filters: 2020–2026 · RCT + Meta-analysis · Human only · No preprints");
    await expect(list.getByText(`${FILTERED_MARK} 1.1`, { exact: true })).toBeVisible();
    expect(recorder.consensus).toHaveLength(1);

    // ── The next explicit Search applies the new snapshot, and its cards replace the old ──
    await dialog.getByRole("button", { name: "Search", exact: true }).click();
    await expect(list.getByText(`${FILTERED_MARK} 2.1`, { exact: true })).toBeVisible();
    await expect(list.getByText(`${FILTERED_MARK} 1.1`, { exact: true })).toHaveCount(0);
    expect(recorder.consensusBodies[1]).toEqual({
      query: QUERY,
      yearMin: 2020,
      yearMax: 2026,
      studyTypes: ["rct", "meta-analysis"],
      excludePreprints: true,
    });
    await expect(applied).toHaveText("Applied filters: 2020–2026 · RCT + Meta-analysis · No preprints");
    await expect(dialog.getByText(SETTINGS_CHANGED)).toHaveCount(0);

    // ── Importing from a filtered search is still the canonical DOI handoff ──
    await resultCheckbox(dialog, DOI_ALPHA).click();
    await dialog.getByRole("button", { name: "Import 1 Selected" }).click();
    await expect(dialog.getByText("Consensus Import Results")).toBeVisible({ timeout: 60_000 });
    await expect(dialog.getByText("Added (1)")).toBeVisible();
    expect(recorder.metadata).toHaveLength(1);
    expect(recorder.metadata[0].identifiers).toEqual([DOI_ALPHA]);
    for (const leak of [FILTERED_MARK, "yearMin", "studyTypes", "meta-analysis", "excludePreprints", "human", "consensus.app"]) {
      expect(recorder.metadata[0].rawBody).not.toContain(leak);
    }
    expect(recorder.consensus).toHaveLength(2);

    // ── Reset filters clears the draft only, and searches nothing ──
    await dialog.getByRole("button", { name: "Reset filters" }).click();
    await expect(fromYear).toHaveValue("");
    await expect(toYear).toHaveValue("");
    for (const name of FILTER_CHECKBOXES) await expect(dialog.getByRole("checkbox", { name })).not.toBeChecked();
    await expect(dialog.getByLabel("Search Consensus")).toHaveValue(QUERY);
    await expect(applied).toHaveText("Applied filters: 2020–2026 · RCT + Meta-analysis · No preprints");
    expect(recorder.consensus).toHaveLength(2);

    // ── Close and reopen: the question and every filter are reset ──
    await closeDialog(page);
    dialog = await openSearchMode(page);
    await sourceGroup(dialog).getByRole("radio", { name: "Consensus" }).click();
    await expect(dialog.getByLabel("Search Consensus")).toHaveValue("");
    const reopened = dialog.getByRole("button", { name: /^Advanced filters/ });
    await expect(reopened).toHaveAccessibleName("Advanced filters");
    await expect(reopened).toHaveAttribute("aria-expanded", "false");
    await reopened.click();
    await expect(dialog.getByLabel("From year", { exact: true })).toHaveValue("");
    for (const name of FILTER_CHECKBOXES) await expect(dialog.getByRole("checkbox", { name })).not.toBeChecked();
    await expect(dialog.getByText("Applied filters:", { exact: true })).toHaveCount(0);
    await closeDialog(page);

    // ── The library holds the canonical record, never filtered discovery wording ──
    await expect.poll(() => getPaperCount(page), { timeout: 30_000 }).toBe(initialCount + 1);
    await expect(page.locator("tbody tr").filter({ hasText: CANONICAL_TITLES[DOI_ALPHA] })).toHaveCount(1);
    await expect(page.locator("tbody tr").filter({ hasText: FILTERED_MARK })).toHaveCount(0);
    expect(recorder.consensus).toHaveLength(2);
    expect(recorder.providerRequests).toEqual([]);
  });

  test("owner: advanced filters at 390×844 — compact, touch-sized, and one tap of Search", async ({ browser }) => {
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
      const recorder = await installStandIns(page, { access: "owner" });
      await openDashboard(page);
      // The 44px sizes below are coarse-pointer sizes: prove this run is one.
      expect(await page.evaluate(() => window.matchMedia("(pointer: coarse)").matches)).toBe(true);

      const dialog = await openSearchMode(page);
      await sourceGroup(dialog).getByRole("radio", { name: "Consensus" }).click();
      await dialog.getByLabel("Search Consensus").fill(QUERY);
      const trigger = dialog.getByRole("button", { name: /^Advanced filters/ });
      await trigger.tap();
      await expect(trigger).toHaveAttribute("aria-expanded", "true");

      // Buttons and year fields are at least 44px tall and fit the phone.
      for (const control of [
        trigger,
        dialog.getByRole("button", { name: "Reset filters" }),
        dialog.getByLabel("From year", { exact: true }),
        dialog.getByLabel("To year", { exact: true }),
      ]) {
        const box = await control.boundingBox();
        expect(box, "filter control has no box").not.toBeNull();
        expect(box!.height).toBeGreaterThanOrEqual(44);
        expect(box!.x + box!.width).toBeLessThanOrEqual(390);
      }
      // Every 16px checkbox carries a hit region a finger can find.
      for (const name of FILTER_CHECKBOXES) {
        const extent = await hitExtent(dialog.getByRole("checkbox", { name }));
        expect(extent.width, `${name} hit width`).toBeGreaterThanOrEqual(40);
        expect(extent.height, `${name} hit height`).toBeGreaterThanOrEqual(40);
      }
      // Nothing in the dialog needs sideways scrolling.
      const overflow = await dialog.evaluate((element) => ({ scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }));
      expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);

      // Taps edit the draft — a tap on a label included — and send nothing.
      await dialog.getByLabel("From year", { exact: true }).fill("2015");
      await dialog.locator("label", { hasText: "Systematic review" }).tap();
      await dialog.getByRole("checkbox", { name: "Human studies only" }).tap();
      await expect(dialog.getByRole("checkbox", { name: "Systematic review" })).toBeChecked();
      expect(recorder.consensus).toHaveLength(0);

      await dialog.getByRole("button", { name: "Search", exact: true }).tap();
      await expect(dialog.getByRole("list", { name: "Consensus search results" })).toBeVisible();
      expect(recorder.consensusBodies).toEqual([{ query: QUERY, yearMin: 2015, studyTypes: ["systematic review"], human: true }]);
      await expect(dialog.getByText("Applied filters:", { exact: true }).locator("xpath=..")).toHaveText(
        "Applied filters: From 2015 · Systematic review · Human only",
      );

      await closeDialog(page);
      expect(recorder.consensus).toHaveLength(1);
      expect(recorder.providerRequests).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test("ordinary user: the real access lookup answers 'user' and no Consensus control exists", async ({ page }) => {
    const recorder = await installStandIns(page, { access: "real" });
    const accessResponse = page.waitForResponse(
      (response) => new URL(response.url()).pathname === ACCESS_RPC_PATH && response.request().method() === "POST",
    );
    await openDashboard(page);
    const response = await accessResponse;
    expect(response.status()).toBe(200);
    const rows = (await response.json()) as Array<{ role?: unknown }>;
    expect(rows[0]?.role).toBe("user");

    const dialog = await openSearchMode(page);
    await expect(dialog.getByRole("tab", { name: "Search", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(sourceGroup(dialog)).toHaveCount(0);
    await expect(dialog.getByRole("radio")).toHaveCount(0);
    await expect(dialog.getByLabel("Search Consensus")).toHaveCount(0);
    await expect(dialog.getByText(/Consensus/)).toHaveCount(0);
    await expect(dialog.getByText("Search PubMed, import by identifier, upload a file, or add manually.")).toBeVisible();
    await closeDialog(page);

    expect(recorder.consensus).toEqual([]);
    expect(recorder.providerRequests).toEqual([]);
  });

  test("a manager gets no Consensus control — the pilot is owner-only", async ({ page }) => {
    const recorder = await installStandIns(page, { access: "manager" });
    await openDashboard(page);
    await expect.poll(() => recorder.accessRequests).toBeGreaterThan(0);

    const dialog = await openSearchMode(page);
    await expect(sourceGroup(dialog)).toHaveCount(0);
    await expect(dialog.getByLabel("Search Consensus")).toHaveCount(0);
    await expect(dialog.getByText(/Consensus/)).toHaveCount(0);
    await closeDialog(page);
    expect(recorder.consensus).toEqual([]);
  });

  test("a failed access lookup fails closed: no Consensus control", async ({ page }) => {
    const recorder = await installStandIns(page, { access: "fail" });
    await openDashboard(page);
    await expect.poll(() => recorder.accessRequests).toBeGreaterThan(0);

    const dialog = await openSearchMode(page);
    await expect(sourceGroup(dialog)).toHaveCount(0);
    await expect(dialog.getByLabel("Search Consensus")).toHaveCount(0);
    await closeDialog(page);
    expect(recorder.consensus).toEqual([]);
  });
});
