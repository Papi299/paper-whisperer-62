import { createHash } from "node:crypto";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/integrations/supabase/types";
import { locateQuote } from "@/lib/evidence/matcher";
import { fakeSupabase } from "@/lib/studyRecord/__tests__/fakeSupabase";
import {
  ABSTRACT,
  fullRows,
  PAPER_ID,
  PAPER_TITLE,
  quoteAnchorRow,
  snapshotRow,
  SNAPSHOT_ID,
  STUDY_ID,
  THIN_SPACE,
  USER,
  uuid,
  VALUE_CONDITION,
  VALUE_N_RANDOMIZED,
  valueRow,
  type FixtureRows,
} from "@/lib/studyRecord/__tests__/fixtures";

/**
 * "Use current abstract", end to end in jsdom (EVIDENCE-RECORDS-001C2C-B):
 * offered in Compare to the pilot owner only, confirmed in a dialog that lists
 * what the change does from the record — never a quote-match forecast — sent
 * once with the SHA-256 of the exact text shown, and answered with what the
 * server did. A scripted server applies the rebase to the in-memory tables the
 * way the installed RPC does for these fixtures. Real Chromium against the
 * local stack (e2e/study-records-rebase.spec.ts) remains the authority for the
 * installed RPC, layout, focus and phone geometry.
 */

type Row<T extends keyof Database["public"]["Tables"]> = Database["public"]["Tables"][T]["Row"];

const REVISED = ABSTRACT.replace("120 participants", "118 participants");
const NEW_COPY = uuid("c", 2);
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

interface Call {
  readonly fn: string;
  readonly args: Record<string, unknown>;
}
type Answer = { data: unknown; error: unknown; status: number } | "throw";

const state = vi.hoisted(() => ({
  db: null as unknown as ReturnType<typeof import("@/lib/studyRecord/__tests__/fakeSupabase").fakeSupabase>,
  tables: {} as Record<string, Record<string, unknown>[]>,
  calls: [] as { fn: string; args: Record<string, unknown> }[],
  answer: null as unknown as (call: { fn: string; args: Record<string, unknown> }) => unknown,
  role: "owner",
  mobile: false,
  toast: vi.fn(),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => (state.db.client.from as unknown as (name: string) => unknown)(table),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      const call = { fn, args: structuredClone(args) };
      state.calls.push(call);
      const response = await state.answer(call);
      if (response === "throw") throw new TypeError("Failed to fetch");
      return response;
    },
  },
}));
vi.mock("@/hooks/useCurrentUserAccess", () => ({
  useCurrentUserAccess: () => ({ access: { role: state.role }, isLoading: false, isError: false }),
}));
vi.mock("@/hooks/useAbstract", () => ({
  useAbstract: () => ({ isPending: false, isError: false, data: ABSTRACT }),
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: state.toast }), toast: state.toast }));
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => state.mobile }));

import { StudyRecordDialog } from "../StudyRecordDialog";

const table = <T extends keyof Database["public"]["Tables"]>(name: T) => state.tables[name] as unknown as Row<T>[];
const libraryAbstract = () => (table("papers")[0] as unknown as { abstract: string | null }).abstract;

/**
 * The installed rebase, scripted for these fixtures: checks the version and
 * the SHA-256 against the library, saves the next copy, moves each quote of
 * the current copy found exactly once, sends reviewed and flagged values that
 * cite the abstract to Needs re-review, and bumps the version.
 */
