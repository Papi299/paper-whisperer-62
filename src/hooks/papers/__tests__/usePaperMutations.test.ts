import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// ── Supabase mock (hoisted) ───────────────────────────────────────────
//
// `mockFrom` returns a builder that exposes both `insert(...)` (used by
// `addPaperManually`) and `update(...)` (used by `updatePaper`). The
// `update(...).eq(...)` chain resolves to `mockUpdateResolve`, defaulting to
// success — individual tests override `mockUpdateResolve.mockResolvedValueOnce`
// to simulate failure. `mockRpc` is used for both `set_paper_tags` and
// `set_paper_projects`; tests override its per-call return as needed.
const {
  mockInsert,
  mockSelect,
  mockSingle,
  mockFrom,
  mockRpc,
  mockUpdate,
  mockUpdateEq,
  mockUpdateResolve,
} = vi.hoisted(() => {
  const mockSingle = vi.fn();
  const mockSelect = vi.fn(() => ({ single: mockSingle }));
  const mockInsert = vi.fn(() => ({ select: mockSelect }));
  const mockRpc = vi.fn();
  const mockUpdateResolve = vi.fn();
  const mockUpdateEq = vi.fn(() => mockUpdateResolve());
  const mockUpdate = vi.fn(() => ({ eq: mockUpdateEq }));
  const mockFrom = vi.fn(() => ({ insert: mockInsert, update: mockUpdate }));
  return { mockInsert, mockSelect, mockSingle, mockFrom, mockRpc, mockUpdate, mockUpdateEq, mockUpdateResolve };
});

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: mockFrom, rpc: mockRpc },
}));

// ── useToast mock ─────────────────────────────────────────────────────
const mockToast = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));

// ── TanStack Query mock ──────────────────────────────────────────────
const mockInvalidateQueries = vi.fn();
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: mockInvalidateQueries }),
}));

// ── usePaperCacheHelpers mock ─────────────────────────────────────────
//
// `mockRollbackCache` is exposed at module scope so the `updatePaper`
// failure tests can assert that the optimistic snapshot is rolled back on
// each handled error path (paper-row update / set_paper_tags /
// set_paper_projects).
const mockInvalidateAndRefetch = vi.fn();
const mockRollbackCache = vi.fn();
vi.mock("../usePaperCacheHelpers", () => ({
  usePaperCacheHelpers: () => ({
    snapshotCache: vi.fn(() => ({})),
    rollbackCache: mockRollbackCache,
    cancelQueries: vi.fn(),
    updatePapersCache: vi.fn(),
    adjustCount: vi.fn(),
    adjustFilteredCount: vi.fn(),
    removeStaleListCaches: vi.fn(),
    invalidateAndRefetch: mockInvalidateAndRefetch,
  }),
}));

// ── useNormalizationWorker mock ───────────────────────────────────────
vi.mock("@/hooks/useNormalizationWorker", () => ({
  useNormalizationWorker: () => ({
    normalize: vi.fn(async (papers: unknown[]) => papers),
  }),
}));

// ── queryKeys mock ────────────────────────────────────────────────────
vi.mock("@/lib/queryKeys", () => ({
  queryKeys: {
    papers: {
      all: (uid: string) => ["papers", uid],
      abstract: (id: string) => ["papers", "abstract", id],
      count: (uid: string) => ["papers", "count", uid],
      list: (...args: unknown[]) => ["papers", "list", ...args],
    },
    projects: { all: (uid: string) => ["projects", uid] },
    tags: { all: (uid: string) => ["tags", uid] },
  },
}));

import { usePaperMutations } from "../usePaperMutations";
import type { PaperWithTags, Project, Tag } from "@/types/database";
import type { ServerFilterParams, ServerSortParams } from "../types";

// ── Test fixtures ─────────────────────────────────────────────────────

const userId = "user-1";
const emptyPapers: PaperWithTags[] = [];
const emptyProjects: Project[] = [];
const emptyTags: Tag[] = [];
const emptyFilters: ServerFilterParams = {};
const emptySort: ServerSortParams = { column: "created_at", direction: "desc" };

