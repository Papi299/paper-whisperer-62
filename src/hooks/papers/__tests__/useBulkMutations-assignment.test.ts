import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// ── Supabase mock (hoisted) ───────────────────────────────────────────
const { mockRpc, mockFrom } = vi.hoisted(() => {
  const mockRpc = vi.fn();
  const mockFrom = vi.fn(() => ({
    insert: vi.fn(() => ({ select: vi.fn(() => ({ single: vi.fn() })) })),
    delete: vi.fn(() => ({ in: vi.fn() })),
    select: vi.fn(() => ({ eq: vi.fn() })),
  }));
  return { mockRpc, mockFrom };
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
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

// ── usePaperCacheHelpers mock ─────────────────────────────────────────
const mockInvalidateAndRefetch = vi.fn();
const mockInvalidateJunctionCaches = vi.fn();
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
    invalidateJunctionCaches: mockInvalidateJunctionCaches,
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

// ── fetchPaperMetadata mock ───────────────────────────────────────────
const mockFetchPaperMetadata = vi.fn();
vi.mock("@/lib/fetchPaperMetadataEdge", () => ({
  fetchPaperMetadata: (...args: unknown[]) => mockFetchPaperMetadata(...args),
}));

// ── processChunkedInsert mock ─────────────────────────────────────────
const mockProcessChunkedInsert = vi.fn();
vi.mock("@/lib/chunkedInsert", () => ({
  processChunkedInsert: (...args: unknown[]) => mockProcessChunkedInsert(...args),
}));

import { useBulkMutations } from "../useBulkMutations";
import type { PaperWithTags, Project, Tag } from "@/types/database";
import type { ServerFilterParams, ServerSortParams } from "../types";

// ── Test fixtures ─────────────────────────────────────────────────────

const userId = "user-1";
const emptyPapers: PaperWithTags[] = [];
const emptyProjects: Project[] = [];
const emptyTags: Tag[] = [];
const emptyFilters: ServerFilterParams = {};
const emptySort: ServerSortParams = { column: "created_at", direction: "desc" };

function renderBulkHook() {
  return renderHook(() =>
    useBulkMutations(userId, emptyPapers, emptyProjects, emptyTags, undefined, emptyFilters, emptySort)
  );
}

describe("useBulkMutations – assignment failure visibility (bulkImportPapers)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function setupSuccessfulInsert() {
    // fetchPaperMetadata returns one paper
    mockFetchPaperMetadata.mockResolvedValue([
      { identifier: "12345", title: "Test Paper", authors: ["Author"], year: 2024, pmid: "12345", doi: null, abstract: null, keywords: [], mesh_terms: [], substances: [], study_type: null, pubmed_url: null, journal_url: null, journal: null },
    ]);
    // processChunkedInsert returns one inserted result
    mockProcessChunkedInsert.mockResolvedValue({
      results: [{ index: 0, id: "paper-id-1", status: "inserted" }],
      lastError: null,
    });
  }

  it("shows normal success toast when assignments succeed", async () => {
    setupSuccessfulInsert();
    mockRpc.mockResolvedValue({ data: null, error: null });

    const { result } = renderBulkHook();

    await act(async () => {
      await result.current.bulkImportPapers(["12345"], undefined, {
        targetProjectIds: ["proj-1"],
        targetTagIds: ["tag-1"],
      });
    });

    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Bulk import complete",
        description: expect.stringContaining("1 added"),
      })
    );
    // Should NOT have destructive variant
    const toastCall = mockToast.mock.calls.find((c: unknown[]) => (c[0] as { title: string }).title === "Bulk import complete");
    expect(toastCall).toBeTruthy();
    expect((toastCall![0] as { variant?: string }).variant).toBeUndefined();
  });

  it("shows warning toast when project assignment fails", async () => {
    setupSuccessfulInsert();
    // Project RPC fails, tag RPC succeeds
    mockRpc
      .mockResolvedValueOnce({ data: null, error: { message: "RPC error" } }) // bulk_set_paper_projects
      .mockResolvedValueOnce({ data: null, error: null }); // bulk_set_paper_tags

    const { result } = renderBulkHook();

    await act(async () => {
      await result.current.bulkImportPapers(["12345"], undefined, {
        targetProjectIds: ["proj-1"],
        targetTagIds: ["tag-1"],
      });
    });

    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Bulk import complete with warnings",
        description: expect.stringContaining("project assignment failed"),
        variant: "destructive",
      })
    );
    // Papers should still be counted as added
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({
        description: expect.stringContaining("1 added"),
      })
    );
  });

  it("shows warning toast when tag assignment fails", async () => {
    setupSuccessfulInsert();
    // Project RPC succeeds, tag RPC fails
    mockRpc
      .mockResolvedValueOnce({ data: null, error: null }) // bulk_set_paper_projects
      .mockResolvedValueOnce({ data: null, error: { message: "RPC error" } }); // bulk_set_paper_tags

    const { result } = renderBulkHook();

    await act(async () => {
      await result.current.bulkImportPapers(["12345"], undefined, {
        targetProjectIds: ["proj-1"],
        targetTagIds: ["tag-1"],
      });
    });

    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Bulk import complete with warnings",
        description: expect.stringContaining("tag assignment failed"),
        variant: "destructive",
      })
    );
  });

  it("shows warning toast when both assignments fail", async () => {
    setupSuccessfulInsert();
    mockRpc.mockResolvedValue({ data: null, error: { message: "RPC error" } });

    const { result } = renderBulkHook();

    await act(async () => {
      await result.current.bulkImportPapers(["12345"], undefined, {
        targetProjectIds: ["proj-1"],
        targetTagIds: ["tag-1"],
      });
    });

    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Bulk import complete with warnings",
        description: expect.stringMatching(/project assignment failed.*tag assignment failed/),
        variant: "destructive",
      })
    );
  });

  it("still invalidates cache even when assignment fails", async () => {
    setupSuccessfulInsert();
    mockRpc.mockResolvedValue({ data: null, error: { message: "RPC error" } });

    const { result } = renderBulkHook();

    await act(async () => {
      await result.current.bulkImportPapers(["12345"], undefined, {
        targetProjectIds: ["proj-1"],
      });
    });

    expect(mockInvalidateAndRefetch).toHaveBeenCalled();
  });
});

