import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { locateQuote } from "@/lib/evidence/matcher";
import { fakeSupabase } from "@/lib/studyRecord/__tests__/fakeSupabase";
import {
  ABSTRACT,
  ARM_COMPARATOR,
  fullRows,
  PAPER_ID,
  PAPER_TITLE,
  quoteAnchorRow,
  STUDY_ID,
  USER,
  uuid,
  valueRow,
  VALUE_COMPARATOR_TYPE,
  VALUE_CONDITION,
  type FixtureRows,
} from "@/lib/studyRecord/__tests__/fixtures";
import { changeRow, headerRow, historyRows, largeSave, manyOperations, valueDigest, type EventRow } from "@/lib/studyRecord/__tests__/historyFixtures";

/**
 * History mode end to end in jsdom (EVIDENCE-RECORDS-001C2B): the Study Record
 * dialog over a fake PostgREST that answers with the selected columns only,
 * and a scripted RPC that commits writes the way the server does — a new
 * version, a header and its change events. Real Chromium
 * (e2e/study-records-history.spec.ts) remains the authority for layout, focus
 * and what the database recorded.
 */

const state = vi.hoisted(() => ({
  db: null as unknown as ReturnType<typeof import("@/lib/studyRecord/__tests__/fakeSupabase").fakeSupabase>,
  tables: {} as Record<string, Record<string, unknown>[]>,
  failures: {} as Record<string, { error: unknown; status?: number }>,
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
      return commit(fn, args);
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

const DENIED = { error: { code: "42501", message: "permission denied" }, status: 403 };

/** The fixture record at version 12 — the version its history reaches — with a quoted, confirmable condition. */
function recordRows(): FixtureRows {
  const rows = fullRows();
  rows.study = { ...rows.study!, row_version: 12 };
  const match = locateQuote("type 2 diabetes", ABSTRACT);
  if (match.kind !== "unique" && match.kind !== "multiple") throw new Error("fixture quote not in the abstract");
  const occurrence = match.occurrences[0];
  rows.values = [
    valueRow({ id: VALUE_CONDITION }),
    valueRow({ id: VALUE_COMPARATOR_TYPE, arm_id: ARM_COMPARATOR, field_key: "comparator_type", value_text: null, value_code: "placebo", value_version: 1 }),
  ];
  rows.anchors = [quoteAnchorRow({ match_start: occurrence.normalized.start, match_end: occurrence.normalized.end, match_count: match.count })];
  return rows;
}

function setTables(events: EventRow[] = historyRows(), rows: FixtureRows = recordRows()) {
  state.tables = {
    evidence_studies: rows.study ? [rows.study] : [],
    evidence_study_reports: rows.reports,
    evidence_source_snapshots: rows.snapshots,
    evidence_arms: rows.arms,
    evidence_outcomes: rows.outcomes,
    evidence_field_values: rows.values,
    evidence_field_anchors: rows.anchors,
    evidence_events: events,
    papers: [{ id: PAPER_ID, user_id: USER, title: PAPER_TITLE }],
  };
  state.failures = {};
  state.db = fakeSupabase({ tables: state.tables, failures: state.failures, project: true });
}

/** The server committing a write: the next version, its header, and one change event. */
function commit(fn: string, args: Record<string, unknown>) {
  const study = state.tables.evidence_studies[0];
  const version = (args.p_expected_version as number) + 1;
  study.row_version = version;
  const events = state.tables.evidence_events;
  if (fn === "evidence_save_changes") {
    events.push(
      headerRow(version, "save_changes"),
      changeRow(version, 1, "value_saved", {
        target: VALUE_CONDITION,
        fieldKey: "condition",
        before: valueDigest({ valueId: VALUE_CONDITION, fieldKey: "condition" }),
        after: valueDigest({ valueId: VALUE_CONDITION, fieldKey: "condition", content: { text: { sha256: "e".repeat(64), chars: 15 } }, valueVersion: 3 }),
      }),
    );
    return { data: { status: "applied", study_id: STUDY_ID, study_version: version, arm_ids: {}, outcome_ids: {} }, error: null, status: 200 };
  }
  return { data: null, error: { code: "P0001", message: "unexpected", details: null, hint: null }, status: 400 };
}

function renderDialog(client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
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

/** Choose a mode the way a pointer does (Radix tabs act on mousedown). */
function chooseMode(name: "Edit" | "Review" | "History") {
  const tab = within(screen.getByRole("tablist", { name: "Study record mode" })).getByRole("tab", { name });
  act(() => {
    fireEvent.mouseDown(tab, { button: 0 });
  });
  expect(tab).toHaveAttribute("aria-selected", "true");
}

async function openHistory() {
  chooseMode("History");
  await waitFor(() => expect(historyPane()).toHaveAttribute("data-history-status", "ready"));
}

const historyPane = () => screen.getByTestId("study-record-history-pane");
const entries = () => within(historyPane()).queryAllByTestId("history-entry");
const versionsShown = () => entries().map((entry) => Number(entry.getAttribute("data-history-version")));
const entry = (version: number) => entries().find((candidate) => candidate.getAttribute("data-history-version") === String(version))!;
const toggleOf = (version: number) => within(entry(version)).getByTestId("history-entry-toggle");
const historyReads = () => state.db.requests.filter((request) => request.table === "evidence_events");
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

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
  setTables();
});

describe("the History mode", () => {
  it("is the third mode; nothing of history is read until it is chosen", async () => {
    await openEditor();
    const modes = screen.getByRole("tablist", { name: "Study record mode" });
    expect(within(modes).getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Edit", "Review", "History"]);
    expect(historyReads()).toEqual([]);
    chooseMode("Review");
    expect(historyReads()).toEqual([]);
    expect(screen.queryByTestId("study-record-history-pane")).toBeNull();
    await openHistory();
    expect(historyReads()).toHaveLength(1);
    // The History panel is the one the History tab controls.
    const tab = within(modes).getByRole("tab", { name: "History" });
    expect(document.getElementById(tab.getAttribute("aria-controls")!)).toBe(historyPane().closest("[role=tabpanel]"));
  });

  it("lists committed operations newest first: a title, a date and time, and the record version each produced", async () => {
    await openEditor();
    await openHistory();
    expect(versionsShown()).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
    expect(entries().map((candidate) => within(candidate).getByRole("heading").textContent)).toEqual([
      "Changes saved",
      "Copy of the library abstract saved",
      "Review recorded",
      "Changes saved",
      "Linked paper changed",
      "Linked paper changed",
      "Study details updated",
      "Changes saved",
      "Review recorded",
      "Review recorded",
    ]);
    const time = entry(12).querySelector("time")!;
    expect(time).toHaveAttribute("dateTime", "2026-10-20T22:00:00.000Z");
    expect(time.textContent).toMatch(/^Oct 2[01], 2026, \d{1,2}:\d{2} [AP]M \S+$/);
    expect(entry(12)).toHaveTextContent("Record version 12");
    expect(within(historyPane()).getByRole("list", { name: "Study record history" })).toBeInTheDocument();
    expect(historyPane()).toHaveTextContent("History is read-only.");
  });

  it("shows nothing it should not: no fingerprint, no id, no stored result, no note", async () => {
    await openEditor();
    await openHistory();
    fireEvent.click(toggleOf(12));
    await waitFor(() => expect(within(entry(12)).getAllByTestId("history-change")).toHaveLength(3));
    fireEvent.click(toggleOf(11));
    await waitFor(() => expect(within(entry(11)).getAllByTestId("history-change")).toHaveLength(5));
    const text = historyPane().textContent ?? "";
    expect(text).not.toMatch(/[0-9a-f]{64}/);
    expect(text).not.toMatch(UUID);
    expect(text).not.toMatch(/PLANTED|payload|abab|status":|applied/);
    // Not even in an attribute.
    expect(historyPane().outerHTML).not.toMatch(UUID);
    expect(historyPane().outerHTML).not.toMatch(/[0-9a-f]{64}/);
  });
});

describe("pages of operations", () => {
  it("Load older adds the older operations below, never one twice, then says it reached the beginning; focus moves to the first added", async () => {
    await openEditor();
    await openHistory();
    fireEvent.click(within(historyPane()).getByTestId("history-load-older"));
    await waitFor(() => expect(versionsShown()).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]));
    expect(within(historyPane()).getByTestId("history-beginning")).toHaveTextContent("This is the beginning of this study record's history.");
    expect(within(historyPane()).queryByTestId("history-load-older")).toBeNull();
    await waitFor(() => expect(within(entry(2)).getByRole("heading")).toHaveFocus());
    expect(screen.getByTestId("history-announcement")).toHaveTextContent("Loaded 2 older entries.");
    expect(historyReads().map((request) => request.lt)).toEqual([[], [["study_version", 3]]]);
    expect(entry(1)).toHaveTextContent("Study record created");
  });

  it("Refresh reads the newest page again: an operation committed elsewhere appears at the top, once", async () => {
    await openEditor();
    await openHistory();
    // "In another tab": a new request commits.
    state.tables.evidence_events.push(headerRow(13, "review_fields"));
    expect(versionsShown()[0]).toBe(12);
    fireEvent.click(within(historyPane()).getByRole("button", { name: "Refresh history" }));
    await waitFor(() => expect(versionsShown()).toEqual([13, 12, 11, 10, 9, 8, 7, 6, 5, 4]));
    expect(screen.getByTestId("history-announcement")).toHaveTextContent("History refreshed.");
    expect(historyReads()).toHaveLength(2);
  });

  it("after Load older, Refresh starts again from the newest page — one request", async () => {
    setTables(manyOperations(25));
    await openEditor();
    await openHistory();
    fireEvent.click(within(historyPane()).getByTestId("history-load-older"));
    await waitFor(() => expect(entries()).toHaveLength(20));
    fireEvent.click(within(historyPane()).getByRole("button", { name: "Refresh history" }));
    await waitFor(() => expect(screen.getByTestId("history-announcement")).toHaveTextContent("History refreshed."));
    expect(versionsShown()).toEqual([25, 24, 23, 22, 21, 20, 19, 18, 17, 16]);
    expect(historyReads()).toHaveLength(3);
  });

  it("opening History after a Save in Edit shows the operation just committed", async () => {
    await openEditor();
    const field = screen.getByTestId("field-study|condition");
    fireEvent.change(within(field).getByLabelText("Value"), { target: { value: "HbA1c reduction" } });
    fireEvent.click(screen.getByTestId("study-record-save"));
    await waitFor(() => expect(screen.getByTestId("study-record-save-status")).toHaveTextContent("Saved."));
    await openHistory();
    expect(versionsShown()[0]).toBe(13);
    expect(within(entry(13)).getByRole("heading")).toHaveTextContent("Changes saved");
    fireEvent.click(toggleOf(13));
    await waitFor(() => expect(within(entry(13)).getByTestId("history-changes")).toHaveTextContent("Condition or health status: text changed"));
    expect(entry(13)).toHaveTextContent("Earlier text isn't stored in History.");
  });
});

describe("an operation's details", () => {
  it("are read when opened, list that operation's own changes only, in order, and close again", async () => {
    await openEditor();
    await openHistory();
    // Version 2 is on the second page.
    fireEvent.click(within(historyPane()).getByTestId("history-load-older"));
    await waitFor(() => expect(entries()).toHaveLength(12));
    const toggle = toggleOf(2);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    const region = document.getElementById(toggle.getAttribute("aria-controls")!)!;
    expect(region).not.toBeVisible();
    expect(toggle).toHaveAccessibleName("Show details: Changes saved, Record version 2");
    const before = historyReads().length;
    fireEvent.click(toggleOf(2));
    expect(toggleOf(2)).toHaveAttribute("aria-expanded", "true");
    const details = document.getElementById(toggleOf(2).getAttribute("aria-controls")!)!;
    expect(details).toBeVisible();
    expect(details).toHaveAccessibleName("Details of “Changes saved”, record version 2");
    await waitFor(() => expect(within(details).getAllByTestId("history-change")).toHaveLength(6));
    expect(within(details).getAllByTestId("history-change").map((change) => change.getAttribute("data-history-change"))).toEqual([
      "arm_added",
      "arm_added",
      "outcome_added",
      "value_saved",
      "value_saved",
      "value_saved",
    ]);
    expect(within(details).getAllByTestId("history-change")[0]).toHaveTextContent("Added intervention group “Metformin”");
    // One read, of version 2's events only, and nothing of version 3 is shown under it.
    expect(historyReads().slice(before).map((request) => request.eq)).toEqual([
      [
        ["user_id", USER],
        ["study_id", STUDY_ID],
        ["study_version", 2],
      ],
    ]);
    expect(details).not.toHaveTextContent("reviewed by you");
    expect(within(entry(3)).queryByTestId("history-changes")).toBeNull();
    fireEvent.click(toggleOf(2));
    expect(toggleOf(2)).toHaveAttribute("aria-expanded", "false");
    expect(details).not.toBeVisible();
    expect(within(details).queryByTestId("history-changes")).toBeNull();
  });

  it("describe a reset review, a Flag and a rebase in what the events recorded — never the text", async () => {
    await openEditor();
    await openHistory();
    fireEvent.click(toggleOf(5));
    await waitFor(() => expect(within(entry(5)).getByTestId("history-changes")).toBeInTheDocument());
    expect(entry(5)).toHaveTextContent("Condition or health status: text changed");
    expect(entry(5)).toHaveTextContent("Previously reviewed by you — saving this change reset the review.");
    expect(entry(5)).toHaveTextContent("Earlier text isn't stored in History.");
    fireEvent.click(toggleOf(4));
    await waitFor(() => expect(within(entry(4)).getByTestId("history-changes")).toHaveTextContent("Comparator type (group now named “Placebo”): flagged"));
    expect(entry(4)).toHaveTextContent("History doesn't keep the text of notes.");
    fireEvent.click(toggleOf(11));
    await waitFor(() => expect(within(entry(11)).getAllByTestId("history-change")).toHaveLength(5));
    expect(entry(11)).toHaveTextContent("Number randomized: needs re-review — a new copy of the abstract was saved");
    expect(entry(11)).toHaveTextContent("Condition or health status: a quote wasn't found in the new copy");
    expect(entry(11)).toHaveTextContent("Earlier copies are kept; History doesn't show their text.");
    // G4: the summary keeps not found apart from found more than once, and counts only the reviews it moved.
    expect(entry(11)).toHaveTextContent("2 quotes rechecked: 1 found again, 1 not found, 0 found more than once.");
    expect(entry(11)).toHaveTextContent("1 field was marked as needing re-review.");
  });

  it("show a large save in parts — 50, then 50, then the last 20 — none twice, none cut off; focus goes to the first change added", async () => {
    setTables([...manyOperations(1), ...largeSave(2, 120)]);
    await openEditor();
    await openHistory();
    fireEvent.click(toggleOf(2));
    const changes = () => within(entry(2)).queryAllByTestId("history-change");
    await waitFor(() => expect(changes()).toHaveLength(50));
    expect(entry(2)).toHaveTextContent("50 changes shown");
    fireEvent.click(within(entry(2)).getByRole("button", { name: "Show more changes" }));
    await waitFor(() => expect(changes()).toHaveLength(100));
    await waitFor(() => expect(changes()[50]).toHaveFocus());
    // Every change keeps tabindex -1 across renders, so a browser never moves focus away from the one focused.
    expect(changes().every((change) => change.getAttribute("tabindex") === "-1")).toBe(true);
    fireEvent.click(within(entry(2)).getByRole("button", { name: "Show more changes" }));
    await waitFor(() => expect(changes()).toHaveLength(120));
    await waitFor(() => expect(changes()[100]).toHaveFocus());
    expect(changes()[50]).toHaveAttribute("tabindex", "-1");
    expect(within(entry(2)).queryByRole("button", { name: "Show more changes" })).toBeNull();
    expect(changes().map((change) => change.textContent?.match(/Outcome (\d+)/)?.[1])).toEqual(Array.from({ length: 120 }, (_, i) => String(i + 1)));
  });
});

describe("failures are failures, never an empty history", () => {
  it("a failed first read says so, offers Try again, and never says there is no history", async () => {
    state.failures.evidence_events = DENIED;
    await openEditor();
    chooseMode("History");
    const alert = await within(historyPane()).findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't load this study record's history.");
    expect(historyPane()).not.toHaveTextContent("No history is recorded");
    expect(entries()).toEqual([]);
    delete state.failures.evidence_events;
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(entries()).toHaveLength(10));
    await waitFor(() => expect(within(historyPane()).getByRole("heading", { name: "History" })).toHaveFocus());
  });

  it("an answer that fails a consistency check is shown as that, with nothing from it", async () => {
    setTables([...historyRows(), { ...headerRow(13, "save_changes"), op: "confirm_all" }]);
    await openEditor();
    chooseMode("History");
    expect(await within(historyPane()).findByRole("alert")).toHaveTextContent("did not pass a consistency check. Nothing from it is displayed.");
    expect(entries()).toEqual([]);
  });

  it("a failed Load older keeps what is shown and tries the same page again — no entry twice", async () => {
    await openEditor();
    await openHistory();
    state.failures.evidence_events = DENIED;
    fireEvent.click(within(historyPane()).getByTestId("history-load-older"));
    await waitFor(() => expect(within(historyPane()).getByTestId("history-footer")).toHaveTextContent("Couldn't load older entries."));
    expect(entries()).toHaveLength(10);
    delete state.failures.evidence_events;
    fireEvent.click(within(historyPane()).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(versionsShown()).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]));
    expect(historyReads().slice(1).map((request) => request.lt)).toEqual([[["study_version", 3]], [["study_version", 3]]]);
  });

  it("a failed read of an operation's details says so, and Try again reads them", async () => {
    await openEditor();
    await openHistory();
    state.failures.evidence_events = DENIED;
    fireEvent.click(toggleOf(12));
    expect(await within(entry(12)).findByRole("alert")).toHaveTextContent("Couldn't load the details of this entry.");
    delete state.failures.evidence_events;
    fireEvent.click(within(entry(12)).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(within(entry(12)).getAllByTestId("history-change")).toHaveLength(3));
  });

  it("a failed Refresh keeps what was read and says it was read earlier", async () => {
    await openEditor();
    await openHistory();
    state.failures.evidence_events = DENIED;
    fireEvent.click(within(historyPane()).getByRole("button", { name: "Refresh history" }));
    await waitFor(() => expect(historyPane()).toHaveTextContent("Couldn't refresh the history. What's shown was read earlier."));
    expect(entries()).toHaveLength(10);
  });
});