function validManualData() {
  return {
    title: "A Great Paper",
    authors: "Smith, Jones",
    year: "2024",
    journal: "Nature",
    pmid: "12345678",
    doi: "10.1234/test",
    abstract: "An abstract",
    keywords: "keyword1, keyword2",
    driveUrl: "",
  };
}

describe("usePaperMutations – addPaperManually return value", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns false when userId is undefined", async () => {
    const { result } = renderHook(() =>
      usePaperMutations(undefined, emptyPapers, emptyProjects, emptyTags, undefined, emptyFilters, emptySort)
    );

    let returnValue: boolean | undefined;
    await act(async () => {
      returnValue = await result.current.addPaperManually(validManualData());
    });

    expect(returnValue).toBe(false);
  });

  it("returns false for invalid year", async () => {
    const { result } = renderHook(() =>
      usePaperMutations(userId, emptyPapers, emptyProjects, emptyTags, undefined, emptyFilters, emptySort)
    );

    let returnValue: boolean | undefined;
    await act(async () => {
      returnValue = await result.current.addPaperManually({ ...validManualData(), year: "1700" });
    });

    expect(returnValue).toBe(false);
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Invalid year" }));
  });

  it("returns false for invalid PMID", async () => {
    const { result } = renderHook(() =>
      usePaperMutations(userId, emptyPapers, emptyProjects, emptyTags, undefined, emptyFilters, emptySort)
    );

    let returnValue: boolean | undefined;
    await act(async () => {
      returnValue = await result.current.addPaperManually({ ...validManualData(), pmid: "not-a-number" });
    });

    expect(returnValue).toBe(false);
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Invalid PMID" }));
  });

  it("returns false for duplicate paper (matching PMID)", async () => {
    const existingPaper = {
      id: "p1", pmid: "12345678", doi: null, title: "Other",
      tags: [], projects: [],
    } as unknown as PaperWithTags;

    const { result } = renderHook(() =>
      usePaperMutations(userId, [existingPaper], emptyProjects, emptyTags, undefined, emptyFilters, emptySort)
    );

    let returnValue: boolean | undefined;
    await act(async () => {
      returnValue = await result.current.addPaperManually(validManualData());
    });

    expect(returnValue).toBe(false);
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Duplicate paper" }));
  });

  it("returns false when DB insert fails", async () => {
    mockSingle.mockResolvedValue({ data: null, error: { code: "XXXXX", message: "DB error" } });

    const { result } = renderHook(() =>
      usePaperMutations(userId, emptyPapers, emptyProjects, emptyTags, undefined, emptyFilters, emptySort)
    );

    let returnValue: boolean | undefined;
    await act(async () => {
      returnValue = await result.current.addPaperManually(validManualData());
    });

    expect(returnValue).toBe(false);
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Error adding paper" }));
  });

  it("returns false on duplicate key constraint (23505)", async () => {
    mockSingle.mockResolvedValue({ data: null, error: { code: "23505", message: "duplicate" } });

    const { result } = renderHook(() =>
      usePaperMutations(userId, emptyPapers, emptyProjects, emptyTags, undefined, emptyFilters, emptySort)
    );

    let returnValue: boolean | undefined;
    await act(async () => {
      returnValue = await result.current.addPaperManually(validManualData());
    });

    expect(returnValue).toBe(false);
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Duplicate paper" }));
  });

  it("returns true on successful insert", async () => {
    mockSingle.mockResolvedValue({ data: { id: "new-paper-id" }, error: null });

    const { result } = renderHook(() =>
      usePaperMutations(userId, emptyPapers, emptyProjects, emptyTags, undefined, emptyFilters, emptySort)
    );

    let returnValue: boolean | undefined;
    await act(async () => {
      returnValue = await result.current.addPaperManually(validManualData());
    });

    expect(returnValue).toBe(true);
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Paper added manually" }));
    expect(mockInvalidateAndRefetch).toHaveBeenCalled();
  });
});

// ── addPaperManually assignment-failure visibility ────────────────────
//
// These tests lock in the mirror of the bulk-import "assignment warnings"
// pattern (`useBulkMutations.ts`) for the single-paper manual-add flow.
// When the paper row is successfully inserted but the follow-up
// `set_paper_projects` / `set_paper_tags` RPCs fail, the function must:
//   • still invalidate the list cache (so the new paper appears),
//   • surface a destructive "Paper added with warnings" toast naming the
//     failed assignment(s),
//   • still return `true` (the paper exists, the dialog should close —
//     the destructive toast + missing chips in the row are the user-
//     visible signal that manual reassignment is needed).

