import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/integrations/supabase/types";
import { locateQuote } from "@/lib/evidence/matcher";
import { fakeSupabase, type FakeOptions } from "@/lib/studyRecord/__tests__/fakeSupabase";
import {
  ABSTRACT,
  fullRows,
  PAPER_ID,
  PAPER_TITLE,
  quoteAnchorRow,
  reportRow,
  SECOND_PAPER_ID,
  snapshotRow,
  STUDY_ID,
  THIN_SPACE,
  USER,
  uuid,
  VALUE_CONDITION,
  type FixtureRows,
} from "@/lib/studyRecord/__tests__/fixtures";

/**
 * The Source pane's read-only comparison, end to end in jsdom
 * (EVIDENCE-RECORDS-001C2C-A): the library abstract read through a fake
 * PostgREST, the banner's states, Compare and its three readings, earlier
 * saved copies, and that none of it writes, or changes the draft. Real
 * Chromium (e2e/study-records-source-compare.spec.ts) remains the authority
 * for layout, selection, focus and phone geometry.
 */

type Row<T extends keyof Database["public"]["Tables"]> = Database["public"]["Tables"][T]["Row"];

const OLD_COPY = uuid("c", 7);
const SECOND_COPY = uuid("c", 2);
const SECOND_TITLE = "A second report of the trial";
const T_OLD = "2026-10-01T12:00:00.000Z";
const OLD_ABSTRACT = "Background: An earlier version of this abstract. Adults with type 2 diabetes were randomized to metformin.";
const SECOND_ABSTRACT = "A second report of the same trial: 118 adults with obesity took part, and weight fell.";
const NBSP = String.fromCodePoint(0x00a0);
const SOFT_HYPHEN = String.fromCodePoint(0x00ad);

