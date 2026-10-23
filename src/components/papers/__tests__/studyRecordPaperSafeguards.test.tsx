import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import type { PaperWithTags } from "@/types/database";
import type { PaperLinkCheck } from "@/hooks/useStudyRecords";

/**
 * EVIDENCE-RECORDS-001C1 — the paper surfaces around study records:
 *   * single paper delete (PaperList): checked before Delete is offered; a held
 *     paper is explained, with a way to its study record — never deleted;
 *   * bulk delete (BulkActionsToolbar): the held selections are named, and the
 *     selection is never sent while it holds one;
 *   * Edit Paper: "Open study record" closes Edit Paper first, and the Study
 *     Record dialog opens only once it has closed (no stacked modals).
 * The database's NO ACTION key stays the protection; these are the UI's checks.
 */

const linkCheck = vi.hoisted(() => ({
  check: { status: "clear" } as PaperLinkCheck,
  retry: vi.fn(),
  calls: [] as { ids: readonly string[]; enabled: boolean }[],
}));
const studies = vi.hoisted(() => ({ count: 0, access: "allowed" }));

vi.mock("@/hooks/useStudyRecords", () => ({
  usePaperLinkCheck: (_userId: string, ids: readonly string[], enabled: boolean) => {
    linkCheck.calls.push({ ids: [...ids], enabled });
    return { check: enabled ? linkCheck.check : { status: "idle" }, retry: linkCheck.retry };
  },
  usePaperStudyRecords: (_u: string, _p: string, enabled: boolean) =>
    enabled
      ? { data: Array.from({ length: studies.count }, (_, i) => ({ studyId: `s${i}` })), isError: false, refetch: vi.fn() }
      : { data: undefined, isError: false, refetch: vi.fn() },
  useStudyRecordWriteAccess: () => studies.access,
}));
vi.mock("@/hooks/useAttachments", () => ({
  useAttachments: () => ({ attachments: [], loading: false, uploading: false, uploadAttachments: vi.fn(), deleteAttachment: vi.fn(), refetch: vi.fn() }),
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    functions: { invoke: vi.fn() },
    storage: { from: () => ({ createSignedUrls: async () => ({ data: [] }) }) },
    from: () => ({
      select: () => ({ eq: () => ({ eq: () => ({ single: async () => ({ data: null, error: null }) }) }) }),
    }),
  },
}));

import { PaperList } from "../PaperList";
import { BulkActionsToolbar } from "../BulkActionsToolbar";
import { EditPaperDialog } from "../EditPaperDialog";

beforeAll(() => {
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture = () => false;
  proto.setPointerCapture = () => {};
  proto.releasePointerCapture = () => {};
  proto.scrollIntoView = () => {};
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 800 });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, value: 1000 });
  Element.prototype.getBoundingClientRect = function (): DOMRect {
    return { x: 0, y: 0, top: 0, left: 0, bottom: 52, right: 1000, width: 1000, height: 52, toJSON: () => ({}) } as DOMRect;
  };
  (globalThis as unknown as Record<string, unknown>).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

const PAPER_ID = "00000000-0000-4000-8000-0000000000a1";

function makePaper(overrides: Partial<PaperWithTags> = {}): PaperWithTags {
  return {
    id: PAPER_ID,
    user_id: "u1",
    title: "Metformin for weight",
    authors: ["Doe J"],
    year: 2024,
    journal: "J Test",
    pmid: null,
    doi: null,
    has_abstract: true,
    study_type: null,
    raw_study_type: null,
    statistical_methods: null,
    keywords: [],
    raw_keywords: null,
    mesh_terms: [],
    substances: [],
    pubmed_url: null,
    journal_url: null,
    drive_url: null,
    tldr: null,
    notes: null,
    insert_order: 1,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    tags: [],
    projects: [],
    ...overrides,
  };
}

const withClient = (node: React.ReactNode) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{node}</QueryClientProvider>
);

beforeEach(() => {
  linkCheck.check = { status: "clear" };
  linkCheck.retry.mockReset();
  linkCheck.calls = [];
  studies.count = 0;
  studies.access = "allowed";
});

