import { test, expect, type BrowserContext, type Locator, type Page, type Request } from "@playwright/test";
import { assertLocalSupabaseUrl, assertOriginsMatch } from "./support/backend-guard";
import { watchStudyRecordTraffic } from "./support/study-record-traffic";
import { waitForDashboard } from "./helpers";

/**
 * EVIDENCE-RECORDS-001C1 — the Study Record UI, end to end, against the local
 * stack. Synthetic data only, in two disposable accounts the lifecycle
 * provisions for this spec (`scripts/e2e-local-evidence-fixture.mjs`):
 *
 *   * the PILOT OWNER (`internal_user_access.role = 'owner'`, local only):
 *     creates a record, quotes the saved abstract — thin spaces, superscripts
 *     and a repeated passage included — saves, is refused where the server
 *     must refuse, and deletes;
 *   * a FORMER OWNER now `manager`: views and deletes the record they hold,
 *     and can create or edit nothing — the server refuses even a direct call.
 *
 * Requirements-001 §I's PR-C1 scenarios, in order: 1 entry point · 2 create ·
 * 3 quote selected and matched · 4 field saved · 5 invalid quote refused ·
 * 6 repeated passage needs a choice · 7 no create/edit without the pilot ·
 * 8 a linked paper is not deleted · 9 a linked discard is not merged ·
 * 10 deleting the record frees the paper · 11 Record/Source on a phone. And
 * C1-R1: a create whose answer is lost after the database committed it is
 * found again on reopening and retried with the same request — one study.
 *
 * Writes go only through the real RPCs. After the run, the lifecycle proves as
 * the database owner that the refused delete and merge changed no assignment,
 * attachment or cleanup job, and removes both accounts.
 */

const CLIENT_MODULE_PATH = "/src/integrations/supabase/client.ts";

const THIN_SPACE = String.fromCodePoint(0x2009);
const SUPERSCRIPT_TWO = String.fromCodePoint(0x00b2);
const GREATER_EQUAL = String.fromCodePoint(0x2265);
/** Selected in the saved copy: a thin space and a superscript must survive the round trip. */
const SELECTED_PASSAGE = `BMI ${GREATER_EQUAL}30${THIN_SPACE}kg/m${SUPERSCRIPT_TWO}`;
/** Twice in the abstract. */
const REPEATED_PHRASE = "body weight was measured";

const TITLES = {
  main: "SR-E2E Metformin trial",
  deleteRace: "SR-E2E Delete race",
  duplicateKept: "SR-E2E Duplicate pair (complete)",
  duplicateHeld: "SR-E2E Duplicate pair (has a study record)",
  mergeKept: "SR-E2E Merge race (complete)",
  mergeDiscard: "SR-E2E Merge race (sparse)",
  formerHeld: "SR-E2E Former owner's paper",
  formerFree: "SR-E2E Paper without a record",
  lostAnswer: "SR-E2E Lost answer",
};

const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing ${name}. The study-record spec runs only through \`npm run test:e2e:local\`, which provisions its accounts.`);
  }
  return value;
}

/**
 * Sign in as one of this spec's accounts. The Layer 2 backend guard is
 * re-asserted before any credential is read, as in the other specs that enter
 * credentials of their own.
 */
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
  if (!browserOrigin) throw new Error("study-record spec could not read the browser-loaded Supabase origin; refusing to continue.");
  assertLocalSupabaseUrl(browserOrigin, "browser-loaded Supabase origin");
  assertOriginsMatch(expectedOrigin, browserOrigin, { label: "Supabase origin (expected vs browser-loaded)" });

  await page.getByPlaceholder("you@example.com").fill(requireEnv(emailVar));
  await page.getByPlaceholder("••••••••").fill(requireEnv(passwordVar));
  await page.getByRole("button", { name: /sign in/i }).click();
  await waitForDashboard(page);
}

// ── Reads and probes through the app's own client (as the signed-in user, under RLS) ──
//
// Each helper imports the Vite-served client module inside the page, so every
// read and probe is the signed-in user's own request, under RLS — never a key.

