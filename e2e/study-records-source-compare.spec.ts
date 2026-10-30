import { test, expect, type BrowserContext, type Locator, type Page, type Request } from "@playwright/test";
import { createHash } from "node:crypto";
import { assertLocalSupabaseUrl, assertOriginsMatch } from "./support/backend-guard";
import { watchStudyRecordTraffic } from "./support/study-record-traffic";
import { waitForDashboard } from "./helpers";

/**
 * EVIDENCE-RECORDS-001C2C-A — the Source pane's read-only comparison, end to
 * end, against the local stack. Synthetic data only, in two disposable
 * accounts of this spec's own, which the lifecycle provisions through the
 * installed RPCs and the owner's own paper edits
 * (`scripts/e2e-local-source-compare-fixture.mjs`) — no copy, quote or event
 * is inserted directly:
 *
 *   * the PILOT OWNER (`internal_user_access.role = 'owner'`, local only):
 *     A the library abstract is the saved copy · B a typography-only
 *     difference, its invisible characters named · C a change of content,
 *     its changes and both texts in full · D the abstract removed · E an
 *     abstract newly available to a record without a copy · F an earlier
 *     saved copy, opened and labelled · G its own quote marked, and only
 *     there · H Compare and Check again write nothing, and Check again reads
 *     an edit made elsewhere · I opening another copy drops a selection — and
 *     on a phone (K), the comparison scrolls nothing sideways and every
 *     control is a reachable touch target;
 *   * a FORMER OWNER now `manager` (J): compares and opens earlier copies,
 *     and the server refuses a rebase sent directly.
 *
 * Throughout, the traffic watch allows no study-record RPC at all (M). After
 * the run the lifecycle checks as the database owner that both users' study
 * records are exactly as provisioned, and every library abstract but the one
 * the spec edits itself — then removes both accounts, verifying nothing of
 * theirs remains (L).
 *
 * Switching between linked PAPERS is not exercised here: no installed RPC
 * links a second paper, so only the component tests
 * (StudyRecordSourceCompare.test.tsx, G2) cover it.
 */

const CLIENT_MODULE_PATH = "/src/integrations/supabase/client.ts";

const TITLES = {
  same: "SRSC-E2E Same trial",
  typography: "SRSC-E2E Typography trial",
  changed: "SRSC-E2E Changed trial",
  removed: "SRSC-E2E Removed trial",
  added: "SRSC-E2E New abstract trial",
  copies: "SRSC-E2E Copies trial",
  former: "SRSC-E2E Former owner's trial",
};

const NBSP = String.fromCodePoint(0x00a0);
const EN_DASH = String.fromCodePoint(0x2013);
const LEFT_QUOTE = String.fromCodePoint(0x201c);
const RIGHT_QUOTE = String.fromCodePoint(0x201d);

/** As the fixture wrote them. */
const TEXTS = {
  same: "Background: A synthetic trial of daily walking in adults with hypertension.\nMethods: 90 participants were randomized 1:1 to walking or usual care for 16 weeks.\nResults: Systolic blood pressure fell by 6 mmHg with walking.",
  sameEdited:
    "Background: A synthetic trial of daily walking in adults with hypertension.\nMethods: 92 participants were randomized 1:1 to walking or usual care for 16 weeks.\nResults: Systolic blood pressure fell by 6 mmHg with walking.",
  typographySaved: 'Background: A synthetic trial of "standing desks" in office workers.\nMethods: 60 participants were randomized for 12-14 weeks.',
  typographyLibrary: `Background: A synthetic trial of ${LEFT_QUOTE}standing desks${RIGHT_QUOTE} in office workers.\nMethods: 60${NBSP}participants were randomized for 12${EN_DASH}14 weeks.`,
  changedSaved:
    "Background: A synthetic trial of metformin in adults with type 2 diabetes.\nMethods: 120 participants were randomized to metformin or placebo for 24 weeks.\nResults: HbA1c fell by 0.8 % with metformin.",
  changedLibrary:
    "Background: A synthetic trial of metformin in adults with type 2 diabetes.\nMethods: 118 participants were randomized to metformin or placebo for 26 weeks.\nResults: HbA1c fell by 0.8 % with metformin.\nConclusions: Metformin lowered HbA1c.",
  added: "Background: A synthetic trial of tai chi in older adults.\nMethods: 70 participants were randomized.",
  copiesFirst: "Background: A synthetic trial of a low-salt diet in adults with heart failure.\nMethods: 80 participants were randomized at three hospitals.\nResults: Readmissions fell.",
  copiesSecond: "Background: A synthetic trial of a low-salt diet in adults with heart failure.\nMethods: 80 participants were randomized at four hospitals.\nResults: Readmissions fell by a fifth.",
  formerFirst: "Background: A synthetic trial of mindfulness in nurses.\nMethods: 40 participants were randomized.",
  formerLibrary: "Background: A synthetic trial of mindfulness in nurses and midwives.\nMethods: 44 participants were randomized.\nResults: Stress scores fell.",
};

