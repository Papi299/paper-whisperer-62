import { test, expect, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { assertLocalSupabaseUrl, assertOriginsMatch } from "./support/backend-guard";
import { watchStudyRecordTraffic } from "./support/study-record-traffic";
import { waitForDashboard } from "./helpers";

/**
 * EVIDENCE-RECORDS-001C2C-B — "Use current abstract", end to end, against the
 * local stack and the installed `evidence_rebase_source`. Synthetic data only,
 * in two disposable accounts of this spec's own, which the lifecycle
 * provisions through the installed RPCs and the owner's own paper edits
 * (`scripts/e2e-local-rebase-fixture.mjs`) — no copy, quote, review or event
 * is inserted directly:
 *
 *   * the PILOT OWNER (`internal_user_access.role = 'owner'`, local only):
 *     R1 a changed abstract adopted through the UI — the confirmation lists
 *     each field whose review changes, one request carries the SHA-256 of the
 *     exact text shown, the server's own counts are reported, the new copy is
 *     shown, the earlier ones open, Review and History say what happened ·
 *     R2 a first copy for a record without one · R3 a typography-only
 *     difference: keeping the copy is the default, Cancel sends nothing ·
 *     R4 an unsaved edit and an open Flag note hold the write, and lose
 *     nothing · R5 a library abstract changed while the confirmation was open
 *     is refused, and read again · R6 an answer lost in transit: Try again
 *     resends the same request, and the server replays it · R7 an unchanged
 *     answer saves nothing — and on a phone (R8), the action and its
 *     confirmation scroll nothing sideways and every control is a reachable
 *     touch target;
 *   * a FORMER OWNER now `manager` (R9): compares, is offered no write, and
 *     the server refuses a rebase sent directly.
 *
 * The traffic watch allows `evidence_rebase_source` alone, and records each
 * body sent. After the run the lifecycle checks as the database owner what
 * each rebase wrote — versions, copies (the earlier ones unchanged), quote
 * offsets, reviews, one request's events in order — and that every other
 * record is exactly as provisioned; then it removes both accounts, verifying
 * nothing of theirs remains.
 *
 * Switching between linked PAPERS is not exercised: no installed RPC links a
 * second paper, so only the component tests cover a second link.
 */

const CLIENT_MODULE_PATH = "/src/integrations/supabase/client.ts";
const REBASE_RPC = "evidence_rebase_source";

const TITLES = {
  changed: "SRRB-E2E Changed trial",
  added: "SRRB-E2E New abstract trial",
  retry: "SRRB-E2E Retry trial",
  stale: "SRRB-E2E Stale trial",
  typography: "SRRB-E2E Typography trial",
  holds: "SRRB-E2E Holds trial",
  phone: "SRRB-E2E Phone trial",
  unchanged: "SRRB-E2E Unchanged trial",
  former: "SRRB-E2E Former owner's trial",
};

const CHANGED_FIRST =
  "Background: A synthetic trial of metformin in adults with type 2 diabetes at three hospitals.\nMethods: Participants aged 40 to 70 years were randomized to metformin or placebo for 24 weeks.\nResults: HbA1c fell by 0.8 % with metformin.";

/** As the fixture wrote them. */
const TEXTS = {
  changedSecond: `${CHANGED_FIRST}\nConclusions: Metformin lowered HbA1c.`,
  changedLibrary:
    "Background: A synthetic trial of metformin in adults with type 2 diabetes at four hospitals.\nMethods: Participants aged 40 to 70 years were randomized to metformin or placebo for 26 weeks; in a second phase they were randomized to metformin or placebo again.\nResults: HbA1c fell by 0.8 % with metformin.\nConclusions: Metformin lowered HbA1c.",
  added: "Background: A synthetic trial of tai chi in older adults.\nMethods: 70 participants were randomized to tai chi or usual care.",
  retryLibrary: "Background: A synthetic trial of a low-salt diet in adults with heart failure.\nMethods: 84 participants were randomized at four hospitals.",
  staleLibrary: "Background: A synthetic trial of daily walking in adults with hypertension.\nMethods: 92 participants were randomized.",
  staleEdited: "Background: A synthetic trial of daily walking in adults with hypertension.\nMethods: 94 participants were randomized for 16 weeks.",
  unchanged: "Background: A synthetic trial of mindfulness in nurses.\nMethods: 40 participants were randomized.",
  formerLibrary: "Background: A synthetic trial of music therapy after surgery.\nMethods: 48 participants were randomized.",
};

const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing ${name}. The study-records-rebase spec runs only through \`npm run test:e2e:local\`, which provisions its accounts.`);
  }
  return value;
}

