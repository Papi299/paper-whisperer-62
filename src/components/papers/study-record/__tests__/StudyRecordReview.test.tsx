import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/integrations/supabase/types";
import { locateQuote } from "@/lib/evidence/matcher";
import { fakeSupabase } from "@/lib/studyRecord/__tests__/fakeSupabase";
import {
  ABSTRACT,
  ARM_COMPARATOR,
  fullRows,
  PAPER_ID,
  PAPER_TITLE,
  quoteAnchorRow,
  snapshotRow,
  STUDY_ID,
  USER,
  uuid,
  valueRow,
  VALUE_COMPARATOR_TYPE,
  VALUE_CONDITION,
  VALUE_N_RANDOMIZED,
  type FixtureRows,
} from "@/lib/studyRecord/__tests__/fixtures";

/**
 * Review mode end to end in jsdom (EVIDENCE-RECORDS-001C2A): reads through a
 * fake PostgREST, writes through PR-B's real client over a scripted RPC that
 * applies a review the way the server does, so every answer is read back.
 * Real Chromium (e2e/study-records-review.spec.ts) remains the authority for
 * layout, selection, focus and hit-testing.
 */

type Row<T extends keyof Database["public"]["Tables"]> = Database["public"]["Tables"][T]["Row"];
interface Call {
  readonly fn: string;
  readonly args: Record<string, unknown>;
}

const T_REVIEW = "2026-10-21T12:00:00.000Z";
const VALUE_SETTING = uuid("f", 4);
const OLD_COPY = uuid("c", 9);

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
      const response = state.answer(call);
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

/** A quote anchor at the place the quote really is in the abstract, as the server would store it. */
function quoteRow(n: number, valueId: string, quoteText: string, overrides: Partial<Row<"evidence_field_anchors">> = {}): Row<"evidence_field_anchors"> {
  const match = locateQuote(quoteText, ABSTRACT);
  if (match.kind !== "unique" && match.kind !== "multiple") throw new Error(`fixture quote not in the abstract: ${quoteText}`);
  const occurrence = match.occurrences[0];
  return quoteAnchorRow({
    id: uuid("9", n),
    value_id: valueId,
    quote_text: quoteText,
    match_start: occurrence.normalized.start,
    match_end: occurrence.normalized.end,
    match_occurrence: 1,
    match_count: match.count,
    ...overrides,
  });
}

/**
 * The C1 fixture record, for review: the condition is quoted (confirmable),
 * the comparator type is quoted and flagged, the number randomized is quoted
 * and reviewed, and the setting is Reported with no source at all.
 */
function reviewRows(): FixtureRows {
  const rows = fullRows();
  rows.values = [
    valueRow({ id: VALUE_CONDITION }),
    valueRow({ id: VALUE_COMPARATOR_TYPE, arm_id: ARM_COMPARATOR, field_key: "comparator_type", value_text: null, value_code: "placebo", value_version: 1, review_status: "disputed", review_note: "Check the methods" }),
    valueRow({ id: VALUE_N_RANDOMIZED, field_key: "n_randomized", value_text: "120 participants", value_int: 120, value_version: 1, review_status: "user_reviewed", reviewed_at: T_REVIEW, reviewed_version: 1 }),
    valueRow({ id: VALUE_SETTING, field_key: "setting", value_text: "Outpatient clinics", value_version: 1 }),
  ];
  rows.anchors = [quoteRow(1, VALUE_CONDITION, "type 2 diabetes"), quoteRow(2, VALUE_COMPARATOR_TYPE, "metformin or placebo"), quoteRow(3, VALUE_N_RANDOMIZED, "120 participants")];
  return rows;
}

function setTables(rows: FixtureRows) {
  state.tables = {
    evidence_studies: rows.study ? [rows.study] : [],
    evidence_study_reports: rows.reports,
    evidence_source_snapshots: rows.snapshots,
    evidence_arms: rows.arms,
    evidence_outcomes: rows.outcomes,
    evidence_field_values: rows.values,
    evidence_field_anchors: rows.anchors,
    papers: [{ id: PAPER_ID, user_id: USER, title: PAPER_TITLE }],
  };
  state.db = fakeSupabase({ tables: state.tables });
}

