import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// ── Supabase mock (hoisted) ───────────────────────────────────────────
const { mockInsert, mockSelect, mockSingle, mockFrom, mockRpc } = vi.hoisted(() => {
  const mockSingle = vi.fn();
  const mockSelect = vi.fn(() => ({ single: mockSingle }));
  const mockInsert = vi.fn(() => ({ select: mockSelect }));
  const mockRpc = vi.fn();
  const mockFrom = vi.fn(() => ({ insert: mockInsert }));
  return { mockInsert, mockSelect, mockSingle, mockFrom, mockRpc };
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
const mockInvalidateAndRefetch = vi.fn();
vi.mock("../usePaperCacheHelpers", () => ({
  usePaperCacheHelpers: () => ({
    snapshotCache: vi.fn(() => ({})),
    rollbackCache: vi.fn(),
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