/** Sign in as one of this spec's accounts, after re-asserting the Layer 2 backend guard. */
async function signIn(page: Page, emailVar: string, passwordVar: string) {
  const expectedOrigin = requireEnv("E2E_EXPECTED_SUPABASE_URL");
  await page.goto("/auth", { waitUntil: "networkidle" });
  const browserOrigin = await page.evaluate(async (modPath) => {
    const mod = await import(modPath);
    const client = (mod as { supabase?: Record<string, unknown> }).supabase ?? {};
    for (const candidate of [client["supabaseUrl"], client["authUrl"], client["realtimeUrl"]]) {
      if (candidate) {
        try {
          return new URL(String(candidate)).origin;
        } catch {
          /* try the next one */
        }
      }
    }
    return null;
  }, CLIENT_MODULE_PATH);
  if (!browserOrigin) throw new Error("study-records-rebase spec could not read the browser-loaded Supabase origin; refusing to continue.");
  assertLocalSupabaseUrl(browserOrigin, "browser-loaded Supabase origin");
  assertOriginsMatch(expectedOrigin, browserOrigin, { label: "Supabase origin (expected vs browser-loaded)" });

  await page.getByPlaceholder("you@example.com").fill(requireEnv(emailVar));
  await page.getByPlaceholder("••••••••").fill(requireEnv(passwordVar));
  await page.getByRole("button", { name: /sign in/i }).click();
  await waitForDashboard(page);
}

// ── Reads and writes through the app's own client (the signed-in user, under RLS) ──

type DbError = { code?: string; message?: string } | null;
type Client = {
  from: (table: string) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
  rpc: (name: string, args: unknown) => Promise<{ data: unknown; error: DbError }>;
  auth: { getUser: () => Promise<{ data: { user: { id: string } | null } }> };
};

interface StudyState {
  userId: string;
  studyId: string;
  paperId: string;
  version: number;
}

/** The study a paper reports, as its owner reads it. */
async function studyOf(page: Page, title: string): Promise<StudyState> {
  return page.evaluate(
    async ({ modPath, title }) => {
      const { supabase: client } = (await import(modPath)) as { supabase: Client };
      const user = (await client.auth.getUser()).data.user;
      if (!user) throw new Error("not signed in");
      const paper = await client.from("papers").select("id").eq("title", title).single();
      if (paper.error) throw new Error(paper.error.message);
      const link = await client.from("evidence_study_reports").select("study_id").eq("paper_id", (paper.data as { id: string }).id).single();
      if (link.error) throw new Error(link.error.message);
      const studyId = (link.data as { study_id: string }).study_id;
      const study = await client.from("evidence_studies").select("row_version").eq("id", studyId).single();
      if (study.error) throw new Error(study.error.message);
      return { userId: user.id, studyId, paperId: (paper.data as { id: string }).id, version: (study.data as { row_version: number }).row_version };
    },
    { modPath: CLIENT_MODULE_PATH, title },
  );
}

/** The library abstract edited "in another tab": the owner's own paper update, as Edit Paper makes it — no study-record write. */
async function editLibraryAbstract(page: Page, paperId: string, abstract: string) {
  const error = await page.evaluate(
    async ({ modPath, paperId, abstract }) => {
      const { supabase: client } = (await import(modPath)) as { supabase: Client };
      const { error } = await client.from("papers").update({ abstract }).eq("id", paperId);
      return error ? error.message : null;
    },
    { modPath: CLIENT_MODULE_PATH, paperId, abstract },
  );
  expect(error).toBeNull();
}

/** A rebase sent directly, outside the UI, with the SHA-256 of `abstract`. */
async function rebaseDirectly(page: Page, study: StudyState, abstract: string): Promise<{ data: Record<string, unknown> | null; error: DbError }> {
  return page.evaluate(
    async ({ modPath, study, sha }) => {
      const { supabase: client } = (await import(modPath)) as { supabase: Client };
      const { data, error } = await client.rpc("evidence_rebase_source", {
        p_study_id: study.studyId,
        p_paper_id: study.paperId,
        p_expected_version: study.version,
        p_expected_abstract_sha256: sha,
        p_request_id: crypto.randomUUID(),
      });
      return { data: (data ?? null) as Record<string, unknown> | null, error: error ? { code: error.code, message: error.message } : null };
    },
    { modPath: CLIENT_MODULE_PATH, study, sha: sha256(abstract) },
  );
}