/** The server applying a review: the value's review columns, then the study version. */
function applied({ fn, args }: Call): unknown {
  const version = (args.p_expected_version as number) + 1;
  if (fn === "evidence_review_fields") {
    const study = state.tables.evidence_studies[0];
    study.row_version = version;
    const row = state.tables.evidence_field_values.find((candidate) => candidate.id === args.p_value_id)!;
    const confirm = args.p_action === "confirm";
    Object.assign(row, {
      review_status: confirm ? "user_reviewed" : "disputed",
      review_reason: null,
      review_note: args.p_note,
      reviewed_at: confirm ? T_REVIEW : null,
      reviewed_version: confirm ? row.value_version : null,
    });
    return {
      data: { status: "applied", study_id: args.p_study_id, study_version: version, value_id: args.p_value_id, value_version: row.value_version, review_status: confirm ? "user_reviewed" : "disputed" },
      error: null,
      status: 200,
    };
  }
  return { data: { status: "applied", study_id: args.p_study_id, study_version: version, arm_ids: {}, outcome_ids: {} }, error: null, status: 200 };
}

const raised = (message: string, code = "P0001", details: string | null = null) => ({ data: null, error: { code, message, details, hint: null }, status: 400 });

function renderDialog() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <StudyRecordDialog target={{ session: 1, paperId: PAPER_ID, paperTitle: PAPER_TITLE, labelSuggestion: "Doe 2024", studyId: STUDY_ID }} userId={USER} onClose={vi.fn()} />
    </QueryClientProvider>,
  );
}

async function openEditor() {
  renderDialog();
  await screen.findByRole("heading", { name: "Study record: Doe 2024" });
}

/** Choose a mode the way a pointer does (Radix tabs act on mousedown). */
function chooseMode(name: "Edit" | "Review") {
  const tab = within(screen.getByRole("tablist", { name: "Study record mode" })).getByRole("tab", { name });
  act(() => {
    fireEvent.mouseDown(tab, { button: 0 });
  });
  expect(tab).toHaveAttribute("aria-selected", "true");
}

const reviewPane = () => screen.getByTestId("study-record-review-pane");
const card = (key: string) => screen.getByTestId(`review-card-${key}`);
const editPanel = () => screen.getByTestId("study-record-record-pane").closest("[role=tabpanel]") as HTMLElement;
const reviewCalls = () => state.calls.filter((call) => call.fn === "evidence_review_fields");
const highlighted = () => [...screen.getByTestId("study-record-saved-abstract").querySelectorAll("mark")].map((mark) => mark.textContent);

/** Every id `element`'s aria-describedby names, resolved to its text. */
function description(element: HTMLElement): string {
  return (element.getAttribute("aria-describedby") ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? `<missing ${id}>`)
    .join(" | ");
}

function textPosition(root: Node, offset: number): [Text, number] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let remaining = offset;
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    if (remaining <= node.data.length) return [node, remaining];
    remaining -= node.data.length;
  }
  throw new Error("offset beyond the text");
}

function selectInCopy(passage: string) {
  const copy = screen.getByTestId("study-record-saved-abstract");
  const start = ABSTRACT.indexOf(passage);
  const range = document.createRange();
  range.setStart(...textPosition(copy, start));
  range.setEnd(...textPosition(copy, start + passage.length));
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  fireEvent.mouseUp(copy);
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
  state.answer = applied;
  state.role = "owner";
  state.mobile = false;
  state.toast.mockReset();
  setTables(reviewRows());
});

