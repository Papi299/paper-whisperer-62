import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabase } from "@/lib/studyRecord/__tests__/fakeSupabase";
import {
  ABSTRACT,
  fullRows,
  PAPER_ID,
  PAPER_TITLE,
  REPEATED_PHRASE,
  reportRow,
  snapshotRow,
  STUDY_ID,
  studyRow,
  USER,
  uuid,
  type FixtureRows,
} from "@/lib/studyRecord/__tests__/fixtures";

/**
 * The Study Record dialog end to end in jsdom (EVIDENCE-RECORDS-001C1): reads
 * through a fake PostgREST, writes through PR-B's real client over a scripted
 * RPC. Real Chromium (e2e/study-records.spec.ts) remains the authority for
 * layout, selection and focus.
 */

interface Call {
  readonly fn: string;
  readonly args: Record<string, unknown>;
}

const state = vi.hoisted(() => ({
  db: null as unknown as ReturnType<typeof import("@/lib/studyRecord/__tests__/fakeSupabase").fakeSupabase>,
  tables: {} as Record<string, Record<string, unknown>[]>,
  calls: [] as { fn: string; args: Record<string, unknown> }[],
  answer: null as unknown as (call: { fn: string; args: Record<string, unknown> }) => unknown,
  role: "owner",
  abstract: "" as string | null,
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
  useAbstract: () => ({ isPending: false, isError: false, data: state.abstract }),
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: state.toast }), toast: state.toast }));
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => state.mobile }));

import { StudyRecordDialog } from "../StudyRecordDialog";

const NEW_STUDY = STUDY_ID;

function setTables(rows: FixtureRows | null) {
  state.tables = {
    evidence_studies: rows?.study ? [rows.study] : [],
    evidence_study_reports: rows?.reports ?? [],
    evidence_source_snapshots: rows?.snapshots ?? [],
    evidence_arms: rows?.arms ?? [],
    evidence_outcomes: rows?.outcomes ?? [],
    evidence_field_values: rows?.values ?? [],
    evidence_field_anchors: rows?.anchors ?? [],
    papers: [{ id: PAPER_ID, user_id: USER, title: PAPER_TITLE }],
  };
  state.db = fakeSupabase({ tables: state.tables });
}

/** A paper's studies, as the entry summary reads them (`evidence_studies` needs `created_at`). */
function applied({ fn, args }: Call): unknown {
  const version = (args.p_expected_version as number) + 1;
  switch (fn) {
    case "evidence_create_study_from_paper":
      // The server creates the study, its link and its abstract copy.
      state.tables.evidence_studies.push(studyRow({ row_version: 1, label: args.p_label as string, design_profile: args.p_design_profile as string }));
      state.tables.evidence_study_reports.push(reportRow({ link_status: args.p_link_status as string }));
      if (state.abstract) state.tables.evidence_source_snapshots.push(snapshotRow({ exact_text: state.abstract, char_count: Array.from(state.abstract).length }));
      return { data: { status: "applied", study_id: NEW_STUDY, study_version: 1, link_id: uuid("b", 1), snapshot_id: state.abstract ? uuid("c", 1) : null }, error: null, status: 200 };
    case "evidence_delete_study":
      return { data: { status: "deleted" }, error: null, status: 200 };
    case "evidence_update_study":
      return { data: { status: "applied", study_id: args.p_study_id, study_version: version }, error: null, status: 200 };
    default:
      return { data: { status: "applied", study_id: args.p_study_id, study_version: version, arm_ids: {}, outcome_ids: {} }, error: null, status: 200 };
  }
}

const raised = (message: string, code = "P0001") => ({ data: null, error: { code, message, details: null, hint: null }, status: 400 });

function renderDialog() {
  const onClose = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <StudyRecordDialog target={{ session: 1, paperId: PAPER_ID, paperTitle: PAPER_TITLE, labelSuggestion: "Doe 2024" }} userId={USER} onClose={onClose} />
    </QueryClientProvider>,
  );
  return { onClose };
}

const dialog = () => screen.getByTestId("study-record-dialog");

/** The text node and offset at `offset` characters into `root`'s text (highlights split it into several nodes). */
function textPosition(root: Node, offset: number): [Text, number] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let remaining = offset;
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    if (remaining <= node.data.length) return [node, remaining];
    remaining -= node.data.length;
  }
  throw new Error("offset beyond the text");
}
const field = (key: string) => screen.getByTestId(`field-${key}`);
const rpcNames = () => state.calls.map((call) => call.fn);