describe("a record that no longer exists, and one with no history", () => {
  it("shows nothing of the history of a study deleted since the record was opened", async () => {
    await openEditor();
    state.tables.evidence_studies.splice(0);
    state.tables.evidence_events.splice(0);
    chooseMode("History");
    await waitFor(() => expect(historyPane()).toHaveAttribute("data-history-status", "gone"));
    expect(historyPane()).toHaveTextContent("This study record no longer exists, so its history can't be shown.");
    expect(entries()).toEqual([]);
  });

  it("drops what it showed when an operation's details find the study gone", async () => {
    await openEditor();
    await openHistory();
    state.tables.evidence_studies.splice(0);
    state.tables.evidence_events.splice(0);
    fireEvent.click(toggleOf(12));
    await waitFor(() => expect(historyPane()).toHaveAttribute("data-history-status", "gone"));
    expect(entries()).toEqual([]);
    // Found mid-session, so it is announced.
    expect(within(historyPane()).getByRole("alert")).toHaveTextContent("This study record no longer exists, so its history can't be shown.");
  });

  it("says a history is empty only when the study exists and nothing was recorded", async () => {
    setTables([]);
    await openEditor();
    chooseMode("History");
    await waitFor(() => expect(historyPane()).toHaveAttribute("data-history-status", "ready"));
    expect(historyPane()).toHaveTextContent("No history is recorded for this study record.");
    expect(within(historyPane()).queryByRole("alert")).toBeNull();
  });
});