describe("Edit and Review", () => {
  it("opens in Edit; Review shows one card per saved value; no Confirm control exists in Edit", async () => {
    await openEditor();
    const modes = screen.getByRole("tablist", { name: "Study record mode" });
    expect(within(modes).getAllByRole("tab").map((tab) => [tab.textContent, tab.getAttribute("aria-selected")])).toEqual([
      ["Edit", "true"],
      ["Review", "false"],
      // C2B: History, read-only (StudyRecordHistory.test.tsx).
      ["History", "false"],
    ]);
    expect(within(editPanel()).queryByRole("button", { name: "Confirm against this source" })).toBeNull();
    expect(screen.getByTestId("study-record-source-pane")).toHaveAttribute("data-source-mode", "edit");

    chooseMode("Review");
    expect(reviewPane().closest("[role=tabpanel]")).toHaveAttribute("data-state", "active");
    expect(editPanel()).toHaveAttribute("data-state", "inactive");
    fireEvent.click(within(reviewPane()).getByRole("radio", { name: /All recorded/ }));
    expect(within(reviewPane()).getAllByRole("article").map((article) => article.getAttribute("data-review-target"))).toEqual([
      "value:study|setting",
      "value:study|condition",
      "value:study|n_randomized",
      `value:arm:${ARM_COMPARATOR}|comparator_type`,
    ]);
    // Confirm exists in Review only, and never on an Edit row.
    expect(within(reviewPane()).getAllByRole("button", { name: "Confirm against this source" }).length).toBeGreaterThan(0);
    expect(within(editPanel()).queryByRole("button", { name: "Confirm against this source" })).toBeNull();
    expect(screen.getByTestId("study-record-dialog").querySelectorAll("[data-issue-target^='value:'] [data-testid=review-confirm]")).toHaveLength(0);
  });

  it("switches modes from the keyboard: arrow keys move between the tabs, and each tab controls its panel", async () => {
    await openEditor();
    const modes = screen.getByRole("tablist", { name: "Study record mode" });
    const [edit, review] = within(modes).getAllByRole("tab");
    act(() => edit.focus());
    // Radix moves roving focus on the next tick; focusing a tab selects it.
    fireEvent.keyDown(edit, { key: "ArrowRight" });
    await waitFor(() => expect(review).toHaveFocus());
    await waitFor(() => expect(review).toHaveAttribute("aria-selected", "true"));
    expect(document.getElementById(review.getAttribute("aria-controls")!)).toBe(reviewPane().closest("[role=tabpanel]"));
    fireEvent.keyDown(review, { key: "ArrowLeft" });
    await waitFor(() => expect(edit).toHaveFocus());
    await waitFor(() => expect(edit).toHaveAttribute("aria-selected", "true"));
    expect(document.getElementById(edit.getAttribute("aria-controls")!)).toBe(editPanel());
  });

  it("summarizes by each value's own status, filters to what needs review, and never judges the record", async () => {
    await openEditor();
    chooseMode("Review");
    const summary = screen.getByTestId("review-summary");
    expect(within(summary).getByText("4 recorded fields")).toBeInTheDocument();
    expect(within(summary).getByTestId("review-summary-counts").textContent).toBe("Not reviewed: 2Reviewed by you: 1Flagged: 1Needs re-review: 0");
    expect(summary).toHaveTextContent("1 can't be confirmed yet");
    expect(summary).toHaveTextContent("Saving is never a review, and PaperLume doesn't check your interpretation.");
    expect(reviewPane().textContent).not.toMatch(/verified|accurate|complete|%/i);
    // Default: Needs your review — the reviewed value is not listed.
    expect(within(reviewPane()).getByRole("radio", { name: /Needs your review \(3\)/ })).toBeChecked();
    expect(screen.queryByTestId("review-card-study|n_randomized")).toBeNull();
    fireEvent.click(within(reviewPane()).getByRole("radio", { name: /All recorded \(4\)/ }));
    expect(card("study|n_randomized")).toBeInTheDocument();
    expect(state.calls).toEqual([]);
  });

  it("shows each card's saved value, sources, status in words and the review date", async () => {
    await openEditor();
    chooseMode("Review");
    fireEvent.click(within(reviewPane()).getByRole("radio", { name: /All recorded/ }));

    const n = card("study|n_randomized");
    expect(within(n).getByTestId("review-status")).toHaveTextContent("Review status: Reviewed by you on Oct 21, 2026");
    expect(n).toHaveTextContent("Reviewed by you — you confirmed this value against the source shown, on Oct 21, 2026. PaperLume hasn't checked your interpretation.");
    expect(within(n).getByTestId("review-value")).toHaveTextContent("As reported120 participantsConfirmed number120");
    // This version is reviewed: nothing to confirm; Flag stays.
    expect(within(n).queryByRole("button", { name: "Confirm against this source" })).toBeNull();
    expect(within(n).getByRole("button", { name: "Flag…" })).toBeInTheDocument();

    const comparator = card(`arm:${ARM_COMPARATOR}|comparator_type`);
    expect(within(comparator).getByRole("heading", { name: "Placebo: Comparator type" })).toBeInTheDocument();
    expect(within(comparator).getByTestId("review-status")).toHaveTextContent("Flagged");
    expect(within(comparator).getByTestId("review-note")).toHaveTextContent("Your note: Check the methods");
    const confirm = within(comparator).getByRole("button", { name: "Confirm against this source" });
    expect(description(confirm)).toBe("Confirming replaces your flag and its note.");

    const condition = card("study|condition");
    expect(within(condition).getByTestId("review-value")).toHaveTextContent("Type 2 diabetes and obesity");
    const [source] = within(condition).getAllByTestId("review-source");
    expect(source).toHaveTextContent(`Quote from the saved abstract of ${PAPER_TITLE} (copy 1 of 1, saved Oct 20, 2026)`);
    expect(within(source).getByTestId("review-quote").querySelector("mark")?.textContent).toBe("type 2 diabetes");
    expect(within(source).getByTestId("review-quote").textContent).toContain("Adults with type 2 diabetes and obesity");
    expect(condition).toHaveTextContent("From the abstract only");
  });
});

