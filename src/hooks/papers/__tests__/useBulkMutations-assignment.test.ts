import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// ── Supabase mock (hoisted) ───────────────────────────────────────────
// The bulk-delete path (`bulkDeletePapers`) chains
// `.from("papers").delete().in("id", paperIds).eq("user_id", userId)`
// after the S2 bulk-delete hardening, so the `delete()` mock must expose
// a recordable `in().eq()` chain. The hoisted `mockDeleteIn` and
// `mockDeleteInEq` spies are asserted against in the bulk-delete
// describe block below. The attachments `select("file_path").in(...)`
// pre-delete read is mocked via a separate `mockAttachmentsSelectIn`
// returning `{ data: [], error: null }` so the storage-cleanup branch
// is skipped (no storage paths).
const {
  mockRpc,
  mockFrom,
  mockDeleteIn,
  mockDeleteInEq,
  mockAttachmentsSelectIn,
} = vi.hoisted(() => {
  const mockRpc = vi.fn();
  const mockDeleteInEq = vi.fn().mockResolvedValue({ error: null });
  const mockDeleteIn = vi.fn(() => ({ eq: mockDeleteInEq }));
  const mockAttachmentsSelectIn = vi
    .fn()
    .mockResolvedValue({ data: [], error: null });
  const mockFrom = vi.fn((table: string) => {
    if (table === "papers") {
      return {
        insert: vi.fn(() => ({ select: vi.fn(() => ({ single: vi.fn() })) })),
        delete: vi.fn(() => ({ in: mockDeleteIn })),
        select: vi.fn(() => ({ eq: vi.fn() })),
      };
    }
    if (table === "paper_attachments") {
      return {
        select: vi.fn(() => ({ in: mockAttachmentsSelectIn })),
      };
    }
    return {
      insert: vi.fn(() => ({ select: vi.fn(() => ({ single: vi.fn() })) })),
      delete: vi.fn(() => ({ in: vi.fn() })),
      select: vi.fn(() => ({ eq: vi.fn() })),
    };
  });
  return { mockRpc, mockFrom, mockDeleteIn, mockDeleteInEq, mockAttachmentsSelectIn };
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

describe("useBulkMutations – bulkDeletePapers explicit user_id scoping (S2 defense-in-depth)", () => {
  // Regression coverage for the S2 bulk-delete hardening — sibling to
  // the PR #133 single-row `usePaperMutations.deletePaper` test that
  // asserts `(\"id\", paperId)` AND `(\"user_id\", userId)` are both on
  // the `.eq` chain. Here the chain shape is `.delete().in(\"id\",
  // paperIds).eq(\"user_id\", userId)` — assert the trailing `.eq` is
  // called exactly once with the user-scoping predicate.

  beforeEach(() => {
    vi.clearAllMocks();
    mockDeleteInEq.mockResolvedValue({ error: null });
    mockAttachmentsSelectIn.mockResolvedValue({ data: [], error: null });
  });

  it("scopes the bulk delete by both row ids AND user_id (defense-in-depth on top of RLS)", async () => {
    const paperIds = ["paper-1", "paper-2", "paper-3"];

    const { result } = renderBulkHook();

    await act(async () => {
      await result.current.bulkDeletePapers(paperIds);
    });

    // The `.in(...)` predicate carries the row ids …
    expect(mockDeleteIn).toHaveBeenCalledWith("id", paperIds);
    expect(mockDeleteIn).toHaveBeenCalledTimes(1);
    // … and the trailing `.eq(...)` carries the user-scoping predicate
    // exactly once. RLS would already protect the row set; this filter
    // makes the ownership intent visible at the call site.
    expect(mockDeleteInEq).toHaveBeenCalledWith("user_id", userId);
    expect(mockDeleteInEq).toHaveBeenCalledTimes(1);

    // Success toast (no destructive variant) — confirms the chain
    // resolved without taking the error branch.
    const deleteToastCall = mockToast.mock.calls.find(
      (c: unknown[]) =>
        typeof (c[0] as { title?: string }).title === "string" &&
        (c[0] as { title: string }).title.startsWith("Deleted "),
    );
    expect(deleteToastCall).toBeTruthy();
    expect((deleteToastCall![0] as { variant?: string }).variant).toBeUndefined();
  });
});
