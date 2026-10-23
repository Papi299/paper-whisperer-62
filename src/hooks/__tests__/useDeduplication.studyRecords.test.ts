import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DuplicateGroup, DuplicatePaperInfo } from "@/types/database";

/**
 * EVIDENCE-RECORDS-001C1 — `merge_exact_duplicates` refused because a study
 * record holds a discarded paper (`evidence_study_reports_paper_fkey`, NO
 * ACTION: the whole merge rolls back). The refusal is explained by the
 * constraint's name only; every other error keeps its existing handling, and
 * the keeper suggestion never proposes discarding a held paper.
 */

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  toast: vi.fn(),
  invalidateQueries: vi.fn(),
}));

vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc: mocks.rpc } }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries: mocks.invalidateQueries }) }));

import { suggestKeepPaper, useDeduplication } from "../useDeduplication";

const USER = "11111111-1111-4111-8111-111111111111";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function paper(n: number, complete: boolean): DuplicatePaperInfo {
  return {
    id: id(n),
    title: `Paper ${n}`,
    authors: complete ? ["Doe J"] : [],
    year: complete ? 2020 : null,
    journal: complete ? "Journal" : null,
    pmid: "12345",
    doi: null,
    abstract: complete ? "Abstract" : null,
    study_type: null,
    keywords: [],
    created_at: "2026-01-01T00:00:00Z",
  };
}

const rawGroup = (papers: DuplicatePaperInfo[]) => ({ match_type: "pmid", match_value: "12345", papers });

const heldError = {
  code: "23503",
  message: 'update or delete on table "papers" violates foreign key constraint "evidence_study_reports_paper_fkey" on table "evidence_study_reports"',
};

async function scanned(papers: DuplicatePaperInfo[]) {
  mocks.rpc.mockImplementation(async (fn: string) =>
    fn === "get_duplicate_papers" ? { data: [rawGroup(papers)], error: null } : { data: null, error: null },
  );
  const hook = renderHook(() => useDeduplication(USER));
  await act(async () => {
    await hook.result.current.scanForDuplicates();
  });
  expect(hook.result.current.duplicateGroups).toHaveLength(1);
  return hook;
}

const titles = () => mocks.toast.mock.calls.map((call) => (call[0] as { title: string }).title);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("suggestKeepPaper with study records", () => {
  const group: DuplicateGroup = { match_type: "pmid", match_value: "1", papers: [paper(1, true), paper(2, false)] };

  it("keeps the completeness suggestion when no paper is held", () => {
    expect(suggestKeepPaper(group)).toBe(id(1));
    expect(suggestKeepPaper(group, new Set())).toBe(id(1));
  });

  it("suggests the one held paper, matched case-insensitively", () => {
    expect(suggestKeepPaper(group, new Set([id(2)]))).toBe(id(2));
    const upper: DuplicateGroup = { ...group, papers: [paper(1, true), { ...paper(2, false), id: id(2).toUpperCase() }] };
    expect(suggestKeepPaper(upper, new Set([id(2)]))).toBe(id(2).toUpperCase());
  });

  it("falls back to completeness when several are held (the group cannot be merged)", () => {
    expect(suggestKeepPaper(group, new Set([id(1), id(2)]))).toBe(id(1));
  });
});

describe("mergeAllGroups — a study record holds a discarded paper", () => {
  it("explains the refusal and counts the group as not merged", async () => {
    const hook = await scanned([paper(1, true), paper(2, false)]);
    mocks.rpc.mockImplementation(async (fn: string) => (fn === "merge_exact_duplicates" ? { data: null, error: heldError } : { data: null, error: null }));

    await act(async () => {
      await hook.result.current.mergeAllGroups(new Map([[0, id(1)]]));
    });

    expect(mocks.rpc).toHaveBeenCalledWith("merge_exact_duplicates", { p_keep_id: id(1), p_discard_ids: [id(2)] });
    expect(mocks.toast).toHaveBeenCalledWith({
      title: "Group not merged",
      description: "A paper in this group has a study record, so the group wasn't merged.",
      variant: "destructive",
    });
    expect(titles()).toContain("Merge partially failed");
    // Nothing changed in the library, so nothing is refetched as if it had.
    expect(mocks.invalidateQueries).not.toHaveBeenCalled();
    // The database's message (constraint and table names) is never shown.
    expect(JSON.stringify(mocks.toast.mock.calls)).not.toMatch(/evidence_study_reports|violates/);
  });

  it("keeps the existing message for every other error, including other foreign keys", async () => {
    const hook = await scanned([paper(1, true), paper(2, false)]);
    const other = { code: "23503", message: 'violates foreign key constraint "paper_tags_paper_id_fkey" on table "paper_tags"' };
    mocks.rpc.mockImplementation(async (fn: string) => (fn === "merge_exact_duplicates" ? { data: null, error: other } : { data: null, error: null }));

    await act(async () => {
      await hook.result.current.mergeAllGroups(new Map([[0, id(1)]]));
    });

    expect(mocks.toast).toHaveBeenCalledWith({ title: "Error merging duplicates", description: other.message, variant: "destructive" });
    expect(titles()).not.toContain("Group not merged");
  });

  it("names the groups left out for study records in the success summary", async () => {
    const hook = await scanned([paper(1, true), paper(2, false)]);
    mocks.rpc.mockImplementation(async () => ({ data: null, error: null }));

    await act(async () => {
      await hook.result.current.mergeAllGroups(new Map([[0, id(1)]]), { skippedForStudyRecords: 2 });
    });

    expect(mocks.toast).toHaveBeenCalledWith({
      title: "Duplicates merged",
      description: "Successfully merged 1 duplicate group. 2 groups with a study record weren't merged.",
    });
  });

  it("says nothing about study records when none were left out", async () => {
    const hook = await scanned([paper(1, true), paper(2, false)]);
    mocks.rpc.mockImplementation(async () => ({ data: null, error: null }));

    await act(async () => {
      await hook.result.current.mergeAllGroups(new Map([[0, id(1)]]));
    });

    expect(mocks.toast).toHaveBeenCalledWith({ title: "Duplicates merged", description: "Successfully merged 1 duplicate group." });
  });
});