describe("saved evidence, never the draft", () => {
  it("keeps the card and the Source pane on the saved value and quote while the draft changes both", async () => {
    await openEditor();
    // In Edit: change the condition and quote another passage for it — unsaved.
    const field = screen.getByTestId("field-study|condition");
    fireEvent.change(within(field).getByLabelText("Value"), { target: { value: "HbA1c reduction" } });
    fireEvent.click(within(field).getByRole("button", { name: "Add quote" }));
    fireEvent.change(within(within(field).getByTestId("add-quote-panel")).getByLabelText("Quote from the saved abstract"), { target: { value: "HbA1c fell" } });
    fireEvent.click(within(field).getByRole("button", { name: "Add this quote" }));
    // Edit's Source pane follows the draft: the new, unsaved quote is highlighted too.
    expect(highlighted()).toEqual(expect.arrayContaining(["type 2 diabetes", "HbA1c fell"]));

    chooseMode("Review");
    expect(screen.getByTestId("study-record-source-pane")).toHaveAttribute("data-source-mode", "review");
    const condition = card("study|condition");
    fireEvent.focus(within(condition).getByRole("heading", { name: "Condition or health status" }));
    expect(within(condition).getByTestId("review-value")).toHaveTextContent("Type 2 diabetes and obesity");
    expect(within(condition).getByTestId("review-value")).not.toHaveTextContent("HbA1c");
    expect(within(condition).getAllByTestId("review-quote").map((quote) => quote.querySelector("mark")?.textContent)).toEqual(["type 2 diabetes"]);
    // Review's Source pane shows the SAVED quote of the card under review — only.
    expect(screen.getByTestId("review-source-focus")).toHaveTextContent("Source for: Condition or health status");
    expect(highlighted()).toEqual(["type 2 diabetes"]);

    const confirm = within(condition).getByRole("button", { name: "Confirm against this source" });
    expect(confirm).toHaveAttribute("aria-disabled", "true");
    expect(description(confirm)).toBe("This field has unsaved changes. Save or undo them to review it.");
    fireEvent.click(confirm);
    expect(reviewCalls()).toEqual([]);

    // Undo the edit in Edit: the saved value can be confirmed again.
    chooseMode("Edit");
    fireEvent.click(within(screen.getByTestId("field-study|condition")).getByRole("button", { name: "Undo changes to this field: Condition or health status" }));
    chooseMode("Review");
    expect(within(card("study|condition")).getByRole("button", { name: "Confirm against this source" })).not.toHaveAttribute("aria-disabled");
  });

  it("says, instead of highlighting the current copy, that a quote is in an earlier copy", async () => {
    const rows = reviewRows();
    rows.snapshots = [snapshotRow({ id: OLD_COPY, seq: 1, captured_at: "2026-10-01T12:00:00.000Z" }), snapshotRow({ seq: 2 })];
    rows.anchors = rows.anchors.map((row) => (row.value_id === VALUE_CONDITION ? { ...row, snapshot_id: OLD_COPY } : row));
    setTables(rows);
    await openEditor();
    chooseMode("Review");
    const condition = card("study|condition");
    fireEvent.focus(within(condition).getByRole("heading", { name: "Condition or health status" }));
    expect(within(condition).getByTestId("review-source")).toHaveTextContent("an earlier copy — copy 1 of 2, saved Oct 1, 2026");
    expect(within(condition).getByTestId("review-source")).toHaveTextContent("This quote is in an earlier copy of the abstract. Show that copy to see it in place.");
    expect(screen.getByTestId("review-source-earlier-copy")).toHaveTextContent("copy 1, saved Oct 1, 2026");
    // The Source pane can open that copy (C2C-A); the current one still highlights nothing for it.
    expect(highlighted()).toEqual([]);
    const confirm = within(condition).getByRole("button", { name: "Confirm against this source" });
    expect(description(confirm)).toBe(
      "Its quotes are in an earlier copy of the abstract. Quote the passage in the current saved copy, or add a full-text reference, then save.",
    );
  });

  it("offers no Use as quote in Review, and ignores a selection there", async () => {
    await openEditor();
    chooseMode("Review");
    selectInCopy("metformin or placebo");
    expect(screen.queryByTestId("use-as-quote-bar")).toBeNull();
    expect(screen.queryByText("Select text in the abstract to use it as a quote.")).toBeNull();
    chooseMode("Edit");
    selectInCopy("metformin or placebo");
    expect(await screen.findByTestId("use-as-quote-bar")).toBeInTheDocument();
  });
});

