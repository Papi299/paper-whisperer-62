import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// ── Supabase mock (hoisted) ───────────────────────────────────────────
//
// `mockFrom` returns a builder that exposes:
//   • `insert(...)`  — used by `addPaperManually` for the row-create call.
//   • `update(...)`  — used by `updatePaper` for the row-edit call. The
//     `update(...).eq(...)` chain resolves to `mockUpdateResolve`, default
//     success; individual tests override with `mockResolvedValueOnce`.
//   • `select(...)`  — used by `addPaperManually` for the duplicate-PMID
//     and duplicate-DOI preflight queries. The chain is
//     `from("papers").select("id").eq("user_id", …).eq("pmid"|"doi", …)
//     .limit(1).maybeSingle()`. `mockPreflightMaybeSingle` is the
//     leaf that returns the result; `mockPreflightSecondEq` is the
//     field-specific `.eq()` whose `.mock.calls` lets tests assert the
//     field name + value (so we can verify DOI normalization and that
//     the right identifier was queried).
// `mockRpc` is used for both `set_paper_tags` and `set_paper_projects`;
// tests override its per-call return as needed.
const {
  mockInsert,
  mockSelect,
  mockSingle,
  mockFrom,
  mockRpc,
  mockUpdate,
  mockUpdateEq,
  mockUpdateResolve,
  mockPreflightTopSelect,
  mockPreflightFirstEq,
  mockPreflightSecondEq,
  mockPreflightLimit,
  mockPreflightMaybeSingle,
} = vi.hoisted(() => {
  const mockSingle = vi.fn();
  const mockSelect = vi.fn(() => ({ single: mockSingle }));
  const mockInsert = vi.fn(() => ({ select: mockSelect }));
  const mockRpc = vi.fn();
  const mockUpdateResolve = vi.fn();
  const mockUpdateEq = vi.fn(() => mockUpdateResolve());
  const mockUpdate = vi.fn(() => ({ eq: mockUpdateEq }));

  // Preflight chain: from("papers").select("id").eq().eq().limit(1).maybeSingle()
  const mockPreflightMaybeSingle = vi.fn();
  const mockPreflightLimit = vi.fn(() => ({ maybeSingle: mockPreflightMaybeSingle }));
  const mockPreflightSecondEq = vi.fn(() => ({ limit: mockPreflightLimit }));
  const mockPreflightFirstEq = vi.fn(() => ({ eq: mockPreflightSecondEq }));
  const mockPreflightTopSelect = vi.fn(() => ({ eq: mockPreflightFirstEq }));

  const mockFrom = vi.fn(() => ({
    insert: mockInsert,
    update: mockUpdate,
    select: mockPreflightTopSelect,
  }));
  return {
    mockInsert,
    mockSelect,
    mockSingle,
    mockFrom,
    mockRpc,
    mockUpdate,
    mockUpdateEq,
    mockUpdateResolve,
    mockPreflightTopSelect,
    mockPreflightFirstEq,
    mockPreflightSecondEq,
    mockPreflightLimit,
    mockPreflightMaybeSingle,
  };
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
    // Default: server-side duplicate preflight returns "no match" so the
    // tests below reach their intended branch (insert / validation /
    // duplicate-key). Tests that exercise a preflight hit or preflight
    // failure override with `mockResolvedValueOnce`.
    mockPreflightMaybeSingle.mockResolvedValue({ data: null, error: null });
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

  it("returns false for duplicate paper (matching PMID) — via server-side preflight", async () => {
    // After the manual-add server-side duplicate-detection fix, the
    // duplicate is caught by the per-user PMID preflight query against
    // `papers`, NOT by scanning the loaded-papers array. We pass
    // `emptyPapers` to the hook to demonstrate that the preflight works
    // even when the duplicate is OUTSIDE the current page / filter.
    mockPreflightMaybeSingle.mockResolvedValueOnce({ data: { id: "existing-paper-id" }, error: null });

    const { result } = renderHook(() =>
      usePaperMutations(userId, emptyPapers, emptyProjects, emptyTags, undefined, emptyFilters, emptySort)
    );

    let returnValue: boolean | undefined;
    await act(async () => {
      returnValue = await result.current.addPaperManually(validManualData());
    });

    expect(returnValue).toBe(false);
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Duplicate paper" }));
    // The PMID-preflight `.eq()` was called with the user-supplied PMID.
    expect(mockPreflightSecondEq).toHaveBeenCalledWith("pmid", "12345678");
    // Insert was NOT attempted.
    expect(mockInsert).not.toHaveBeenCalled();
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

// ── addPaperManually server-side duplicate preflight ──────────────────
//
// These tests lock in the fix that replaces the old client-side
// `papers.some(...)` duplicate check (which scanned only the currently
// loaded/paginated/filtered `papers` array and additionally hard-blocked
// on exact title match — both wrong) with two narrow `.maybeSingle()`
// queries against `papers` scoped to the current user via PMID and
// (normalized) DOI. The preflight is sequential (PMID first, bail on
// hit) and is a UX improvement only — the DB partial unique indexes
// `idx_papers_user_pmid_unique` / `idx_papers_user_doi_unique
// (user_id, lower(doi))` plus the post-insert `23505` branch remain the
// data-integrity backstop and are exercised by the separate
// `returns false on duplicate key constraint (23505)` test above.

describe("usePaperMutations – addPaperManually server-side duplicate preflight", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: every preflight call returns "no match" so insert is reached
    // by tests that don't explicitly configure a hit.
    mockPreflightMaybeSingle.mockResolvedValue({ data: null, error: null });
    // Default: insert succeeds so success-path tests reach `return true`.
    mockSingle.mockResolvedValue({ data: { id: "new-paper-id" }, error: null });
    // Default: no RPC errors on the (unused-here) assignment path.
    mockRpc.mockResolvedValue({ error: null });
  });

  it("catches a server-side PMID duplicate even when the duplicate is NOT in the loaded papers array", async () => {
    // Loaded papers is empty — the old client-side check would have missed
    // this duplicate. The preflight (sequential: PMID first) now catches it.
    mockPreflightMaybeSingle.mockResolvedValueOnce({ data: { id: "existing-id" }, error: null });

    const { result } = renderHook(() =>
      usePaperMutations(userId, emptyPapers, emptyProjects, emptyTags, undefined, emptyFilters, emptySort)
    );

    let returnValue: boolean | undefined;
    await act(async () => {
      returnValue = await result.current.addPaperManually(validManualData());
    });

    expect(returnValue).toBe(false);
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({
      title: "Duplicate paper",
      variant: "destructive",
    }));
    expect(mockPreflightSecondEq).toHaveBeenCalledWith("pmid", "12345678");
    expect(mockInsert).not.toHaveBeenCalled();
    // DOI preflight must NOT have run — PMID match short-circuits.
    expect(mockPreflightSecondEq).not.toHaveBeenCalledWith("doi", expect.anything());
  });

  it("catches a server-side DOI duplicate when PMID preflight returned no match", async () => {
    // PMID preflight: no match. DOI preflight: hit.
    mockPreflightMaybeSingle
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: { id: "existing-id" }, error: null });

    const { result } = renderHook(() =>
      usePaperMutations(userId, emptyPapers, emptyProjects, emptyTags, undefined, emptyFilters, emptySort)
    );

    let returnValue: boolean | undefined;
    await act(async () => {
      returnValue = await result.current.addPaperManually(validManualData());
    });

    expect(returnValue).toBe(false);
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({
      title: "Duplicate paper",
      variant: "destructive",
    }));
    expect(mockPreflightSecondEq).toHaveBeenCalledWith("pmid", "12345678");
    expect(mockPreflightSecondEq).toHaveBeenCalledWith("doi", "10.1234/test");
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("normalizes the DOI before preflight (strips `https://doi.org/` and lowercases)", async () => {
    const data = { ...validManualData(), pmid: "", doi: "https://doi.org/10.1234/FOO" };

    const { result } = renderHook(() =>
      usePaperMutations(userId, emptyPapers, emptyProjects, emptyTags, undefined, emptyFilters, emptySort)
    );

    await act(async () => {
      await result.current.addPaperManually(data);
    });

    // PMID preflight should NOT have run (empty PMID). DOI preflight should
    // have been called with the normalized form: lowercased and stripped of
    // the `https://doi.org/` prefix — matching the storage form behind the
    // per-user partial unique index `idx_papers_user_doi_unique
    // (user_id, lower(doi))`.
    expect(mockPreflightSecondEq).toHaveBeenCalledWith("doi", "10.1234/foo");
    expect(mockPreflightSecondEq).not.toHaveBeenCalledWith("pmid", expect.anything());
  });

  it("does not run any preflight when neither PMID nor DOI is provided", async () => {
    const data = { ...validManualData(), pmid: "", doi: "" };

    const { result } = renderHook(() =>
      usePaperMutations(userId, emptyPapers, emptyProjects, emptyTags, undefined, emptyFilters, emptySort)
    );

    let returnValue: boolean | undefined;
    await act(async () => {
      returnValue = await result.current.addPaperManually(data);
    });

    expect(returnValue).toBe(true);
    // Preflight `.maybeSingle()` must NOT have been called at all.
    expect(mockPreflightMaybeSingle).not.toHaveBeenCalled();
    // Insert proceeds normally.
    expect(mockInsert).toHaveBeenCalled();
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Paper added manually" }));
  });

  it("proceeds to insert when the preflight returns no match for either identifier", async () => {
    const { result } = renderHook(() =>
      usePaperMutations(userId, emptyPapers, emptyProjects, emptyTags, undefined, emptyFilters, emptySort)
    );

    let returnValue: boolean | undefined;
    await act(async () => {
      returnValue = await result.current.addPaperManually(validManualData());
    });

    expect(returnValue).toBe(true);
    expect(mockPreflightMaybeSingle).toHaveBeenCalledTimes(2); // PMID + DOI
    expect(mockInsert).toHaveBeenCalled();
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Paper added manually" }));
  });

  it("returns false with a destructive error toast when the PMID preflight query itself fails", async () => {
    mockPreflightMaybeSingle.mockResolvedValueOnce({ data: null, error: { message: "network error" } });

    const { result } = renderHook(() =>
      usePaperMutations(userId, emptyPapers, emptyProjects, emptyTags, undefined, emptyFilters, emptySort)
    );

    let returnValue: boolean | undefined;
    await act(async () => {
      returnValue = await result.current.addPaperManually(validManualData());
    });

    expect(returnValue).toBe(false);
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({
      title: "Could not check for duplicates",
      variant: "destructive",
    }));
    // Must not proceed to insert.
    expect(mockInsert).not.toHaveBeenCalled();
    // DOI preflight must not run after the PMID preflight errored.
    expect(mockPreflightSecondEq).not.toHaveBeenCalledWith("doi", expect.anything());
  });

  it("returns false with a destructive error toast when the DOI preflight query itself fails", async () => {
    mockPreflightMaybeSingle
      .mockResolvedValueOnce({ data: null, error: null }) // PMID preflight: ok / no match
      .mockResolvedValueOnce({ data: null, error: { message: "network error" } }); // DOI preflight: errored

    const { result } = renderHook(() =>
      usePaperMutations(userId, emptyPapers, emptyProjects, emptyTags, undefined, emptyFilters, emptySort)
    );

    let returnValue: boolean | undefined;
    await act(async () => {
      returnValue = await result.current.addPaperManually(validManualData());
    });

    expect(returnValue).toBe(false);
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({
      title: "Could not check for duplicates",
      variant: "destructive",
    }));
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("does NOT block on title-only match — PMID/DOI-only dedup policy", async () => {
    // Regression for the fix that removed the title-based hard block that
    // contradicted the PMID/DOI-only duplicate-detection policy documented
    // in `docs/start-here.md` (Standing product decisions). The loaded
    // papers array contains a paper with the EXACT same title as the input,
    // but the preflight (which only checks PMID + DOI) returns no match —
    // so insert must proceed.
    const sameTitlePaper = {
      id: "p1",
      pmid: "99999999", // different PMID
      doi: "10.9999/other", // different DOI
      title: "A Great Paper", // SAME title as validManualData().title
      tags: [],
      projects: [],
    } as unknown as PaperWithTags;

    const { result } = renderHook(() =>
      usePaperMutations(userId, [sameTitlePaper], emptyProjects, emptyTags, undefined, emptyFilters, emptySort)
    );

    let returnValue: boolean | undefined;
    await act(async () => {
      returnValue = await result.current.addPaperManually(validManualData());
    });

    expect(returnValue).toBe(true);
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Paper added manually" }));
    expect(mockToast).not.toHaveBeenCalledWith(expect.objectContaining({ title: "Duplicate paper" }));
    expect(mockInsert).toHaveBeenCalled();
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