// ── UI helpers ──

function studyDialog(page: Page) {
  return page.getByTestId("study-record-dialog");
}

async function openStudy(page: Page, title: string, label: string) {
  await page.getByRole("button", { name: `Expand abstract for ${title}` }).click();
  const entry = page.getByTestId("study-record-entry");
  await expect(entry.getByTestId("study-record-entry-status")).toHaveText("Study records — 1");
  await entry.getByRole("button", { name: "Open study record" }).click();
  await expect(studyDialog(page).getByRole("heading", { name: `Study record: ${label}` })).toBeVisible();
}

async function closeStudy(page: Page, title: string) {
  await studyDialog(page).getByRole("button", { name: "Close" }).last().click();
  await expect(studyDialog(page)).toBeHidden();
  await page.getByRole("button", { name: `Collapse abstract for ${title}` }).click();
}

const sourcePane = (page: Page) => studyDialog(page).getByTestId("study-record-source-pane");
const banner = (page: Page) => sourcePane(page).getByTestId("source-status");
const compareView = (page: Page) => studyDialog(page).getByTestId("source-compare");
const panel = (page: Page) => sourcePane(page).getByTestId("source-update");
const actionButton = (page: Page) => panel(page).getByRole("button", { name: "Use current abstract" });
const confirmation = (page: Page) => page.getByTestId("source-update-dialog");
const outcome = (page: Page) => sourcePane(page).getByTestId("source-update-outcome");

async function chooseMode(page: Page, name: "Edit" | "Review" | "History") {
  const tab = studyDialog(page).getByRole("tablist", { name: "Study record mode" }).getByRole("tab", { name });
  await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
}

/** Open Compare from the banner once the library read says `state`, and wait for the action to be offered. */
async function openCompare(page: Page, state: string, opener = "source-compare-open") {
  await expect(banner(page)).toHaveAttribute("data-source-state", state);
  await sourcePane(page).getByTestId(opener).click();
  await expect(compareView(page)).toBeVisible();
}

const marked = (element: Locator) => element.locator("mark").evaluateAll((marks) => marks.map((mark) => mark.textContent));
const lines = (element: Locator) => element.locator("p").allTextContents();

/** No sideways scroll anywhere in the dialogs: every scrolling box fits its content (the 1 px sr-only boxes aside). */
async function expectNoSidewaysScroll(page: Page, where: string) {
  const overflow = await page.evaluate(() => {
    const roots = [...document.querySelectorAll("[data-testid=study-record-dialog], [data-testid=source-update-dialog]")];
    const boxes: string[] = [];
    for (const root of roots) {
      for (const element of [root, ...root.querySelectorAll("*")]) {
        const style = getComputedStyle(element);
        if (style.overflowX === "visible" || element.classList.contains("sr-only") || element.clientWidth <= 1) continue;
        if (element.scrollWidth > element.clientWidth) boxes.push(`${element.tagName.toLowerCase()}[${element.getAttribute("data-testid") ?? element.className}] ${element.scrollWidth}>${element.clientWidth}`);
      }
    }
    return { document: document.documentElement.scrollWidth - document.documentElement.clientWidth, boxes };
  });
  expect(overflow.document, `${where}: no document-level sideways scroll`).toBeLessThanOrEqual(0);
  expect(overflow.boxes, `${where}: nothing in the dialog scrolls sideways`).toEqual([]);
}

/** The control a tap at its centre reaches is the control itself (or inside it), not something covering it. */
async function expectReachable(control: Locator, what: string) {
  await control.scrollIntoViewIfNeeded();
  const hit = await control.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const at = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return { reached: at === el || el.contains(at), height: box.height, left: box.left, right: box.right };
  });
  expect(hit.reached, `${what}: a tap at its centre reaches it`).toBe(true);
  return hit;
}

// ─────────────────────────────────────────────────────────────────────────────