const state = vi.hoisted(() => ({
  db: null as unknown as ReturnType<typeof import("@/lib/studyRecord/__tests__/fakeSupabase").fakeSupabase>,
  tables: {} as Record<string, Record<string, unknown>[]>,
  calls: [] as { fn: string; args: Record<string, unknown> }[],
  role: "owner",
  mobile: false,
  toast: vi.fn(),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => (state.db.client.from as unknown as (name: string) => unknown)(table),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      state.calls.push({ fn, args: structuredClone(args) });
      const version = (args.p_expected_version as number) + 1;
      if (fn === "evidence_save_changes") {
        (state.tables.evidence_studies[0] as Record<string, unknown>).row_version = version;
        return { data: { status: "applied", study_id: args.p_study_id, study_version: version, arm_ids: {}, outcome_ids: {} }, error: null, status: 200 };
      }
      return { data: null, error: { code: "P0001", message: "unexpected", details: null, hint: null }, status: 400 };
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

/** A quote anchor where `quoteText` really is in `text`, as the server would store it. */
function quoteRow(n: number, valueId: string, quoteText: string, text: string, overrides: Partial<Row<"evidence_field_anchors">> = {}): Row<"evidence_field_anchors"> {
  const match = locateQuote(quoteText, text);
  if (match.kind !== "unique" && match.kind !== "multiple") throw new Error(`fixture quote not in the text: ${quoteText}`);
  return quoteAnchorRow({
    id: uuid("9", n),
    value_id: valueId,
    quote_text: quoteText,
    match_start: match.occurrences[0].normalized.start,
    match_end: match.occurrences[0].normalized.end,
    match_occurrence: 1,
    match_count: match.count,
    ...overrides,
  });
}

interface Library {
  /** The library abstract of the first paper; undefined leaves the paper out of the library read. */
  readonly abstract?: string | null;
  readonly secondAbstract?: string | null;
  readonly failures?: FakeOptions["failures"];
}

/** Refuse every library-abstract read with `error` — and nothing else: the record's own title read still answers. */
function refuseAbstractReads(error: { code: string; message: string }, status: number) {
  const base = state.db;
  const refused = {
    eq: () => refused,
    abortSignal: () => refused,
    then: <T,>(onFulfilled: (value: { data: null; error: typeof error; status: number }) => T) => Promise.resolve({ data: null, error, status }).then(onFulfilled),
  };
  const client = {
    from: (table: string) => {
      const builder = (base.client.from as unknown as (name: string) => Record<string, unknown>)(table);
      if (table !== "papers") return builder;
      return { ...builder, select: (columns: string) => (columns === "id, user_id, abstract" ? refused : (builder.select as (c: string) => unknown)(columns)) };
    },
  };
  state.db = { ...base, client: client as unknown as typeof base.client };
}

function setTables(rows: FixtureRows, library: Library = { abstract: ABSTRACT }) {
  const papers: Record<string, unknown>[] = [];
  if (library.abstract !== undefined) papers.push({ id: PAPER_ID, user_id: USER, title: PAPER_TITLE, abstract: library.abstract });
  if (rows.reports.some((report) => report.paper_id === SECOND_PAPER_ID)) papers.push({ id: SECOND_PAPER_ID, user_id: USER, title: SECOND_TITLE, abstract: library.secondAbstract ?? SECOND_ABSTRACT });
  state.tables = {
    evidence_studies: rows.study ? [rows.study] : [],
    evidence_study_reports: rows.reports,
    evidence_source_snapshots: rows.snapshots,
    evidence_arms: rows.arms,
    evidence_outcomes: rows.outcomes,
    evidence_field_values: rows.values,
    evidence_field_anchors: rows.anchors,
    papers,
  };
  state.db = fakeSupabase({ tables: state.tables, failures: library.failures });
}

/** The C1 record, its condition quoted on an EARLIER copy (copy 1) of two; copy 2 is the abstract. */
function twoCopyRows(): FixtureRows {
  const rows = fullRows();
  rows.snapshots = [
    snapshotRow({ id: OLD_COPY, seq: 1, captured_at: T_OLD, exact_text: OLD_ABSTRACT, char_count: Array.from(OLD_ABSTRACT).length }),
    snapshotRow({ seq: 2 }),
  ];
  rows.anchors = [quoteRow(1, VALUE_CONDITION, "type 2 diabetes", OLD_ABSTRACT, { snapshot_id: OLD_COPY })];
  return rows;
}

/** The C1 record linked to a second paper too, each with a copy of its own. */
function twoLinkRows(): FixtureRows {
  const rows = fullRows();
  rows.reports = [reportRow(), reportRow({ id: uuid("b", 2), paper_id: SECOND_PAPER_ID, link_basis: "user_linked", created_at: "2026-10-20T11:00:00.000Z" })];
  rows.snapshots = [snapshotRow(), snapshotRow({ id: SECOND_COPY, paper_id: SECOND_PAPER_ID, exact_text: SECOND_ABSTRACT, char_count: Array.from(SECOND_ABSTRACT).length })];
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

/** Choose a tab the way a pointer does (Radix tabs act on mousedown). */
function chooseTab(list: HTMLElement, name: string | RegExp) {
  const tab = within(list).getByRole("tab", { name });
  act(() => {
    fireEvent.mouseDown(tab, { button: 0 });
  });
  expect(tab).toHaveAttribute("aria-selected", "true");
}
const chooseMode = (name: "Edit" | "Review" | "History") => chooseTab(screen.getByRole("tablist", { name: "Study record mode" }), name);
const chooseReading = (name: string | RegExp) => chooseTab(screen.getByRole("tablist", { name: "What to show" }), name);

const sourcePane = () => screen.getByTestId("study-record-source-pane");
/** The banner's state, once the library read has answered. */
async function sourceState(): Promise<string | null> {
  const banner = await within(sourcePane()).findByTestId("source-status");
  return banner.getAttribute("data-source-state");
}
/** Every library-abstract read so far. */
const libraryReads = () => state.db.requests.filter((request) => request.table === "papers" && request.columns === "id, user_id, abstract");
/** Every read of one saved copy's text by its id (the Source pane's earlier-copy read). */
const copyReads = () => state.db.requests.filter((request) => request.table === "evidence_source_snapshots" && request.eq.some(([column]) => column === "paper_id"));
const writes = () => state.calls;
/** The readings on screen: Radix keeps an inactive panel, hidden and empty. */
const reading = () => within(screen.getByTestId("source-compare")).getAllByTestId("source-compare-reading").filter((panel) => !panel.hidden);

function textPosition(root: Node, offset: number): [Text, number] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let remaining = offset;
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    if (remaining <= node.data.length) return [node, remaining];
    remaining -= node.data.length;
  }
  throw new Error("offset beyond the text");
}

function selectIn(element: HTMLElement, text: string, passage: string) {
  const start = text.indexOf(passage);
  if (start < 0) throw new Error(`passage not in the text: ${passage}`);
  const range = document.createRange();
  range.setStart(...textPosition(element, start));
  range.setEnd(...textPosition(element, start + passage.length));
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  fireEvent.mouseUp(element);
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
  state.toast.mockReset();
  window.getSelection()?.removeAllRanges();
  setTables(fullRows());
});

describe("The source status (C2C-A)", () => {
  it("says the library abstract is the same, character for character, and offers nothing to compare", async () => {
    await openEditor();
    expect(await sourceState()).toBe("current");
    expect(within(sourcePane()).getByTestId("source-status")).toHaveTextContent("Same as the abstract in your library, character for character.");
    expect(within(sourcePane()).queryByRole("button", { name: /Compare/ })).not.toBeInTheDocument();
    // The one read: this user's linked paper, by id, its abstract only.
    expect(libraryReads()).toHaveLength(1);
    expect(libraryReads()[0]).toMatchObject({ eq: [["user_id", USER], ["id", PAPER_ID]], signal: true });
  });

  it("keeps the saved copy for a typography-only difference, and never calls it the same in meaning", async () => {
    setTables(fullRows(), { abstract: ABSTRACT.split(THIN_SPACE).join(" ") });
    await openEditor();
    expect(await sourceState()).toBe("typography_only_change");
    const banner = within(sourcePane()).getByTestId("source-status");
    expect(banner).toHaveAttribute("data-source-capture", "allowed");
    expect(banner).toHaveTextContent("only in characters PaperLume's quote matching treats as the same");
    expect(banner).toHaveTextContent("This is a technical comparison, not a check that the two say the same thing.");
    expect(banner).toHaveTextContent("Your record keeps its saved copy");
    expect(banner).toHaveTextContent("comparing is for information only: nothing is saved or changed. Your record keeps saved copy 1");
    expect(within(banner).getByRole("button", { name: "Compare the saved copy with the abstract in your library" })).toBeInTheDocument();
    // The record still shows, and quotes from, its saved copy.
    expect(screen.getByTestId("study-record-saved-abstract").textContent).toBe(ABSTRACT);
  });

  it("flags a change of content, and keeps the record's copy", async () => {
    setTables(fullRows(), { abstract: ABSTRACT.replace("120 participants", "118 participants") });
    await openEditor();
    expect(await sourceState()).toBe("content_change");
    expect(within(sourcePane()).getByTestId("source-status")).toHaveTextContent("has changed since this record's source copy was saved. Your quotes still point to the saved copy.");
    expect(screen.getByTestId("study-record-saved-abstract").textContent).toBe(ABSTRACT);
  });

  it.each([
    ["removed", null],
    ["emptied", `  ${SOFT_HYPHEN}\n`],
  ])("says when the abstract was %s, and offers no comparison", async (_label, abstract) => {
    setTables(fullRows(), { abstract });
    await openEditor();
    expect(await sourceState()).toBe("abstract_removed");
    expect(within(sourcePane()).getByTestId("source-status")).toHaveTextContent("The abstract was removed from your library. Your record keeps its saved copy.");
    expect(within(sourcePane()).queryByTestId("source-compare-open")).not.toBeInTheDocument();
  });

  it("says a newly available abstract can't be quoted, and shows it read-only on request", async () => {
    const rows = fullRows();
    rows.snapshots = [];
    rows.anchors = [];
    setTables(rows, { abstract: ABSTRACT });
    await openEditor();
    expect(await sourceState()).toBe("abstract_now_available");
    const banner = within(sourcePane()).getByTestId("source-status");
    expect(banner).toHaveTextContent("This paper now has an abstract in your library, but this record has no saved copy of it, so it can't be quoted.");
    expect(banner).toHaveTextContent("showing the library abstract is for information only");
    fireEvent.click(within(banner).getByRole("button", { name: "Show the library abstract" }));
    const compare = await screen.findByTestId("source-compare");
    expect(within(compare).getByRole("heading", { name: "The abstract in your library" })).toHaveFocus();
    expect(within(screen.getByRole("tablist", { name: "What to show" })).getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Library abstract"]);
    await waitFor(() => expect(within(compare).getByTestId("source-compare-library-text").textContent).toBe(ABSTRACT));
    expect(screen.queryByTestId("use-as-quote-bar")).not.toBeInTheDocument();
    expect(writes()).toEqual([]);
  });

  it("never offers a copy of an abstract over 50,000 characters, whichever way it differs (G1)", async () => {
    setTables(fullRows(), { abstract: `${ABSTRACT} ${"x".repeat(50_001)}` });
    await openEditor();
    expect(await sourceState()).toBe("content_change");
    const banner = within(sourcePane()).getByTestId("source-status");
    expect(banner).toHaveAttribute("data-source-capture", "refused_too_long");
    expect(banner).toHaveTextContent("longer than 50,000 characters, the most a saved copy can hold, so PaperLume can't save a copy of it.");
  });

  it("never offers a copy of an over-long abstract that differs only typographically (G1)", async () => {
    setTables(fullRows(), { abstract: ABSTRACT.replace(THIN_SPACE, " ".repeat(50_001)) });
    await openEditor();
    expect(await sourceState()).toBe("typography_only_change");
    expect(within(sourcePane()).getByTestId("source-status")).toHaveAttribute("data-source-capture", "refused_too_long");
  });

  it("fails closed: a failed read is never 'the same' nor the saved copy, and Check again reads again", async () => {
    setTables(fullRows(), { abstract: ABSTRACT });
    refuseAbstractReads({ code: "42501", message: "permission denied" }, 403);
    await openEditor();
    const problem = () => within(sourcePane()).getByTestId("source-read-problem");
    await waitFor(() => expect(problem()).toHaveAttribute("data-source-status", "failed"));
    expect(problem()).toHaveTextContent("Couldn't read the abstract in your library, so PaperLume can't say whether it has changed since this copy was saved.");
    expect(within(problem()).getByRole("status")).toHaveAttribute("data-failure", "refused");
    expect(within(sourcePane()).queryByTestId("source-status")).not.toBeInTheDocument();
    expect(sourcePane()).not.toHaveTextContent("Same as the abstract in your library");
    expect(screen.getByTestId("study-record-saved-abstract").textContent).toBe(ABSTRACT);
    // The library answers again.
    state.db = fakeSupabase({ tables: state.tables });
    fireEvent.click(within(problem()).getByRole("button", { name: "Check the abstract in your library again" }));
    expect(await sourceState()).toBe("current");
    expect(libraryReads()).toHaveLength(1);
  });

  it("tells a failure worth trying again from a refusal, and reads again on Check again", async () => {
    setTables(fullRows(), { abstract: ABSTRACT });
    refuseAbstractReads({ code: "57014", message: "canceling statement due to statement timeout" }, 500);
    await openEditor();
    // One automatic retry for a transient failure, then the failure is shown.
    await waitFor(() => expect(within(sourcePane()).getByTestId("source-read-problem")).toHaveAttribute("data-source-status", "failed"), { timeout: 4000 });
    const problem = within(sourcePane()).getByTestId("source-read-problem");
    expect(within(problem).getByRole("status")).toHaveAttribute("data-failure", "transient");
    expect(problem).toHaveTextContent("Couldn't reach the abstract in your library just now");
    state.db = fakeSupabase({ tables: state.tables });
    fireEvent.click(within(problem).getByRole("button", { name: "Check the abstract in your library again" }));
    expect(await sourceState()).toBe("current");
  });

  it("is a failure, never an answer, when the read comes back malformed", async () => {
    setTables(fullRows(), { abstract: ABSTRACT });
    // Two rows for one paper id: what a broken answer would be.
    state.tables.papers.push({ id: PAPER_ID, user_id: USER, title: PAPER_TITLE, abstract: ABSTRACT });
    await openEditor();
    await waitFor(() => expect(within(sourcePane()).getByTestId("source-read-problem")).toHaveAttribute("data-source-status", "failed"));
    expect(within(sourcePane()).getByTestId("source-read-problem")).toHaveTextContent("The abstract in your library didn't pass PaperLume's checks, so it isn't compared.");
  });

  it("says when the paper can't be read — not that its abstract was removed", async () => {
    setTables(fullRows(), { abstract: undefined });
    await openEditor();
    await waitFor(() => expect(within(sourcePane()).getByTestId("source-read-problem")).toHaveAttribute("data-source-status", "unavailable"));
    expect(within(sourcePane()).getByTestId("source-read-problem")).toHaveTextContent("This paper couldn't be read from your library, so its abstract can't be compared.");
    expect(sourcePane()).not.toHaveTextContent("removed from your library");
  });

  it("reads the library again on Check again and on Compare, and not at all while History is shown", async () => {
    setTables(fullRows(), { abstract: ABSTRACT.replace("120 participants", "118 participants") });
    await openEditor();
    expect(await sourceState()).toBe("content_change");
    expect(libraryReads()).toHaveLength(1);
    fireEvent.click(within(sourcePane()).getByRole("button", { name: "Check the abstract in your library again" }));
    await waitFor(() => expect(libraryReads()).toHaveLength(2));
    expect(await sourceState()).toBe("content_change");
    fireEvent.click(within(sourcePane()).getByRole("button", { name: "Compare the saved copy with the abstract in your library" }));
    await waitFor(() => expect(libraryReads()).toHaveLength(3));
    await screen.findByTestId("source-compare-changes");
    fireEvent.click(screen.getByTestId("source-compare-back"));

    chooseMode("History");
    await screen.findByTestId("study-record-history-pane");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(libraryReads()).toHaveLength(3);
    chooseMode("Edit");
    await waitFor(() => expect(libraryReads()).toHaveLength(4));
    expect(writes()).toEqual([]);
  });
});

describe("Compare (C2C-A)", () => {
  const CHANGED = ABSTRACT.replace("120 participants", "118 participants").replace("metformin or placebo", "metformin or a placebo");

  async function openCompare(abstract = CHANGED) {
    setTables(fullRows(), { abstract });
    await openEditor();
    await sourceState();
    fireEvent.click(within(sourcePane()).getByTestId("source-compare-open"));
    return screen.findByTestId("source-compare");
  }

  it("opens on the changes: struck through and underlined, said in words, and moved between one by one", async () => {
    const compare = await openCompare();
    expect(within(compare).getByRole("heading", { name: "Saved copy and library abstract" })).toHaveFocus();
    const changes = await within(compare).findByTestId("source-compare-changes");
    expect(within(compare).getByTestId("source-compare-summary")).toHaveTextContent("2 places differ: 1 word only in the saved copy, 2 words only in the library abstract.");
    expect(within(compare).getByText("Struck-through text is only in saved copy 1. Underlined text is only in the library abstract. Everything else is in both.")).toBeInTheDocument();
    const marks = within(changes).getAllByTestId("source-compare-change");
    expect(marks.map((mark) => [mark.querySelector("del")?.textContent ?? null, mark.querySelector("ins")?.textContent ?? null])).toEqual([
      ["Only in the saved copy: 120", "Only in the library abstract: 118"],
      [null, "Only in the library abstract:  a"],
    ]);
    // The unchanged text is all there, as it is in both.
    expect(changes.textContent).toContain("Methods: ");
    expect(changes.textContent).toContain(" participants received metformin or");
    expect(changes.textContent).toContain(" placebo for 12");

    const position = within(compare).getByTestId("source-compare-position");
    expect(position).toHaveTextContent("2 changes");
    const previous = within(compare).getByRole("button", { name: "Previous change" });
    const next = within(compare).getByRole("button", { name: "Next change" });
    expect(previous).toBeDisabled();
    fireEvent.click(next);
    expect(position).toHaveTextContent("Change 1 of 2");
    expect(marks[0]).toHaveFocus();
    fireEvent.click(next);
    expect(position).toHaveTextContent("Change 2 of 2");
    expect(marks[1]).toHaveFocus();
    expect(next).toBeDisabled();
    fireEvent.click(previous);
    expect(position).toHaveTextContent("Change 1 of 2");
  });

  it("names both texts and shows each in full, exactly, one at a time", async () => {
    const compare = await openCompare();
    await within(compare).findByTestId("source-compare-changes");
    expect(within(screen.getByRole("tablist", { name: "What to show" })).getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Changes", "Saved copy 1", "Library abstract"]);
    chooseReading("Saved copy 1");
    expect(reading().map((element) => element.getAttribute("data-reading"))).toEqual(["saved"]);
    expect(within(compare).getByText("Saved copy 1 — the abstract currently saved with this study record")).toBeInTheDocument();
    expect(within(compare).getByTestId("source-compare-saved-text").textContent).toBe(ABSTRACT);
    chooseReading("Library abstract");
    expect(reading().map((element) => element.getAttribute("data-reading"))).toEqual(["library"]);
    expect(within(compare).getByText("Library abstract — the abstract currently stored in your paper library")).toBeInTheDocument();
    expect(within(compare).getByTestId("source-compare-library-text").textContent).toBe(CHANGED);
    // Back to the saved copy: the pane as it was, its heading focused.
    fireEvent.click(within(compare).getByTestId("source-compare-back"));
    expect(screen.queryByTestId("source-compare")).not.toBeInTheDocument();
    expect(screen.getByTestId("study-record-saved-abstract").textContent).toBe(ABSTRACT);
    await waitFor(() => expect(within(sourcePane()).getByRole("heading", { name: "Saved copy of the abstract" })).toHaveFocus());
  });

  it("names the characters a typography-only difference changes, and says quote matching ignores them", async () => {
    const retyped = ABSTRACT.replace("were randomized", `were${NBSP}randomized`).replace("participants", `parti${SOFT_HYPHEN}cipants`);
    const compare = await openCompare(retyped);
    const changes = await within(compare).findByTestId("source-compare-changes");
    expect(within(changes).getAllByTestId("source-compare-hidden-character").map((mark) => mark.textContent)).toEqual(["space", "no-break space", "soft hyphen"]);
    expect(within(compare).getByText(/PaperLume's quote matching treats every difference shown here as no difference/)).toBeInTheDocument();
    expect(within(compare).getByTestId("source-compare-summary")).toHaveTextContent("2 places differ");
  });

  it("offers the two texts in full when they differ too much to show change by change", async () => {
    const other = Array.from({ length: 1_200 }, (_, i) => `Zeile ${i}: Teilnehmende bekamen Tabletten.`).join(" ");
    const compare = await openCompare(other);
    expect(await within(compare).findByTestId("source-compare-too-different")).toHaveTextContent("These two texts differ in too many places to show one by one.");
    chooseReading("Library abstract");
    expect(within(compare).getByTestId("source-compare-library-text").textContent).toBe(other);
  });

  it("writes nothing and keeps the draft: opening, reading, moving, checking again and closing send no RPC", async () => {
    setTables(fullRows(), { abstract: CHANGED });
    await openEditor();
    await sourceState();
    // An unsaved edit first.
    const textbox = within(screen.getByTestId("field-study|condition")).getAllByRole("textbox")[0];
    fireEvent.change(textbox, { target: { value: "Type 2 diabetes, unsaved" } });
    expect(screen.getByTestId("study-record-save-status")).toHaveTextContent("Unsaved changes");

    fireEvent.click(within(sourcePane()).getByTestId("source-compare-open"));
    const compare = await screen.findByTestId("source-compare");
    await within(compare).findByTestId("source-compare-changes");
    fireEvent.click(within(compare).getByRole("button", { name: "Next change" }));
    chooseReading("Saved copy 1");
    chooseReading("Library abstract");
    fireEvent.click(within(compare).getByRole("button", { name: "Check the abstract in your library again" }));
    await waitFor(() => expect(within(compare).getByTestId("source-compare-library-text")).toBeInTheDocument());
    fireEvent.click(within(compare).getByTestId("source-compare-back"));

    expect(writes()).toEqual([]);
    expect(within(screen.getByTestId("field-study|condition")).getAllByRole("textbox")[0]).toHaveValue("Type 2 diabetes, unsaved");
    expect(screen.getByTestId("study-record-save-status")).toHaveTextContent("Unsaved changes");
    // Every request was a read of the tables the Source pane may read.
    expect([...new Set(state.db.requests.map((request) => request.table))].sort()).toEqual([
      "evidence_arms",
      "evidence_field_anchors",
      "evidence_field_values",
      "evidence_outcomes",
      "evidence_source_snapshots",
      "evidence_studies",
      "evidence_study_reports",
      "papers",
    ]);
  });

  it("isn't offered in Review, which says where the record stands", async () => {
    setTables(fullRows(), { abstract: CHANGED });
    await openEditor();
    await sourceState();
    chooseMode("Review");
    expect(sourcePane()).toHaveAttribute("data-source-mode", "review");
    expect(within(sourcePane()).getByTestId("source-status")).toHaveTextContent("has changed since this record's source copy was saved");
    expect(within(sourcePane()).queryByTestId("source-compare-open")).not.toBeInTheDocument();
  });

  it("leaves Compare when Review is chosen, and returns to it in Edit", async () => {
    await openCompare();
    chooseMode("Review");
    expect(screen.queryByTestId("source-compare")).not.toBeInTheDocument();
    chooseMode("Edit");
    expect(await screen.findByTestId("source-compare")).toBeInTheDocument();
  });
});

describe("Earlier saved copies (C2C-A)", () => {
  beforeEach(() => setTables(twoCopyRows(), { abstract: ABSTRACT }));

  async function openCopies() {
    await openEditor();
    await sourceState();
    const copies = within(sourcePane()).getByTestId("saved-copies");
    expect(copies).toHaveTextContent("Saved copies of this abstract (2)");
    fireEvent.click(within(copies).getByRole("button", { name: "Show saved copies" }));
    return copies;
  }

  it("lists every saved copy from the record, newest first, and reads no copy's text until one is opened", async () => {
    const copies = await openCopies();
    const items = within(copies).getAllByTestId("saved-copy-item");
    expect(items.map((item) => item.getAttribute("data-copy-seq"))).toEqual(["2", "1"]);
    expect(items[0]).toHaveTextContent("Copy 2 of 2 · saved Oct 20, 2026");
    expect(items[0]).toHaveTextContent("The current copy, shown above: new quotes come from it.");
    expect(items[1]).toHaveTextContent(`Copy 1 of 2 · saved Oct 1, 2026 · ${Array.from(OLD_ABSTRACT).length} characters`);
    expect(copyReads()).toEqual([]);
  });

  it("opens one earlier copy, read-only, with its own quotes marked by its own offsets — for this user, study, paper and copy", async () => {
    const copies = await openCopies();
    fireEvent.click(within(copies).getByRole("button", { name: "Show copy 1" }));
    const earlier = await screen.findByTestId("earlier-copy");
    expect(within(earlier).getByRole("heading", { name: "Copy 1 of 2 — an earlier saved copy" })).toHaveFocus();
    const text = await within(earlier).findByTestId("earlier-copy-text");
    expect(text.textContent).toBe(OLD_ABSTRACT);
    expect([...text.querySelectorAll("mark")].map((mark) => mark.textContent)).toEqual(["type 2 diabetes"]);
    expect(earlier).toHaveTextContent("Read-only. A quote stays on the copy it was made on; new quotes come from the current copy, copy 2.");
    expect(earlier).toHaveTextContent("The highlighted passage is the saved quote on this copy.");
    expect(copyReads()).toHaveLength(1);
    expect(copyReads()[0]).toMatchObject({ eq: [["user_id", USER], ["study_id", STUDY_ID], ["paper_id", PAPER_ID], ["id", OLD_COPY]], signal: true });
    // No "Use as quote" on an earlier copy.
    selectIn(text, OLD_ABSTRACT, "earlier version");
    expect(screen.queryByTestId("use-as-quote-bar")).not.toBeInTheDocument();
    fireEvent.click(within(earlier).getByTestId("earlier-copy-back"));
    expect(screen.getByTestId("study-record-saved-abstract").textContent).toBe(ABSTRACT);
    expect(writes()).toEqual([]);
  });

  it("never marks a quote of one copy on another", async () => {
    await openEditor();
    // The condition's quote is on copy 1. Its words are in copy 2 as well, and still nothing marks them there.
    expect(ABSTRACT).toContain("type 2 diabetes");
    expect([...screen.getByTestId("study-record-saved-abstract").querySelectorAll("mark")].map((mark) => mark.textContent)).toEqual([]);
  });

  it("refuses a copy that isn't the one the record holds", async () => {
    await openCopies();
    // The copy changed under the record (it can't, in the database — this is what a wrong answer would look like).
    state.tables.evidence_source_snapshots[0].captured_at = "2026-10-02T12:00:00.000Z";
    fireEvent.click(within(sourcePane()).getByRole("button", { name: "Show copy 1" }));
    expect(await within(screen.getByTestId("earlier-copy")).findByRole("alert")).toHaveTextContent("Copy 1 didn't pass PaperLume's checks, so it isn't shown.");
    expect(screen.queryByTestId("earlier-copy-text")).not.toBeInTheDocument();
  });

  it("says when the copy is no longer saved with the record", async () => {
    await openCopies();
    state.tables.evidence_source_snapshots.splice(0, 1);
    fireEvent.click(within(sourcePane()).getByRole("button", { name: "Show copy 1" }));
    expect(await within(screen.getByTestId("earlier-copy")).findByText("Copy 1 is no longer saved with this record. Reload the record to see it as it is now.")).toBeInTheDocument();
  });

  it("opens an earlier copy from a field's sources in Edit", async () => {
    await openEditor();
    const condition = screen.getByTestId("field-study|condition");
    expect(condition).toHaveTextContent("From an earlier copy of the abstract");
    fireEvent.click(within(condition).getByRole("button", { name: "Show copy 1" }));
    const earlier = await screen.findByTestId("earlier-copy");
    expect(await within(earlier).findByTestId("earlier-copy-text")).toHaveTextContent(OLD_ABSTRACT);
  });

  it("opens an earlier copy from Review's source focus, marking that card's quotes only", async () => {
    await openEditor();
    chooseMode("Review");
    const card = screen.getByTestId("review-card-study|condition");
    fireEvent.focus(within(card).getByRole("heading", { name: "Condition or health status" }));
    const focus = within(sourcePane()).getByTestId("review-source-earlier-copy");
    fireEvent.click(within(focus).getByRole("button", { name: "Show copy 1" }));
    const earlier = await screen.findByTestId("earlier-copy");
    const text = await within(earlier).findByTestId("earlier-copy-text");
    expect([...text.querySelectorAll("mark")].map((mark) => mark.textContent)).toEqual(["type 2 diabetes"]);
    expect(earlier).toHaveTextContent("The highlighted passage is this field's saved quote on this copy.");
    expect(writes()).toEqual([]);
  });

  it("on a phone, opens an earlier copy inside the Review card", async () => {
    state.mobile = true;
    await openEditor();
    chooseMode("Review");
    const card = screen.getByTestId("review-card-study|condition");
    fireEvent.click(within(card).getByRole("button", { name: "Show the saved abstract" }));
    fireEvent.click(within(card).getByTestId("review-show-earlier-copy"));
    const earlier = await within(card).findByTestId("earlier-copy");
    const text = await within(earlier).findByTestId("earlier-copy-text");
    expect(text.textContent).toBe(OLD_ABSTRACT);
    expect([...text.querySelectorAll("mark")].map((mark) => mark.textContent)).toEqual(["type 2 diabetes"]);
    fireEvent.click(within(earlier).getByRole("button", { name: "Hide copy 1" }));
    expect(within(card).queryByTestId("earlier-copy")).not.toBeInTheDocument();
  });
});

describe("Quote selection belongs to its copy (G2)", () => {
  const PASSAGE = "metformin or placebo";

  it("drops a selection when another linked paper's copy is shown: its offsets never cut the other copy", async () => {
    setTables(twoLinkRows(), { abstract: ABSTRACT });
    await openEditor();
    selectIn(screen.getByTestId("study-record-saved-abstract"), ABSTRACT, PASSAGE);
    const bar = await screen.findByTestId("use-as-quote-bar");
    expect(bar).toHaveTextContent(PASSAGE);

    fireEvent.change(within(sourcePane()).getByLabelText("Paper"), { target: { value: SECOND_PAPER_ID } });
    expect(screen.getByTestId("study-record-saved-abstract").textContent).toBe(SECOND_ABSTRACT);
    expect(screen.queryByTestId("use-as-quote-bar")).not.toBeInTheDocument();
    // The same offsets in the second copy would have cut other text; nothing of it was offered.
    expect(SECOND_ABSTRACT.slice(ABSTRACT.indexOf(PASSAGE), ABSTRACT.indexOf(PASSAGE) + PASSAGE.length)).not.toBe(PASSAGE);
    fireEvent.change(within(sourcePane()).getByLabelText("Paper"), { target: { value: PAPER_ID } });
    expect(screen.queryByTestId("use-as-quote-bar")).not.toBeInTheDocument();
    // The second paper's own abstract was read only once it was shown.
    await waitFor(() => expect(libraryReads().map((request) => request.eq[1][1])).toEqual([PAPER_ID, SECOND_PAPER_ID, PAPER_ID]));
    expect(writes()).toEqual([]);
  });

  it("drops a selection when the comparison or a saved copy is opened", async () => {
    setTables(twoCopyRows(), { abstract: ABSTRACT.replace("120 participants", "118 participants") });
    await openEditor();
    await sourceState();
    selectIn(screen.getByTestId("study-record-saved-abstract"), ABSTRACT, PASSAGE);
    await screen.findByTestId("use-as-quote-bar");
    fireEvent.click(within(sourcePane()).getByTestId("source-compare-open"));
    await screen.findByTestId("source-compare");
    expect(screen.queryByTestId("use-as-quote-bar")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("source-compare-back"));
    expect(screen.queryByTestId("use-as-quote-bar")).not.toBeInTheDocument();
  });

  it("drops a selection when the record is read back with a new current copy", async () => {
    setTables(fullRows(), { abstract: ABSTRACT });
    await openEditor();
    selectIn(screen.getByTestId("study-record-saved-abstract"), ABSTRACT, PASSAGE);
    await screen.findByTestId("use-as-quote-bar");
    // Elsewhere, the link got a new copy; then this editor saves, and reads the record back.
    state.tables.evidence_source_snapshots.push(snapshotRow({ id: uuid("c", 8), seq: 2, exact_text: SECOND_ABSTRACT, char_count: Array.from(SECOND_ABSTRACT).length }));
    fireEvent.change(within(screen.getByTestId("field-study|condition")).getAllByRole("textbox")[0], { target: { value: "Type 2 diabetes" } });
    fireEvent.click(screen.getByTestId("study-record-save"));
    await waitFor(() => expect(screen.getByTestId("study-record-saved-abstract").textContent).toBe(SECOND_ABSTRACT));
    expect(screen.queryByTestId("use-as-quote-bar")).not.toBeInTheDocument();
    expect(writes().map((call) => call.fn)).toEqual(["evidence_save_changes"]);
  });
});

describe("Phone and former owner (C2C-A)", () => {
  it("on a phone, compares in the Source tab with one full-width reading at a time", async () => {
    state.mobile = true;
    setTables(fullRows(), { abstract: ABSTRACT.replace("120 participants", "118 participants") });
    await openEditor();
    // Nothing of the library is read until the Source tab is shown.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(libraryReads()).toHaveLength(0);
    chooseTab(screen.getByRole("tablist", { name: "Study record view" }), "Source");
    expect(await sourceState()).toBe("content_change");
    fireEvent.click(within(sourcePane()).getByTestId("source-compare-open"));
    const compare = await screen.findByTestId("source-compare");
    await within(compare).findByTestId("source-compare-changes");
    expect(reading().map((element) => element.getAttribute("data-reading"))).toEqual(["changes"]);
    chooseReading("Library abstract");
    expect(reading().map((element) => element.getAttribute("data-reading"))).toEqual(["library"]);
    expect(writes()).toEqual([]);
  });

  it("lets a former owner compare and open earlier copies, and nothing else", async () => {
    state.role = "manager";
    setTables(twoCopyRows(), { abstract: ABSTRACT.replace("120 participants", "118 participants") });
    await openEditor();
    expect(screen.getByTestId("study-record-read-only")).toBeInTheDocument();
    expect(screen.queryByTestId("study-record-save")).not.toBeInTheDocument();
    expect(await sourceState()).toBe("content_change");
    fireEvent.click(within(sourcePane()).getByTestId("source-compare-open"));
    await within(await screen.findByTestId("source-compare")).findByTestId("source-compare-changes");
    fireEvent.click(screen.getByTestId("source-compare-back"));
    fireEvent.click(within(sourcePane()).getByRole("button", { name: "Show saved copies" }));
    fireEvent.click(within(sourcePane()).getByRole("button", { name: "Show copy 1" }));
    expect((await screen.findByTestId("earlier-copy-text")).textContent).toBe(OLD_ABSTRACT);
    expect(writes()).toEqual([]);
  });
});