describe("PaperList — deleting one paper", () => {
  function renderList() {
    const onDelete = vi.fn();
    const onOpenStudyRecord = vi.fn();
    const paper = makePaper();
    render(
      withClient(
        <PaperList
          papers={[paper]}
          userId="u1"
          onEdit={vi.fn()}
          onDelete={onDelete}
          findMatchingKeywords={() => []}
          visibleColumns={["title"]}
          columnWidths={{ title: 300 }}
          onColumnResize={vi.fn()}
          normalizeKeyword={(k) => k}
          excludedKeywords={new Set()}
          excludedStudyTypes={new Set()}
          onExcludeStudyType={vi.fn(async () => true)}
          onExcludeKeyword={vi.fn(async () => true)}
          onUpdateDriveUrl={vi.fn(async () => {})}
          selectedPaperIds={new Set()}
          onToggleSelect={vi.fn()}
          onToggleSelectAll={vi.fn()}
          totalCount={1}
          isTotalCountAuthoritative={true}
          hasActiveFilters={false}
          onAddPapers={vi.fn()}
          onClearFilters={vi.fn()}
          onOpenStudyRecord={onOpenStudyRecord}
        />,
      ),
    );
    return { onDelete, onOpenStudyRecord, paper };
  }

  const openConfirmation = async () => {
    fireEvent.click(await screen.findByRole("button", { name: "Delete Metformin for weight" }));
    return screen.findByRole("alertdialog");
  };

  it("checks only this paper, only while the confirmation is open", async () => {
    renderList();
    expect(linkCheck.calls.every((call) => !call.enabled && call.ids.length === 0)).toBe(true);
    await openConfirmation();
    expect(linkCheck.calls.at(-1)).toEqual({ ids: [PAPER_ID], enabled: true });
  });

  it("offers Delete only once the check is clear", async () => {
    linkCheck.check = { status: "checking" };
    const { onDelete } = renderList();
    const confirmation = await openConfirmation();
    expect(within(confirmation).getByText("Checking for study records…")).toBeInTheDocument();
    const del = within(confirmation).getByRole("button", { name: "Delete" });
    expect(del).toBeDisabled();
    fireEvent.click(del);
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("deletes when the check is clear", async () => {
    const { onDelete } = renderList();
    const confirmation = await openConfirmation();
    fireEvent.click(within(confirmation).getByRole("button", { name: "Delete" }));
    expect(onDelete).toHaveBeenCalledWith(PAPER_ID);
  });

  it("explains a held paper, never deletes it, and opens its study record after closing", async () => {
    linkCheck.check = { status: "held", held: [{ paperId: PAPER_ID, title: "Metformin for weight" }] };
    const { onDelete, onOpenStudyRecord, paper } = renderList();
    const confirmation = await openConfirmation();
    expect(confirmation).toHaveTextContent("This paper has a study record");
    expect(confirmation).toHaveTextContent("‘Metformin for weight’ has a study record. Delete the study record first");
    expect(within(confirmation).queryByRole("button", { name: "Delete" })).toBeNull();
    fireEvent.click(within(confirmation).getByRole("button", { name: "Open study record" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() => expect(onOpenStudyRecord).toHaveBeenCalledWith(paper));
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("says a failed check plainly and offers Try again — not Delete", async () => {
    linkCheck.check = { status: "error" };
    const { onDelete } = renderList();
    const confirmation = await openConfirmation();
    expect(confirmation).toHaveTextContent("Couldn't check whether this paper has a study record, so it can't be deleted yet.");
    fireEvent.click(within(confirmation).getByRole("button", { name: "Try again" }));
    expect(linkCheck.retry).toHaveBeenCalledTimes(1);
    expect(within(confirmation).queryByRole("button", { name: "Delete" })).toBeNull();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("shows the study-record entry in the expanded details, not as another row icon", async () => {
    studies.count = 2;
    const { onOpenStudyRecord, paper } = renderList();
    const rowButtonsBefore = screen.getAllByRole("button").map((b) => b.getAttribute("aria-label"));
    expect(rowButtonsBefore.some((label) => /study record/i.test(label ?? ""))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /abstract/i }));
    const entry = await screen.findByTestId("study-record-entry");
    expect(entry).toHaveTextContent("Study records — 2");
    fireEvent.click(within(entry).getByRole("button", { name: "Open study record" }));
    expect(onOpenStudyRecord).toHaveBeenCalledWith(paper);
  });
});

describe("BulkActionsToolbar — deleting a selection", () => {
  const PROJECT = { id: "p1", user_id: "u1", name: "P", description: null, color: null, created_at: "", updated_at: "" } as never;
  function renderToolbar(check: PaperLinkCheck, selected = 3) {
    const props = {
      onDeleteCheckOpenChange: vi.fn(),
      onRetryDeleteCheck: vi.fn(),
      onDeselectPapers: vi.fn(),
      onBulkDelete: vi.fn(async () => {}),
    };
    render(
      <BulkActionsToolbar
        selectedCount={selected}
        onCompare={vi.fn()}
        onClearSelection={vi.fn()}
        onBulkSetProjects={vi.fn(async () => {})}
        onBulkSetTags={vi.fn(async () => {})}
        projects={[PROJECT]}
        tags={[]}
        deleteCheck={check}
        {...props}
      />,
    );
    return props;
  }
  const openDelete = () => {
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    return screen.getByRole("dialog");
  };

  it("starts the check when the confirmation opens and stops it when it closes", () => {
    const props = renderToolbar({ status: "clear" });
    const dialog = openDelete();
    expect(props.onDeleteCheckOpenChange).toHaveBeenLastCalledWith(true);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(props.onDeleteCheckOpenChange).toHaveBeenLastCalledWith(false);
  });

  it("names the held papers, offers to deselect them, and never sends the selection", () => {
    const held = Array.from({ length: 10 }, (_, i) => ({ paperId: `id-${i}`, title: i === 3 ? null : `Paper ${i}` }));
    const props = renderToolbar({ status: "held", held }, 12);
    const dialog = openDelete();
    expect(dialog).toHaveTextContent("Some selected papers have study records");
    expect(dialog).toHaveTextContent("10 of the 12 selected papers have study records. Deselect them or delete their study records first.");
    expect(within(dialog).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Paper 0",
      "Paper 1",
      "Paper 2",
      "A paper in your selection",
      "Paper 4",
      "Paper 5",
      "Paper 6",
      "Paper 7",
      "and 2 more",
    ]);
    expect(within(dialog).queryByRole("button", { name: "Delete" })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Deselect papers with study records" }));
    expect(props.onDeselectPapers).toHaveBeenCalledWith(held.map((p) => p.paperId));
    expect(props.onBulkDelete).not.toHaveBeenCalled();
  });

  it("closes the confirmation when deselecting would empty the selection", () => {
    const props = renderToolbar({ status: "held", held: [{ paperId: "a", title: "A" }, { paperId: "b", title: "B" }] }, 2);
    fireEvent.click(within(openDelete()).getByRole("button", { name: "Deselect papers with study records" }));
    expect(props.onDeleteCheckOpenChange).toHaveBeenLastCalledWith(false);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("waits for the check before offering Delete, and says a failure", () => {
    const checking = renderToolbar({ status: "checking" });
    const dialog = openDelete();
    expect(dialog).toHaveTextContent("Checking for study records…");
    const del = within(dialog).getByRole("button", { name: "Delete" });
    expect(del).toBeDisabled();
    fireEvent.click(del);
    expect(checking.onBulkDelete).not.toHaveBeenCalled();
  });

  it("offers Try again — not Delete — after a failed check", () => {
    const props = renderToolbar({ status: "error" });
    const dialog = openDelete();
    expect(dialog).toHaveTextContent("Couldn't check whether these papers have study records, so nothing can be deleted yet.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Try again" }));
    expect(props.onRetryDeleteCheck).toHaveBeenCalled();
    expect(within(dialog).queryByRole("button", { name: "Delete" })).toBeNull();
  });

  it("deletes a clear selection", async () => {
    const props = renderToolbar({ status: "clear" });
    fireEvent.click(within(openDelete()).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(props.onBulkDelete).toHaveBeenCalledTimes(1));
  });
});

describe("Edit Paper — Open study record", () => {
  function Harness({ onOpenStudyRecord }: { onOpenStudyRecord: (paper: PaperWithTags) => void }) {
    const [open, setOpen] = useState(true);
    return withClient(
      <EditPaperDialog
        paper={open ? makePaper() : null}
        projects={[]}
        tags={[]}
        open={open}
        onOpenChange={setOpen}
        onSave={vi.fn(async () => true)}
        userId="u1"
        onOpenStudyRecord={onOpenStudyRecord}
      />,
    );
  }

  it("closes Edit Paper first and opens the study record only once it has closed", async () => {
    const onOpenStudyRecord = vi.fn();
    render(<Harness onOpenStudyRecord={onOpenStudyRecord} />);
    const entry = await screen.findByTestId("study-record-entry");
    expect(entry).toHaveTextContent("Study records — None");
    expect(entry).toHaveTextContent("Opening the study record closes Edit Paper. Save your paper changes first.");
    fireEvent.click(within(entry).getByRole("button", { name: "Start a study record" }));
    // At no point are both dialogs requested at once.
    expect(onOpenStudyRecord).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Edit Paper" })).toBeNull());
    await waitFor(() => expect(onOpenStudyRecord).toHaveBeenCalledWith(expect.objectContaining({ id: PAPER_ID })));
    expect(onOpenStudyRecord).toHaveBeenCalledTimes(1);
  });

  it("offers nothing for a user without study records and without the pilot", async () => {
    studies.access = "not_allowed";
    render(<Harness onOpenStudyRecord={vi.fn()} />);
    await screen.findByRole("heading", { name: "Edit Paper" });
    expect(screen.queryByTestId("study-record-entry")).toBeNull();
  });
});