test.describe("Use current abstract — the pilot owner", () => {
  test.describe.configure({ mode: "serial" });

  let context: BrowserContext;
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext({ storageState: { cookies: [], origins: [] }, viewport: DESKTOP });
    page = await context.newPage();
    await signIn(page, "E2E_STUDY_REBASE_OWNER_EMAIL", "E2E_STUDY_REBASE_OWNER_PASSWORD");
  });

  test.afterAll(async () => {
    await context?.close();
  });

  test("R1 · a changed abstract adopted: what it does, one request with the exact SHA-256, the server's counts, the new copy, the earlier ones, Review and History", async () => {
    test.setTimeout(60_000);
    const before = await studyOf(page, TITLES.changed);
    expect(before.version).toBe(7);
    const traffic = watchStudyRecordTraffic(page, [REBASE_RPC]);
    await openStudy(page, TITLES.changed, "SRRB Changed trial");
    await openCompare(page, "content_change");
    await expect(panel(page)).toContainText("Your record keeps saved copy 2 unless you choose to use the abstract in your library instead.");
    await expect(actionButton(page)).not.toHaveAttribute("aria-disabled");
    await actionButton(page).click();

    // The confirmation: from the record, never a forecast of which quotes will be found.
    const dialog = confirmation(page);
    await expect(dialog.getByRole("heading", { name: "Use the current abstract?" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    const impact = dialog.getByTestId("source-update-impact");
    await expect(impact).toContainText(`Paper: “${TITLES.changed}”`);
    await expect(impact).toContainText("The record's saved copy now: copy 2 of 2");
    await expect(impact).toContainText(`${Array.from(TEXTS.changedLibrary).length} characters — as copy 3, the record's current copy.`);
    await expect(impact).toContainText("Copies 1 to 2 stay with the record, and you can still open them.");
    await expect(impact).toContainText(
      "PaperLume will check existing quotations against the new abstract. Quotations that cannot be matched uniquely will remain linked to their earlier saved copies.",
    );
    await expect(impact).toContainText("4 quotes on copy 2 will be checked.");
    await expect(impact.getByTestId("source-update-needs-rereview").getByRole("listitem")).toHaveText([
      "Setting (countries, care setting) — now Flagged",
      "Condition or health status — now Reviewed by you",
    ]);
    await expect(impact.getByTestId("source-update-stays-rereview").getByRole("listitem")).toHaveText(["Who took part"]);
    await expect(impact.getByTestId("source-update-stays-unreviewed").getByRole("listitem")).toHaveText(["Key demographics (for example age, sex)"]);
    await expect(impact).not.toContainText("Eligibility criteria");
    expect(traffic.bodiesOf(REBASE_RPC)).toEqual([]);

    await dialog.getByRole("button", { name: "Save as copy 3" }).click();
    await expect(outcome(page)).toHaveAttribute("data-outcome", "applied");
    await expect(outcome(page)).toBeFocused();
    // The server's own answer, in words.
    expect(await lines(outcome(page))).toEqual([
      "Saved copy 3 of this paper's abstract as the record's current copy.",
      "Copies 1 to 2 are kept, and you can still open them.",
      "4 quotes were checked against copy 3: 2 found exactly once and moved to it, 1 not found, 1 found more than once.",
      "Quotes not found exactly once stay on copy 2.",
      "2 fields now need re-review.",
    ]);
    // One request: the exact text shown, hashed as UTF-8, at the version shown.
    const bodies = traffic.bodiesOf(REBASE_RPC);
    expect(bodies).toHaveLength(1);
    expect(Object.keys(bodies[0]).sort()).toEqual(["p_expected_abstract_sha256", "p_expected_version", "p_paper_id", "p_request_id", "p_study_id"]);
    expect(bodies[0]).toMatchObject({ p_study_id: before.studyId, p_paper_id: before.paperId, p_expected_version: 7, p_expected_abstract_sha256: sha256(TEXTS.changedLibrary) });
    expect(String(bodies[0].p_request_id)).toMatch(UUID);
    expect((await studyOf(page, TITLES.changed)).version).toBe(8);

    // The pane shows the new current copy, with the quotes that moved to it marked.
    const current = sourcePane(page).getByTestId("study-record-saved-abstract");
    await expect(current).toHaveText(TEXTS.changedLibrary);
    await expect(banner(page)).toHaveAttribute("data-source-state", "current");
    expect(await marked(current)).toEqual(["adults with type 2 diabetes", "aged 40 to 70 years"]);
    // The earlier copies stay, read-only; copy 2 keeps the quotes not found exactly once.
    const copies = sourcePane(page).getByTestId("saved-copies");
    await expect(copies).toContainText("Saved copies of this abstract (3)");
    await copies.getByRole("button", { name: "Show saved copies" }).click();
    await copies.getByRole("button", { name: "Show copy 2" }).click();
    const earlier = sourcePane(page).getByTestId("earlier-copy");
    await expect(earlier.getByRole("heading", { name: "Copy 2 of 3 — an earlier saved copy" })).toBeFocused();
    await expect(earlier.getByTestId("earlier-copy-text")).toHaveText(TEXTS.changedSecond);
    expect(await marked(earlier.getByTestId("earlier-copy-text"))).toEqual(["at three hospitals", "were randomized to metformin or placebo"]);
    await earlier.getByTestId("earlier-copy-back").click();

    // Review: the statuses the server set — and the one it left alone.
    await chooseMode(page, "Review");
    await studyDialog(page).getByRole("radio", { name: /All recorded/ }).click();
    const status = (field: string) => studyDialog(page).getByTestId(`review-card-study|${field}`).getByTestId("review-status");
    await expect(status("condition")).toHaveText(/Needs re-review — a new copy of the abstract was saved/);
    await expect(status("setting")).toHaveText(/Needs re-review — a new copy of the abstract was saved/);
    await expect(studyDialog(page).getByTestId("review-card-study|setting").getByTestId("review-note")).toHaveText("Your earlier review note: Check the hospitals");
    await expect(status("population_description")).toHaveText(/Needs re-review/);
    await expect(status("demographics")).toHaveText(/Not reviewed/);
    await expect(status("eligibility_criteria")).toHaveText(/Reviewed by you on/);

    // History: the operation as recorded, read afresh.
    await chooseMode(page, "History");
    const entry = studyDialog(page).locator("[data-history-version='8']");
    await expect(entry.getByRole("heading", { name: "Copy of the library abstract saved" })).toBeVisible();
    await entry.getByTestId("history-entry-toggle").click();
    const changes = entry.getByTestId("history-change");
    await expect(changes).toHaveCount(8);
    await expect(changes.nth(0)).toContainText(`Saved a new copy of the abstract of the paper now titled “${TITLES.changed}”`);
    await expect(changes.nth(1)).toContainText("Condition or health status: a quote was found again in copy 3");
    await expect(changes.nth(3)).toContainText("Who took part: a quote was found more than once in the new copy");
    await expect(changes.nth(4)).toContainText("Setting (countries, care setting): a quote wasn't found in the new copy");
    await expect(changes.nth(5)).toContainText("Condition or health status: needs re-review — a new copy of the abstract was saved");
    await expect(changes.nth(6)).toContainText("Its review note is kept.");
    await expect(changes.nth(7)).toContainText("4 quotes rechecked: 2 found again, 1 not found, 1 found more than once.");
    await expect(changes.nth(7)).toContainText("2 fields were marked as needing re-review.");
    await chooseMode(page, "Edit");

    await closeStudy(page, TITLES.changed);
    traffic.stop();
    expect(traffic.forbidden).toEqual([]);
    expect(traffic.rpcs.filter((rpc) => !traffic.reads.includes(rpc))).toEqual([REBASE_RPC]);
  });

  test("R2 · a first copy for a record without one: said to replace nothing, and the field that couldn't check the abstract named", async () => {
    const before = await studyOf(page, TITLES.added);
    expect(before.version).toBe(3);
    const traffic = watchStudyRecordTraffic(page, [REBASE_RPC]);
    await openStudy(page, TITLES.added, "SRRB New abstract trial");
    await openCompare(page, "abstract_now_available");
    await expect(panel(page)).toContainText("Using the library abstract saves it as the record's first copy, so it can be quoted.");
    await expect(actionButton(page)).not.toHaveAttribute("aria-disabled");
    await actionButton(page).click();
    const dialog = confirmation(page);
    await expect(dialog).toContainText("The record has no saved copy of this paper's abstract yet.");
    await expect(dialog).toContainText("as the record's first copy");
    await expect(dialog).toContainText("With no earlier copy, there are no quotes to check.");
    await expect(dialog).not.toContainText("stay with the record");
    await expect(dialog.getByTestId("source-update-needs-rereview").getByRole("listitem")).toHaveText(["Condition or health status — now Reviewed by you"]);
    await expect(dialog.getByTestId("source-update-unavailable")).toContainText("1 field says this paper had no abstract to check.");
    await dialog.getByRole("button", { name: "Save as the first copy" }).click();
    await expect(outcome(page)).toHaveAttribute("data-outcome", "applied");
    expect(await lines(outcome(page))).toEqual([
      "Saved copy 1 of this paper's abstract — the record's first copy.",
      "There was no earlier copy, so no quote was checked.",
      "1 field now needs re-review.",
    ]);
    expect(traffic.bodiesOf(REBASE_RPC)).toEqual([
      expect.objectContaining({ p_study_id: before.studyId, p_paper_id: before.paperId, p_expected_version: 3, p_expected_abstract_sha256: sha256(TEXTS.added) }),
    ]);
    await expect(sourcePane(page).getByTestId("study-record-saved-abstract")).toHaveText(TEXTS.added);
    await expect(banner(page)).toHaveAttribute("data-source-state", "current");

    await chooseMode(page, "History");
    const entry = studyDialog(page).locator("[data-history-version='4']");
    await expect(entry.getByRole("heading", { name: "Copy of the library abstract saved" })).toBeVisible();
    await entry.getByTestId("history-entry-toggle").click();
    const changes = entry.getByTestId("history-change");
    await expect(changes).toHaveCount(3);
    await expect(changes.nth(0)).toContainText(`Saved a copy of the abstract of the paper now titled “${TITLES.added}”`);
    await expect(changes.nth(2)).toContainText("No quotes to recheck: this was the first saved copy of the abstract");
    await expect(changes.nth(2)).toContainText("1 field was marked as needing re-review.");
    await expect(entry).not.toContainText(/replac|rechecked:/);
    await chooseMode(page, "Edit");
    await closeStudy(page, TITLES.added);
    traffic.stop();
    expect(traffic.forbidden).toEqual([]);
  });

  test("R3 · a typography-only difference: keeping the copy is the default, the choice explicit — and Cancel sends nothing", async () => {
    const traffic = watchStudyRecordTraffic(page, [REBASE_RPC]);
    await openStudy(page, TITLES.typography, "SRRB Typography trial");
    await openCompare(page, "typography_only_change");
    await expect(panel(page)).toContainText("Keeping saved copy 1 is the default: the two differ only in characters quote matching treats as the same.");
    await expect(actionButton(page)).not.toHaveAttribute("aria-disabled");
    await actionButton(page).click();
    await expect(confirmation(page)).toContainText("Keeping the saved copy is the default; nothing changes unless you save.");
    await confirmation(page).getByRole("button", { name: "Cancel" }).click();
    await expect(confirmation(page)).toBeHidden();
    await expect(actionButton(page)).toBeFocused();
    await closeStudy(page, TITLES.typography);
    traffic.stop();
    expect(traffic.forbidden).toEqual([]);
    expect(traffic.bodiesOf(REBASE_RPC)).toEqual([]);
  });

  test("R4 · an unsaved edit, then an open Flag note, hold the write — and lose nothing", async () => {
    const traffic = watchStudyRecordTraffic(page, [REBASE_RPC]);
    await openStudy(page, TITLES.holds, "SRRB Holds trial");
    // An unsaved edit.
    const name = studyDialog(page).getByLabel("Study name");
    await name.fill("SRRB Holds trial (draft)");
    await openCompare(page, "content_change");
    await expect(actionButton(page)).toHaveAttribute("aria-disabled", "true");
    await expect(panel(page).getByTestId("source-update-reason")).toHaveText(/Save or undo your unsaved changes first/);
    // Pressed anyway (it stays focusable, so its reason is read): nothing opens.
    await actionButton(page).click({ force: true });
    await expect(confirmation(page)).toHaveCount(0);
    await name.fill("SRRB Holds trial");
    await expect(actionButton(page)).not.toHaveAttribute("aria-disabled");

    // A Flag note started in Review, then left open.
    await chooseMode(page, "Review");
    const card = studyDialog(page).getByTestId("review-card-study|condition");
    await card.getByRole("button", { name: "Flag…" }).click();
    await card.getByLabel("What's wrong with this value?").fill("Half a thought");
    await chooseMode(page, "Edit");
    await expect(actionButton(page)).toHaveAttribute("aria-disabled", "true");
    await expect(panel(page).getByTestId("source-update-reason")).toHaveText("Send or cancel the Flag note you started in Review first.");
    await actionButton(page).click({ force: true });
    await expect(confirmation(page)).toHaveCount(0);
    await chooseMode(page, "Review");
    await expect(card.getByLabel("What's wrong with this value?")).toHaveValue("Half a thought");
    await card.getByRole("button", { name: "Cancel" }).click();
    await chooseMode(page, "Edit");
    await expect(actionButton(page)).not.toHaveAttribute("aria-disabled");
    await closeStudy(page, TITLES.holds);
    traffic.stop();
    expect(traffic.forbidden).toEqual([]);
    expect(traffic.bodiesOf(REBASE_RPC)).toEqual([]);
  });

  test("R5 · a library abstract changed while the confirmation was open is refused, nothing is saved, and the library is read again", async () => {
    const before = await studyOf(page, TITLES.stale);
    let traffic = watchStudyRecordTraffic(page, [REBASE_RPC]);
    await openStudy(page, TITLES.stale, "SRRB Stale trial");
    await openCompare(page, "content_change");
    await actionButton(page).click();
    await expect(confirmation(page)).toBeVisible();
    traffic.stop();
    expect(traffic.forbidden).toEqual([]);
    // Edited in another tab, after the comparison was read — the spec's own write, outside the watch.
    await editLibraryAbstract(page, before.paperId, TEXTS.staleEdited);
    traffic = watchStudyRecordTraffic(page, [REBASE_RPC]);
    await confirmation(page).getByRole("button", { name: "Save as copy 2" }).click();
    await expect(outcome(page)).toHaveAttribute("data-outcome", "source_changed");
    await expect(outcome(page)).toContainText("Nothing was saved: the abstract in your library changed after you compared it.");
    await expect(outcome(page)).toBeFocused();
    expect(traffic.bodiesOf(REBASE_RPC)).toEqual([expect.objectContaining({ p_expected_abstract_sha256: sha256(TEXTS.staleLibrary), p_expected_version: before.version })]);
    // Read again at once: the comparison now shows what the library says.
    await compareView(page).getByRole("tablist", { name: "What to show" }).getByRole("tab", { name: "Library abstract", exact: true }).click();
    await expect(compareView(page).getByTestId("source-compare-library-text")).toHaveText(TEXTS.staleEdited);
    expect((await studyOf(page, TITLES.stale)).version).toBe(before.version);
    await closeStudy(page, TITLES.stale);
    traffic.stop();
    expect(traffic.forbidden).toEqual([]);
  });

  test("R6 · an answer lost in transit: one alert, Try again resends the SAME request, and the server's replay is reported", async () => {
    const before = await studyOf(page, TITLES.retry);
    expect(before.version).toBe(1);
    const traffic = watchStudyRecordTraffic(page, [REBASE_RPC]);
    // The first attempt reaches the server — which applies it — and its answer is then lost.
    await page.route(`**/rest/v1/rpc/${REBASE_RPC}`, async (route) => {
      await route.fetch();
      await route.abort("failed");
    }, { times: 1 });
    await openStudy(page, TITLES.retry, "SRRB Retry trial");
    await openCompare(page, "content_change");
    await actionButton(page).click();
    await confirmation(page).getByRole("button", { name: "Save as copy 2" }).click();
    const alert = studyDialog(page).getByTestId("source-update-uncertain-alert");
    await expect(alert).toHaveText(/We couldn't tell whether the new copy was saved\. Try again — it won't be saved twice\./);
    await expect(alert).toBeFocused();
    await expect(studyDialog(page).getByRole("button", { name: /Delete study record/ })).toBeDisabled();
    await alert.getByRole("button", { name: "Try again" }).click();
    await expect(outcome(page)).toHaveAttribute("data-outcome", "replayed");
    await expect(outcome(page)).toContainText("Your earlier attempt had already saved it: nothing was saved twice.");
    const bodies = traffic.bodiesOf(REBASE_RPC);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[0]).toMatchObject({ p_expected_version: 1, p_expected_abstract_sha256: sha256(TEXTS.retryLibrary) });
    expect((await studyOf(page, TITLES.retry)).version).toBe(2);
    await expect(sourcePane(page).getByTestId("study-record-saved-abstract")).toHaveText(TEXTS.retryLibrary);
    await closeStudy(page, TITLES.retry);
    traffic.stop();
    expect(traffic.forbidden).toEqual([]);
  });

  test("R7 · an unchanged answer: the library abstract is already the copy — nothing offered, and a direct rebase saves nothing", async () => {
    const before = await studyOf(page, TITLES.unchanged);
    const traffic = watchStudyRecordTraffic(page, [REBASE_RPC]);
    await openStudy(page, TITLES.unchanged, "SRRB Unchanged trial");
    await expect(banner(page)).toHaveAttribute("data-source-state", "current");
    await expect(sourcePane(page).getByTestId("source-compare-open")).toHaveCount(0);
    await closeStudy(page, TITLES.unchanged);
    traffic.stop();
    expect(traffic.forbidden).toEqual([]);
    // Sent directly, outside the UI: the server answers `unchanged` and writes nothing (the lifecycle checks that too).
    const answer = await rebaseDirectly(page, before, TEXTS.unchanged);
    expect(answer.error).toBeNull();
    expect(answer.data).toMatchObject({ status: "unchanged", study_version: before.version, seq: 1, previous_snapshot_id: null, rematched: 0, needs_rereview: 0 });
    expect((await studyOf(page, TITLES.unchanged)).version).toBe(before.version);
  });
});

