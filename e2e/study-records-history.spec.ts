import { test, expect, type BrowserContext, type Locator, type Page, type Request } from "@playwright/test";
import { assertLocalSupabaseUrl, assertOriginsMatch } from "./support/backend-guard";
import { watchStudyRecordTraffic } from "./support/study-record-traffic";
import { waitForDashboard } from "./helpers";

/**
 * EVIDENCE-RECORDS-001C2B — the History Viewer, end to end, against the local
 * stack. Synthetic data only, in two disposable accounts of this spec's own,
 * which the lifecycle provisions through the real RPCs
 * (`scripts/e2e-local-history-fixture.mjs`) — no event is inserted directly:
 *
 *   * the PILOT OWNER (`internal_user_access.role = 'owner'`, local only)
 *     reads a study record with twelve committed operations: H1 History opens
 *     on demand, newest first · H7 it reads by version, for this user and
 *     study only, and writes nothing · H8 Load older, without a duplicate ·
 *     H9 an opened entry shows its own changes only · H2 a creation, and a
 *     record created in the browser · H12 a failed read is never an empty
 *     history · H3 a Save, H4 a Confirm, H5 a Flag and H6 an edit that resets
 *     the review each appear as what they were · H11 a change committed
 *     elsewhere appears on Refresh — and on a phone, nothing scrolls sideways;
 *   * a FORMER OWNER now `manager` (H10): History stays theirs to read, only
 *     theirs, and nothing of it can be written.
 *
 * After the run the lifecycle checks as the database owner every committed
 * operation of the history study, version by version, with its own change
 * events — the fixture's twelve and exactly the spec's five, nothing from the
 * viewer — then removes both accounts, verifying nothing of theirs remains.
 */

const CLIENT_MODULE_PATH = "/src/integrations/supabase/client.ts";

const TITLES = {
  history: "SRH-E2E History trial",
  creation: "SRH-E2E Creation trial",
  former: "SRH-E2E Former owner's trial",
};
const LONG_OUTCOME = "Bodyweightchangefrombaseline".repeat(8).slice(0, 200);
const NOTES = { flag: "Check the inclusion criteria" };
const EDITS = { first: "Adults aged 40 to 65", second: "Adults aged 40 to 70" };

const LABELS = {
  demographics: "Key demographics (for example age, sex)",
  eligibility: "Eligibility criteria, as reported",
  condition: "Condition or health status",
};

const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };
/** What a history read never selects (C2B §13): the request's fingerprint and stored result, a note, or everything. */
const PRIVATE_COLUMNS = ["payload_sha256", "result", "note", "*"];
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing ${name}. The study-records-history spec runs only through \`npm run test:e2e:local\`, which provisions its accounts.`);
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
  if (!browserOrigin) throw new Error("study-records-history spec could not read the browser-loaded Supabase origin; refusing to continue.");
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

/** The study a paper reports, as its owner reads it: the ids History must be scoped to, and its version. */
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

/** A link change committed "in another tab": the same RPC the editor uses, outside this page's dialog. */
async function setLinkDirectly(page: Page, study: StudyState, action: "confirm" | "mark_provisional"): Promise<{ data: unknown; error: DbError }> {
  return page.evaluate(
    async ({ modPath, study, action }) => {
      const { supabase: client } = (await import(modPath)) as { supabase: Client };
      const { data, error } = await client.rpc("evidence_set_link", {
        p_study_id: study.studyId,
        p_paper_id: study.paperId,
        p_action: action,
        p_expected_version: study.version,
        p_request_id: crypto.randomUUID(),
      });
      return { data, error: error ? { code: error.code, message: error.message } : null };
    },
    { modPath: CLIENT_MODULE_PATH, study, action },
  );
}