const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };
const ABSTRACT_COLUMNS = "id,user_id,abstract";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing ${name}. The study-records-source-compare spec runs only through \`npm run test:e2e:local\`, which provisions its accounts.`);
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
  if (!browserOrigin) throw new Error("study-records-source-compare spec could not read the browser-loaded Supabase origin; refusing to continue.");
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

/** A rebase sent directly, outside the UI: what a former owner's own client could try. */
async function rebaseDirectly(page: Page, study: StudyState, abstract: string): Promise<DbError> {
  const sha = createHash("sha256").update(abstract, "utf8").digest("hex");
  return page.evaluate(
    async ({ modPath, study, sha }) => {
      const { supabase: client } = (await import(modPath)) as { supabase: Client };
      const { error } = await client.rpc("evidence_rebase_source", {
        p_study_id: study.studyId,
        p_paper_id: study.paperId,
        p_expected_version: study.version,
        p_expected_abstract_sha256: sha,
        p_request_id: crypto.randomUUID(),
      });
      return error ? { code: error.code, message: error.message } : null;
    },
    { modPath: CLIENT_MODULE_PATH, study, sha },
  );
}

/** Every library-abstract read and saved-copy text read the page makes, with its filters: each must be a GET, scoped. */
function watchSourceReads(page: Page) {
  const abstracts: URLSearchParams[] = [];
  const copies: URLSearchParams[] = [];
  const methods: string[] = [];
  const onRequest = (request: Request) => {
    const url = new URL(request.url());
    if (url.pathname.endsWith("/rest/v1/papers") && url.searchParams.get("select") === ABSTRACT_COLUMNS) {
      methods.push(request.method());
      abstracts.push(url.searchParams);
    }
    if (url.pathname.endsWith("/rest/v1/evidence_source_snapshots") && url.searchParams.has("paper_id")) {
      methods.push(request.method());
      copies.push(url.searchParams);
    }
  };
  page.on("request", onRequest);
  return { abstracts, copies, methods, stop: () => page.off("request", onRequest) };
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

/** A paper without an abstract can't be expanded: its record opens from Edit Paper. */
async function openStudyFromEditPaper(page: Page, title: string, label: string) {
  await page.getByRole("button", { name: `Edit ${title}`, exact: true }).click();
  const entry = page.getByRole("dialog").getByTestId("study-record-entry");
  await expect(entry.getByTestId("study-record-entry-status")).toHaveText("Study records — 1");
  await entry.getByRole("button", { name: "Open study record" }).click();
  await expect(studyDialog(page).getByRole("heading", { name: `Study record: ${label}` })).toBeVisible();
}

async function closeStudy(page: Page, title?: string) {
  await studyDialog(page).getByRole("button", { name: "Close" }).last().click();
  await expect(studyDialog(page)).toBeHidden();
  if (title) await page.getByRole("button", { name: `Collapse abstract for ${title}` }).click();
}

const sourcePane = (page: Page) => studyDialog(page).getByTestId("study-record-source-pane");
const banner = (page: Page) => sourcePane(page).getByTestId("source-status");
const compareView = (page: Page) => studyDialog(page).getByTestId("source-compare");

async function chooseReading(page: Page, name: string) {
  const tab = compareView(page).getByRole("tablist", { name: "What to show" }).getByRole("tab", { name, exact: true });
  await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
}

/** Select `passage` in the shown saved copy, as a reader would. */
async function selectInSavedCopy(page: Page, passage: string) {
  await page.getByTestId("study-record-saved-abstract").evaluate((root, passage) => {
    const full = root.textContent ?? "";
    const at = full.indexOf(passage);
    if (at < 0) throw new Error("the passage is not in the saved copy");
    const position = (offset: number): [Text, number] => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let remaining = offset;
      for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
        if (remaining <= node.data.length) return [node, remaining];
        remaining -= node.data.length;
      }
      throw new Error("offset beyond the copy");
    };
    const range = document.createRange();
    range.setStart(...position(at));
    range.setEnd(...position(at + passage.length));
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    root.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  }, passage);
}