type DbError = { code?: string; message?: string } | null;
/** The part of the supabase-js client these probes use. */
type Client = {
  from: (table: string) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
  rpc: (name: string, args: unknown) => Promise<{ data: unknown; error: DbError }>;
};

async function paperId(page: Page, title: string): Promise<string> {
  const ids = await page.evaluate(
    async ({ modPath, title }) => {
      const { supabase: client } = (await import(modPath)) as { supabase: Client };
      const { data, error } = await client.from("papers").select("id").eq("title", title);
      if (error) throw new Error(error.message);
      return (data as { id: string }[]).map((row) => row.id);
    },
    { modPath: CLIENT_MODULE_PATH, title },
  );
  if (ids.length !== 1) throw new Error(`expected one paper titled ${title}, found ${ids.length}`);
  return ids[0];
}

/** The studies a paper reports, with their versions. */
async function studiesOf(page: Page, title: string): Promise<{ id: string; version: number }[]> {
  const id = await paperId(page, title);
  return page.evaluate(
    async ({ modPath, id }) => {
      const { supabase: client } = (await import(modPath)) as { supabase: Client };
      const links = await client.from("evidence_study_reports").select("study_id").eq("paper_id", id);
      if (links.error) throw new Error(links.error.message);
      const ids = (links.data as { study_id: string }[]).map((row) => row.study_id);
      if (ids.length === 0) return [];
      const studies = await client.from("evidence_studies").select("id, row_version").in("id", ids);
      if (studies.error) throw new Error(studies.error.message);
      return (studies.data as { id: string; row_version: number }[]).map((row) => ({ id: row.id, version: row.row_version }));
    },
    { modPath: CLIENT_MODULE_PATH, id },
  );
}

interface StoredQuote {
  quote_text: string;
  match_start: number | null;
  match_end: number | null;
  match_occurrence: number | null;
  match_count: number | null;
  normalization_version: string | null;
  matched_at: string | null;
}

/** The supporting abstract quotes of one field, as the SERVER stored them. */
async function quotesOf(page: Page, studyId: string, fieldKey: string): Promise<StoredQuote[]> {
  return page.evaluate(
    async ({ modPath, studyId, fieldKey }) => {
      const { supabase: client } = (await import(modPath)) as { supabase: Client };
      const value = await client.from("evidence_field_values").select("id").eq("study_id", studyId).eq("field_key", fieldKey);
      if (value.error) throw new Error(value.error.message);
      const values = value.data as { id: string }[];
      if (values.length !== 1) return [];
      const anchors = await client
        .from("evidence_field_anchors")
        .select("quote_text, match_start, match_end, match_occurrence, match_count, normalization_version, matched_at, position")
        .eq("value_id", values[0].id)
        .eq("purpose", "supports")
        .eq("source_kind", "abstract")
        .order("position");
      if (anchors.error) throw new Error(anchors.error.message);
      return anchors.data as StoredQuote[];
    },
    { modPath: CLIENT_MODULE_PATH, studyId, fieldKey },
  );
}

/** A paper's library abstract, as its owner reads it. */
async function libraryAbstract(page: Page, title: string): Promise<string> {
  return page.evaluate(
    async ({ modPath, title }) => {
      const { supabase: client } = (await import(modPath)) as { supabase: Client };
      const { data, error } = await client.from("papers").select("abstract").eq("title", title).single();
      if (error) throw new Error(error.message);
      return (data as { abstract: string }).abstract;
    },
    { modPath: CLIENT_MODULE_PATH, title },
  );
}

/** Create a study record through the lifecycle RPC directly — the "other tab" of a race, or a refused attempt. */
async function createStudyDirectly(page: Page, title: string, label: string): Promise<DbError> {
  const id = await paperId(page, title);
  return page.evaluate(
    async ({ modPath, id, label }) => {
      const { supabase: client } = (await import(modPath)) as { supabase: Client };
      const { error } = await client.rpc("evidence_create_study_from_paper", {
        p_paper_id: id,
        p_label: label,
        p_design_profile: "rct_parallel",
        p_link_status: "provisional",
        p_request_id: crypto.randomUUID(),
      });
      return error ? { code: error.code, message: error.message } : null;
    },
    { modPath: CLIENT_MODULE_PATH, id, label },
  );
}