describe("useBulkMutations – assignment failure visibility (bulkImportFromParsedData)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const parsedPaper = {
    title: "Test Paper",
    authors: ["Author"],
    year: 2024,
    journal: null,
    pmid: "12345",
    doi: null,
    abstract: null,
    keywords: [],
    mesh_terms: [],
    substances: [],
    study_type: null,
    pubmed_url: null,
    journal_url: null,
    drive_url: null,
  };

  function setupSuccessfulFileInsert() {
    mockProcessChunkedInsert.mockResolvedValue({
      results: [{ index: 0, id: "paper-id-1", status: "inserted" }],
      lastError: null,
    });
  }

  it("shows normal success toast when file import assignments succeed", async () => {
    setupSuccessfulFileInsert();
    mockRpc.mockResolvedValue({ data: null, error: null });

    const { result } = renderBulkHook();

    await act(async () => {
      await result.current.bulkImportFromParsedData([parsedPaper], undefined, {
        targetProjectIds: ["proj-1"],
      });
    });

    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "File import complete",
      })
    );
  });

  it("shows warning toast when file import project assignment fails", async () => {
    setupSuccessfulFileInsert();
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: "RPC error" } });

    const { result } = renderBulkHook();

    await act(async () => {
      await result.current.bulkImportFromParsedData([parsedPaper], undefined, {
        targetProjectIds: ["proj-1"],
      });
    });

    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "File import complete with warnings",
        description: expect.stringContaining("project assignment failed"),
        variant: "destructive",
      })
    );
    // Papers still counted as added
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({
        description: expect.stringContaining("1 added"),
      })
    );
  });

  it("shows warning toast when file import tag assignment fails", async () => {
    setupSuccessfulFileInsert();
    mockRpc
      .mockResolvedValueOnce({ data: null, error: null }) // projects
      .mockResolvedValueOnce({ data: null, error: { message: "RPC error" } }); // tags

    const { result } = renderBulkHook();

    await act(async () => {
      await result.current.bulkImportFromParsedData([parsedPaper], undefined, {
        targetProjectIds: ["proj-1"],
        targetTagIds: ["tag-1"],
      });
    });

    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "File import complete with warnings",
        description: expect.stringContaining("tag assignment failed"),
        variant: "destructive",
      })
    );
  });
});
