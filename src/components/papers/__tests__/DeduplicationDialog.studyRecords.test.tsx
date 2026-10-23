import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { DuplicateGroup, DuplicatePaperInfo } from "@/types/database";
import type { PaperLinkCheck } from "@/hooks/useStudyRecords";

/**
 * EVIDENCE-RECORDS-001C1 — duplicate merge when a study record holds a paper
 * (Requirements-001 §E10, §G5). The database refuses to discard such a paper
 * (`evidence_study_reports_paper_fkey`, NO ACTION); the dialog must say so
 * first, suggest keeping that paper, leave a group it cannot merge out of
 * "Merge All", and merge nothing while it does not know.
 */

const dedup = vi.hoisted(() => ({
  groups: [] as DuplicateGroup[],
  mergeAllGroups: vi.fn(async () => {}),
  scanForDuplicates: vi.fn(async () => {}),
}));
const linkCheck = vi.hoisted(() => ({ check: { status: "idle" } as PaperLinkCheck, retry: vi.fn() }));

vi.mock("@/hooks/useDeduplication", async (importActual) => {
  const actual = await importActual<typeof import("@/hooks/useDeduplication")>();
  return {
    ...actual,
    useDeduplication: () => ({
      scanning: false,
      duplicateGroups: dedup.groups,
      merging: false,
      scanForDuplicates: dedup.scanForDuplicates,
      mergeAllGroups: dedup.mergeAllGroups,
    }),
  };
});
vi.mock("@/hooks/useStudyRecords", () => ({
  usePaperLinkCheck: () => linkCheck,
}));

import { DeduplicationDialog } from "../DeduplicationDialog";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function paper(n: number, title: string, complete: boolean): DuplicatePaperInfo {
  return {
    id: id(n),
    title,
    authors: complete ? ["Doe J"] : [],
    year: complete ? 2020 : null,
    journal: complete ? "Journal" : null,
    pmid: null,
    doi: "10.1000/x",
    abstract: complete ? "An abstract." : null,
    study_type: null,
    keywords: [],
    created_at: "2026-01-01T00:00:00Z",
  };
}

// Group 0: A is the more complete record; B has the study record.
const A = paper(1, "Paper A (complete)", true);
const B = paper(2, "Paper B (has a study record)", false);
// Group 1: nothing held.
const C = paper(3, "Paper C (complete)", true);
const D = paper(4, "Paper D", false);
// Group 2: both held.
const E = paper(5, "Paper E", true);
const F = paper(6, "Paper F", false);

const group = (value: string, papers: [DuplicatePaperInfo, DuplicatePaperInfo]): DuplicateGroup => ({
  match_type: "doi",
  match_value: value,
  papers,
});

function held(...papers: DuplicatePaperInfo[]): PaperLinkCheck {
  return { status: "held", held: papers.map((p) => ({ paperId: p.id, title: p.title })) };
}

function renderDialog() {
  return render(<DeduplicationDialog open onOpenChange={() => {}} userId="11111111-1111-4111-8111-111111111111" />);
}

const cards = () => screen.getAllByTestId("duplicate-group");
const mergeButton = () => screen.getByRole("button", { name: /^Merge All/ });

beforeEach(() => {
  vi.clearAllMocks();
  dedup.groups = [group("10.1000/ab", [A, B]), group("10.1000/cd", [C, D])];
  linkCheck.check = { status: "clear" };
});