describe("Confirm", () => {
  it("sends one request, shows the saved review, announces it and moves focus to the next card that needs review", async () => {
    await openEditor();
    chooseMode("Review");
    fireEvent.click(within(card("study|condition")).getByRole("button", { name: "Confirm against this source" }));
    await waitFor(() => expect(screen.getByTestId("review-announcement")).toHaveTextContent("Confirmed Condition or health status. Next: Placebo: Comparator type."));
    expect(reviewCalls()).toEqual([
      {
        fn: "evidence_review_fields",
        args: {
          p_study_id: STUDY_ID,
          p_expected_version: 4,
          p_value_id: VALUE_CONDITION,
          p_expected_value_version: 2,
          p_action: "confirm",
          p_note: null,
          p_request_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        },
      },
    ]);
    await waitFor(() => expect(document.activeElement).toBe(within(card(`arm:${ARM_COMPARATOR}|comparator_type`)).getByRole("heading", { name: "Placebo: Comparator type" })));
    // Read back: the condition is reviewed now, so the default filter no longer lists it.
    expect(screen.queryByTestId("review-card-study|condition")).toBeNull();
    fireEvent.click(within(reviewPane()).getByRole("radio", { name: /All recorded/ }));
    expect(within(card("study|condition")).getByTestId("review-status")).toHaveTextContent("Reviewed by you on Oct 21, 2026");
    expect(within(card("study|condition")).queryByRole("button", { name: "Confirm against this source" })).toBeNull();
  });

  it("says beside the button why a value can't be confirmed, and sends nothing when pressed", async () => {
    await openEditor();
    chooseMode("Review");
    const setting = card("study|setting");
    expect(within(setting).getByTestId("review-sources")).toHaveTextContent("No source given.");
    const confirm = within(setting).getByRole("button", { name: "Confirm against this source" });
    expect(confirm).toHaveAttribute("aria-disabled", "true");
    expect(description(confirm)).toBe("Add a quote from the saved abstract or a full-text reference, then save.");
    fireEvent.click(confirm);
    expect(state.calls).toEqual([]);
  });

  it("shows the server's reasons on the card when it refuses, and moves focus there", async () => {
    state.answer = (call) => (call.fn === "evidence_review_fields" ? raised("evidence_confirm_blocked", "P0001", "no_current_support") : applied(call));
    await openEditor();
    chooseMode("Review");
    fireEvent.click(within(card("study|condition")).getByRole("button", { name: "Confirm against this source" }));
    const alert = await within(card("study|condition")).findByTestId("review-card-alert");
    expect(alert).toHaveTextContent("Add a quote from the saved abstract or a full-text reference, then save.");
    await waitFor(() => expect(alert).toHaveFocus());
    fireEvent.click(within(alert).getByRole("button", { name: "Dismiss" }));
    expect(within(card("study|condition")).queryByTestId("review-card-alert")).toBeNull();
  });

  it("when the outcome is unknown, says so, holds every write, and Try again resends the same request", async () => {
    state.answer = (call) => (call.fn === "evidence_review_fields" ? "throw" : applied(call));
    await openEditor();
    chooseMode("Review");
    fireEvent.click(within(card("study|condition")).getByRole("button", { name: "Confirm against this source" }));
    const alert = await screen.findByTestId("review-uncertain-alert");
    expect(alert).toHaveTextContent("We couldn't tell whether your review was recorded. Try again — it won't be recorded twice.");
    await waitFor(() => expect(alert).toHaveFocus());
    // Every other write waits, and so does every other review.
    expect(screen.getByRole("button", { name: "Delete study record" })).toBeDisabled();
    expect(screen.getByTestId("study-record-save")).toHaveAttribute("aria-disabled", "true");
    expect(description(within(card(`arm:${ARM_COMPARATOR}|comparator_type`)).getByRole("button", { name: "Confirm against this source" }))).toContain(
      "Resolve the earlier action first: try it again, or reload.",
    );
    expect(reviewCalls()).toHaveLength(1);

    state.answer = applied;
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.queryByTestId("review-uncertain-alert")).toBeNull());
    expect(reviewCalls()).toHaveLength(2);
    expect(reviewCalls()[1]).toEqual(reviewCalls()[0]);
    await waitFor(() => expect(screen.getByTestId("review-announcement")).toHaveTextContent("Confirmed Condition or health status."));
  });
});