describe("usePaperMutations – addPaperManually assignment-failure visibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: paper row insert succeeds. Individual tests override RPC outcomes.
    mockSingle.mockResolvedValue({ data: { id: "new-paper-id" }, error: null });
  });

  it("returns true with normal success toast when both assignments succeed", async () => {
    mockRpc.mockResolvedValue({ error: null });

    const { result } = renderHook(() =>
      usePaperMutations(userId, emptyPapers, emptyProjects, emptyTags, undefined, emptyFilters, emptySort)
    );

    let returnValue: boolean | undefined;
    await act(async () => {
      returnValue = await result.current.addPaperManually(validManualData(), {
        targetProjectIds: ["proj-1"],
        targetTagIds: ["tag-1"],
      });
    });

    expect(returnValue).toBe(true);
    expect(mockRpc).toHaveBeenCalledWith(
      "set_paper_projects",
      expect.objectContaining({ p_paper_id: "new-paper-id", p_project_ids: ["proj-1"] }),
    );
    expect(mockRpc).toHaveBeenCalledWith(
      "set_paper_tags",
      expect.objectContaining({ p_paper_id: "new-paper-id", p_tag_ids: ["tag-1"] }),
    );
    expect(mockInvalidateAndRefetch).toHaveBeenCalled();
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Paper added manually" }));
    // No "Paper added with warnings" toast on the full-success path.
    expect(mockToast).not.toHaveBeenCalledWith(expect.objectContaining({ title: "Paper added with warnings" }));
  });

  it("returns true and shows a warning toast when only project assignment fails", async () => {
    // First RPC (`set_paper_projects`) fails; second (`set_paper_tags`) succeeds.
    mockRpc
      .mockResolvedValueOnce({ error: { message: "project RPC failed" } })
      .mockResolvedValueOnce({ error: null });

    const { result } = renderHook(() =>
      usePaperMutations(userId, emptyPapers, emptyProjects, emptyTags, undefined, emptyFilters, emptySort)
    );

    let returnValue: boolean | undefined;
    await act(async () => {
      returnValue = await result.current.addPaperManually(validManualData(), {
        targetProjectIds: ["proj-1"],
        targetTagIds: ["tag-1"],
      });
    });

    expect(returnValue).toBe(true);
    expect(mockInvalidateAndRefetch).toHaveBeenCalled();
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({
      title: "Paper added with warnings",
      description: expect.stringContaining("project assignment failed"),
      variant: "destructive",
    }));
    // The warning must NOT mention tag — tag succeeded.
    const warningCalls = mockToast.mock.calls.filter(
      (c: unknown[]) => (c[0] as { title?: string })?.title === "Paper added with warnings",
    );
    expect(warningCalls).toHaveLength(1);
    // The variable failure label must not mention tags. The static suffix
    // ("you may need to assign the project/tag manually") intentionally
    // names both, so we assert against the specific failure phrase, not
    // the substring "tag" in isolation.
    expect((warningCalls[0][0] as { description: string }).description).not.toContain("tag assignment failed");
    // The normal success toast must NOT fire on partial-success paths.
    expect(mockToast).not.toHaveBeenCalledWith(expect.objectContaining({ title: "Paper added manually" }));
  });

  it("returns true and shows a warning toast when only tag assignment fails", async () => {
    // First RPC (`set_paper_projects`) succeeds; second (`set_paper_tags`) fails.
    mockRpc
      .mockResolvedValueOnce({ error: null })
      .mockResolvedValueOnce({ error: { message: "tag RPC failed" } });

    const { result } = renderHook(() =>
      usePaperMutations(userId, emptyPapers, emptyProjects, emptyTags, undefined, emptyFilters, emptySort)
    );

    let returnValue: boolean | undefined;
    await act(async () => {
      returnValue = await result.current.addPaperManually(validManualData(), {
        targetProjectIds: ["proj-1"],
        targetTagIds: ["tag-1"],
      });
    });

    expect(returnValue).toBe(true);
    expect(mockInvalidateAndRefetch).toHaveBeenCalled();
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({
      title: "Paper added with warnings",
      description: expect.stringContaining("tag assignment failed"),
      variant: "destructive",
    }));
    const warningCalls = mockToast.mock.calls.filter(
      (c: unknown[]) => (c[0] as { title?: string })?.title === "Paper added with warnings",
    );
    expect(warningCalls).toHaveLength(1);
    // The variable failure label must not mention project. The static
    // suffix names both for user guidance; assert against the specific
    // failure phrase.
    expect((warningCalls[0][0] as { description: string }).description).not.toContain("project assignment failed");
    expect(mockToast).not.toHaveBeenCalledWith(expect.objectContaining({ title: "Paper added manually" }));
  });

  it("returns true and shows a warning toast mentioning both when both assignments fail", async () => {
    mockRpc
      .mockResolvedValueOnce({ error: { message: "project RPC failed" } })
      .mockResolvedValueOnce({ error: { message: "tag RPC failed" } });

    const { result } = renderHook(() =>
      usePaperMutations(userId, emptyPapers, emptyProjects, emptyTags, undefined, emptyFilters, emptySort)
    );

    let returnValue: boolean | undefined;
    await act(async () => {
      returnValue = await result.current.addPaperManually(validManualData(), {
        targetProjectIds: ["proj-1"],
        targetTagIds: ["tag-1"],
      });
    });

    expect(returnValue).toBe(true);
    expect(mockInvalidateAndRefetch).toHaveBeenCalled();
    const warningCalls = mockToast.mock.calls.filter(
      (c: unknown[]) => (c[0] as { title?: string })?.title === "Paper added with warnings",
    );
    expect(warningCalls).toHaveLength(1);
    const description = (warningCalls[0][0] as { description: string }).description;
    expect(description).toContain("project assignment failed");
    expect(description).toContain("tag assignment failed");
    expect((warningCalls[0][0] as { variant: string }).variant).toBe("destructive");
    expect(mockToast).not.toHaveBeenCalledWith(expect.objectContaining({ title: "Paper added manually" }));
  });

  it("does not call assignment RPCs and shows normal success toast when no assignments requested", async () => {
    const { result } = renderHook(() =>
      usePaperMutations(userId, emptyPapers, emptyProjects, emptyTags, undefined, emptyFilters, emptySort)
    );

    let returnValue: boolean | undefined;
    await act(async () => {
      returnValue = await result.current.addPaperManually(validManualData());
    });

    expect(returnValue).toBe(true);
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Paper added manually" }));
    expect(mockToast).not.toHaveBeenCalledWith(expect.objectContaining({ title: "Paper added with warnings" }));
  });
});