const marked = (element: Locator) => element.locator("mark").evaluateAll((marks) => marks.map((mark) => mark.textContent));

/** No sideways scroll anywhere in the dialog: every scrolling box fits its content (the 1 px sr-only boxes aside). */
async function expectNoSidewaysScroll(page: Page, where: string) {
  const overflow = await page.evaluate(() => {
    const dialog = document.querySelector("[data-testid=study-record-dialog]");
    const boxes: string[] = [];
    for (const element of dialog ? [dialog, ...dialog.querySelectorAll("*")] : []) {
      const style = getComputedStyle(element);
      if (style.overflowX === "visible" || element.classList.contains("sr-only") || element.clientWidth <= 1) continue;
      if (element.scrollWidth > element.clientWidth) boxes.push(`${element.tagName.toLowerCase()}[${element.getAttribute("data-testid") ?? element.className}] ${element.scrollWidth}>${element.clientWidth}`);
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
    return { reached: at === el || el.contains(at), height: box.height };
  });
  expect(hit.reached, `${what}: a tap at its centre reaches it`).toBe(true);
  return hit;
}

// ─────────────────────────────────────────────────────────────────────────────

test.describe("Source comparison — the pilot owner", () => {
  test.describe.configure({ mode: "serial" });

  let context: BrowserContext;
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext({ storageState: { cookies: [], origins: [] }, viewport: DESKTOP });
    page = await context.newPage();
    await signIn(page, "E2E_STUDY_SOURCE_OWNER_EMAIL", "E2E_STUDY_SOURCE_OWNER_PASSWORD");
  });

  test.afterAll(async () => {
    await context?.close();
  });

  test("A · the library abstract is the saved copy: said so, nothing to compare, one scoped read", async () => {
    const same = await studyOf(page, TITLES.same);
    const traffic = watchStudyRecordTraffic(page, []);
    const reads = watchSourceReads(page);
    await openStudy(page, TITLES.same, "SRSC Same trial");
    await expect(banner(page)).toHaveAttribute("data-source-state", "current");
    await expect(banner(page)).toHaveText(/Same as the abstract in your library, character for character\./);
    await expect(sourcePane(page).getByTestId("source-compare-open")).toHaveCount(0);
    expect(reads.abstracts.map((params) => [params.get("user_id"), params.get("id")])).toEqual([[`eq.${same.userId}`, `eq.${same.paperId}`]]);
    expect(new Set(reads.methods)).toEqual(new Set(["GET"]));
    await closeStudy(page, TITLES.same);
    traffic.stop();
    reads.stop();
    expect(traffic.forbidden).toEqual([]);
    expect(traffic.rpcs.filter((rpc) => !traffic.reads.includes(rpc))).toEqual([]);
  });

  test("B · a typography-only difference keeps the saved copy, and Compare names what can't be seen", async () => {
    const traffic = watchStudyRecordTraffic(page, []);
    await openStudy(page, TITLES.typography, "SRSC Typography trial");
    await expect(banner(page)).toHaveAttribute("data-source-state", "typography_only_change");
    await expect(banner(page)).toContainText("only in characters PaperLume's quote matching treats as the same");
    await expect(banner(page)).toContainText("This is a technical comparison, not a check that the two say the same thing.");
    await expect(banner(page)).toContainText("Your record keeps saved copy 1");
    await expect(sourcePane(page).getByTestId("study-record-saved-abstract")).toHaveText(TEXTS.typographySaved);
    await sourcePane(page).getByTestId("source-compare-open").click();
    const changes = compareView(page).getByTestId("source-compare-changes");
    await expect(changes).toBeVisible();
    await expect(changes.getByTestId("source-compare-hidden-character")).toHaveText(["space", "no-break space"]);
    await expect(compareView(page)).toContainText("PaperLume's quote matching treats every difference shown here as no difference.");
    await expect(compareView(page).getByTestId("source-compare-summary")).toHaveText(/^4 places differ: spacing, punctuation or invisible characters only\.$/);
    await closeStudy(page, TITLES.typography);
    traffic.stop();
    expect(traffic.forbidden).toEqual([]);
  });

  test("C · a change of content: its changes struck and underlined, moved between, and both texts in full and named", async () => {
    const traffic = watchStudyRecordTraffic(page, []);
    await openStudy(page, TITLES.changed, "SRSC Changed trial");
    await expect(banner(page)).toHaveAttribute("data-source-state", "content_change");
    await expect(banner(page)).toContainText("Your quotes still point to the saved copy.");
    await sourcePane(page).getByTestId("source-compare-open").click();
    await expect(compareView(page).getByRole("heading", { name: "Saved copy and library abstract" })).toBeFocused();
    const changes = compareView(page).getByTestId("source-compare-changes");
    const marks = changes.getByTestId("source-compare-change");
    await expect(marks).toHaveCount(3);
    await expect(marks.nth(0).locator("del")).toHaveText("Only in the saved copy: 120");
    await expect(marks.nth(0).locator("ins")).toHaveText("Only in the library abstract: 118");
    // Decoration as well as colour.
    expect(await marks.nth(0).locator("del").evaluate((el) => getComputedStyle(el).textDecorationLine)).toContain("line-through");
    expect(await marks.nth(0).locator("ins").evaluate((el) => getComputedStyle(el).textDecorationLine)).toContain("underline");
    const next = compareView(page).getByRole("button", { name: "Next change" });
    await next.click();
    await expect(marks.nth(0)).toBeFocused();
    await next.click();
    await expect(marks.nth(1)).toBeFocused();
    await expect(compareView(page).getByTestId("source-compare-position")).toHaveText("Change 2 of 3");

    await chooseReading(page, "Saved copy 1");
    await expect(compareView(page).getByText("Saved copy 1 — the abstract currently saved with this study record")).toBeVisible();
    await expect(compareView(page).getByTestId("source-compare-saved-text")).toHaveText(TEXTS.changedSaved);
    await chooseReading(page, "Library abstract");
    await expect(compareView(page).getByText("Library abstract — the abstract currently stored in your paper library")).toBeVisible();
    await expect(compareView(page).getByTestId("source-compare-library-text")).toHaveText(TEXTS.changedLibrary);
    await compareView(page).getByTestId("source-compare-back").click();
    await expect(sourcePane(page).getByTestId("study-record-saved-abstract")).toHaveText(TEXTS.changedSaved);
    expect(await marked(sourcePane(page).getByTestId("study-record-saved-abstract"))).toEqual(["adults with type 2 diabetes"]);
    await closeStudy(page, TITLES.changed);
    traffic.stop();
    expect(traffic.forbidden).toEqual([]);
  });

  test("D · the abstract removed from the library: the record keeps its copy, and there is nothing to compare", async () => {
    await openStudyFromEditPaper(page, TITLES.removed, "SRSC Removed trial");
    await expect(banner(page)).toHaveAttribute("data-source-state", "abstract_removed");
    await expect(banner(page)).toContainText("The abstract was removed from your library. Your record keeps its saved copy.");
    await expect(sourcePane(page).getByTestId("source-compare-open")).toHaveCount(0);
    await closeStudy(page);
  });

  test("E · an abstract newly available to a record without a copy: said so, and shown read-only", async () => {
    await openStudy(page, TITLES.added, "SRSC New abstract trial");
    await expect(banner(page)).toHaveAttribute("data-source-state", "abstract_now_available");
    await expect(banner(page)).toContainText("This paper now has an abstract in your library, but this record has no saved copy of it, so it can't be quoted.");
    await sourcePane(page).getByRole("button", { name: "Show the library abstract" }).click();
    await expect(compareView(page).getByRole("tablist", { name: "What to show" }).getByRole("tab")).toHaveText(["Library abstract"]);
    await expect(compareView(page).getByTestId("source-compare-library-text")).toHaveText(TEXTS.added);
    await expect(studyDialog(page).getByTestId("use-as-quote-bar")).toHaveCount(0);
    await closeStudy(page, TITLES.added);
  });

  test("F · G · I · an earlier saved copy, opened read-only with its own quote marked; opening it drops a selection", async () => {
    const copies = await studyOf(page, TITLES.copies);
    const traffic = watchStudyRecordTraffic(page, []);
    const reads = watchSourceReads(page);
    await openStudy(page, TITLES.copies, "SRSC Copies trial");
    await expect(banner(page)).toHaveAttribute("data-source-state", "current");
    const current = sourcePane(page).getByTestId("study-record-saved-abstract");
    await expect(current).toHaveText(TEXTS.copiesSecond);
    // G: on copy 2, the quote that moved; never the one kept on copy 1.
    expect(await marked(current)).toEqual(["adults with heart failure"]);

    // I: a selection in the current copy, then another copy opened.
    await selectInSavedCopy(page, "low-salt diet");
    await expect(studyDialog(page).getByTestId("use-as-quote-bar")).toContainText("low-salt diet");
    const list = sourcePane(page).getByTestId("saved-copies");
    await expect(list).toContainText("Saved copies of this abstract (2)");
    await list.getByRole("button", { name: "Show saved copies" }).click();
    await expect(list.getByTestId("saved-copy-item")).toHaveCount(2);
    expect(reads.copies).toEqual([]);
    await list.getByRole("button", { name: "Show copy 1" }).click();
    await expect(studyDialog(page).getByTestId("use-as-quote-bar")).toHaveCount(0);

    // F: labelled, read-only, its exact text.
    const earlier = sourcePane(page).getByTestId("earlier-copy");
    await expect(earlier.getByRole("heading", { name: "Copy 1 of 2 — an earlier saved copy" })).toBeFocused();
    await expect(earlier).toContainText(`${Array.from(TEXTS.copiesFirst).length} characters`);
    await expect(earlier).toContainText("Read-only. A quote stays on the copy it was made on; new quotes come from the current copy, copy 2.");
    const text = earlier.getByTestId("earlier-copy-text");
    await expect(text).toHaveText(TEXTS.copiesFirst);
    // G: copy 1's own quote, by copy 1's own offsets.
    expect(await marked(text)).toEqual(["at three hospitals"]);
    expect(reads.copies.map((params) => [params.get("user_id"), params.get("study_id"), params.get("paper_id")])).toEqual([[`eq.${copies.userId}`, `eq.${copies.studyId}`, `eq.${copies.paperId}`]]);
    expect(new Set(reads.methods)).toEqual(new Set(["GET"]));

    await earlier.getByTestId("earlier-copy-back").click();
    await expect(current).toHaveText(TEXTS.copiesSecond);
    await expect(studyDialog(page).getByTestId("use-as-quote-bar")).toHaveCount(0);
    await closeStudy(page, TITLES.copies);
    traffic.stop();
    reads.stop();
    expect(traffic.forbidden).toEqual([]);
  });

  test("H · Check again reads the library afresh — an edit made elsewhere shows — and nothing is written", async () => {
    const same = await studyOf(page, TITLES.same);
    let traffic = watchStudyRecordTraffic(page, []);
    const reads = watchSourceReads(page);
    await openStudy(page, TITLES.same, "SRSC Same trial");
    await expect(banner(page)).toHaveAttribute("data-source-state", "current");
    traffic.stop();
    expect(traffic.forbidden).toEqual([]);
    // The abstract is edited in another tab — the spec's own write, outside the watch; the banner doesn't move until asked.
    await editLibraryAbstract(page, same.paperId, TEXTS.sameEdited);
    traffic = watchStudyRecordTraffic(page, []);
    await expect(banner(page)).toHaveAttribute("data-source-state", "current");
    const before = reads.abstracts.length;
    await banner(page).getByRole("button", { name: "Check the abstract in your library again" }).click();
    await expect(banner(page)).toHaveAttribute("data-source-state", "content_change");
    expect(reads.abstracts.length).toBe(before + 1);
    await sourcePane(page).getByTestId("source-compare-open").click();
    await expect(compareView(page).getByTestId("source-compare-change")).toHaveCount(1);
    await chooseReading(page, "Library abstract");
    await expect(compareView(page).getByTestId("source-compare-library-text")).toHaveText(TEXTS.sameEdited);
    await chooseReading(page, "Saved copy 1");
    await expect(compareView(page).getByTestId("source-compare-saved-text")).toHaveText(TEXTS.same);
    await compareView(page).getByTestId("source-compare-back").click();
    // The record is as it was: its version, its copy.
    expect((await studyOf(page, TITLES.same)).version).toBe(same.version);
    await closeStudy(page, TITLES.same);
    traffic.stop();
    reads.stop();
    expect(traffic.forbidden).toEqual([]);
    expect(traffic.rpcs.filter((rpc) => !traffic.reads.includes(rpc))).toEqual([]);
    expect(new Set(reads.methods)).toEqual(new Set(["GET"]));
  });
});