describe("DeduplicationDialog — study records", () => {
  it("with no study records, suggests and counts exactly as before", () => {
    renderDialog();
    expect(within(cards()[0]).getByRole("radio", { name: /Paper A/ })).toBeChecked();
    expect(within(cards()[1]).getByRole("radio", { name: /Paper C/ })).toBeChecked();
    expect(mergeButton()).toHaveTextContent("Merge All (2 groups)");
    expect(mergeButton()).not.toHaveAttribute("aria-disabled");
    expect(screen.queryByTestId("duplicate-study-record-notice")).toBeNull();
    expect(screen.getByText(/2 papers will be removed/)).toBeInTheDocument();
  });

  it("suggests keeping the paper a study record links to, over the more complete one", async () => {
    linkCheck.check = held(B);
    renderDialog();
    expect(within(cards()[0]).getByRole("radio", { name: /Paper B/ })).toBeChecked();
    expect(within(cards()[0]).getByText("Study record")).toBeInTheDocument();
    expect(screen.getByTestId("duplicate-study-record-notice")).toHaveTextContent(/never moves or combines study records/);
    expect(screen.queryByTestId("duplicate-group-block")).toBeNull();

    fireEvent.click(mergeButton());
    expect(dedup.mergeAllGroups).toHaveBeenCalledTimes(1);
    const [selections, options] = dedup.mergeAllGroups.mock.calls[0] as unknown as [Map<number, string>, { skippedForStudyRecords: number }];
    expect([...selections]).toEqual([
      [0, B.id],
      [1, C.id],
    ]);
    expect(options).toEqual({ skippedForStudyRecords: 0 });
  });

  it("refuses to discard a held paper the user chose to drop, and merges the rest", () => {
    linkCheck.check = held(B);
    renderDialog();
    fireEvent.click(within(cards()[0]).getByRole("radio", { name: /Paper A/ }));

    expect(within(cards()[0]).getByTestId("duplicate-group-block")).toHaveTextContent(
      "‘Paper B (has a study record)’ has a study record. Keep that paper in this group, or delete its study record first.",
    );
    expect(mergeButton()).toHaveTextContent("Merge All (1 group)");
    // Only the mergeable group's discards are counted.
    expect(screen.getByText(/1 paper will be removed/)).toBeInTheDocument();

    fireEvent.click(mergeButton());
    const [selections, options] = dedup.mergeAllGroups.mock.calls[0] as unknown as [Map<number, string>, { skippedForStudyRecords: number }];
    expect([...selections]).toEqual([[1, C.id]]);
    expect(options).toEqual({ skippedForStudyRecords: 1 });
  });

  it("never overrides a keeper the user chose when the check settles later", () => {
    const G = paper(7, "Paper G", false);
    dedup.groups = [{ match_type: "doi", match_value: "10.1000/abg", papers: [A, B, G] }];
    linkCheck.check = { status: "checking" };
    const view = renderDialog();
    // The suggestion (A) is replaced by the user's own choice before the answer arrives.
    fireEvent.click(within(cards()[0]).getByRole("radio", { name: /Paper G/ }));
    linkCheck.check = held(B);
    view.rerender(<DeduplicationDialog open onOpenChange={() => {}} userId="11111111-1111-4111-8111-111111111111" />);
    expect(within(cards()[0]).getByRole("radio", { name: /Paper G/ })).toBeChecked();
    expect(within(cards()[0]).getByTestId("duplicate-group-block")).toHaveTextContent(/Paper B \(has a study record\)/);
    expect(mergeButton()).toHaveTextContent("Merge All (0 groups)");
  });

  it("re-suggests a group the user has not touched once the answer arrives", () => {
    linkCheck.check = { status: "checking" };
    const view = renderDialog();
    expect(within(cards()[0]).getByRole("radio", { name: /Paper A/ })).toBeChecked();
    linkCheck.check = held(B);
    view.rerender(<DeduplicationDialog open onOpenChange={() => {}} userId="11111111-1111-4111-8111-111111111111" />);
    expect(within(cards()[0]).getByRole("radio", { name: /Paper B/ })).toBeChecked();
    expect(screen.queryByTestId("duplicate-group-block")).toBeNull();
  });

  it("cannot merge a group in which several papers have study records", () => {
    dedup.groups = [group("10.1000/ef", [E, F]), group("10.1000/cd", [C, D])];
    linkCheck.check = held(E, F);
    renderDialog();
    expect(within(cards()[0]).getByTestId("duplicate-group-block")).toHaveTextContent(
      "2 papers in this group have study records, so this group can't be merged. Study records are never merged automatically.",
    );
    expect(within(cards()[0]).getAllByText("Study record")).toHaveLength(2);
    expect(mergeButton()).toHaveTextContent("Merge All (1 group)");
    fireEvent.click(mergeButton());
    const [selections, options] = dedup.mergeAllGroups.mock.calls[0] as unknown as [Map<number, string>, { skippedForStudyRecords: number }];
    expect([...selections]).toEqual([[1, C.id]]);
    expect(options).toEqual({ skippedForStudyRecords: 1 });
  });

  it("offers no merge at all when every group is blocked", () => {
    dedup.groups = [group("10.1000/ef", [E, F])];
    linkCheck.check = held(E, F);
    renderDialog();
    expect(mergeButton()).toBeDisabled();
    expect(mergeButton()).toHaveTextContent("Merge All (0 groups)");
  });

  it("merges nothing while the check is still running, and says why", () => {
    linkCheck.check = { status: "checking" };
    renderDialog();
    expect(screen.getByText("Checking for study records…")).toBeInTheDocument();
    expect(mergeButton()).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(mergeButton());
    expect(dedup.mergeAllGroups).not.toHaveBeenCalled();
    // Nothing is presented as blocked before the answer is known.
    expect(screen.queryByTestId("duplicate-group-block")).toBeNull();
  });

  it("says a failed check plainly, offers Try again, and merges nothing", () => {
    linkCheck.check = { status: "error" };
    renderDialog();
    expect(screen.getByText(/Couldn't check these papers for study records/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(linkCheck.retry).toHaveBeenCalledTimes(1);
    expect(mergeButton()).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(mergeButton());
    expect(dedup.mergeAllGroups).not.toHaveBeenCalled();
  });

  it("keeps every keeper radio operable, blocked or not", () => {
    linkCheck.check = held(E, F);
    dedup.groups = [group("10.1000/ef", [E, F])];
    renderDialog();
    for (const radio of within(cards()[0]).getAllByRole("radio")) expect(radio).not.toBeDisabled();
  });
});