function applyRebase({ args }: Call): Answer {
  const study = table("evidence_studies")[0];
  if (args.p_expected_version !== study.row_version) return { data: null, error: { code: "P0001", message: "evidence_version_conflict", details: null }, status: 400 };
  const abstract = libraryAbstract();
  if (abstract === null || sha(abstract) !== args.p_expected_abstract_sha256) {
    return { data: null, error: { code: "P0001", message: "evidence_source_changed_again", details: null }, status: 400 };
  }
  const copies = table("evidence_source_snapshots").filter((copy) => copy.paper_id === args.p_paper_id);
  const previous = copies.reduce<Row<"evidence_source_snapshots"> | null>((top, copy) => (!top || copy.seq > top.seq ? copy : top), null);
  const seq = (previous?.seq ?? 0) + 1;
  const id = previous ? NEW_COPY : uuid("c", 1);
  table("evidence_source_snapshots").push(snapshotRow({ id, seq, exact_text: abstract, char_count: Array.from(abstract).length, captured_at: "2026-10-30T12:00:00.000Z" }));
  let rematched = 0;
  let notFound = 0;
  let ambiguous = 0;
  const moved = new Set<string>();
  for (const anchor of table("evidence_field_anchors")) {
    if (!previous || anchor.snapshot_id !== previous.id || anchor.purpose !== "supports" || anchor.source_kind !== "abstract") continue;
    const match = locateQuote(anchor.quote_text as string, abstract);
    if (match.kind === "unique") {
      Object.assign(anchor, { snapshot_id: id, match_start: match.occurrences[0].normalized.start, match_end: match.occurrences[0].normalized.end, match_occurrence: 1, match_count: 1 });
      moved.add(anchor.value_id);
      rematched += 1;
    } else if (match.kind === "multiple") ambiguous += 1;
    else notFound += 1;
  }
  let needsRereview = 0;
  for (const value of table("evidence_field_values")) {
    const dependent = table("evidence_field_anchors").some((anchor) => anchor.value_id === value.id && anchor.paper_id === args.p_paper_id && anchor.source_kind === "abstract");
    if (!dependent) continue;
    const to = value.review_status === "unreviewed" ? "unreviewed" : "needs_rereview";
    if (to === value.review_status && !moved.has(value.id)) continue;
    if (to !== value.review_status) needsRereview += 1;
    Object.assign(value, { review_status: to, review_reason: to === "needs_rereview" ? "source_changed" : null, reviewed_at: null, reviewed_version: null, value_version: value.value_version + 1 });
  }
  study.row_version += 1;
  return {
    data: {
      status: "applied",
      study_id: args.p_study_id,
      study_version: study.row_version,
      paper_id: args.p_paper_id,
      snapshot_id: id,
      previous_snapshot_id: previous?.id ?? null,
      seq,
      rematched,
      not_found: notFound,
      ambiguous,
      needs_rereview: needsRereview,
    },
    error: null,
    status: 200,
  };
}

function setTables(rows: FixtureRows, abstract: string | null = REVISED) {
  state.tables = {
    evidence_studies: rows.study ? [rows.study] : [],
    evidence_study_reports: rows.reports,
    evidence_source_snapshots: rows.snapshots,
    evidence_arms: rows.arms,
    evidence_outcomes: rows.outcomes,
    evidence_field_values: rows.values,
    evidence_field_anchors: rows.anchors,
    papers: [{ id: PAPER_ID, user_id: USER, title: PAPER_TITLE, abstract }],
  };
  state.db = fakeSupabase({ tables: state.tables });
}

/** The C1 record with reviews: the condition reviewed and quoted, the number randomized flagged and quoted, the setting unreviewed and quoted. */
function reviewedRows(): FixtureRows {
  const rows = fullRows();
  rows.values = [
    ...rows.values.map((value) =>
      value.id === VALUE_CONDITION
        ? { ...value, review_status: "user_reviewed", reviewed_at: "2026-10-21T10:00:00.000Z", reviewed_version: value.value_version }
        : value.id === VALUE_N_RANDOMIZED
          ? { ...value, review_status: "disputed", review_note: "Check the count" }
          : value,
    ),
    valueRow({ id: uuid("f", 4), field_key: "setting", value_text: "Three hospitals", value_version: 1 }),
  ];
  const quote = (n: number, valueId: string, quoteText: string) => {
    const match = locateQuote(quoteText, ABSTRACT);
    if (match.kind !== "unique") throw new Error(`fixture quote not unique: ${quoteText}`);
    return quoteAnchorRow({ id: uuid("9", n), value_id: valueId, quote_text: quoteText, match_start: match.occurrences[0].normalized.start, match_end: match.occurrences[0].normalized.end });
  };
  rows.anchors = [quote(1, VALUE_CONDITION, "type 2 diabetes"), quote(2, VALUE_N_RANDOMIZED, "120 participants"), quote(3, uuid("f", 4), "Leukocytes stayed")];
  return rows;
}