test.describe("Use current abstract — on a phone", () => {
  test("R8 · in the Source tab's Compare: the action and its confirmation scroll nothing sideways, and every control is a reachable touch target", async ({ browser }) => {
    test.setTimeout(60_000);
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] }, viewport: PHONE, hasTouch: true, isMobile: true });
    const page = await context.newPage();
    try {
      await signIn(page, "E2E_STUDY_REBASE_OWNER_EMAIL", "E2E_STUDY_REBASE_OWNER_PASSWORD");
      const traffic = watchStudyRecordTraffic(page, [REBASE_RPC]);
      await openStudy(page, TITLES.phone, "SRRB Phone trial");
      const dialog = studyDialog(page);
      await dialog.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((animation) => animation.finished)));
      expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches), "the phone context has a coarse pointer").toBe(true);
      await dialog.getByRole("tablist", { name: "Study record view" }).getByRole("tab", { name: "Source" }).tap();
      await expect(banner(page)).toHaveAttribute("data-source-state", "content_change");
      await sourcePane(page).getByTestId("source-compare-open").tap();
      await expect(panel(page)).toBeVisible();
      await expect(actionButton(page)).not.toHaveAttribute("aria-disabled");
      await expectNoSidewaysScroll(page, "Compare, with Use current abstract");
      const hit = await expectReachable(actionButton(page), "Use current abstract");
      expect(hit.height, "Use current abstract: a touch target at least 40 px tall").toBeGreaterThanOrEqual(40);

      await actionButton(page).tap();
      const sheet = confirmation(page);
      await expect(sheet).toBeVisible();
      await sheet.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((animation) => animation.finished)));
      await expectNoSidewaysScroll(page, "the confirmation");
      // It fits the screen, its text scrolls inside it, and its buttons stay outside that scroll.
      const box = await sheet.boundingBox();
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.y + box!.height).toBeLessThanOrEqual(PHONE.height);
      expect(await sheet.getByTestId("source-update-impact").evaluate((el) => getComputedStyle(el).overflowY)).toBe("auto");
      for (const name of ["Cancel", "Save as copy 2"]) {
        const button = sheet.getByRole("button", { name });
        const reach = await expectReachable(button, name);
        expect(reach.height, `${name}: a touch target at least 40 px tall`).toBeGreaterThanOrEqual(40);
        expect(reach.left).toBeGreaterThanOrEqual(0);
        expect(reach.right).toBeLessThanOrEqual(PHONE.width);
      }
      await sheet.getByRole("button", { name: "Cancel" }).tap();
      await expect(sheet).toBeHidden();
      traffic.stop();
      expect(traffic.forbidden).toEqual([]);
      expect(traffic.bodiesOf(REBASE_RPC)).toEqual([]);
    } finally {
      await context.close();
    }
  });
});