test.describe("Source comparison — on a phone", () => {
  test("K · the comparison is in the Source tab, one full-width reading at a time: nothing scrolls sideways, every control is a reachable touch target", async ({ browser }) => {
    test.setTimeout(60_000);
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] }, viewport: PHONE, hasTouch: true, isMobile: true });
    const page = await context.newPage();
    try {
      await signIn(page, "E2E_STUDY_SOURCE_OWNER_EMAIL", "E2E_STUDY_SOURCE_OWNER_PASSWORD");
      await openStudy(page, TITLES.changed, "SRSC Changed trial");
      const dialog = studyDialog(page);
      await dialog.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((animation) => animation.finished)));
      expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches), "the phone context has a coarse pointer").toBe(true);
      const sourceTab = dialog.getByRole("tablist", { name: "Study record view" }).getByRole("tab", { name: "Source" });
      await sourceTab.tap();
      await expect(banner(page)).toHaveAttribute("data-source-state", "content_change");
      await expectNoSidewaysScroll(page, "the Source tab, with its banner");
      await sourcePane(page).getByTestId("source-compare-open").tap();
      await expect(compareView(page).getByTestId("source-compare-changes")).toBeVisible();
      await expectNoSidewaysScroll(page, "Compare, Changes");

      const readings = compareView(page).getByRole("tablist", { name: "What to show" }).getByRole("tab");
      for (const [control, what] of [
        [readings.nth(0), "the Changes tab"],
        [readings.nth(1), "the Saved copy tab"],
        [readings.nth(2), "the Library abstract tab"],
        [compareView(page).getByRole("button", { name: "Next change" }), "Next change"],
        [compareView(page).getByTestId("source-compare-back"), "Back to the saved copy"],
        [compareView(page).getByRole("button", { name: "Check the abstract in your library again" }), "Check again"],
      ] as const) {
        const hit = await expectReachable(control, what);
        expect(hit.height, `${what}: a touch target at least 40 px tall`).toBeGreaterThanOrEqual(40);
      }
      await readings.nth(2).tap();
      await expect(compareView(page).getByTestId("source-compare-library-text")).toHaveText(TEXTS.changedLibrary);
      await expect(compareView(page).getByTestId("source-compare-changes")).toHaveCount(0);
      await expectNoSidewaysScroll(page, "Compare, Library abstract");
      await readings.nth(1).tap();
      await expect(compareView(page).getByTestId("source-compare-saved-text")).toHaveText(TEXTS.changedSaved);
      await expectNoSidewaysScroll(page, "Compare, Saved copy");
    } finally {
      await context.close();
    }
  });
});