/** Save a quote the saved copy does not contain, bypassing the browser's checks. */
async function saveUnmatchedQuoteDirectly(page: Page, title: string): Promise<DbError> {
  const id = await paperId(page, title);
  const [study] = await studiesOf(page, title);
  return page.evaluate(
    async ({ modPath, id, studyId, version }) => {
      const { supabase: client } = (await import(modPath)) as { supabase: Client };
      const copy = await client.from("evidence_source_snapshots").select("id").eq("study_id", studyId).single();
      if (copy.error) throw new Error(copy.error.message);
      const { error } = await client.rpc("evidence_save_changes", {
        p_study_id: studyId,
        p_expected_version: version,
        p_request_id: crypto.randomUUID(),
        p_changes: [
          {
            op: "set_value",
            target: { scope: "study" },
            field_key: "setting",
            expected_value_version: null,
            value_state: "reported",
            state_reason: null,
            content: { shape: "text", text: "Clinics" },
            note: null,
            references: [
              {
                purpose: "supports",
                source_kind: "abstract",
                paper_id: id,
                snapshot_id: (copy.data as { id: string }).id,
                quote_text: "insulin glargine",
                occurrence: null,
                expected_match_count: null,
              },
            ],
          },
        ],
      });
      return error ? { code: error.code, message: error.message } : null;
    },
    { modPath: CLIENT_MODULE_PATH, id, studyId: study.id, version: study.version },
  );
}

/** A paper's assignments and attachments, as its owner reads them. */
async function holdings(page: Page, title: string): Promise<{ projects: number; tags: number; attachments: number }> {
  const id = await paperId(page, title);
  return page.evaluate(
    async ({ modPath, id }) => {
      const { supabase: client } = (await import(modPath)) as { supabase: Client };
      const count = async (table: string) => {
        const { data, error } = await client.from(table).select("paper_id").eq("paper_id", id);
        if (error) throw new Error(error.message);
        return (data as unknown[]).length;
      };
      return { projects: await count("paper_projects"), tags: await count("paper_tags"), attachments: await count("paper_attachments") };
    },
    { modPath: CLIENT_MODULE_PATH, id },
  );
}

// ── UI helpers ──

/**
 * What the Study Record dialog may send while it is open: reads — the
 * dashboard's audited RPC reads among them (`support/study-record-traffic.ts`)
 * — and the study-record RPCs; never an Edge Function, another RPC, or a
 * direct write.
 */
function watchDialogTraffic(page: Page) {
  return watchStudyRecordTraffic(page, [
    "evidence_create_study_from_paper",
    "evidence_update_study",
    "evidence_save_changes",
    "evidence_set_link",
    "evidence_delete_study",
  ]);
}

async function expandRow(page: Page, title: string) {
  const toggle = page.getByRole("button", { name: `Expand abstract for ${title}` });
  await toggle.click();
  await expect(page.getByRole("button", { name: `Collapse abstract for ${title}` })).toBeVisible();
}

async function collapseRow(page: Page, title: string) {
  await page.getByRole("button", { name: `Collapse abstract for ${title}` }).click();
}

function studyDialog(page: Page) {
  return page.getByTestId("study-record-dialog");
}

async function closeStudyDialog(page: Page) {
  await studyDialog(page).getByRole("button", { name: "Close" }).last().click();
  await expect(studyDialog(page)).toBeHidden();
}

/** Select `passage` (its `nth` occurrence) in the saved copy, as a reader would. */
async function selectInSavedCopy(page: Page, passage: string, nth = 0) {
  await page.getByTestId("study-record-saved-abstract").evaluate(
    (root, { passage, nth }) => {
      const full = root.textContent ?? "";
      let at = -1;
      for (let i = 0; i <= nth; i += 1) at = full.indexOf(passage, at + 1);
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
    },
    { passage, nth },
  );
}

async function save(page: Page) {
  await studyDialog(page).getByTestId("study-record-save").click();
  await expect(studyDialog(page).getByTestId("study-record-save-status")).toHaveText("Saved.");
}