/** Every history row the signed-in user can read, by owner and study: RLS decides, not the UI. */
async function readableHistory(page: Page): Promise<{ user_id: string; study_id: string }[]> {
  return page.evaluate(async (modPath) => {
    const { supabase: client } = (await import(modPath)) as { supabase: Client };
    const { data, error } = await client.from("evidence_events").select("user_id, study_id");
    if (error) throw new Error(error.message);
    return data as { user_id: string; study_id: string }[];
  }, CLIENT_MODULE_PATH);
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

async function chooseMode(page: Page, mode: "Edit" | "Review" | "History") {
  const tab = studyDialog(page).getByRole("tablist", { name: "Study record mode" }).getByRole("tab", { name: mode, exact: true });
  await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
}

const historyPane = (page: Page) => studyDialog(page).getByTestId("study-record-history-pane");
const historyEntry = (page: Page, version: number) => historyPane(page).locator(`[data-testid="history-entry"][data-history-version="${version}"]`);

async function openHistory(page: Page) {
  await chooseMode(page, "History");
  await expect(historyPane(page)).toHaveAttribute("data-history-status", "ready");
}

async function versionsShown(page: Page): Promise<number[]> {
  return historyPane(page)
    .getByTestId("history-entry")
    .evaluateAll((entries) => entries.map((entry) => Number(entry.getAttribute("data-history-version"))));
}

/** Open one entry's details and wait for its changes. */
async function expand(page: Page, version: number): Promise<Locator> {
  const entry = historyEntry(page, version);
  const toggle = entry.getByTestId("history-entry-toggle");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(entry.getByTestId("history-changes")).toBeVisible();
  return entry;
}

async function changeTypes(entry: Locator): Promise<string[]> {
  return entry.getByTestId("history-change").evaluateAll((changes) => changes.map((change) => change.getAttribute("data-history-change") ?? ""));
}

function card(page: Page, label: string): Locator {
  return studyDialog(page).getByRole("article", { name: label, exact: true });
}

async function showAll(page: Page) {
  await studyDialog(page).getByTestId("study-record-review-pane").getByRole("radio", { name: /^All recorded/ }).check();
}

/** From a Review card to its field in Edit, a new text, and Save. */
async function editAndSave(page: Page, label: string, fieldKey: string, value: string) {
  const dialog = studyDialog(page);
  await chooseMode(page, "Review");
  await showAll(page);
  await card(page, label).getByRole("button", { name: `Edit ${label}` }).click();
  await expect(dialog.getByRole("tab", { name: "Edit", exact: true })).toHaveAttribute("aria-selected", "true");
  await dialog.getByTestId(`field-study|${fieldKey}`).getByLabel("Value").fill(value);
  await dialog.getByTestId("study-record-save").click();
  await expect(dialog.getByTestId("study-record-save-status")).toHaveText("Saved.");
}

/** Every request the page sends to `evidence_events`: its method and its query. */
function watchHistoryReads(page: Page) {
  const reads: { method: string; params: URLSearchParams }[] = [];
  const onRequest = (request: Request) => {
    const url = new URL(request.url());
    if (url.pathname.endsWith("/rest/v1/evidence_events")) reads.push({ method: request.method(), params: url.searchParams });
  };
  page.on("request", onRequest);
  return { reads, stop: () => page.off("request", onRequest) };
}

/** Each history read is a GET for this user and this study, by named columns — never a private one. */
function expectScopedReads(reads: { method: string; params: URLSearchParams }[], study: StudyState) {
  for (const { method, params } of reads) {
    expect(method).toBe("GET");
    expect(params.get("user_id")).toBe(`eq.${study.userId}`);
    expect(params.get("study_id")).toBe(`eq.${study.studyId}`);
    const columns = (params.get("select") ?? "").split(",");
    expect(columns.length).toBeGreaterThan(0);
    for (const column of PRIVATE_COLUMNS) expect(columns).not.toContain(column);
  }
}

async function expectNoSidewaysScroll(page: Page, where: string) {
  const overflow = await page.evaluate(() => {
    const widest = (element: Element | null | undefined) => (element ? element.scrollWidth - element.clientWidth : 0);
    return {
      document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      dialog: widest(document.querySelector("[data-testid=study-record-dialog]")),
      history: widest(document.querySelector("[data-testid=study-record-history-pane]")?.closest("[role=tabpanel]")),
    };
  });
  expect(overflow.document, `${where}: no document-level sideways scroll`).toBeLessThanOrEqual(0);
  expect(overflow.dialog, `${where}: nothing overflows the dialog sideways`).toBeLessThanOrEqual(0);
  expect(overflow.history, `${where}: nothing overflows the History pane sideways`).toBeLessThanOrEqual(0);
}

/** The control a tap at its centre reaches is the control itself (or inside it), not something covering it. */
async function expectReachable(control: Locator, what: string) {
  await control.scrollIntoViewIfNeeded();
  const hit = await control.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const at = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return { reached: at === el || el.contains(at), height: box.height };
  });
  expect(hit.reached, `${what}: a tap at its centre reaches it`).toBe(true);
  return hit;
}