describe("read-only", () => {
  it("sends nothing but reads, whatever is done in History, and offers no write", async () => {
    await openEditor();
    await openHistory();
    fireEvent.click(toggleOf(12));
    await waitFor(() => expect(within(entry(12)).getAllByTestId("history-change")).toHaveLength(3));
    fireEvent.click(toggleOf(12));
    fireEvent.click(within(historyPane()).getByTestId("history-load-older"));
    await waitFor(() => expect(entries()).toHaveLength(12));
    fireEvent.click(within(historyPane()).getByRole("button", { name: "Refresh history" }));
    await waitFor(() => expect(screen.getByTestId("history-announcement")).toHaveTextContent("History refreshed."));
    expect(state.calls).toEqual([]);
    // Every control in the pane is History's own.
    const names = within(historyPane())
      .getAllByRole("button")
      .map((button) => button.textContent ?? "");
    for (const name of names) expect(name).toMatch(/^(Show details|Hide details|Refresh|Load older entries)/);
    expect(within(historyPane()).queryByRole("textbox")).toBeNull();
    expect(within(historyPane()).queryByRole("radio")).toBeNull();
  });

  it("works the same for a former owner who may no longer edit — and still offers no write", async () => {
    state.role = "manager";
    await openEditor();
    await openHistory();
    expect(versionsShown()).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
    fireEvent.click(toggleOf(12));
    await waitFor(() => expect(within(entry(12)).getAllByTestId("history-change")).toHaveLength(3));
    expect(screen.queryByTestId("study-record-save")).toBeNull();
    expect(state.calls).toEqual([]);
  });

  it("renders recorded text as text: a label holding markup creates no element", async () => {
    setTables([
      headerRow(1, "create_study"),
      changeRow(1, 1, "study_created", { target: STUDY_ID, after: { label: "<img src=x onerror=alert(1)>", design_profile: "rct_parallel", notes: null } }),
    ]);
    await openEditor();
    await openHistory();
    fireEvent.click(toggleOf(1));
    await waitFor(() => expect(within(entry(1)).getByTestId("history-changes")).toHaveTextContent("Study record created as “<img src=x onerror=alert(1)>”"));
    expect(historyPane().querySelector("img")).toBeNull();
  });
});