async function expectNoSidewaysScroll(page: Page, where: string) {
  const overflow = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    dialog: (() => {
      const el = document.querySelector("[data-testid=study-record-dialog]");
      return el ? el.scrollWidth - el.clientWidth : 0;
    })(),
  }));
  expect(overflow.document, `${where}: no document-level sideways scroll`).toBeLessThanOrEqual(0);
  expect(overflow.dialog, `${where}: nothing overflows the dialog sideways`).toBeLessThanOrEqual(0);
}

// ─────────────────────────────────────────────────────────────────────────────

test.describe("Study records — the pilot owner", () => {
  test.describe.configure({ mode: "serial" });

  let context: BrowserContext;
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext({ storageState: { cookies: [], origins: [] }, viewport: DESKTOP });
    page = await context.newPage();
    await signIn(page, "E2E_STUDY_OWNER_EMAIL", "E2E_STUDY_OWNER_PASSWORD");
  });

  test.afterAll(async () => {
    await context?.close();
  });

  test("1 · the entry point is in the paper's expanded details, not the row's icons", async () => {
    // Test 2's create is this group's first write, and CI retries a failed
    // group from the top against what the failed attempt left: say so here.
    expect(
      await studiesOf(page, TITLES.main).catch(() => null),
      "the paper is as provisioned, with no study record; if not, an earlier attempt of this group changed it, and that attempt's error is the one to read",
    ).toEqual([]);

    const rowButtons = await page.getByRole("row").filter({ hasText: TITLES.main }).getByRole("button").evaluateAll((buttons) =>
      buttons.map((button) => button.getAttribute("aria-label") ?? button.textContent ?? ""),
    );
    expect(rowButtons.some((label) => /study record/i.test(label))).toBe(false);

    await expandRow(page, TITLES.main);
    const entry = page.getByTestId("study-record-entry");
    await expect(entry.getByTestId("study-record-entry-status")).toHaveText("Study records — None");
    await expect(entry.getByRole("button", { name: "Start a study record" })).toBeVisible();
  });

  test("2 · the owner creates a study record, and the saved copy keeps every character", async () => {
    const traffic = watchDialogTraffic(page);
    await page.getByTestId("study-record-entry").getByRole("button", { name: "Start a study record" }).click();
    const dialog = studyDialog(page);
    await expect(dialog.getByRole("heading", { name: `Study record for: ${TITLES.main}` })).toBeVisible();
    await expect(dialog).toContainText("PaperLume doesn't check whether it's right.");
    await expect(dialog.getByTestId("study-record-source-notice")).toContainText("PaperLume will save a copy of this paper's abstract");

    await dialog.getByRole("radio", { name: /^Yes/ }).click();
    await dialog.getByRole("radio", { name: /^Randomized trial, parallel groups/ }).click();
    await expect(dialog.getByLabel("Study name")).toHaveValue("Doe 2024");
    await dialog.getByRole("button", { name: "Create study record" }).click();

    await expect(dialog.getByRole("heading", { name: "Study record: Doe 2024" })).toBeVisible();
    const abstract = await libraryAbstract(page, TITLES.main);
    expect(abstract).toContain(SELECTED_PASSAGE);
    const copy = dialog.getByTestId("study-record-saved-abstract");
    expect(await copy.evaluate((el) => el.textContent)).toBe(abstract);
    expect(await copy.evaluate((el) => getComputedStyle(el).whiteSpace)).toBe("pre-wrap");

    traffic.stop();
    expect(traffic.forbidden).toEqual([]);
    expect(traffic.rpcs).toContain("evidence_create_study_from_paper");
    const [study] = await studiesOf(page, TITLES.main);
    expect(study.version).toBe(1);
  });

  test("3–4 · a selected passage becomes a quote the server matches, and the field is saved", async () => {
    const traffic = watchDialogTraffic(page);
    const dialog = studyDialog(page);
    await selectInSavedCopy(page, SELECTED_PASSAGE);
    const bar = dialog.getByTestId("use-as-quote-bar");
    await expect(bar).toContainText(SELECTED_PASSAGE);
    await bar.getByLabel("Use as quote for").selectOption({ label: "Who took part" });
    await bar.getByRole("button", { name: "Use as quote" }).click();

    const field = dialog.getByTestId("field-study|population_description");
    await expect(field.getByRole("radio", { name: "Reported", exact: true })).toBeChecked();
    await expect(field.getByLabel("Value")).toHaveValue(SELECTED_PASSAGE);
    await expect(field).toContainText("Found in the saved abstract");
    await expect(dialog.getByTestId("study-record-save-status")).toHaveText("Unsaved changes");
    await save(page);

    traffic.stop();
    expect(traffic.forbidden).toEqual([]);
    expect(traffic.rpcs.filter((name) => name.startsWith("evidence_"))).toEqual(["evidence_save_changes"]);
    const [study] = await studiesOf(page, TITLES.main);
    const [quote] = await quotesOf(page, study.id, "population_description");
    expect(quote.quote_text).toBe(SELECTED_PASSAGE);
    // Matched by the server, not the browser: offsets, count and time are its own.
    expect(quote.match_start).not.toBeNull();
    expect(quote.match_end).toBeGreaterThan(quote.match_start!);
    expect([quote.match_occurrence, quote.match_count, quote.normalization_version]).toEqual([1, 1, "v1"]);
    expect(quote.matched_at).not.toBeNull();
  });

  test("5 · a quote that isn't in the saved copy cannot be added — and the server refuses one too", async () => {
    const dialog = studyDialog(page);
    const field = dialog.getByTestId("field-study|condition");
    await field.getByRole("radio", { name: "Reported", exact: true }).click();
    await field.getByLabel("Value").fill("Type 2 diabetes");
    await field.getByRole("button", { name: "Add quote" }).click();
    const panel = field.getByTestId("add-quote-panel");
    await panel.getByLabel("Quote from the saved abstract").fill("insulin glargine");
    await expect(panel.getByTestId("add-quote-status")).toHaveText(
      "This text wasn't found in the saved abstract. Select it directly in the abstract, or add it as a full-text reference if it comes from elsewhere.",
    );
    await expect(panel.getByRole("button", { name: "Add this quote" })).toBeDisabled();
    await panel.getByLabel("Quote from the saved abstract").fill("ab");
    await expect(panel.getByTestId("add-quote-status")).toHaveText("Quote at least 3 characters, including a letter or number.");
    await panel.getByRole("button", { name: "Cancel" }).click();

    // The browser only advises; the database decides. A quote sent anyway is refused.
    const refused = await saveUnmatchedQuoteDirectly(page, TITLES.main);
    expect(refused?.message).toBe("evidence_quote_not_found");
  });

  test("6 · a passage that occurs twice needs an explicit choice, which the server keeps", async () => {
    const dialog = studyDialog(page);
    const field = dialog.getByTestId("field-study|condition");
    await field.getByRole("button", { name: "Add quote" }).click();
    const panel = field.getByTestId("add-quote-panel");
    await panel.getByLabel("Quote from the saved abstract").fill(REPEATED_PHRASE);
    await expect(panel.getByTestId("add-quote-status")).toHaveText("Found 2 times in the saved abstract. Choose the one you mean.");
    const add = panel.getByRole("button", { name: "Add this quote" });
    await expect(add).toBeDisabled();
    await panel.getByRole("radio", { name: "Occurrence 2" }).click();
    await expect(add).toBeEnabled();
    await add.click();
    await expect(field).toContainText("occurrence 2 of 2");
    await save(page);

    const [study] = await studiesOf(page, TITLES.main);
    const [quote] = await quotesOf(page, study.id, "condition");
    expect([quote.quote_text, quote.match_occurrence, quote.match_count]).toEqual([REPEATED_PHRASE, 2, 2]);
    await closeStudyDialog(page);
    await collapseRow(page, TITLES.main);
  });

  test("8 · a paper with a study record is not deleted — alone, in a selection, or in a race", async () => {
    test.setTimeout(60_000);
    // Alone: explained, with a way to the record, and no Delete.
    await page.getByRole("button", { name: `Delete ${TITLES.main}` }).click();
    let confirmation = page.getByRole("alertdialog");
    await expect(confirmation).toContainText("This paper has a study record");
    await expect(confirmation).toContainText(`‘${TITLES.main}’ has a study record. Delete the study record first`);
    await expect(confirmation.getByRole("button", { name: "Delete" })).toHaveCount(0);
    await confirmation.getByRole("button", { name: "Open study record" }).click();
    await expect(studyDialog(page).getByRole("heading", { name: "Study record: Doe 2024" })).toBeVisible();
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await closeStudyDialog(page);

    // In a selection: named, deselectable, never sent.
    for (const title of [TITLES.main, TITLES.deleteRace]) {
      const checkbox = page.getByRole("checkbox", { name: `Select ${title}`, exact: true });
      await checkbox.focus();
      await page.keyboard.press("Space");
      await expect(checkbox).toBeChecked();
    }
    await page.getByRole("region", { name: "Bulk actions" }).getByRole("button", { name: "Delete", exact: true }).click();
    const bulk = page.getByRole("dialog", { name: "Some selected papers have study records" });
    await expect(bulk).toContainText("1 of the 2 selected papers have study records.");
    await expect(bulk.getByRole("listitem")).toHaveText([TITLES.main]);
    await expect(bulk.getByRole("button", { name: "Delete" })).toHaveCount(0);
    await bulk.getByRole("button", { name: "Deselect papers with study records" }).click();
    const clear = page.getByRole("dialog", { name: "Delete 1 paper?" });
    await expect(clear.getByRole("button", { name: "Delete" })).toBeEnabled();
    await clear.getByRole("button", { name: "Cancel" }).click();
    await page.getByRole("region", { name: "Bulk actions" }).getByRole("button", { name: "Clear Selection" }).click();

    // In a race: the check is clear when the confirmation opens; a record made
    // in "another tab" before Delete is pressed is refused by the database.
    const before = await holdings(page, TITLES.deleteRace);
    expect(before).toEqual({ projects: 1, tags: 1, attachments: 1 });
    await page.getByRole("button", { name: `Delete ${TITLES.deleteRace}` }).click();
    confirmation = page.getByRole("alertdialog");
    const del = confirmation.getByRole("button", { name: "Delete" });
    await expect(del).toBeEnabled();
    expect(await createStudyDirectly(page, TITLES.deleteRace, "Created in another tab")).toBeNull();
    await del.click();
    await expect(page.getByText("Paper not deleted")).toBeVisible();
    await expect(page.getByRole("button", { name: `Delete ${TITLES.deleteRace}` })).toBeVisible();
    expect(await holdings(page, TITLES.deleteRace)).toEqual(before);
  });

  test("9 · a merge that would discard a paper with a study record is refused", async () => {
    test.setTimeout(60_000);
    await page.getByRole("button", { name: "Find Duplicates" }).click();
    const dialog = page.getByRole("dialog", { name: /Find Duplicates/ });
    await expect(dialog.getByTestId("duplicate-group")).toHaveCount(2);
    await expect(dialog.getByTestId("duplicate-study-record-notice")).toBeVisible();

    // The held paper is suggested as the keeper; discarding it is blocked.
    const held = dialog.getByTestId("duplicate-group").filter({ hasText: TITLES.duplicateHeld });
    await expect(held.getByRole("radio", { name: new RegExp(TITLES.duplicateHeld.replace(/[()]/g, "\\$&")) })).toBeChecked();
    await expect(held.getByText("Study record", { exact: true })).toBeVisible();
    await held.getByRole("radio", { name: new RegExp(TITLES.duplicateKept.replace(/[()]/g, "\\$&")) }).click();
    await expect(held.getByTestId("duplicate-group-block")).toContainText(`‘${TITLES.duplicateHeld}’ has a study record.`);
    const merge = dialog.getByRole("button", { name: /^Merge All/ });
    await expect(merge).toHaveText("Merge All (1 group)");

    // The other group is clear — until "another tab" links its discard.
    const before = await holdings(page, TITLES.mergeDiscard);
    expect(await createStudyDirectly(page, TITLES.mergeDiscard, "Created in another tab")).toBeNull();
    await merge.click();
    await expect(page.getByText("Group not merged")).toBeVisible();
    await expect(page.getByText("A paper in this group has a study record, so the group wasn't merged.")).toBeVisible();
    for (const title of [TITLES.duplicateKept, TITLES.duplicateHeld, TITLES.mergeKept, TITLES.mergeDiscard]) {
      await paperId(page, title);
    }
    expect(await holdings(page, TITLES.mergeDiscard)).toEqual(before);
  });

  test("10 · deleting the study record keeps the paper — and then the paper can be deleted", async () => {
    await page.reload({ waitUntil: "networkidle" });
    await waitForDashboard(page);
    await expandRow(page, TITLES.main);
    const entry = page.getByTestId("study-record-entry");
    await expect(entry.getByTestId("study-record-entry-status")).toHaveText("Study records — 1");
    await entry.getByRole("button", { name: "Open study record" }).click();
    const dialog = studyDialog(page);
    await expect(dialog.getByRole("heading", { name: "Study record: Doe 2024" })).toBeVisible();
    await dialog.getByRole("button", { name: "Delete study record" }).click();
    const confirm = page.getByTestId("study-record-delete-dialog");
    await expect(confirm).toContainText("The paper stays in your library.");
    await confirm.getByRole("button", { name: "Delete study record" }).click();
    await expect(page.getByText("Study record deleted. The paper stays in your library.")).toBeVisible();
    await expect(dialog).toBeHidden();
    expect(await studiesOf(page, TITLES.main)).toEqual([]);

    await page.getByRole("button", { name: `Delete ${TITLES.main}` }).click();
    const confirmation = page.getByRole("alertdialog");
    await expect(confirmation.getByRole("heading", { name: "Delete Paper" })).toBeVisible();
    await confirmation.getByRole("button", { name: "Delete" }).click();
    await expect(page.getByRole("button", { name: `Delete ${TITLES.main}` })).toHaveCount(0);
  });

  test("C1-R1 · a create whose answer is lost is found on reopening, and retrying sends the same request — one study", async () => {
    await page.reload({ waitUntil: "networkidle" });
    await waitForDashboard(page);
    const CREATE_RPC = "**/rest/v1/rpc/evidence_create_study_from_paper";
    const sent: unknown[] = [];
    const onRequest = (request: Request) => {
      if (request.method() === "POST" && request.url().includes("/rest/v1/rpc/evidence_create_study_from_paper")) sent.push(request.postDataJSON());
    };
    page.on("request", onRequest);
    const traffic = watchDialogTraffic(page);
    // The first create reaches the database and commits; its answer never reaches the page.
    await page.route(
      CREATE_RPC,
      async (route) => {
        await route.fetch();
        await route.abort("failed");
      },
      { times: 1 },
    );

    await expandRow(page, TITLES.lostAnswer);
    const entry = page.getByTestId("study-record-entry");
    await entry.getByRole("button", { name: "Start a study record" }).click();
    const dialog = studyDialog(page);
    await dialog.getByRole("radio", { name: /^Yes/ }).click();
    await dialog.getByRole("radio", { name: /^Randomized trial, parallel groups/ }).click();
    await dialog.getByLabel("Study name").fill("Lost answer trial");
    await dialog.getByRole("button", { name: "Create study record" }).click();

    const recovery = dialog.getByTestId("study-record-create-recovery");
    await expect(recovery.getByRole("alert")).toContainText("We couldn't confirm whether your change was saved.");
    const [created] = await studiesOf(page, TITLES.lostAnswer);
    expect(created.version).toBe(1);

    // The user leaves — allowed, and told the attempt is still open.
    await closeStudyDialog(page);
    await expect(page.getByText("This study record isn't confirmed yet")).toBeVisible();
    await expect(entry.getByTestId("study-record-entry-status")).toHaveText("Study records — 1");

    // Reopening at once offers the recovery, not a new creation.
    await entry.getByRole("button", { name: "Open study record" }).click();
    await expect(recovery).toBeVisible();
    await expect(recovery).toContainText("it might already exist");
    await expect(recovery).toContainText("Lost answer trial");
    await expect(dialog.getByRole("button", { name: "Create study record" })).toHaveCount(0);
    expect(sent).toHaveLength(1);

    const replay = page.waitForResponse((response) => response.url().includes("/rest/v1/rpc/evidence_create_study_from_paper"));
    await recovery.getByRole("button", { name: "Try again" }).click();
    expect(await (await replay).json()).toMatchObject({ status: "replayed", study_id: created.id });
    await expect(dialog.getByRole("heading", { name: "Study record: Lost answer trial" })).toBeVisible();

    // The exact original request, sent twice; the database holds one study.
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    expect(await studiesOf(page, TITLES.lostAnswer)).toEqual([created]);
    page.off("request", onRequest);
    traffic.stop();
    expect(traffic.forbidden).toEqual([]);
    await closeStudyDialog(page);
    await collapseRow(page, TITLES.lostAnswer);
  });

  test("11 · on a phone, Record and Source switch, and nothing scrolls sideways", async () => {
    await page.setViewportSize(PHONE);
    await page.reload({ waitUntil: "networkidle" });
    await waitForDashboard(page);
    await expandRow(page, TITLES.deleteRace);
    await page.getByTestId("study-record-entry").getByRole("button", { name: "Open study record" }).click();
    const dialog = studyDialog(page);
    await expect(dialog.getByRole("heading", { name: "Study record: Created in another tab" })).toBeVisible();
    const record = dialog.getByRole("tab", { name: "Record" });
    const source = dialog.getByRole("tab", { name: "Source" });
    await expect(record).toHaveAttribute("aria-selected", "true");
    await expect(dialog.getByTestId("study-record-record-pane")).toBeVisible();
    await expect(dialog.getByTestId("study-record-save")).toBeVisible();
    await expectNoSidewaysScroll(page, "Record");

    await source.click();
    await expect(source).toHaveAttribute("aria-selected", "true");
    await expect(dialog.getByTestId("study-record-saved-abstract")).toContainText("Synthetic abstract for the delete race");
    await expect(dialog.getByTestId("study-record-record-pane")).toBeHidden();
    await expectNoSidewaysScroll(page, "Source");

    await record.click();
    await expect(dialog.getByTestId("study-record-record-pane")).toBeVisible();
    await closeStudyDialog(page);
  });
});

