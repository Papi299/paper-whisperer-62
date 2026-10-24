import { test, expect, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { assertLocalSupabaseUrl, assertOriginsMatch } from "./support/backend-guard";
import { watchStudyRecordTraffic } from "./support/study-record-traffic";
import { waitForDashboard } from "./helpers";

/**
 * EVIDENCE-RECORDS-001C2A — Human Review, end to end, against the local stack.
 * Synthetic data only, in two disposable accounts of this spec's own, which
 * the lifecycle provisions through the real RPCs
 * (`scripts/e2e-local-review-fixture.mjs`):
 *
 *   * the PILOT OWNER (`internal_user_access.role = 'owner'`, local only)
 *     reviews one saved value at a time: R1 Confirm, persisted · R2 Confirm
 *     blocked, nothing sent · R3 Flag notes · R4 an unsaved edit elsewhere
 *     survives a Confirm, and Review shows only saved evidence · R5 saving a
 *     reviewed value resets its review · R6 a change made elsewhere refuses
 *     the Confirm · R7 a lost answer, retried with the same request · and on a
 *     phone, a Not reported claim confirmed with its saved copy beside it;
 *   * a FORMER OWNER now `manager` (R8): Review is read-only, and the server
 *     refuses a review sent directly.
 *
 * After the run the lifecycle checks as the database owner each value's
 * status, note, versions and review events — exactly one per recorded Confirm
 * or Flag — and removes both accounts, verifying nothing of theirs remains.
 */

const CLIENT_MODULE_PATH = "/src/integrations/supabase/client.ts";

const TITLES = {
  review: "SRR-E2E Review trial",
  conflict: "SRR-E2E Conflict trial",
  former: "SRR-E2E Former owner's trial",
};
const FLAG_NOTES = { first: "Check the methods", updated: "Check the methods and Table 1" };

const LABELS = {
  condition: "Condition or health status",
  setting: "Setting (countries, care setting)",
  classification: "Your classification of the design",
  demographics: "Key demographics (for example age, sex)",
  population: "Who took part",
  nRandomized: "Number randomized",
  designAsReported: "Design as described by the authors",
  eligibility: "Eligibility criteria, as reported",
  registration: "Trial registration numbers",
  armName: "Metformin: Group name as reported",
};

const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };
const REVIEW_RPC = "evidence_review_fields";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing ${name}. The study-records-review spec runs only through \`npm run test:e2e:local\`, which provisions its accounts.`);
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
  if (!browserOrigin) throw new Error("study-records-review spec could not read the browser-loaded Supabase origin; refusing to continue.");
  assertLocalSupabaseUrl(browserOrigin, "browser-loaded Supabase origin");
  assertOriginsMatch(expectedOrigin, browserOrigin, { label: "Supabase origin (expected vs browser-loaded)" });

  await page.getByPlaceholder("you@example.com").fill(requireEnv(emailVar));
  await page.getByPlaceholder("••••••••").fill(requireEnv(passwordVar));
  await page.getByRole("button", { name: /sign in/i }).click();
  await waitForDashboard(page);
}

// ── Reads and probes through the app's own client (the signed-in user, under RLS) ──

type DbError = { code?: string; message?: string } | null;
type Client = {
  from: (table: string) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
  rpc: (name: string, args: unknown) => Promise<{ data: unknown; error: DbError }>;
};

interface SavedValue {
  id: string;
  study_id: string;
  value_version: number;
  review_status: string;
  review_note: string | null;
  reviewed_version: number | null;
  reviewed_at: string | null;
  study_version: number;
  events: Record<string, number>;
}