test.describe("Source comparison — a former owner, now a manager", () => {
  test("J · compares and opens earlier copies of their own record; nothing can be saved, and a rebase sent directly is refused", async ({ browser }) => {
    test.setTimeout(60_000);
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] }, viewport: DESKTOP });
    const page = await context.newPage();
    try {
      await signIn(page, "E2E_STUDY_SOURCE_FORMER_EMAIL", "E2E_STUDY_SOURCE_FORMER_PASSWORD");
      const own = await studyOf(page, TITLES.former);
      const traffic = watchStudyRecordTraffic(page, []);
      await openStudy(page, TITLES.former, "SRSC Former owner's trial");
      const dialog = studyDialog(page);
      await expect(dialog.getByTestId("study-record-read-only")).toBeVisible();
      await expect(dialog.getByTestId("study-record-save")).toHaveCount(0);
      await expect(banner(page)).toHaveAttribute("data-source-state", "content_change");
      await sourcePane(page).getByTestId("source-compare-open").click();
      await chooseReading(page, "Library abstract");
      await expect(compareView(page).getByTestId("source-compare-library-text")).toHaveText(TEXTS.formerLibrary);
      await compareView(page).getByTestId("source-compare-back").click();
      await sourcePane(page).getByRole("button", { name: "Show saved copies" }).click();
      await sourcePane(page).getByRole("button", { name: "Show copy 1" }).click();
      const text = sourcePane(page).getByTestId("earlier-copy-text");
      await expect(text).toHaveText(TEXTS.formerFirst);
      expect(await marked(text)).toEqual(["40 participants"]);
      traffic.stop();
      expect(traffic.forbidden).toEqual([]);
      expect(traffic.rpcs.filter((rpc) => !traffic.reads.includes(rpc))).toEqual([]);

      // A manager is not an owner: the rebase itself refuses, before reading anything.
      expect(await rebaseDirectly(page, own, TEXTS.formerLibrary)).toEqual({ code: "42501", message: "evidence_records_not_enabled" });
      expect((await studyOf(page, TITLES.former)).version).toBe(own.version);
    } finally {
      await context.close();
    }
  });
});