function renderDialog() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <StudyRecordDialog target={{ session: 1, paperId: PAPER_ID, paperTitle: PAPER_TITLE, labelSuggestion: "Doe 2024", studyId: STUDY_ID }} userId={USER} onClose={vi.fn()} />
    </QueryClientProvider>,
  );
  return client;
}

async function openEditor() {
  const client = renderDialog();
  await screen.findByRole("heading", { name: "Study record: Doe 2024" });
  return client;
}

function chooseTab(list: HTMLElement, name: string | RegExp) {
  const tab = within(list).getByRole("tab", { name });
  act(() => {
    fireEvent.mouseDown(tab, { button: 0 });
  });
  expect(tab).toHaveAttribute("aria-selected", "true");
}
const chooseMode = (name: "Edit" | "Review" | "History") => chooseTab(screen.getByRole("tablist", { name: "Study record mode" }), name);

const sourcePane = () => screen.getByTestId("study-record-source-pane");
const panel = () => within(sourcePane()).getByTestId("source-update");
const actionButton = () => within(panel()).getByRole("button", { name: "Use current abstract" });
const dialog = () => screen.getByTestId("source-update-dialog");
const rebaseCalls = () => state.calls.filter((call) => call.fn === "evidence_rebase_source");
const libraryReads = () => state.db.requests.filter((request) => request.table === "papers" && request.columns === "id, user_id, abstract");

/** Open Compare once the library read has answered with a state that can lead to a copy. */
async function openCompare(state: string = "content_change") {
  const banner = await within(sourcePane()).findByTestId("source-status");
  await waitFor(() => expect(banner).toHaveAttribute("data-source-state", state));
  fireEvent.click(within(banner).getByTestId("source-compare-open"));
  await within(sourcePane()).findByTestId("source-compare");
  await waitFor(() => expect(actionButton()).not.toHaveAttribute("aria-disabled"));
}

/** Press the button the way a keyboard user does — focus, then activate — so the dialog knows where it was opened from. */
async function openConfirmation() {
  act(() => actionButton().focus());
  fireEvent.click(actionButton());
  return screen.findByTestId("source-update-dialog");
}