// ─────────────────────────────────────────────────────────────────────────────

test.describe("History — the pilot owner", () => {
  test.describe.configure({ mode: "serial" });

  let context: BrowserContext;
  let page: Page;
  let study: StudyState;

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext({ storageState: { cookies: [], origins: [] }, viewport: DESKTOP });
    page = await context.newPage();
    await signIn(page, "E2E_STUDY_HISTORY_OWNER_EMAIL", "E2E_STUDY_HISTORY_OWNER_PASSWORD");
  });

  test.afterAll(async () => {
    await context?.close();
  });

  test("H1 · H7 · History opens on demand: committed operations newest first, read by version for this user and study only, and nothing is written", async () => {
    // This group writes from H3 on, and CI retries a failed group from the top against what the failed
    // attempt left. Say so here, not later on the versions.
    study = await studyOf(page, TITLES.history);
    expect(study.version, "the history study is as provisioned; if not, an earlier attempt of this group wrote, and that attempt's error is the one to read").toBe(12);

    const traffic = watchStudyRecordTraffic(page, []);
    const history = watchHistoryReads(page);
    await openStudy(page, TITLES.history, "SRH History trial");
    const dialog = studyDialog(page);
    await expect(dialog.getByRole("tab", { name: "Edit", exact: true })).toHaveAttribute("aria-selected", "true");
    await chooseMode(page, "Review");
    // On demand: nothing of history is read in Edit or Review.
    expect(history.reads).toEqual([]);

    await openHistory(page);
    expect(await versionsShown(page)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
    await expect(historyPane(page).getByTestId("history-entry").getByRole("heading")).toHaveText([
      "Changes saved",
      "Changes saved",
      "Changes saved",
      "Changes saved",
      "Linked paper changed",
      "Linked paper changed",
      "Study details updated",
      "Changes saved",
      "Review recorded",
      "Review recorded",
    ]);
    const newest = historyEntry(page, 12);
    await expect(newest).toContainText("Record version 12");
    const time = newest.locator("time");
    expect(Date.parse((await time.getAttribute("datetime")) ?? "")).not.toBeNaN();
    await expect(time).toHaveText(/^[A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2} [AP]M \S+$/);
    await expect(historyPane(page)).toContainText("History is read-only.");

    // One read: the newest headers, by version, with a row of look-ahead.
    expect(history.reads).toHaveLength(1);
    expectScopedReads(history.reads, study);
    const [first] = history.reads;
    expect([first.params.get("ordinal"), first.params.get("order"), first.params.get("limit"), first.params.get("study_version")]).toEqual(["eq.0", "study_version.desc", "11", null]);
    expect(first.params.get("select")).toBe("id,user_id,study_id,study_version,ordinal,event_type,request_id,op,occurred_at");

    // Read-only: no write, no RPC, no Edge Function — and no write control in the pane.
    traffic.stop();
    expect(traffic.forbidden).toEqual([]);
    expect(traffic.rpcs.filter((rpc) => !traffic.reads.includes(rpc))).toEqual([]);
    // Anchored: an entry's own toggle is named after it ("Show details: Changes saved, …").
    await expect(historyPane(page).getByRole("button", { name: /^(confirm|flag|save|delete|edit)\b/i })).toHaveCount(0);
    await expect(historyPane(page).getByRole("button")).toHaveText(
      Array.from({ length: 12 }, (_, index) => (index === 0 ? "Refresh" : index === 11 ? "Load older entries" : "Show details")),
    );
    history.stop();
  });

  test("H8 · Load older adds the two oldest operations, none twice, and says where the history begins", async () => {
    const traffic = watchStudyRecordTraffic(page, []);
    const history = watchHistoryReads(page);
    await historyPane(page).getByRole("button", { name: "Load older entries" }).click();
    await expect.poll(() => versionsShown(page)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    await expect(historyPane(page).getByTestId("history-beginning")).toHaveText("This is the beginning of this study record's history.");
    await expect(historyEntry(page, 2).getByRole("heading")).toBeFocused();
    expect(history.reads).toHaveLength(1);
    expectScopedReads(history.reads, study);
    expect(history.reads[0].params.get("study_version")).toBe("lt.3");
    traffic.stop();
    expect(traffic.forbidden).toEqual([]);
    history.stop();
  });

  test("H9 · H2 · an opened entry shows its own changes only; the first is the creation; nothing shows a fingerprint or an id", async () => {
    const history = watchHistoryReads(page);
    const save = await expand(page, 2);
    expect(await changeTypes(save)).toEqual(["arm_added", "arm_added", "outcome_added", "value_saved", "value_saved", "value_saved"]);
    await expect(save.getByTestId("history-change")).toHaveText([
      "Added intervention group “Metformin”",
      "Added comparator group “Placebo”",
      `Added outcome “${LONG_OUTCOME}”`,
      /^Condition or health status: recorded as Reported — a text of 27 characters/,
      /^Setting \(countries, care setting\): recorded as Reported — a text of 18 characters/,
      /^Comparator type \(group now named “Placebo”\): recorded as Reported — Placebo/,
    ]);
    await expect(save).not.toContainText("reviewed by you");
    expect(history.reads).toHaveLength(1);
    expectScopedReads(history.reads, study);
    expect([history.reads[0].params.get("study_version"), history.reads[0].params.get("ordinal"), history.reads[0].params.get("order")]).toEqual(["eq.2", "gt.0", "ordinal.asc"]);

    const creation = await expand(page, 1);
    await expect(creation.getByRole("heading")).toHaveText("Study record created");
    await expect(creation.getByTestId("history-change")).toHaveText([
      /^Study record created as “SRH History trial”Kind of study: Randomized trial, parallel groups$/,
      `Linked to the paper now titled “${TITLES.history}”, as confirmed by you`,
      new RegExp(`^Saved a copy of the abstract of the paper now titled “${TITLES.history}”Copy 1, [\\d,]+ characters\\. History doesn't keep the copy's text\\.$`),
    ]);

    // The fixture's edit of a confirmed value: the save that reset the review.
    const reset = await expand(page, 5);
    await expect(reset.getByTestId("history-change")).toHaveText([
      "Condition or health status: text changedPreviously reviewed by you — saving this change reset the review.Earlier text isn't stored in History.",
    ]);

    // Closed again: its changes go.
    const toggle = save.getByTestId("history-entry-toggle");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(save.getByTestId("history-changes")).toHaveCount(0);

    const text = (await historyPane(page).textContent()) ?? "";
    expect(text).not.toMatch(/[0-9a-f]{64}/);
    expect(text).not.toMatch(UUID);
    expect(await historyPane(page).evaluate((el) => el.outerHTML)).not.toMatch(UUID);
    history.stop();
  });

  test("H12 · a failed read is shown as a failure — never as an empty history — and Try again reads it", async () => {
    await chooseMode(page, "Edit");
    const failing = (url: URL) => url.pathname.endsWith("/rest/v1/evidence_events");
    await page.route(failing, (route) => route.abort("failed"));
    await chooseMode(page, "History");
    const alert = historyPane(page).getByRole("alert");
    await expect(alert).toHaveText(/Couldn't load this study record's history\./, { timeout: 10_000 });
    await expect(historyPane(page)).not.toContainText("No history is recorded");
    await expect(historyPane(page).getByTestId("history-entry")).toHaveCount(0);
    await page.unroute(failing);
    await alert.getByRole("button", { name: "Try again" }).click();
    await expect.poll(() => versionsShown(page)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
    await expect(historyPane(page).getByRole("heading", { name: "History", exact: true })).toBeFocused();
  });

  test("H3 · a value saved in Edit is a new save at the top of History — its text never shown", async () => {
    await editAndSave(page, LABELS.demographics, "demographics", EDITS.first);
    await openHistory(page);
    expect((await versionsShown(page))[0]).toBe(13);
    const saved = await expand(page, 13);
    await expect(saved.getByRole("heading")).toHaveText("Changes saved");
    expect(await changeTypes(saved)).toEqual(["value_saved"]);
    await expect(saved.getByTestId("history-change")).toHaveText([`${LABELS.demographics}: text changedEarlier text isn't stored in History.`]);
    await expect(historyPane(page)).not.toContainText(EDITS.first);
  });

  test("H4 · a Confirm in Review is a recorded review", async () => {
    await chooseMode(page, "Review");
    await showAll(page);
    await card(page, LABELS.demographics).getByRole("button", { name: "Confirm against this source", exact: true }).click();
    await expect(studyDialog(page).getByTestId("review-announcement")).toContainText(`Confirmed ${LABELS.demographics}.`);
    await openHistory(page);
    expect((await versionsShown(page))[0]).toBe(14);
    const confirmed = await expand(page, 14);
    await expect(confirmed.getByRole("heading")).toHaveText("Review recorded");
    expect(await changeTypes(confirmed)).toEqual(["review_confirmed"]);
    await expect(confirmed.getByTestId("history-change")).toHaveText([`${LABELS.demographics}: reviewed by you`]);
  });

  test("H5 · a Flag is a recorded review — its note kept out of History", async () => {
    await chooseMode(page, "Review");
    await showAll(page);
    const eligibility = card(page, LABELS.eligibility);
    await eligibility.getByRole("button", { name: "Flag…" }).click();
    await eligibility.getByLabel("What's wrong with this value?").fill(NOTES.flag);
    await eligibility.getByRole("button", { name: "Flag", exact: true }).click();
    await expect(studyDialog(page).getByTestId("review-announcement")).toHaveText(`Flagged ${LABELS.eligibility}.`);
    await openHistory(page);
    expect((await versionsShown(page))[0]).toBe(15);
    const flagged = await expand(page, 15);
    expect(await changeTypes(flagged)).toEqual(["review_flagged"]);
    await expect(flagged.getByTestId("history-change")).toHaveText([`${LABELS.eligibility}: flaggedHistory doesn't keep the text of notes.`]);
    await expect(historyPane(page)).not.toContainText(NOTES.flag);
  });

  test("H6 · editing the confirmed value again: History says the save reset the review", async () => {
    await editAndSave(page, LABELS.demographics, "demographics", EDITS.second);
    await openHistory(page);
    expect((await versionsShown(page))[0]).toBe(16);
    const reset = await expand(page, 16);
    await expect(reset.getByTestId("history-change")).toHaveText([
      `${LABELS.demographics}: text changedPreviously reviewed by you — saving this change reset the review.Earlier text isn't stored in History.`,
    ]);
    await expect(historyPane(page)).not.toContainText(EDITS.second);
  });

  test("H11 · a change committed in another tab appears on Refresh, once, at the top", async () => {
    await expect.poll(() => versionsShown(page).then((versions) => versions[0])).toBe(16);
    const current = await studyOf(page, TITLES.history);
    const sent = await setLinkDirectly(page, current, "mark_provisional");
    expect(sent.error).toBeNull();
    // Not read until asked: History is a reading of what was committed when it was read.
    expect((await versionsShown(page))[0]).toBe(16);
    const history = watchHistoryReads(page);
    await historyPane(page).getByRole("button", { name: "Refresh history" }).click();
    await expect.poll(() => versionsShown(page)).toEqual([17, 16, 15, 14, 13, 12, 11, 10, 9, 8]);
    await expect(historyPane(page).getByTestId("history-announcement")).toHaveText("History refreshed.");
    expect(history.reads).toHaveLength(1);
    expectScopedReads(history.reads, study);
    expect(history.reads[0].params.get("study_version")).toBeNull();
    const link = await expand(page, 17);
    await expect(link.getByTestId("history-change")).toHaveText([`Link to the paper now titled “${TITLES.history}” changed from confirmed by you to provisional`]);
    history.stop();
    await closeStudy(page, TITLES.history);
  });

  test("H2 · a record created in the browser: its History is its creation", async () => {
    await page.getByRole("button", { name: `Expand abstract for ${TITLES.creation}` }).click();
    const entry = page.getByTestId("study-record-entry");
    await expect(entry.getByTestId("study-record-entry-status")).toHaveText("Study records — None");
    await entry.getByRole("button", { name: "Start a study record" }).click();
    const dialog = studyDialog(page);
    await dialog.getByRole("radio", { name: /^Yes/ }).click();
    await dialog.getByRole("radio", { name: /^Randomized trial, parallel groups/ }).click();
    await dialog.getByLabel("Study name").fill("SRH Creation trial");
    await dialog.getByRole("button", { name: "Create study record" }).click();
    await expect(dialog.getByRole("heading", { name: "Study record: SRH Creation trial" })).toBeVisible();

    await openHistory(page);
    expect(await versionsShown(page)).toEqual([1]);
    await expect(historyPane(page).getByTestId("history-beginning")).toBeVisible();
    const creation = await expand(page, 1);
    expect(await changeTypes(creation)).toEqual(["study_created", "link_created", "source_captured"]);
    await expect(creation.getByTestId("history-change").first()).toHaveText(/^Study record created as “SRH Creation trial”/);
    await closeStudy(page, TITLES.creation);
  });
});

test.describe("History — on a phone", () => {
  test("History is its own mode: nothing scrolls sideways, a long name wraps, and every control is a reachable touch target", async ({ browser }) => {
    test.setTimeout(60_000);
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] }, viewport: PHONE, hasTouch: true, isMobile: true });
    const page = await context.newPage();
    try {
      await signIn(page, "E2E_STUDY_HISTORY_OWNER_EMAIL", "E2E_STUDY_HISTORY_OWNER_PASSWORD");
      await openStudy(page, TITLES.history, "SRH History trial");
      const dialog = studyDialog(page);
      await dialog.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((animation) => animation.finished)));
      await openHistory(page);
      await expectNoSidewaysScroll(page, "History");
      const coarse = await page.evaluate(() => matchMedia("(pointer: coarse)").matches);
      expect(coarse, "the phone context has a coarse pointer").toBe(true);

      const tab = dialog.getByRole("tablist", { name: "Study record mode" }).getByRole("tab", { name: "History", exact: true });
      const versions = await versionsShown(page);
      for (const [control, what] of [
        [tab, "the History tab"],
        [historyPane(page).getByRole("button", { name: "Refresh history" }), "Refresh"],
        [historyEntry(page, versions[0]).getByTestId("history-entry-toggle"), "Show details"],
        [historyPane(page).getByRole("button", { name: "Load older entries" }), "Load older"],
      ] as const) {
        const hit = await expectReachable(control, what);
        expect(hit.height, `${what}: a touch target at least 40 px tall`).toBeGreaterThanOrEqual(40);
      }

      // The save with the 200-character outcome name, wherever it is now.
      while (!(await versionsShown(page)).includes(2)) {
        await historyPane(page).getByRole("button", { name: "Load older entries" }).tap();
        await expect(historyPane(page).getByRole("button", { name: "Load older entries" }).or(historyPane(page).getByTestId("history-beginning"))).toBeVisible();
      }
      const toggle = historyEntry(page, 2).getByTestId("history-entry-toggle");
      await toggle.tap();
      const outcome = historyEntry(page, 2).getByTestId("history-change").nth(2);
      await expect(outcome).toContainText(LONG_OUTCOME);
      const wraps = await outcome.evaluate((el) => ({ fits: el.scrollWidth <= el.clientWidth, lines: Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el.firstElementChild!).lineHeight)) }));
      expect(wraps.fits, "the long name wraps inside its line").toBe(true);
      expect(wraps.lines).toBeGreaterThan(1);
      await expectNoSidewaysScroll(page, "History, a long name shown");
    } finally {
      await context.close();
    }
  });
});