// ── updatePaper return-value contract ─────────────────────────────────
//
// These tests lock in the contract that drives the Edit Paper dialog's
// "stay open on failure" UX. `EditPaperDialog.handleSave` reads this
// boolean and only calls `onOpenChange(false)` when it is `true`, so the
// dialog closes after a real success and preserves the edited form values
// on every handled failure path. Tests intentionally do not assert on the
// success toast title or cache-helper invocations except where they are
// the contractual signal (rollback on each failure).

describe("usePaperMutations – updatePaper return value", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: paper-row UPDATE succeeds. Individual tests override.
    mockUpdateResolve.mockResolvedValue({ error: null });
    // Default: every RPC succeeds. Individual tests override.
    mockRpc.mockResolvedValue({ error: null });
  });

  it("returns false when userId is undefined", async () => {
    const { result } = renderHook(() =>
      usePaperMutations(undefined, emptyPapers, emptyProjects, emptyTags, undefined, emptyFilters, emptySort)
    );

    let returnValue: boolean | undefined;
    await act(async () => {
      returnValue = await result.current.updatePaper("paper-1", { title: "x" });
    });

    expect(returnValue).toBe(false);
    // No DB writes should have happened.
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("returns true on successful field-only update", async () => {
    const { result } = renderHook(() =>
      usePaperMutations(userId, emptyPapers, emptyProjects, emptyTags, undefined, emptyFilters, emptySort)
    );

    let returnValue: boolean | undefined;
    await act(async () => {
      returnValue = await result.current.updatePaper("paper-1", { title: "Edited" });
    });

    expect(returnValue).toBe(true);
    expect(mockUpdate).toHaveBeenCalledWith({ title: "Edited" });
    expect(mockRollbackCache).not.toHaveBeenCalled();
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Paper updated" }));
  });

  it("returns false and rolls back when the papers row UPDATE fails", async () => {
    mockUpdateResolve.mockResolvedValueOnce({ error: { message: "DB update failed" } });

    const { result } = renderHook(() =>
      usePaperMutations(userId, emptyPapers, emptyProjects, emptyTags, undefined, emptyFilters, emptySort)
    );

    let returnValue: boolean | undefined;
    await act(async () => {
      returnValue = await result.current.updatePaper("paper-1", { title: "Edited" });
    });

    expect(returnValue).toBe(false);
    expect(mockRollbackCache).toHaveBeenCalledTimes(1);
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Error updating paper" }));
    // No subsequent RPCs should have fired after the row UPDATE failed.
    expect(mockRpc).not.toHaveBeenCalled();
    // The success toast must NOT fire.
    expect(mockToast).not.toHaveBeenCalledWith(expect.objectContaining({ title: "Paper updated" }));
  });

  it("returns false and rolls back when set_paper_tags fails", async () => {
    // First RPC call (`set_paper_tags`) fails; second (`set_paper_projects`) would have succeeded but must not be reached.
    mockRpc.mockResolvedValueOnce({ error: { message: "tag RPC failed" } });

    const { result } = renderHook(() =>
      usePaperMutations(userId, emptyPapers, emptyProjects, emptyTags, undefined, emptyFilters, emptySort)
    );

    let returnValue: boolean | undefined;
    await act(async () => {
      returnValue = await result.current.updatePaper("paper-1", {
        title: "Edited",
        tagIds: ["t1"],
        projectIds: ["p1"],
      });
    });

    expect(returnValue).toBe(false);
    expect(mockRollbackCache).toHaveBeenCalledTimes(1);
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Error updating tags" }));
    // set_paper_projects must not have been called after the tag failure.
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledWith("set_paper_tags", expect.any(Object));
    // Success toast must NOT fire.
    expect(mockToast).not.toHaveBeenCalledWith(expect.objectContaining({ title: "Paper updated" }));
  });

  it("returns false and rolls back when set_paper_projects fails", async () => {
    // First RPC (`set_paper_tags`) succeeds; second (`set_paper_projects`) fails.
    mockRpc
      .mockResolvedValueOnce({ error: null })
      .mockResolvedValueOnce({ error: { message: "project RPC failed" } });

    const { result } = renderHook(() =>
      usePaperMutations(userId, emptyPapers, emptyProjects, emptyTags, undefined, emptyFilters, emptySort)
    );

    let returnValue: boolean | undefined;
    await act(async () => {
      returnValue = await result.current.updatePaper("paper-1", {
        title: "Edited",
        tagIds: ["t1"],
        projectIds: ["p1"],
      });
    });

    expect(returnValue).toBe(false);
    expect(mockRollbackCache).toHaveBeenCalledTimes(1);
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Error updating projects" }));
    expect(mockRpc).toHaveBeenCalledTimes(2);
    // Success toast must NOT fire.
    expect(mockToast).not.toHaveBeenCalledWith(expect.objectContaining({ title: "Paper updated" }));
  });

  it("returns true when no field changes but tag+project assignments succeed", async () => {
    const { result } = renderHook(() =>
      usePaperMutations(userId, emptyPapers, emptyProjects, emptyTags, undefined, emptyFilters, emptySort)
    );

    let returnValue: boolean | undefined;
    await act(async () => {
      returnValue = await result.current.updatePaper("paper-1", {
        tagIds: ["t1"],
        projectIds: ["p1"],
      });
    });

    expect(returnValue).toBe(true);
    // No papers row UPDATE should have happened (empty paperUpdates).
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockRpc).toHaveBeenCalledWith("set_paper_tags", expect.any(Object));
    expect(mockRpc).toHaveBeenCalledWith("set_paper_projects", expect.any(Object));
    expect(mockRollbackCache).not.toHaveBeenCalled();
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Paper updated" }));
  });
});