/** One saved value of the study a paper reports, as its owner reads it, with its study's version and its events by type. */
async function savedValue(page: Page, title: string, fieldKey: string): Promise<SavedValue> {
  return page.evaluate(
    async ({ modPath, title, fieldKey }) => {
      const { supabase: client } = (await import(modPath)) as { supabase: Client };
      const paper = await client.from("papers").select("id").eq("title", title).single();
      if (paper.error) throw new Error(paper.error.message);
      const link = await client.from("evidence_study_reports").select("study_id").eq("paper_id", (paper.data as { id: string }).id).single();
      if (link.error) throw new Error(link.error.message);
      const studyId = (link.data as { study_id: string }).study_id;
      const study = await client.from("evidence_studies").select("row_version").eq("id", studyId).single();
      if (study.error) throw new Error(study.error.message);
      const value = await client
        .from("evidence_field_values")
        .select("id, study_id, value_version, review_status, review_note, reviewed_version, reviewed_at")
        .eq("study_id", studyId)
        .eq("field_key", fieldKey)
        .single();
      if (value.error) throw new Error(value.error.message);
      const events = await client.from("evidence_events").select("event_type").eq("study_id", studyId).eq("target_id", (value.data as { id: string }).id);
      if (events.error) throw new Error(events.error.message);
      const byType: Record<string, number> = {};
      for (const { event_type } of events.data as { event_type: string }[]) byType[event_type] = (byType[event_type] ?? 0) + 1;
      return { ...(value.data as Omit<SavedValue, "study_version" | "events">), study_version: (study.data as { row_version: number }).row_version, events: byType };
    },
    { modPath: CLIENT_MODULE_PATH, title, fieldKey },
  );
}

/** Send a review straight to the RPC — the way "another tab", or a client bypassing the UI, would. */
async function reviewDirectly(page: Page, value: SavedValue, action: "confirm" | "flag", note: string | null): Promise<{ data: unknown; error: DbError }> {
  return page.evaluate(
    async ({ modPath, value, action, note }) => {
      const { supabase: client } = (await import(modPath)) as { supabase: Client };
      const { data, error } = await client.rpc("evidence_review_fields", {
        p_study_id: value.study_id,
        p_expected_version: value.study_version,
        p_value_id: value.id,
        p_expected_value_version: value.value_version,
        p_action: action,
        p_note: note,
        p_request_id: crypto.randomUUID(),
      });
      return { data, error: error ? { code: error.code, message: error.message } : null };
    },
    { modPath: CLIENT_MODULE_PATH, value, action, note },
  );
}

/** Change a saved text value "in another tab": a save at the current versions, keeping its sources. */
async function changeTextDirectly(page: Page, value: SavedValue, fieldKey: string, text: string): Promise<DbError> {
  return page.evaluate(
    async ({ modPath, value, fieldKey, text }) => {
      const { supabase: client } = (await import(modPath)) as { supabase: Client };
      const anchors = await client.from("evidence_field_anchors").select("id").eq("value_id", value.id);
      if (anchors.error) throw new Error(anchors.error.message);
      const { error } = await client.rpc("evidence_save_changes", {
        p_study_id: value.study_id,
        p_expected_version: value.study_version,
        p_request_id: crypto.randomUUID(),
        p_changes: [
          {
            op: "set_value",
            target: { scope: "study" },
            field_key: fieldKey,
            expected_value_version: value.value_version,
            value_state: "reported",
            state_reason: null,
            content: { shape: "text", text },
            note: null,
            references: (anchors.data as { id: string }[]).map((anchor) => ({ anchor_id: anchor.id })),
          },
        ],
      });
      return error ? { code: error.code, message: error.message } : null;
    },
    { modPath: CLIENT_MODULE_PATH, value, fieldKey, text },
  );
}

// ── UI helpers ──

/**
 * Every review RPC the page sends, by request body, and anything the dialog
 * must never send: an Edge Function, a direct table write, an RPC other than
 * the study-record ones and the dashboard's audited reads
 * (`support/study-record-traffic.ts`).
 */
function watchTraffic(page: Page) {
  const traffic = watchStudyRecordTraffic(page, ["evidence_save_changes", "evidence_update_study", "evidence_set_link", REVIEW_RPC]);
  return { reviews: traffic.bodiesOf(REVIEW_RPC), forbidden: traffic.forbidden, stop: traffic.stop };
}

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

async function closeStudy(page: Page, title: string, { discard = false } = {}) {
  await studyDialog(page).getByRole("button", { name: "Close" }).last().click();
  if (discard) await page.getByRole("alertdialog").getByRole("button", { name: "Discard changes" }).click();
  await expect(studyDialog(page)).toBeHidden();
  await page.getByRole("button", { name: `Collapse abstract for ${title}` }).click();
}