test.describe("History — a former owner, now a manager", () => {
  test("H10 · reads their own History, and only theirs; has nothing to save; and the server refuses a write sent directly", async ({ browser }) => {
    test.setTimeout(60_000);
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] }, viewport: DESKTOP });
    const page = await context.newPage();
    try {
      await signIn(page, "E2E_STUDY_HISTORY_FORMER_EMAIL", "E2E_STUDY_HISTORY_FORMER_PASSWORD");
      const own = await studyOf(page, TITLES.former);
      const traffic = watchStudyRecordTraffic(page, []);
      const history = watchHistoryReads(page);
      await openStudy(page, TITLES.former, "SRH Former owner's trial");
      const dialog = studyDialog(page);
      await expect(dialog.getByTestId("study-record-read-only")).toBeVisible();
      await expect(dialog.getByTestId("study-record-save")).toHaveCount(0);

      await openHistory(page);
      expect(await versionsShown(page)).toEqual([4, 3, 2, 1]);
      await expect(historyPane(page).getByTestId("history-entry").getByRole("heading")).toHaveText(["Changes saved", "Review recorded", "Changes saved", "Study record created"]);
      const confirmed = await expand(page, 3);
      await expect(confirmed.getByTestId("history-change")).toHaveText([`${LABELS.condition}: reviewed by you`]);

      // A save of 52 changes is shown in two parts, none twice, none cut off; focus goes to the first change added.
      const large = await expand(page, 4);
      const changes = large.getByTestId("history-change");
      await expect(changes).toHaveCount(50);
      await expect(large).toContainText("50 changes shown");
      await large.getByRole("button", { name: "Show more changes" }).click();
      await expect(changes).toHaveCount(52);
      await expect(changes.nth(50)).toBeFocused();
      await expect(large.getByRole("button", { name: "Show more changes" })).toHaveCount(0);
      expect(await changes.evaluateAll((items) => items.map((item) => item.textContent))).toEqual([
        "Added comparator group “Group 1”",
        ...Array.from({ length: 19 }, (_, i) => `Added intervention group “Group ${i + 2}”`),
        ...Array.from({ length: 32 }, (_, i) => `Added outcome “Outcome ${i + 1}”`),
      ]);
      expectScopedReads(history.reads, own);
      // The newest page, version 3's changes, and version 4's in two parts — after ordinal 0, then 50.
      expect(history.reads.map((read) => [read.params.get("study_version"), read.params.get("ordinal")])).toEqual([
        [null, "eq.0"],
        ["eq.3", "gt.0"],
        ["eq.4", "gt.0"],
        ["eq.4", "gt.50"],
      ]);
      traffic.stop();
      expect(traffic.forbidden).toEqual([]);
      history.stop();

      // Only their own history is readable at all: RLS, not the screen, decides.
      const readable = await readableHistory(page);
      expect(readable.length).toBeGreaterThan(0);
      expect([...new Set(readable.map((row) => `${row.user_id}|${row.study_id}`))]).toEqual([`${own.userId}|${own.studyId}`]);

      // A manager is not an owner: the server refuses a write sent directly, and History stays as it was.
      const refused = await setLinkDirectly(page, own, "mark_provisional");
      expect(refused.error).toEqual({ code: "42501", message: "evidence_records_not_enabled" });
      await historyPane(page).getByRole("button", { name: "Refresh history" }).click();
      await expect(historyPane(page).getByTestId("history-announcement")).toHaveText("History refreshed.");
      expect(await versionsShown(page)).toEqual([4, 3, 2, 1]);
    } finally {
      await context.close();
    }
  });
});