describe("switching modes keeps what Edit and Review hold", () => {
  it("an unsaved Edit draft survives History", async () => {
    await openEditor();
    const value = () => within(screen.getByTestId("field-study|condition")).getByLabelText("Value") as HTMLTextAreaElement;
    fireEvent.change(value(), { target: { value: "An unsaved edit" } });
    expect(screen.getByTestId("study-record-save-status")).toHaveTextContent("Unsaved changes");
    await openHistory();
    chooseMode("Edit");
    expect(value().value).toBe("An unsaved edit");
    expect(screen.getByTestId("study-record-save-status")).toHaveTextContent("Unsaved changes");
    expect(state.calls).toEqual([]);
  });

  it("an open Flag note survives History", async () => {
    await openEditor();
    chooseMode("Review");
    fireEvent.click(within(screen.getByTestId("study-record-review-pane")).getByRole("radio", { name: /All recorded/ }));
    const card = screen.getByTestId("review-card-study|condition");
    fireEvent.click(within(card).getByRole("button", { name: "Flag…" }));
    fireEvent.change(within(card).getByLabelText("What's wrong with this value?"), { target: { value: "Check the methods" } });
    await openHistory();
    chooseMode("Review");
    expect((within(screen.getByTestId("review-card-study|condition")).getByLabelText("What's wrong with this value?") as HTMLTextAreaElement).value).toBe("Check the methods");
    expect(state.calls).toEqual([]);
  });

  it("History unmounts when left, so the next opening reads afresh", async () => {
    await openEditor();
    await openHistory();
    chooseMode("Edit");
    expect(screen.queryByTestId("study-record-history-pane")).toBeNull();
    state.tables.evidence_events.push(headerRow(13, "set_link"));
    const before = historyReads().length;
    chooseMode("History");
    // Read again on opening, whatever is still cached in this same instant.
    await waitFor(() => expect(versionsShown()[0]).toBe(13));
    expect(historyReads().length).toBe(before + 1);
  });
});