async function chooseMode(page: Page, mode: "Edit" | "Review") {
  const tab = studyDialog(page).getByRole("tablist", { name: "Study record mode" }).getByRole("tab", { name: mode, exact: true });
  await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
}

async function showAll(page: Page) {
  await studyDialog(page).getByTestId("study-record-review-pane").getByRole("radio", { name: /^All recorded/ }).check();
}

function card(page: Page, label: string): Locator {
  return studyDialog(page).getByRole("article", { name: label, exact: true });
}

const confirmButton = (target: Locator) => target.getByRole("button", { name: "Confirm against this source", exact: true });

/** Select `passage` in the saved copy, as a reader would. */
async function selectInSavedCopy(page: Page, passage: string) {
  await studyDialog(page)
    .getByTestId("study-record-saved-abstract")
    .evaluate((root, passage) => {
      const at = (root.textContent ?? "").indexOf(passage);
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

async function expectNoSidewaysScroll(page: Page, where: string) {
  const overflow = await page.evaluate(() => {
    const widest = (selector: string) => {
      const el = document.querySelector(selector);
      return el ? el.scrollWidth - el.clientWidth : 0;
    };
    return {
      document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      dialog: widest("[data-testid=study-record-dialog]"),
      review: (() => {
        const pane = document.querySelector("[data-testid=study-record-review-pane]")?.closest("[role=tabpanel]");
        return pane ? pane.scrollWidth - pane.clientWidth : 0;
      })(),
    };
  });
  expect(overflow.document, `${where}: no document-level sideways scroll`).toBeLessThanOrEqual(0);
  expect(overflow.dialog, `${where}: nothing overflows the dialog sideways`).toBeLessThanOrEqual(0);
  expect(overflow.review, `${where}: nothing overflows the Review pane sideways`).toBeLessThanOrEqual(0);
}

/** The control a tap at its centre reaches is the control itself (or inside it), not something covering it. */
async function expectReachable(control: Locator, what: string) {
  await control.scrollIntoViewIfNeeded();
  const hit = await control.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const at = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return { reached: at === el || el.contains(at), height: box.height, width: box.width };
  });
  expect(hit.reached, `${what}: a tap at its centre reaches it`).toBe(true);
  return hit;
}

// ─────────────────────────────────────────────────────────────────────────────

test.describe("Review — the pilot owner", () => {
  test.describe.configure({ mode: "serial" });

  let context: BrowserContext;
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext({ storageState: { cookies: [], origins: [] }, viewport: DESKTOP });
    page = await context.newPage();
    await signIn(page, "E2E_STUDY_REVIEW_OWNER_EMAIL", "E2E_STUDY_REVIEW_OWNER_PASSWORD");
  });

  test.afterAll(async () => {
    await context?.close();
  });

  test("R1 · Confirm one quoted value; it persists after reopening, and focus moves to the next", async () => {
    // R1's Confirm is this group's first write, and CI retries a failed group
    // from the top against what the failed attempt left: once that Confirm has
    // committed, a retry can't repeat R1. Say so here, not later on the counts.
    const provisioned = await savedValue(page, TITLES.review, "condition");
    expect(
      [provisioned.review_status, provisioned.events.review_confirmed ?? 0],
      "R1's value is as provisioned; if not, an earlier attempt of this group confirmed it, and that attempt's error is the one to read",
    ).toEqual(["unreviewed", 0]);

    const traffic = watchTraffic(page);
    await openStudy(page, TITLES.review, "SRR Review trial");
    const dialog = studyDialog(page);
    // Edit is the default, and has no Confirm anywhere.
    await expect(dialog.getByRole("tab", { name: "Edit", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(dialog.getByTestId("study-record-record-pane").getByRole("button", { name: "Confirm against this source" })).toHaveCount(0);

    await chooseMode(page, "Review");
    const summary = dialog.getByTestId("review-summary");
    await expect(summary).toContainText("10 recorded fields");
    await expect(summary.getByTestId("review-summary-counts")).toHaveText("Not reviewed: 9Reviewed by you: 1Flagged: 0Needs re-review: 0");
    await expect(dialog.getByRole("radio", { name: "Needs your review (9)" })).toBeChecked();

    const condition = card(page, LABELS.condition);
    await expect(condition.getByTestId("review-quote").locator("mark")).toHaveText("adults with type 2 diabetes and obesity");
    await expect(condition).toContainText(`Quote from the saved abstract of ${TITLES.review} (copy 1 of 1, saved`);
    await condition.getByRole("heading", { name: LABELS.condition }).click();
    await expect(dialog.getByTestId("review-source-focus")).toContainText(`Source for: ${LABELS.condition}`);
    await expect(dialog.getByTestId("study-record-saved-abstract").locator("mark")).toHaveText(["adults with type 2 diabetes and obesity"]);
    // Opening the record and Review sent no review and nothing forbidden — checked before the Confirm writes.
    expect(traffic.reviews).toEqual([]);
    expect(traffic.forbidden).toEqual([]);

    await confirmButton(condition).click();
    await expect(dialog.getByTestId("review-announcement")).toHaveText(`Confirmed ${LABELS.condition}. Next: ${LABELS.eligibility}.`);
    // Confirm & next: focus is on the next value that needs review.
    await expect(card(page, LABELS.eligibility).getByRole("heading", { name: LABELS.eligibility })).toBeFocused();
    await expect(card(page, LABELS.condition)).toHaveCount(0); // reviewed now: no longer listed by default

    expect(traffic.reviews).toHaveLength(1);
    expect(traffic.reviews[0]).toMatchObject({ p_action: "confirm", p_note: null, p_expected_value_version: 1 });
    expect(Object.keys(traffic.reviews[0]).sort()).toEqual(["p_action", "p_expected_value_version", "p_expected_version", "p_note", "p_request_id", "p_study_id", "p_value_id"]);
    const saved = await savedValue(page, TITLES.review, "condition");
    expect([saved.review_status, saved.reviewed_version, saved.value_version, saved.reviewed_at !== null]).toEqual(["user_reviewed", 1, 1, true]);
    expect(saved.events.review_confirmed).toBe(1);
    // Watched from before the record opened, so the dashboard's startup reads may land in it: the watch
    // allows those by name and arguments, and nothing else the dialog must not send.
    traffic.stop();
    expect(traffic.forbidden).toEqual([]);

    // Reopened: read again from the database, the review is still there.
    await closeStudy(page, TITLES.review);
    await openStudy(page, TITLES.review, "SRR Review trial");
    await chooseMode(page, "Review");
    await showAll(page);
    await expect(card(page, LABELS.condition).getByTestId("review-status")).toContainText("Reviewed by you on");
    await expect(confirmButton(card(page, LABELS.condition))).toHaveCount(0);
  });

  test("R2 · Confirm is blocked, and says why, for a Reported value without a source and a design classification without support — nothing is sent", async () => {
    const traffic = watchTraffic(page);
    for (const label of [LABELS.setting, LABELS.classification]) {
      const blocked = card(page, label);
      await expect(blocked.getByTestId("review-sources")).toContainText("No source given.");
      const confirm = confirmButton(blocked);
      await expect(confirm).toHaveAttribute("aria-disabled", "true");
      await expect(confirm).toHaveAccessibleDescription("Add a quote from the saved abstract or a full-text reference, then save.");
      // Pressed anyway (aria-disabled stays focusable, so it can be): the press is refused in the browser.
      await confirm.focus();
      await page.keyboard.press("Enter");
      await confirm.dispatchEvent("click");
    }
    await expect(studyDialog(page).getByTestId("review-summary")).toContainText("2 can't be confirmed yet");
    traffic.stop();
    expect(traffic.reviews).toEqual([]);
    expect(traffic.forbidden).toEqual([]);
    for (const field of ["setting", "design_classification"]) {
      const saved = await savedValue(page, TITLES.review, field);
      expect(saved.review_status).toBe("unreviewed");
      expect(saved.events.review_confirmed ?? 0).toBe(0);
    }
  });

  test("R3 · Flag: a short note is refused, a note is accepted, the same note changes nothing, a new note updates the flag", async () => {
    const traffic = watchTraffic(page);
    const dialog = studyDialog(page);
    const demographics = card(page, LABELS.demographics);
    const flag = demographics.getByRole("button", { name: "Flag…" });
    await flag.click();
    const note = demographics.getByLabel("What's wrong with this value?");
    await expect(note).toBeFocused();

    // Escape closes the form, not the dialog.
    await note.fill("Something");
    await page.keyboard.press("Escape");
    await expect(demographics.getByTestId("flag-form")).toHaveCount(0);
    await expect(flag).toBeFocused();
    await expect(dialog).toBeVisible();

    await flag.click();
    await note.fill("ab");
    await demographics.getByRole("button", { name: "Flag", exact: true }).click();
    await expect(demographics.getByTestId("flag-form").getByRole("alert")).toHaveText("Say what's wrong, in at least 3 characters.");
    await expect(note).toHaveAttribute("aria-invalid", "true");
    expect(traffic.reviews).toEqual([]);

    await note.fill(FLAG_NOTES.first);
    await demographics.getByRole("button", { name: "Flag", exact: true }).click();
    await expect(demographics.getByTestId("review-status")).toContainText("Flagged");
    await expect(demographics.getByTestId("review-note")).toHaveText(`Your note: ${FLAG_NOTES.first}`);
    await expect(demographics.getByTestId("review-status")).toBeFocused();
    await expect(dialog.getByTestId("review-announcement")).toHaveText(`Flagged ${LABELS.demographics}.`);
    // Confirming would replace the flag: the button says so.
    await expect(confirmButton(demographics)).toHaveAccessibleDescription("Confirming replaces your flag and its note.");

    // The same note again: the browser doesn't send it, and the server would record nothing.
    await demographics.getByRole("button", { name: "Flag…" }).click();
    await expect(demographics.getByLabel("What's wrong with this value?")).toHaveValue(FLAG_NOTES.first);
    await expect(demographics.getByRole("button", { name: "Update flag" })).toBeDisabled();
    const flagged = await savedValue(page, TITLES.review, "demographics");
    const same = await reviewDirectly(page, flagged, "flag", FLAG_NOTES.first);
    expect(same.error).toBeNull();
    expect(same.data).toMatchObject({ status: "unchanged", review_status: "disputed" });

    await demographics.getByLabel("What's wrong with this value?").fill(FLAG_NOTES.updated);
    await demographics.getByRole("button", { name: "Update flag" }).click();
    await expect(demographics.getByTestId("review-note")).toHaveText(`Your note: ${FLAG_NOTES.updated}`);
    traffic.stop();
    // The page sent the first Flag, the direct same-note call (answered unchanged), and the update — never the short note.
    expect(traffic.reviews.filter((body) => body.p_action === "flag").map((body) => body.p_note)).toEqual([FLAG_NOTES.first, FLAG_NOTES.first, FLAG_NOTES.updated]);
    const updated = await savedValue(page, TITLES.review, "demographics");
    expect([updated.review_status, updated.review_note, updated.value_version]).toEqual(["disputed", FLAG_NOTES.updated, 1]);
    expect(updated.events.review_flagged).toBe(2);
  });

  test("R4 · an unsaved edit holds only its own card, Review shows only saved evidence, and the draft survives another value's Confirm", async () => {
    const dialog = studyDialog(page);
    await chooseMode(page, "Edit");
    const field = dialog.getByTestId("field-study|population_description");
    await field.getByLabel("Value").fill("Adults (edited, not saved)");
    await field.getByRole("button", { name: "Add quote" }).click();
    await field.getByTestId("add-quote-panel").getByLabel("Quote from the saved abstract").fill("HbA1c fell by 0.8 %");
    await field.getByRole("button", { name: "Add this quote" }).click();
    await expect(dialog.getByTestId("study-record-save-status")).toHaveText("Unsaved changes");
    // Edit's Source pane follows the draft: the unsaved quote is highlighted there.
    await expect(dialog.getByTestId("study-record-saved-abstract").locator("mark", { hasText: "HbA1c fell by 0.8 %" })).toHaveCount(1);

    await chooseMode(page, "Review");
    const population = card(page, LABELS.population);
    // The saved value and quote — not the draft's.
    await expect(population.getByTestId("review-value")).toContainText("Adults with type 2 diabetes and obesity");
    await expect(population.getByTestId("review-value")).not.toContainText("edited");
    await expect(population.getByTestId("review-quote").locator("mark")).toHaveText(["type 2 diabetes and obesity"]);
    await expect(confirmButton(population)).toHaveAttribute("aria-disabled", "true");
    await expect(confirmButton(population)).toHaveAccessibleDescription("This field has unsaved changes. Save or undo them to review it.");
    await population.getByRole("heading", { name: LABELS.population }).click();
    await expect(dialog.getByTestId("review-source-focus")).toContainText(`Source for: ${LABELS.population}`);
    await expect(dialog.getByTestId("study-record-saved-abstract").locator("mark")).toHaveText(["type 2 diabetes and obesity"]);
    // Review has no "Use as quote", even for a selection made in the saved copy.
    await selectInSavedCopy(page, "body weight was measured");
    await expect(dialog.getByTestId("use-as-quote-bar")).toHaveCount(0);
    await expect(dialog.getByText("Select text in the abstract to use it as a quote.")).toHaveCount(0);

    const traffic = watchTraffic(page);
    const n = card(page, LABELS.nRandomized);
    await expect(n.getByTestId("review-value")).toContainText("120 participants");
    await confirmButton(n).click();
    await expect(dialog.getByTestId("review-announcement")).toHaveText(new RegExp(`^Confirmed ${LABELS.nRandomized}\\.`));
    traffic.stop();
    expect(traffic.reviews).toHaveLength(1);
    expect((await savedValue(page, TITLES.review, "n_randomized")).review_status).toBe("user_reviewed");

    // Back in Edit, the unsaved edit is exactly as it was.
    await chooseMode(page, "Edit");
    await expect(field.getByLabel("Value")).toHaveValue("Adults (edited, not saved)");
    await expect(field).toContainText("HbA1c fell by 0.8 %");
    await expect(dialog.getByTestId("study-record-save-status")).toHaveText("Unsaved changes");
    const untouched = await savedValue(page, TITLES.review, "population_description");
    expect([untouched.review_status, untouched.value_version]).toEqual(["unreviewed", 1]);
    await closeStudy(page, TITLES.review, { discard: true });
  });

  test("R5 · Edit from a reviewed card, save, and the value returns to Not reviewed at its next version", async () => {
    await openStudy(page, TITLES.review, "SRR Review trial");
    const dialog = studyDialog(page);
    await chooseMode(page, "Review");
    await showAll(page);
    const design = card(page, LABELS.designAsReported);
    await expect(design.getByTestId("review-status")).toContainText("Reviewed by you on");
    const before = await savedValue(page, TITLES.review, "design_as_reported");
    expect([before.review_status, before.value_version]).toEqual(["user_reviewed", 1]);

    await design.getByRole("button", { name: `Edit ${LABELS.designAsReported}` }).click();
    await expect(dialog.getByRole("tab", { name: "Edit", exact: true })).toHaveAttribute("aria-selected", "true");
    const field = dialog.getByTestId("field-study|design_as_reported");
    await expect(field.locator(":focus")).toHaveCount(1);
    await field.getByLabel("Value").fill("Randomized 1:1, parallel groups");
    await expect(field).toContainText("Saving a change to this value clears your review of it.");
    await dialog.getByTestId("study-record-save").click();
    await expect(dialog.getByTestId("study-record-save-status")).toHaveText("Saved.");

    await chooseMode(page, "Review");
    await expect(design.getByTestId("review-status")).toHaveText("Review status: Not reviewed");
    await expect(confirmButton(design)).not.toHaveAttribute("aria-disabled");
    const after = await savedValue(page, TITLES.review, "design_as_reported");
    expect([after.review_status, after.value_version, after.reviewed_version, after.reviewed_at, after.review_note]).toEqual(["unreviewed", 2, null, null, null]);
    await closeStudy(page, TITLES.review);
  });

  test("R7 · a lost answer: the Confirm committed, Try again sends the same request, and it is recorded once", async () => {
    await openStudy(page, TITLES.review, "SRR Review trial");
    const dialog = studyDialog(page);
    await chooseMode(page, "Review");
    const traffic = watchTraffic(page);
    // The first Confirm reaches the database and commits; its answer never reaches the page.
    await page.route(
      `**/rest/v1/rpc/${REVIEW_RPC}`,
      async (route) => {
        await route.fetch();
        await route.abort("failed");
      },
      { times: 1 },
    );
    const eligibility = card(page, LABELS.eligibility);
    await confirmButton(eligibility).click();
    const alert = dialog.getByTestId("review-uncertain-alert");
    await expect(alert).toHaveText(/We couldn't tell whether your review was recorded\. Try again — it won't be recorded twice\./);
    await expect(alert).toBeFocused();
    // It was recorded; the page can't know. Every other write waits.
    expect((await savedValue(page, TITLES.review, "eligibility_criteria")).review_status).toBe("user_reviewed");
    await expect(dialog.getByRole("button", { name: "Delete study record" })).toBeDisabled();
    await expect(confirmButton(card(page, LABELS.registration))).toHaveAccessibleDescription("Resolve the earlier action first: try it again, or reload.");

    const replay = page.waitForResponse((response) => response.url().includes(`/rest/v1/rpc/${REVIEW_RPC}`));
    await alert.getByRole("button", { name: "Try again" }).click();
    expect(await (await replay).json()).toMatchObject({ status: "replayed", review_status: "user_reviewed" });
    await expect(alert).toHaveCount(0);
    await expect(dialog.getByTestId("review-announcement")).toHaveText(new RegExp(`^Confirmed ${LABELS.eligibility}\\.`));

    traffic.stop();
    expect(traffic.reviews).toHaveLength(2);
    expect(traffic.reviews[1]).toEqual(traffic.reviews[0]);
    const saved = await savedValue(page, TITLES.review, "eligibility_criteria");
    expect(saved.events.review_confirmed).toBe(1);
    await closeStudy(page, TITLES.review);
  });

  test("R6 · a change made elsewhere refuses the Confirm, and nothing is recorded", async () => {
    await openStudy(page, TITLES.conflict, "SRR Conflict trial");
    const dialog = studyDialog(page);
    await chooseMode(page, "Review");
    const condition = card(page, LABELS.condition);
    await expect(condition.getByTestId("review-value")).toContainText("Older adults");
    await expect(confirmButton(condition)).not.toHaveAttribute("aria-disabled");

    // "Another tab" changes the value after this one loaded it.
    const loaded = await savedValue(page, TITLES.conflict, "condition");
    expect(await changeTextDirectly(page, loaded, "condition", "Older adults (changed in another tab)")).toBeNull();

    const traffic = watchTraffic(page);
    await confirmButton(condition).click();
    const alert = dialog.getByRole("alert").filter({ hasText: "This study record was changed in another tab or window." });
    await expect(alert).toHaveText(/Reload to review the latest version\./);
    await expect(alert).toBeFocused();
    await expect(confirmButton(condition)).toHaveAccessibleDescription("This record changed elsewhere. Reload to review it.");
    traffic.stop();
    expect(traffic.reviews).toHaveLength(1);
    const saved = await savedValue(page, TITLES.conflict, "condition");
    expect([saved.review_status, saved.value_version, saved.events.review_confirmed ?? 0]).toEqual(["unreviewed", 2, 0]);

    // Reload shows the latest version, not yet reviewed.
    await alert.getByRole("button", { name: "Reload latest version" }).click();
    await expect(condition.getByTestId("review-value")).toContainText("Older adults (changed in another tab)");
    await expect(condition.getByTestId("review-status")).toHaveText("Review status: Not reviewed");
    await closeStudy(page, TITLES.conflict);
  });
});

test.describe("Review — on a phone", () => {
  test("a Not reported claim is confirmed with its saved copy beside it; controls are reachable and nothing scrolls sideways", async ({ browser }) => {
    test.setTimeout(60_000);
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] }, viewport: PHONE, hasTouch: true, isMobile: true });
    const page = await context.newPage();
    try {
      await signIn(page, "E2E_STUDY_REVIEW_OWNER_EMAIL", "E2E_STUDY_REVIEW_OWNER_PASSWORD");
      await openStudy(page, TITLES.review, "SRR Review trial");
      const dialog = studyDialog(page);
      await dialog.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((animation) => animation.finished)));
      await chooseMode(page, "Review");
      // One row of tabs in Review: each card carries its own source.
      await expect(dialog.getByTestId("study-record-review-pane").locator("xpath=ancestor::*[@role='tabpanel'][1]").getByRole("tablist")).toHaveCount(0);
      await expectNoSidewaysScroll(page, "Review");

      const registration = card(page, LABELS.registration);
      await expect(registration.getByTestId("review-value")).toContainText("Not reported in the abstract");
      await expect(registration.getByTestId("review-source")).toContainText(`Examined: the saved abstract of ${TITLES.review}`);
      const show = registration.getByRole("button", { name: "Show the saved abstract" });
      await expect(show).toHaveAttribute("aria-expanded", "false");
      await show.tap();
      await expect(registration.getByRole("button", { name: "Hide the saved abstract" })).toHaveAttribute("aria-expanded", "true");
      await expect(registration.getByTestId("review-inline-saved-abstract")).toContainText("Background: We randomized adults with type 2 diabetes and obesity");
      await expect(registration.getByTestId("review-inline-copy")).toContainText("You recorded that you examined this saved copy.");
      await expectNoSidewaysScroll(page, "Review, saved copy shown");

      const coarse = await page.evaluate(() => matchMedia("(pointer: coarse)").matches);
      expect(coarse, "the phone context has a coarse pointer").toBe(true);
      for (const [control, what] of [
        [confirmButton(registration), "Confirm"],
        [registration.getByRole("button", { name: "Flag…" }), "Flag…"],
        [registration.getByRole("button", { name: `Edit ${LABELS.registration}` }), "Edit"],
      ] as const) {
        const hit = await expectReachable(control, what);
        expect(hit.height, `${what}: a touch target at least 40 px tall`).toBeGreaterThanOrEqual(40);
      }

      await confirmButton(registration).tap();
      await expect(dialog.getByTestId("review-announcement")).toHaveText(new RegExp(`^Confirmed ${LABELS.registration}\\.`));
      expect((await savedValue(page, TITLES.review, "registration_ids")).review_status).toBe("user_reviewed");
      await expectNoSidewaysScroll(page, "Review, after Confirm");
    } finally {
      await context.close();
    }
  });
});