describe("Flag", () => {
  it("takes a labelled note, explains a short one inline, and closes on Escape without sending or closing the dialog", async () => {
    await openEditor();
    chooseMode("Review");
    const condition = card("study|condition");
    const flagButton = within(condition).getByRole("button", { name: "Flag…" });
    fireEvent.click(flagButton);
    expect(flagButton).toHaveAttribute("aria-expanded", "true");
    const form = within(condition).getByTestId("flag-form");
    const note = within(form).getByLabelText("What's wrong with this value?");
    await waitFor(() => expect(note).toHaveFocus());
    expect(description(note)).toContain("At least 3 characters.");
    expect(description(note)).toContain("0 of 2,000 characters");

    fireEvent.change(note, { target: { value: "ab" } });
    fireEvent.click(within(form).getByRole("button", { name: "Flag" }));
    expect(note).toHaveAttribute("aria-invalid", "true");
    expect(within(form).getByRole("alert")).toHaveTextContent("Say what's wrong, in at least 3 characters.");
    expect(description(note)).toContain("Say what's wrong, in at least 3 characters.");
    expect(state.calls).toEqual([]);

    fireEvent.change(note, { target: { value: "x".repeat(2001) } });
    expect(within(form).getByRole("alert")).toHaveTextContent("Flag notes can be up to 2,000 characters.");

    fireEvent.keyDown(note, { key: "Escape" });
    expect(within(condition).queryByTestId("flag-form")).toBeNull();
    await waitFor(() => expect(flagButton).toHaveFocus());
    expect(screen.getByTestId("study-record-dialog")).toBeInTheDocument();
    expect(state.calls).toEqual([]);
  });

  it("flags with the note, then starts the next Flag from it and waits for a change before Update", async () => {
    await openEditor();
    chooseMode("Review");
    fireEvent.click(within(card("study|condition")).getByRole("button", { name: "Flag…" }));
    fireEvent.change(within(card("study|condition")).getByLabelText("What's wrong with this value?"), { target: { value: "Check the table" } });
    fireEvent.click(within(card("study|condition")).getByRole("button", { name: "Flag" }));
    await waitFor(() => expect(within(card("study|condition")).getByTestId("review-status")).toHaveTextContent("Flagged"));
    expect(reviewCalls().map((call) => [call.args.p_action, call.args.p_note])).toEqual([["flag", "Check the table"]]);
    expect(within(card("study|condition")).queryByTestId("flag-form")).toBeNull();
    await waitFor(() => expect(within(card("study|condition")).getByTestId("review-status")).toHaveFocus());
    expect(screen.getByTestId("review-announcement")).toHaveTextContent("Flagged Condition or health status.");

    fireEvent.click(within(card("study|condition")).getByRole("button", { name: "Flag…" }));
    const note = within(card("study|condition")).getByLabelText("What's wrong with this value?");
    expect(note).toHaveValue("Check the table");
    const update = within(card("study|condition")).getByRole("button", { name: "Update flag" });
    expect(update).toBeDisabled();
    expect(card("study|condition")).toHaveTextContent("Change the note to update the flag.");
    fireEvent.change(note, { target: { value: "Check the table and the figure" } });
    expect(update).toBeEnabled();
  });
});