test.describe("Use current abstract — a former owner, now a manager", () => {
  test("R9 · compares their own record, is offered no write, and a rebase sent directly is refused", async ({ browser }) => {
    test.setTimeout(60_000);
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] }, viewport: DESKTOP });
    const page = await context.newPage();
    try {
      await signIn(page, "E2E_STUDY_REBASE_FORMER_EMAIL", "E2E_STUDY_REBASE_FORMER_PASSWORD");
      const own = await studyOf(page, TITLES.former);
      const traffic = watchStudyRecordTraffic(page, []);
      await openStudy(page, TITLES.former, "SRRB Former owner's trial");
      await expect(studyDialog(page).getByTestId("study-record-read-only")).toBeVisible();
      await openCompare(page, "content_change");
      await expect(compareView(page).getByRole("tablist", { name: "What to show" })).toBeVisible();
      await expect(sourcePane(page).getByTestId("source-update")).toHaveCount(0);
      await expect(studyDialog(page).getByRole("button", { name: "Use current abstract" })).toHaveCount(0);
      traffic.stop();
      expect(traffic.forbidden).toEqual([]);
      expect(traffic.rpcs.filter((rpc) => !traffic.reads.includes(rpc))).toEqual([]);
      // A manager is not an owner: the rebase itself refuses, before reading anything.
      const answer = await rebaseDirectly(page, own, TEXTS.formerLibrary);
      expect(answer).toEqual({ data: null, error: { code: "42501", message: "evidence_records_not_enabled" } });
      expect((await studyOf(page, TITLES.former)).version).toBe(own.version);
    } finally {
      await context.close();
    }
  });
});