describe("keyboard and phone", () => {
  it("the arrow keys reach History from Review, and its panel is the one the tab controls", async () => {
    await openEditor();
    const modes = screen.getByRole("tablist", { name: "Study record mode" });
    const [, review, history] = within(modes).getAllByRole("tab");
    chooseMode("Review");
    act(() => review.focus());
    fireEvent.keyDown(review, { key: "ArrowRight" });
    await waitFor(() => expect(history).toHaveFocus());
    await waitFor(() => expect(history).toHaveAttribute("aria-selected", "true"));
    await waitFor(() => expect(historyPane()).toHaveAttribute("data-history-status", "ready"));
    // Each toggle is a real button: Enter and Space activate it natively.
    expect(toggleOf(12).tagName).toBe("BUTTON");
    expect(toggleOf(12)).toHaveAttribute("type", "button");
  });

  it("on a phone, History is a full-screen mode of its own, read the same way", async () => {
    state.mobile = true;
    await openEditor();
    await openHistory();
    expect(versionsShown()).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
    // Review stays mounted and hidden, as C2A left it.
    expect(screen.getByTestId("study-record-review-pane").closest("[role=tabpanel]")).toHaveAttribute("data-state", "inactive");
    expect(within(screen.getByRole("tablist", { name: "Study record mode" })).getAllByRole("tab")).toHaveLength(3);
  });

  it("on a desktop, History takes the Source pane's place, which stays mounted", async () => {
    await openEditor();
    const source = screen.getByTestId("study-record-source-pane").closest("section")!;
    expect(source).not.toHaveClass("hidden");
    await openHistory();
    expect(screen.getByTestId("study-record-source-pane").closest("section")).toBe(source);
    expect(source).toHaveClass("hidden");
    expect(historyPane().closest("[role=tabpanel]")).toHaveClass("col-span-2");
    chooseMode("Edit");
    expect(source).not.toHaveClass("hidden");
  });
});

// A request id, a payload fingerprint and a stored result sit in every header row the fake holds.
it("the fixture really holds what History must not show", () => {
  const header = historyRows()[0];
  expect(header.payload_sha256).toMatch(/^\\x(ab){32}$/);
  expect(header.result).toMatchObject({ status: "applied" });
  expect(historyRows().some((row) => row.note === "PLANTED-NOTE-NEVER-SHOWN")).toBe(true);
  expect(uuid("7", 1)).toMatch(UUID);
});