describe("Edit from Review", () => {
  it("switches to Edit, opens the collapsed section and focuses the field", async () => {
    await openEditor();
    const participants = screen.getByRole("button", { name: "Participants" });
    fireEvent.click(participants);
    expect(participants).toHaveAttribute("aria-expanded", "false");
    chooseMode("Review");
    fireEvent.click(within(card("study|condition")).getByRole("button", { name: "Edit Condition or health status" }));
    await waitFor(() => expect(editPanel()).toHaveAttribute("data-state", "active"));
    expect(participants).toHaveAttribute("aria-expanded", "true");
    await waitFor(() => expect(screen.getByTestId("field-study|condition").contains(document.activeElement)).toBe(true));
  });
});

describe("a user who may not write", () => {
  it("sees every value and status, and no Confirm, Flag or Edit", async () => {
    state.role = "manager";
    await openEditor();
    chooseMode("Review");
    fireEvent.click(within(reviewPane()).getByRole("radio", { name: /All recorded/ }));
    expect(screen.getByTestId("review-read-only")).toHaveTextContent("You can see these fields and their reviews, but your account can't confirm or flag them.");
    expect(within(reviewPane()).getAllByRole("article")).toHaveLength(4);
    expect(within(reviewPane()).queryByRole("button", { name: "Confirm against this source" })).toBeNull();
    expect(within(reviewPane()).queryByRole("button", { name: "Flag…" })).toBeNull();
    expect(within(reviewPane()).queryByRole("button", { name: /^Edit / })).toBeNull();
    expect(within(card("study|n_randomized")).getByTestId("review-status")).toHaveTextContent("Reviewed by you on Oct 21, 2026");
    expect(within(card(`arm:${ARM_COMPARATOR}|comparator_type`)).getByTestId("review-status")).toHaveTextContent("Flagged");
    expect(reviewPane()).not.toHaveTextContent("can't be confirmed yet");
  });
});

describe("on a phone", () => {
  beforeEach(() => {
    state.mobile = true;
  });

  it("has one row of mode tabs in Review, and each card shows its source beside the claim", async () => {
    await openEditor();
    expect(screen.getByRole("tablist", { name: "Study record view" })).toBeInTheDocument();
    chooseMode("Review");
    // Review has no inner Source tab: the source is in each card.
    expect(within(reviewPane().closest("[role=tabpanel]") as HTMLElement).queryByRole("tablist")).toBeNull();
    const condition = card("study|condition");
    expect(within(condition).getByTestId("review-quote").querySelector("mark")?.textContent).toBe("type 2 diabetes");
    const show = within(condition).getByRole("button", { name: "Show the saved abstract" });
    fireEvent.click(show);
    expect(show).toHaveAttribute("aria-expanded", "true");
    const inline = within(condition).getByTestId("review-inline-saved-abstract");
    expect(inline.textContent).toBe(ABSTRACT);
    expect([...inline.querySelectorAll("mark")].map((mark) => mark.textContent)).toEqual(["type 2 diabetes"]);
    expect(within(condition).getByTestId("review-inline-copy")).toHaveTextContent("Saved copy 1 of 1, saved Oct 20, 2026.");
  });
});

describe("source identity", () => {
  it("names the saved copy the Source pane shows in Review", async () => {
    await openEditor();
    chooseMode("Review");
    fireEvent.focus(within(card("study|condition")).getByRole("heading", { name: "Condition or health status" }));
    expect(screen.getByTestId("study-record-source-pane")).toHaveTextContent("Saved copy 1 of 1, saved Oct 20, 2026.");
    expect(screen.getByTestId("review-source-focus")).toHaveTextContent("The highlighted passage is the quote this field cites.");
  });
});