test.describe("Review — a former owner, now a manager", () => {
  test("R8 · sees the saved reviews, has no Confirm or Flag, and the server refuses a review sent directly", async ({ browser }) => {
    test.setTimeout(60_000);
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] }, viewport: DESKTOP });
    const page = await context.newPage();
    try {
      await signIn(page, "E2E_STUDY_REVIEW_FORMER_EMAIL", "E2E_STUDY_REVIEW_FORMER_PASSWORD");
      await openStudy(page, TITLES.former, "SRR Former owner's trial");
      const dialog = studyDialog(page);
      await chooseMode(page, "Review");
      await showAll(page);
      await expect(dialog.getByTestId("review-read-only")).toBeVisible();
      await expect(card(page, LABELS.condition).getByTestId("review-status")).toContainText("Reviewed by you on");
      await expect(card(page, LABELS.setting).getByTestId("review-status")).toContainText("Flagged");
      await expect(card(page, LABELS.setting).getByTestId("review-note")).toHaveText("Your note: Check the full text");
      await expect(dialog.getByRole("button", { name: "Confirm against this source" })).toHaveCount(0);
      await expect(dialog.getByRole("button", { name: "Flag…" })).toHaveCount(0);
      await expect(dialog.getByTestId("study-record-review-pane").getByRole("button", { name: /^Edit / })).toHaveCount(0);

      // Hiding the controls is only the experience: the server refuses too.
      const setting = await savedValue(page, TITLES.former, "setting");
      const refused = await reviewDirectly(page, setting, "confirm", null);
      expect(refused.error).toEqual({ code: "42501", message: "evidence_records_not_enabled" });
      const after = await savedValue(page, TITLES.former, "setting");
      expect([after.review_status, after.review_note, after.study_version]).toEqual(["disputed", "Check the full text", setting.study_version]);
    } finally {
      await context.close();
    }
  });
});