test.describe("Study records — a former owner, now a manager", () => {
  test("7 · can view and delete their record, but cannot create or edit — and the server agrees", async ({ browser }) => {
    test.setTimeout(60_000);
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] }, viewport: DESKTOP });
    const page = await context.newPage();
    try {
      await signIn(page, "E2E_STUDY_FORMER_EMAIL", "E2E_STUDY_FORMER_PASSWORD");

      // No record: nothing is offered.
      await expandRow(page, TITLES.formerFree);
      await expect(page.getByTestId("study-record-entry")).toHaveCount(0);
      await collapseRow(page, TITLES.formerFree);

      // Their record: shown, opened read-only.
      await expandRow(page, TITLES.formerHeld);
      const entry = page.getByTestId("study-record-entry");
      await expect(entry.getByTestId("study-record-entry-status")).toHaveText("Study records — 1");
      await expect(entry.getByRole("button", { name: "Start a study record" })).toHaveCount(0);
      await entry.getByRole("button", { name: "Open study record" }).click();
      const dialog = studyDialog(page);
      await expect(dialog.getByRole("heading", { name: "Study record: Former owner's study" })).toBeVisible();
      await expect(dialog.getByTestId("study-record-read-only")).toBeVisible();
      await expect(dialog.getByTestId("study-record-save")).toHaveCount(0);
      await expect(dialog.getByLabel("Study name")).toBeDisabled();
      await expect(dialog.getByRole("button", { name: "Add intervention group" })).toHaveCount(0);

      // Hiding the controls is only the experience: the server refuses too.
      const refused = await createStudyDirectly(page, TITLES.formerFree, "Not allowed");
      expect(refused).toEqual({ code: "42501", message: "evidence_records_not_enabled" });

      // Delete stays available to whoever owns the record.
      await dialog.getByRole("button", { name: "Delete study record" }).click();
      await page.getByTestId("study-record-delete-dialog").getByRole("button", { name: "Delete study record" }).click();
      await expect(page.getByText("Study record deleted. The paper stays in your library.")).toBeVisible();
      await expect(dialog).toBeHidden();
      await expect(page.getByRole("button", { name: `Delete ${TITLES.formerHeld}` })).toBeVisible();
    } finally {
      await context.close();
    }
  });
});