beforeAll(() => {
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture = () => false;
  proto.setPointerCapture = () => {};
  proto.releasePointerCapture = () => {};
  proto.scrollIntoView = () => {};
  if (!("ResizeObserver" in globalThis)) {
    (globalThis as unknown as Record<string, unknown>).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

beforeEach(() => {
  state.calls = [];
  state.role = "owner";
  state.mobile = false;
  state.answer = (call) => (call.fn === "evidence_rebase_source" ? applyRebase(call as Call) : { data: null, error: { code: "P0001", message: "unexpected", details: null }, status: 400 });
  state.toast.mockReset();
  setTables(reviewedRows());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Use current abstract — offered, and confirmed", () => {
  it("is offered in Compare to the pilot owner, says the saved copy is kept unless chosen otherwise, and Cancel sends nothing", async () => {
    await openEditor();
    // Not on the banner: the choice is made where both texts are shown.
    const banner = await within(sourcePane()).findByTestId("source-status");
    await waitFor(() => expect(banner).toHaveAttribute("data-source-state", "content_change"));
    expect(within(sourcePane()).queryByTestId("source-update")).not.toBeInTheDocument();
    await openCompare();
    expect(panel()).toHaveTextContent("Your record keeps saved copy 1 unless you choose to use the abstract in your library instead.");
    const confirmation = await openConfirmation();
    expect(within(confirmation).getByRole("heading", { name: "Use the current abstract?" })).toBeInTheDocument();
    // Cancel is where focus starts: nothing is one key press from being saved.
    await waitFor(() => expect(within(confirmation).getByRole("button", { name: "Cancel" })).toHaveFocus());
    fireEvent.click(within(confirmation).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByTestId("source-update-dialog")).not.toBeInTheDocument());
    expect(state.calls).toEqual([]);
    expect(actionButton()).toHaveFocus();
  });

  it("lists what the change does — from the record, never a forecast of which quotes will be found", async () => {
    await openEditor();
    await openCompare();
    const confirmation = await openConfirmation();
    const impact = within(confirmation).getByTestId("source-update-impact");
    expect(impact).toHaveTextContent(`Paper: “${PAPER_TITLE}”`);
    expect(impact).toHaveTextContent("The record's saved copy now: copy 1 of 1, saved Oct 20, 2026.");
    expect(within(impact).getByTestId("source-update-what")).toHaveTextContent(
      `PaperLume saves the library abstract you compared — ${Array.from(REVISED).length.toLocaleString("en-US")} characters — as copy 2, the record's current copy. A saved copy is never changed afterwards.`,
    );
    expect(impact).toHaveTextContent("Copy 1 stays with the record, and you can still open it.");
    expect(impact).toHaveTextContent(
      "PaperLume will check existing quotations against the new abstract. Quotations that cannot be matched uniquely will remain linked to their earlier saved copies.",
    );
    expect(impact).toHaveTextContent("3 quotes on copy 1 will be checked.");
    expect(impact).toHaveTextContent("A quote found again means only that the same characters are in the new copy, not that they mean the same thing.");
    // Each field by name, by what happens to its review.
    expect(within(impact).getByTestId("source-update-needs-rereview")).toHaveTextContent("2 fields will need re-review");
    expect(within(within(impact).getByTestId("source-update-needs-rereview")).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "Condition or health status — now Reviewed by you",
      "Number randomized — now Flagged",
    ]);
    expect(within(within(impact).getByTestId("source-update-stays-unreviewed")).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Setting (countries, care setting)"]);
    expect(impact).toHaveTextContent("Review notes are kept: a field's flag note stays with it, shown as your earlier review note.");
    // No forecast: no sentence puts a count on quotes found, matched, moved or kept.
    for (const sentence of (impact.textContent ?? "").split(/(?<=[.:])/)) {
      expect(sentence, sentence).not.toMatch(/\b\d+\b[^.:]*\b(found|matched|rematched|moved|kept|stay)\b/i);
    }
    expect(state.calls).toEqual([]);
  });

  it("one confirmation sends one request, with the SHA-256 of the exact text shown; the new copy is then shown with what the server did", async () => {
    await openEditor();
    await openCompare();
    const confirmation = await openConfirmation();
    fireEvent.click(within(confirmation).getByRole("button", { name: "Save as copy 2" }));
    const outcome = await within(sourcePane()).findByTestId("source-update-outcome");
    expect(rebaseCalls()).toHaveLength(1);
    expect(rebaseCalls()[0].args).toEqual({
      p_study_id: STUDY_ID,
      p_paper_id: PAPER_ID,
      p_expected_version: 4,
      p_expected_abstract_sha256: sha(REVISED),
      p_request_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(state.calls.map((call) => call.fn)).toEqual(["evidence_rebase_source"]);
    // What the server answered — its counts, not a forecast.
    expect(outcome).toHaveAttribute("data-outcome", "applied");
    expect(within(outcome).getAllByRole("paragraph").map((line) => line.textContent)).toEqual([
      "Saved copy 2 of this paper's abstract as the record's current copy.",
      "Copy 1 is kept, and you can still open it.",
      "3 quotes were checked against copy 2: 2 found exactly once and moved to it, 1 not found.",
      "Quotes not found exactly once stay on copy 1.",
      "2 fields now need re-review.",
    ]);
    await waitFor(() => expect(outcome).toHaveFocus());
    // The pane shows the new current copy.
    expect(sourcePane()).toHaveAttribute("data-source-view", "current");
    await waitFor(() => expect(screen.getByTestId("study-record-saved-abstract").textContent).toBe(REVISED));
    await waitFor(() => expect(within(sourcePane()).getByTestId("source-status")).toHaveAttribute("data-source-state", "current"));
    // And the record read back: the number randomized's quote ("120 participants") stayed on copy 1.
    expect(table("evidence_field_anchors").map((anchor) => anchor.snapshot_id)).toEqual([NEW_COPY, SNAPSHOT_ID, NEW_COPY]);
  });

  it("typography only: keeping the copy is the default, the choice is explicit, and confirming says so", async () => {
    setTables(reviewedRows(), ABSTRACT.split(THIN_SPACE).join(" "));
    await openEditor();
    await openCompare("typography_only_change");
    expect(panel()).toHaveTextContent("Keeping saved copy 1 is the default: the two differ only in characters quote matching treats as the same.");
    const confirmation = await openConfirmation();
    expect(confirmation).toHaveTextContent("The two differ only in characters quote matching treats as the same. Keeping the saved copy is the default; nothing changes unless you save.");
    fireEvent.click(within(confirmation).getByRole("button", { name: "Cancel" }));
    expect(state.calls).toEqual([]);
  });

  it("a first capture: Show the library abstract, then Save as the first copy — said to replace nothing, and fields that couldn't check it named", async () => {
    const rows = fullRows();
    rows.snapshots = [];
    rows.anchors = [
      { ...quoteAnchorRow(), purpose: "unavailable", snapshot_id: null, position: null, quote_text: null, match_start: null, match_end: null, match_occurrence: null, match_count: null, normalization_version: null, matched_at: null },
    ];
    rows.values = rows.values.map((value) =>
      value.id === VALUE_CONDITION
        ? { ...value, value_state: "not_reported", value_text: null, review_status: "user_reviewed", reviewed_at: "2026-10-21T10:00:00.000Z", reviewed_version: value.value_version }
        : value,
    );
    setTables(rows, REVISED);
    await openEditor();
    const banner = await within(sourcePane()).findByTestId("source-status");
    await waitFor(() => expect(banner).toHaveAttribute("data-source-state", "abstract_now_available"));
    fireEvent.click(within(banner).getByRole("button", { name: "Show the library abstract" }));
    await within(sourcePane()).findByTestId("source-compare");
    await waitFor(() => expect(actionButton()).not.toHaveAttribute("aria-disabled"));
    expect(panel()).toHaveTextContent("This record has no saved copy of this paper's abstract. Using the library abstract saves it as the record's first copy, so it can be quoted.");
    const confirmation = await openConfirmation();
    expect(confirmation).toHaveTextContent("The record has no saved copy of this paper's abstract yet.");
    expect(confirmation).toHaveTextContent("as the record's first copy");
    expect(confirmation).toHaveTextContent("With no earlier copy, there are no quotes to check.");
    expect(confirmation).not.toHaveTextContent(/stay with the record|will be checked/);
    expect(within(confirmation).getByTestId("source-update-unavailable")).toHaveTextContent(
      "1 field says this paper had no abstract to check. Once a copy is saved, it can't be confirmed until you edit it to record what the abstract says.",
    );
    fireEvent.click(within(confirmation).getByRole("button", { name: "Save as the first copy" }));
    const outcome = await within(sourcePane()).findByTestId("source-update-outcome");
    expect(rebaseCalls()).toHaveLength(1);
    expect(within(outcome).getAllByRole("paragraph").map((line) => line.textContent)).toEqual([
      "Saved copy 1 of this paper's abstract — the record's first copy.",
      "There was no earlier copy, so no quote was checked.",
      "1 field now needs re-review.",
    ]);
    expect(outcome.textContent).not.toMatch(/replac|kept|earlier copies/i);
  });

  it("a former owner compares, and is never offered the write", async () => {
    state.role = "manager";
    await openEditor();
    await openCompare_readOnly();
    expect(within(sourcePane()).queryByTestId("source-update")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Use current abstract" })).not.toBeInTheDocument();
    expect(state.calls).toEqual([]);
  });
});

async function openCompare_readOnly() {
  const banner = await within(sourcePane()).findByTestId("source-status");
  await waitFor(() => expect(banner).toHaveAttribute("data-source-state", "content_change"));
  fireEvent.click(within(banner).getByTestId("source-compare-open"));
  await within(sourcePane()).findByTestId("source-compare");
}

describe("Use current abstract — when it waits, and when nothing can be sent", () => {
  it("waits while the draft has unsaved changes, says why beside the button, and opens nothing", async () => {
    await openEditor();
    await openCompare();
    // An unsaved edit: the study name.
    fireEvent.change(screen.getByLabelText("Study name"), { target: { value: "Doe 2024 (draft)" } });
    await waitFor(() => expect(actionButton()).toHaveAttribute("aria-disabled", "true"));
    const reason = within(panel()).getByTestId("source-update-reason");
    expect(reason).toHaveTextContent("Save or undo your unsaved changes first");
    expect(actionButton().getAttribute("aria-describedby")).toBe(reason.id);
    fireEvent.click(actionButton());
    expect(screen.queryByTestId("source-update-dialog")).not.toBeInTheDocument();
    expect(state.calls).toEqual([]);
  });

  it("waits while a Flag note is open in Review — the note kept as typed — and is offered again once it is cancelled (G3)", async () => {
    await openEditor();
    chooseMode("Review");
    const card = await screen.findByTestId(`review-card-study|setting`);
    fireEvent.click(within(card).getByRole("button", { name: "Flag…" }));
    fireEvent.change(within(card).getByLabelText("What's wrong with this value?"), { target: { value: "Half a thought" } });
    chooseMode("Edit");
    await openCompare_readOnly();
    await waitFor(() => expect(actionButton()).toHaveAttribute("aria-disabled", "true"));
    expect(within(panel()).getByTestId("source-update-reason")).toHaveTextContent("Send or cancel the Flag note you started in Review first.");
    fireEvent.click(actionButton());
    expect(screen.queryByTestId("source-update-dialog")).not.toBeInTheDocument();
    // Back in Review, the note is as typed.
    chooseMode("Review");
    expect(within(screen.getByTestId(`review-card-study|setting`)).getByLabelText("What's wrong with this value?")).toHaveValue("Half a thought");
    fireEvent.click(within(screen.getByTestId(`review-card-study|setting`)).getByRole("button", { name: "Cancel" }));
    chooseMode("Edit");
    await waitFor(() => expect(actionButton()).not.toHaveAttribute("aria-disabled"));
    expect(state.calls).toEqual([]);
  });

  it("keeps a card with an open Flag note in view whatever the filter (G3)", async () => {
    await openEditor();
    chooseMode("Review");
    // Show all, flag a reviewed value, then go back to "Needs your review", which would otherwise hide it.
    fireEvent.click(screen.getByRole("radio", { name: /All recorded/ }));
    const card = await screen.findByTestId("review-card-study|condition");
    fireEvent.click(within(card).getByRole("button", { name: "Flag…" }));
    fireEvent.change(within(card).getByLabelText("What's wrong with this value?"), { target: { value: "Recheck" } });
    fireEvent.click(screen.getByRole("radio", { name: /Needs your review/ }));
    expect(within(screen.getByTestId("review-card-study|condition")).getByLabelText("What's wrong with this value?")).toHaveValue("Recheck");
  });

  it("nothing can be sent from a confirmation whose abstract changed while it was open", async () => {
    const client = await openEditor();
    await openCompare();
    const confirmation = await openConfirmation();
    (table("papers")[0] as unknown as { abstract: string }).abstract = `${REVISED} Changed again.`;
    await act(async () => {
      await client.refetchQueries({ queryKey: ["studyRecords", USER, "libraryAbstract"] });
    });
    await waitFor(() => expect(within(confirmation).getByTestId("source-update-problem")).toHaveTextContent("changed while this was open"));
    const confirm = within(confirmation).getByRole("button", { name: "Save as copy 2" });
    expect(confirm).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(confirm);
    expect(state.calls).toEqual([]);
  });

  it("says why, and opens nothing, for an abstract over 50,000 characters", async () => {
    setTables(reviewedRows(), `${REVISED} ${"x".repeat(50_001)}`);
    await openEditor();
    const banner = await within(sourcePane()).findByTestId("source-status");
    await waitFor(() => expect(banner).toHaveAttribute("data-source-capture", "refused_too_long"));
    fireEvent.click(within(banner).getByTestId("source-compare-open"));
    await waitFor(() => expect(within(panel()).getByTestId("source-update-reason")).toHaveTextContent("longer than 50,000 characters"));
    expect(actionButton()).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(actionButton());
    expect(screen.queryByTestId("source-update-dialog")).not.toBeInTheDocument();
  });

  it("says why, and sends nothing, without Web Crypto", async () => {
    vi.stubGlobal("crypto", { randomUUID: () => uuid("7", 1) });
    await openEditor();
    await openCompare_readOnly();
    await waitFor(() => expect(within(panel()).getByTestId("source-update-reason")).toHaveTextContent("This browser can't compute the check PaperLume uses"));
    expect(actionButton()).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(actionButton());
    expect(screen.queryByTestId("source-update-dialog")).not.toBeInTheDocument();
    expect(state.calls).toEqual([]);
  });
});

describe("Use current abstract — what the server answered", () => {
  it("the library changed again: nothing saved, the library read again at once, and a new choice needed", async () => {
    await openEditor();
    await openCompare();
    const confirmation = await openConfirmation();
    // Edited in another tab after the comparison was read.
    (table("papers")[0] as unknown as { abstract: string }).abstract = `${REVISED} Edited elsewhere.`;
    const reads = libraryReads().length;
    fireEvent.click(within(confirmation).getByRole("button", { name: "Save as copy 2" }));
    const outcome = await within(sourcePane()).findByTestId("source-update-outcome");
    expect(outcome).toHaveAttribute("data-outcome", "source_changed");
    expect(outcome).toHaveTextContent("Nothing was saved: the abstract in your library changed after you compared it.");
    await waitFor(() => expect(outcome).toHaveFocus());
    await waitFor(() => expect(libraryReads().length).toBe(reads + 1));
    expect(rebaseCalls()).toHaveLength(1);
    expect(table("evidence_source_snapshots")).toHaveLength(1);
    // The new text is what a new choice would be about.
    fireEvent.mouseDown(within(screen.getByRole("tablist", { name: "What to show" })).getByRole("tab", { name: "Library abstract" }), { button: 0 });
    await waitFor(() => expect(within(sourcePane()).getByTestId("source-compare-library-text").textContent).toBe(`${REVISED} Edited elsewhere.`));
  });

  it("an unknown outcome: one alert with Try again, which resends the SAME request — and the server's replay is reported", async () => {
    let applied: Answer | null = null;
    state.answer = (call) => {
      if (call.fn !== "evidence_rebase_source") return { data: null, error: { code: "P0001", message: "unexpected" }, status: 400 };
      // The first attempt is applied, but its answer is lost; the retry gets the replay.
      if (!applied) {
        applied = applyRebase(call as Call);
        return "throw";
      }
      const data = (applied as { data: Record<string, unknown> }).data;
      return { data: { ...data, status: "replayed" }, error: null, status: 200 };
    };
    await openEditor();
    await openCompare();
    fireEvent.click(within(await openConfirmation()).getByRole("button", { name: "Save as copy 2" }));
    const alert = await screen.findByTestId("source-update-uncertain-alert");
    expect(alert).toHaveTextContent("We couldn't tell whether the new copy was saved. Try again — it won't be saved twice.");
    await waitFor(() => expect(alert).toHaveFocus());
    // Everything else waits.
    expect(screen.getByRole("button", { name: /Delete study record/ })).toBeDisabled();
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    const outcome = await within(sourcePane()).findByTestId("source-update-outcome");
    expect(rebaseCalls()).toHaveLength(2);
    expect(rebaseCalls()[1].args).toEqual(rebaseCalls()[0].args);
    expect(outcome).toHaveAttribute("data-outcome", "replayed");
    expect(outcome).toHaveTextContent("Your earlier attempt had already saved it: nothing was saved twice.");
    expect(table("evidence_source_snapshots")).toHaveLength(2);
  });

  it("a refusal that needs a reload: said in fixed words, with Reload, and the action waits until then", async () => {
    state.answer = () => ({ data: null, error: { code: "P0001", message: "evidence_history_limit", details: null }, status: 400 });
    await openEditor();
    await openCompare();
    fireEvent.click(within(await openConfirmation()).getByRole("button", { name: "Save as copy 2" }));
    const outcome = await within(sourcePane()).findByTestId("source-update-outcome");
    expect(outcome).toHaveAttribute("data-outcome", "failed:history_limit");
    expect(outcome).toHaveTextContent("This study record has reached its limit of 5,000 history entries.");
    expect(outcome).toHaveTextContent("Reload the record before trying again.");
    expect(actionButton()).toHaveAttribute("aria-disabled", "true");
    expect(within(panel()).getByTestId("source-update-reason")).toHaveTextContent("Reload the record before trying again.");
    expect(table("evidence_source_snapshots")).toHaveLength(1);
    fireEvent.click(within(outcome).getByRole("button", { name: "Reload latest version" }));
    await waitFor(() => expect(within(sourcePane()).queryByTestId("source-update-outcome")).not.toBeInTheDocument());
  });

  it("a version conflict: nothing saved, the editor's own alert asks for a reload", async () => {
    table("evidence_studies")[0].row_version = 6;
    await openEditor();
    // The record was read at version 6; another tab moves it on.
    await openCompare();
    table("evidence_studies")[0].row_version = 7;
    fireEvent.click(within(await openConfirmation()).getByRole("button", { name: "Save as copy 2" }));
    await waitFor(() => expect(screen.getByText("This study record was changed in another tab or window, so no copy was saved. Reload to see the latest version.")).toBeInTheDocument());
    expect(table("evidence_source_snapshots")).toHaveLength(1);
  });
});

describe("Use current abstract — on a phone", () => {
  it("lives in the Source tab's Compare; its confirmation scrolls inside, with its buttons outside the scroll", async () => {
    state.mobile = true;
    await openEditor();
    chooseTab(screen.getByRole("tablist", { name: "Study record view" }), "Source");
    await openCompare();
    const confirmation = await openConfirmation();
    expect(confirmation.className).toMatch(/max-h-\[calc\(100dvh-2rem\)\]/);
    const scroll = within(confirmation).getByTestId("source-update-impact");
    expect(scroll.className).toMatch(/overflow-y-auto/);
    expect(scroll.contains(within(confirmation).getByRole("button", { name: "Save as copy 2" }))).toBe(false);
    for (const button of within(confirmation).getAllByRole("button")) expect(button.className).toMatch(/coarse:min-h-10/);
  });
});