async function openEditor() {
  const result = renderDialog();
  await screen.findByTestId("study-record-editor");
  await screen.findByRole("heading", { name: "Study record: Doe 2024" });
  return result;
}

// jsdom lacks what Radix's form controls and focus handling reach for.
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
  state.abstract = ABSTRACT;
  state.mobile = false;
  state.toast.mockReset();
});

describe("Start a study record", () => {
  beforeEach(() => setTables(null));

  it("explains what a study record is, and that PaperLume doesn't check it", async () => {
    renderDialog();
    await screen.findByRole("heading", { name: `Study record for: ${PAPER_TITLE}` });
    expect(dialog()).toHaveTextContent("PaperLume doesn't check whether it's right.");
    expect(screen.getByTestId("study-record-source-notice")).toHaveTextContent("PaperLume will save a copy of this paper's abstract");
  });

  it("creates nothing, and remembers nothing, when the answer is No", async () => {
    const { onClose } = renderDialog();
    await screen.findByRole("radio", { name: /^No(?!t)/ });
    fireEvent.click(screen.getByRole("radio", { name: /^No(?!t)/ }));
    expect(screen.getByText("No study record will be created, and PaperLume won't remember this answer.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close without creating" }));
    expect(state.calls).toEqual([]);
    expect(state.toast).toHaveBeenCalledWith({ title: "No study record created." });
    expect(onClose).toHaveBeenCalled();
  });

  it.each([
    ["Yes", "user_confirmed"],
    ["Not sure", "provisional"],
  ])("creates with a %s answer as a %s link, through the typed lifecycle RPC", async (answer, linkStatus) => {
    renderDialog();
    await screen.findByRole("radio", { name: new RegExp(`^${answer}`) });
    fireEvent.click(screen.getByRole("radio", { name: new RegExp(`^${answer}`) }));
    fireEvent.click(screen.getByRole("radio", { name: /Randomized trial, parallel groups/ }));
    const name = screen.getByLabelText("Study name");
    expect(name).toHaveValue("Doe 2024");
    fireEvent.change(name, { target: { value: "Doe 2024 trial" } });
    fireEvent.click(screen.getByRole("button", { name: "Create study record" }));

    await screen.findByTestId("study-record-editor");
    expect(state.calls).toEqual([
      {
        fn: "evidence_create_study_from_paper",
        args: { p_paper_id: PAPER_ID, p_label: "Doe 2024 trial", p_design_profile: "rct_parallel", p_link_status: linkStatus, p_request_id: expect.stringMatching(/^[0-9a-f-]{36}$/) },
      },
    ]);
  });

  it("says what is missing and sends nothing", async () => {
    renderDialog();
    fireEvent.click(await screen.findByRole("button", { name: "Create study record" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(state.calls).toEqual([]);
  });

  it("explains a record can be created without an abstract, supported by full-text references", async () => {
    state.abstract = null;
    renderDialog();
    fireEvent.click(await screen.findByRole("radio", { name: /^Yes/ }));
    expect(screen.getByTestId("study-record-source-notice")).toHaveTextContent("This paper has no abstract in your library. You can still create the record");
  });

  it("shows the pilot refusal distinctly", async () => {
    state.answer = () => raised("evidence_records_not_enabled", "42501");
    renderDialog();
    fireEvent.click(await screen.findByRole("radio", { name: /^Yes/ }));
    fireEvent.click(screen.getByRole("radio", { name: /Randomized trial, parallel groups/ }));
    fireEvent.click(screen.getByRole("button", { name: "Create study record" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Study records aren't available for your account yet.");
  });

  it("resends the same request after an unknown outcome, so nothing is created twice", async () => {
    state.answer = () => "throw";
    renderDialog();
    fireEvent.click(await screen.findByRole("radio", { name: /^Yes/ }));
    fireEvent.click(screen.getByRole("radio", { name: /Randomized trial, parallel groups/ }));
    fireEvent.click(screen.getByRole("button", { name: "Create study record" }));
    const retry = await screen.findByRole("button", { name: "Try again" });
    state.answer = applied;
    fireEvent.click(retry);
    await screen.findByTestId("study-record-editor");
    expect(state.calls).toHaveLength(2);
    expect(state.calls[1]).toEqual(state.calls[0]);
  });

  it("offers a manager no way to create", async () => {
    state.role = "manager";
    renderDialog();
    expect(await screen.findByText(/Study records aren't available for your account yet\./)).toBeInTheDocument();
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.queryByRole("button", { name: "Create study record" })).toBeNull();
  });
});

describe("The editor", () => {
  beforeEach(() => setTables(fullRows()));

  it("shows the saved copy exactly, as text, never as HTML", async () => {
    const rows = fullRows();
    const hostile = `${ABSTRACT}\n<img src=x onerror="alert(1)"> <b>bold</b>`;
    rows.snapshots = [snapshotRow({ exact_text: hostile, char_count: Array.from(hostile).length })];
    setTables(rows);
    await openEditor();
    const copy = screen.getByTestId("study-record-saved-abstract");
    expect(copy.textContent).toBe(hostile);
    expect(copy.className).toContain("whitespace-pre-wrap");
    expect(copy.querySelector("img, b, script")).toBeNull();
  });

  it("shows core fields, keeps optional ones behind More details, and every state as a radio", async () => {
    await openEditor();
    expect(screen.queryByTestId("field-study|setting")).toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: /^More details/ })[0]);
    expect(field("study|setting")).toBeInTheDocument();
    const radios = within(field("study|population_description")).getAllByRole("radio");
    expect(radios.map((radio) => radio.parentElement?.textContent)).toEqual(["Reported", "Not reported", "Unclear", "Not applicable", "Couldn't check"]);
    expect(field("study|population_description")).toHaveTextContent("Not yet recorded");
  });

  it("flags a Reported value without a source as “No source given”, but still saves it", async () => {
    await openEditor();
    const who = field("study|population_description");
    fireEvent.click(within(who).getByRole("radio", { name: "Reported" }));
    expect(within(who).getByTestId("no-source-given")).toHaveTextContent("No source given.");
    fireEvent.change(within(who).getByLabelText("Value"), { target: { value: "Adults with type 2 diabetes" } });
    fireEvent.click(screen.getByTestId("study-record-save"));
    await waitFor(() => expect(rpcNames()).toEqual(["evidence_save_changes"]));
  });

  it("makes the user choose which occurrence a repeated typed quote means, and sends that choice", async () => {
    await openEditor();
    const who = field("study|population_description");
    fireEvent.click(within(who).getByRole("radio", { name: "Reported" }));
    fireEvent.change(within(who).getByLabelText("Value"), { target: { value: "Adults" } });
    fireEvent.click(within(who).getByRole("button", { name: "Add quote" }));
    const panel = within(who).getByTestId("add-quote-panel");
    fireEvent.change(within(panel).getByLabelText("Quote from the saved abstract"), { target: { value: REPEATED_PHRASE } });
    expect(within(panel).getByTestId("add-quote-status")).toHaveTextContent("Found 2 times in the saved abstract. Choose the one you mean.");
    const add = within(panel).getByRole("button", { name: "Add this quote" });
    expect(add).toBeDisabled();
    fireEvent.click(within(panel).getByRole("radio", { name: "Occurrence 2" }));
    expect(add).toBeEnabled();
    fireEvent.click(add);
    expect(within(who).getByText(/occurrence 2 of 2/)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("study-record-save"));
    await waitFor(() => expect(state.calls).toHaveLength(1));
    const [change] = state.calls[0].args.p_changes as { field_key: string; references: unknown[] }[];
    expect(change.field_key).toBe("population_description");
    expect(change.references).toEqual([
      { purpose: "supports", source_kind: "abstract", paper_id: PAPER_ID, snapshot_id: uuid("c", 1), quote_text: REPEATED_PHRASE, occurrence: 2, expected_match_count: 2 },
    ]);
  });

  it("refuses a quote that isn't in the saved copy, with the specific reason", async () => {
    await openEditor();
    const who = field("study|population_description");
    fireEvent.click(within(who).getByRole("radio", { name: "Reported" }));
    fireEvent.click(within(who).getByRole("button", { name: "Add quote" }));
    const panel = within(who).getByTestId("add-quote-panel");
    fireEvent.change(within(panel).getByLabelText("Quote from the saved abstract"), { target: { value: "insulin glargine" } });
    expect(within(panel).getByTestId("add-quote-status")).toHaveTextContent("This text wasn't found in the saved abstract.");
    expect(within(panel).getByRole("button", { name: "Add this quote" })).toBeDisabled();
    fireEvent.change(within(panel).getByLabelText("Quote from the saved abstract"), { target: { value: "ab" } });
    expect(within(panel).getByTestId("add-quote-status")).toHaveTextContent("Quote at least 3 characters, including a letter or number.");
  });

  it("uses a selection in the saved copy as a quote, with the occurrence the selection is", async () => {
    await openEditor();
    const copy = screen.getByTestId("study-record-saved-abstract");
    const start = ABSTRACT.indexOf(REPEATED_PHRASE, ABSTRACT.indexOf(REPEATED_PHRASE) + 1);
    const range = document.createRange();
    const [startNode, startOffset] = textPosition(copy, start);
    const [endNode, endOffset] = textPosition(copy, start + REPEATED_PHRASE.length);
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    fireEvent.mouseUp(copy);

    const bar = await screen.findByTestId("use-as-quote-bar");
    fireEvent.change(within(bar).getByLabelText("Use as quote for"), { target: { value: "study|population_description" } });
    fireEvent.click(within(bar).getByRole("button", { name: "Use as quote" }));

    const who = field("study|population_description");
    expect(within(who).getByRole("radio", { name: "Reported" })).toBeChecked();
    expect(within(who).getByLabelText("Value")).toHaveValue(REPEATED_PHRASE);
    expect(within(who).getByText(/occurrence 2 of 2/)).toBeInTheDocument();
  });

  it("adds a full-text reference as a location only, marked as the user's own", async () => {
    await openEditor();
    const who = field("study|population_description");
    fireEvent.click(within(who).getByRole("radio", { name: "Reported" }));
    fireEvent.click(within(who).getByRole("button", { name: "Add full-text reference" }));
    const panel = within(who).getByTestId("add-full-text-panel");
    expect(panel).toHaveTextContent("Your reference — not checked by PaperLume");
    fireEvent.change(within(panel).getByLabelText("Location type"), { target: { value: "table" } });
    fireEvent.change(within(panel).getByLabelText("Location"), { target: { value: "2" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Add reference" }));
    expect(within(who).getByText("Table 2 · Your reference — not checked by PaperLume")).toBeInTheDocument();
    expect(within(who).queryByTestId("no-source-given")).toBeNull();
  });

  it("asks before removing a group with recorded values, and lets the user undo it", async () => {
    await openEditor();
    fireEvent.click(screen.getByRole("button", { name: "Remove Placebo" }));
    const confirm = await screen.findByRole("alertdialog");
    expect(confirm).toHaveTextContent("Remove ‘Placebo’?");
    expect(confirm).toHaveTextContent("Its 1 recorded value and their sources will be deleted when you save.");
    fireEvent.click(within(confirm).getByRole("button", { name: "Remove Placebo" }));
    expect(await screen.findByText("‘Placebo’ will be removed when you save.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.getByTestId(`group-${uuid("d", 2)}`)).toBeInTheDocument();
  });

  it("asks before discarding unsaved changes on close", async () => {
    const { onClose } = await openEditor();
    fireEvent.change(screen.getByLabelText("Study name"), { target: { value: "Doe 2024 (renamed)" } });
    expect(screen.getByTestId("study-record-save-status")).toHaveTextContent("Unsaved changes");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Close" }));
    const confirm = await screen.findByRole("alertdialog");
    expect(confirm).toHaveTextContent("Discard unsaved changes?");
    fireEvent.click(within(confirm).getByRole("button", { name: "Keep editing" }));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Study name")).toHaveValue("Doe 2024 (renamed)");

    fireEvent.click(within(dialog()).getByRole("button", { name: "Close" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Discard changes" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(state.calls).toEqual([]);
  });

  it("asks before leaving a draft for the list of the paper's studies", async () => {
    await openEditor();
    fireEvent.change(screen.getByLabelText("Study name"), { target: { value: "Doe 2024 (renamed)" } });
    fireEvent.click(screen.getByRole("button", { name: "All studies from this paper" }));
    expect(await screen.findByRole("alertdialog")).toHaveTextContent("Discard unsaved changes?");
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByLabelText("Study name")).toHaveValue("Doe 2024 (renamed)");
  });

  it("lets the owner add another study from a paper that already has one", async () => {
    await openEditor();
    fireEvent.click(screen.getByRole("button", { name: "All studies from this paper" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add another study from this paper" }));
    expect(await screen.findByRole("heading", { name: `Study record for: ${PAPER_TITLE}` })).toBeInTheDocument();
  });

  it("deletes the study record after saying exactly what goes — and that the paper stays", async () => {
    const { onClose } = await openEditor();
    fireEvent.click(screen.getByRole("button", { name: "Delete study record" }));
    const confirm = await screen.findByTestId("study-record-delete-dialog");
    expect(confirm).toHaveTextContent("Delete ‘Doe 2024’?");
    for (const item of ["structured values", "saved copies of the abstract", "its history", "the study with its links to papers"]) expect(confirm).toHaveTextContent(item);
    expect(confirm).toHaveTextContent("The paper stays in your library.");
    fireEvent.click(within(confirm).getByRole("button", { name: "Delete study record" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(state.calls.map((call) => [call.fn, call.args.p_study_id, call.args.p_expected_version])).toEqual([["evidence_delete_study", STUDY_ID, 4]]);
    expect(state.toast).toHaveBeenCalledWith({ title: "Study record deleted. The paper stays in your library." });
  });

  it("suggests a number from the reported text, but never confirms it for the user", async () => {
    await openEditor();
    const field = screen.getByTestId("field-study|n_randomized");
    fireEvent.change(within(field).getByLabelText("Confirmed number"), { target: { value: "" } });
    fireEvent.change(within(field).getByLabelText("As reported"), { target: { value: "n = 1,204 adults" } });
    expect(within(field).getByText("We read this as 1,204. Correct?")).toBeInTheDocument();
    expect(within(field).getByLabelText("Confirmed number")).toHaveValue("");
    fireEvent.click(within(field).getByRole("button", { name: "Use 1204" }));
    expect(within(field).getByLabelText("Confirmed number")).toHaveValue("1204");
    expect(within(field).queryByText("We read this as 1,204. Correct?")).toBeNull();
  });

  it("lists every study a paper reports and opens the one chosen", async () => {
    const second = uuid("5", 2);
    setTables(fullRows());
    state.tables.evidence_studies.push(studyRow({ id: second, label: "Doe 2024 (extension)", row_version: 1, created_at: "2026-10-21T10:00:00.000Z" }));
    state.tables.evidence_study_reports.push(reportRow({ id: uuid("b", 2), study_id: second, link_status: "provisional" }));
    renderDialog();
    const list = await screen.findByRole("list", { name: "Study records" });
    expect(within(list).getAllByRole("listitem").map((item) => item.querySelector("p")?.textContent)).toEqual(["Doe 2024", "Doe 2024 (extension)"]);
    expect(within(list).getByText(/^Provisional/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add another study from this paper" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open Doe 2024 (extension)" }));
    expect(await screen.findByRole("heading", { name: "Study record: Doe 2024 (extension)" })).toBeInTheDocument();
    // This study has no saved copy of the abstract: quotes give way to full-text references.
    expect(screen.getByTestId("study-record-source-pane")).toHaveTextContent("This study record has no saved copy of this paper's abstract");
  });

  it("shows a version conflict in words, keeps the edits, and offers a reload", async () => {
    state.answer = () => raised("evidence_version_conflict");
    await openEditor();
    fireEvent.change(screen.getByLabelText("Study name"), { target: { value: "Doe 2024 (renamed)" } });
    fireEvent.click(screen.getByTestId("study-record-save"));
    const alert = await screen.findByText(/changed in another tab or window, so your changes weren't saved/);
    expect(alert.closest("[role=alert]")).toHaveFocus();
    expect(screen.getByLabelText("Study name")).toHaveValue("Doe 2024 (renamed)");
    expect(screen.getByRole("button", { name: "Reload latest version" })).toBeInTheDocument();
  });
});

describe("a user the pilot no longer allows to edit", () => {
  beforeEach(() => {
    setTables(fullRows());
    state.role = "user";
  });

  it("can view and delete the records they hold, but not edit them", async () => {
    await openEditor();
    expect(screen.getByTestId("study-record-read-only")).toHaveTextContent("You can view and delete this study record.");
    expect(screen.queryByTestId("study-record-save")).toBeNull();
    expect(screen.getByLabelText("Study name")).toBeDisabled();
    for (const radio of within(field("study|condition")).getAllByRole("radio")) expect(radio).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Add intervention group" })).toBeNull();
    expect(screen.getByRole("button", { name: "Delete study record" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "All studies from this paper" })).toBeNull();
  });
});

describe("on a phone", () => {
  beforeEach(() => {
    setTables(fullRows());
    state.mobile = true;
  });

  it("switches between the record and the saved source", async () => {
    await openEditor();
    const record = screen.getByRole("tab", { name: "Record" });
    const source = screen.getByRole("tab", { name: "Source" });
    expect(record).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("study-record-source-pane").closest("[role=tabpanel]")).toHaveAttribute("data-state", "inactive");
    act(() => {
      fireEvent.mouseDown(source, { button: 0 });
    });
    expect(source).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("study-record-source-pane").closest("[role=tabpanel]")).toHaveAttribute("data-state", "active");
    expect(screen.getByTestId("study-record-record-pane").closest("[role=tabpanel]")).toHaveAttribute("data-state", "inactive");
  });
});
