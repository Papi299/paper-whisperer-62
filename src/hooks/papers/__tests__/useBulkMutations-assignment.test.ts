import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// ── Supabase mock (hoisted) ───────────────────────────────────────────
// Since ATTACHMENT-ORPHAN-CLEANUP-HARDENING-001 the bulk-delete path deletes
// through `delete_papers_with_attachment_cleanup` and then drains
// `attachment_cleanup_queue`. The direct
// `.from("papers").delete().in("id", paperIds).eq("user_id", userId)` chain is
// still mocked because it is what the PRE-MIGRATION compatibility path uses, and
// the S2 scoping test below now exercises it through that path — where the
// predicate still has to be right. `mockAttachmentsSelectIn` serves the
// compatibility path's pre-delete `select("file_path").in(...)` read; the
// cleanup-queue chain resolves to an empty page so Storage is never called.
const {
  mockRpc,
  mockFrom,
  mockDeleteIn,
  mockDeleteInEq,
  mockAttachmentsSelectIn,
  mockStorageRemove,
} = vi.hoisted(() => {
  const mockRpc = vi.fn();
  const mockDeleteInEq = vi.fn().mockResolvedValue({ error: null });
  const mockDeleteIn = vi.fn(() => ({ eq: mockDeleteInEq }));
  const mockAttachmentsSelectIn = vi
    .fn()
    .mockResolvedValue({ data: [], error: null });
  const mockStorageRemove = vi.fn().mockResolvedValue({ data: null, error: null });
  const cleanupQueueChain = () => {
    const chain = {
      select: vi.fn(() => chain),
      eq: vi.fn(() => chain),
      order: vi.fn(() => chain),
      range: vi.fn(async () => ({ data: [] as unknown[], error: null })),
      delete: vi.fn(() => chain),
      in: vi.fn(async () => ({ error: null })),
    };
    return chain;
  };
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
    if (table === "attachment_cleanup_queue") {
      return cleanupQueueChain();
    }
    return {
      insert: vi.fn(() => ({ select: vi.fn(() => ({ single: vi.fn() })) })),
      delete: vi.fn(() => ({ in: vi.fn() })),
      select: vi.fn(() => ({ eq: vi.fn() })),
    };
  });
  return {
    mockRpc,
    mockFrom,
    mockDeleteIn,
    mockDeleteInEq,
    mockAttachmentsSelectIn,
    mockStorageRemove,
  };
});

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: mockFrom,
    rpc: mockRpc,
    storage: { from: () => ({ remove: mockStorageRemove }) },
  },
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
import { resetAttachmentCleanupAvailabilityForTests } from "@/lib/attachmentCleanupAvailability";
import type { PaperWithTags, Project, Tag } from "@/types/database";
import type { ServerFilterParams, ServerSortParams } from "../types";

// ── Test fixtures ─────────────────────────────────────────────────────

const userId = "user-1";
const emptyPapers: PaperWithTags[] = [];
const emptyProjects: Project[] = [];
const emptyTags: Tag[] = [];
const emptyFilters: ServerFilterParams = {
  filterPaperIds: null,
  yearFrom: null,
  yearTo: null,
  studyTypes: null,
  notesPresence: "all",
};
const emptySort: ServerSortParams = { sortColumn: null, sortAscending: null };

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
  // Regression coverage for the S2 bulk-delete hardening. Since
  // ATTACHMENT-ORPHAN-CLEANUP-HARDENING-001 the ownership check that matters on
  // the primary path lives SERVER-side — `delete_papers_with_attachment_cleanup`
  // validates every id against `auth.uid()` before mutating anything, which is
  // strictly stronger than a client predicate and is pinned by
  // supabase/tests/database/014_attachment_cleanup_recovery.test.sql.
  //
  // The client-side `.in("id", …).eq("user_id", …)` chain still exists in the
  // pre-migration compatibility path, and this suite keeps asserting it there:
  // that path runs in Production until the migration is applied, so its scoping
  // predicate is not historical.

  beforeEach(() => {
    vi.clearAllMocks();
    // The missing-schema classifier deliberately remembers, for the life of the
    // session, that a cleanup object answered — that is what turns a LATER
    // missing-object error into a visible partial-install failure rather than a
    // silent downgrade. Tests that exercise both the present and the absent
    // schema in one file must therefore start each case from no evidence.
    resetAttachmentCleanupAvailabilityForTests();
    mockDeleteInEq.mockResolvedValue({ error: null });
    mockAttachmentsSelectIn.mockResolvedValue({ data: [], error: null });
  });

  it("deletes through the cleanup RPC, not a direct table delete, when the schema is present", async () => {
    const paperIds = ["paper-1", "paper-2", "paper-3"];
    mockRpc.mockResolvedValue({ data: [{ deleted_count: 3, queued_count: 0 }], error: null });

    const { result } = renderBulkHook();
    await act(async () => {
      await result.current.bulkDeletePapers(paperIds);
    });

    expect(mockRpc).toHaveBeenCalledWith("delete_papers_with_attachment_cleanup", {
      p_paper_ids: paperIds,
    });
    // No direct DELETE at all: the RPC owns both the enqueue and the deletion,
    // and issuing a second one would be a partial, non-atomic duplicate.
    expect(mockDeleteIn).not.toHaveBeenCalled();

    const deleteToastCall = mockToast.mock.calls.find(
      (c: unknown[]) =>
        typeof (c[0] as { title?: string }).title === "string" &&
        (c[0] as { title: string }).title.startsWith("Deleted "),
    );
    expect(deleteToastCall).toBeTruthy();
    expect((deleteToastCall![0] as { variant?: string }).variant).toBeUndefined();
  });

  it("scopes the pre-migration fallback delete by both row ids AND user_id (defense-in-depth on top of RLS)", async () => {
    const paperIds = ["paper-1", "paper-2", "paper-3"];
    // The exact pre-migration answer: PostgREST cannot find the function.
    mockRpc.mockResolvedValue({
      data: null,
      error: {
        code: "PGRST202",
        message: "Could not find the function public.delete_papers_with_attachment_cleanup(p_paper_ids) in the schema cache",
      },
    });

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

    const deleteToastCall = mockToast.mock.calls.find(
      (c: unknown[]) =>
        typeof (c[0] as { title?: string }).title === "string" &&
        (c[0] as { title: string }).title.startsWith("Deleted "),
    );
    expect(deleteToastCall).toBeTruthy();
    expect((deleteToastCall![0] as { variant?: string }).variant).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// CHROME-EXTENSION-IMPORT-001D — deterministic duplicate resolution.
//
// `safe_bulk_insert_papers` may now answer a duplicate with the existing
// paper's id. Everything below is about what the importer is allowed to DO
// with that id, and the two halves that matter are:
//
//   * without the explicit opt-in the id is not acted on at all — Add Papers,
//     PubMed Search and file import must keep behaving exactly as they did;
//   * with the opt-in, assignment goes through the ADDITIVE `bulk_add_*` RPCs
//     and never the replace-all `bulk_set_*`, because the target paper already
//     has a taxonomy that the setter would delete.
//
// The absent-id case is not an edge case here: it is what every database that
// predates migration 20260903180000 returns for every duplicate, so the
// "no id → no additive call" test is the compatibility proof that lets the
// frontend ship before that migration is applied.
// ══════════════════════════════════════════════════════════════════════════

/** Names of the RPCs a run actually invoked, in call order. */
function rpcNames(): string[] {
  return mockRpc.mock.calls.map((c: unknown[]) => c[0] as string);
}

describe("useBulkMutations – resolved-duplicate assignment (bulkImportPapers)", () => {
  const DUPLICATE_PAPER_ID = "existing-paper-id-1";

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchPaperMetadata.mockResolvedValue([
      { identifier: "12345", title: "Test Paper", authors: ["Author"], year: 2024, pmid: "12345", doi: null, abstract: null, keywords: [], mesh_terms: [], substances: [], study_type: null, pubmed_url: null, journal_url: null, journal: null },
    ]);
  });

  /** The RPC answers "duplicate", optionally naming the existing row. */
  function setupDuplicate({ resolved }: { resolved: boolean }) {
    mockProcessChunkedInsert.mockResolvedValue({
      results: [
        resolved
          ? { index: 0, id: DUPLICATE_PAPER_ID, status: "duplicate" }
          : { index: 0, status: "duplicate" },
      ],
      lastError: null,
    });
  }

  it("uses the replace-all setters for a NEWLY INSERTED paper, never the additive pair", async () => {
    // The inserted row owns nothing yet, so "set to exactly this" and "add
    // this" are the same operation — and the reviewed setter path stays.
    mockProcessChunkedInsert.mockResolvedValue({
      results: [{ index: 0, id: "new-paper-id", status: "inserted" }],
      lastError: null,
    });
    mockRpc.mockResolvedValue({ data: null, error: null });

    const { result } = renderBulkHook();
    let outcome: Awaited<ReturnType<typeof result.current.bulkImportPapers>>;

    await act(async () => {
      outcome = await result.current.bulkImportPapers(["12345"], undefined, {
        targetProjectIds: ["proj-1"],
        targetTagIds: ["tag-1"],
        applyAssignmentsToResolvedDuplicates: true,
      });
    });

    expect(mockRpc).toHaveBeenCalledWith("bulk_set_paper_projects", {
      p_paper_ids: ["new-paper-id"],
      p_project_ids: ["proj-1"],
    });
    expect(mockRpc).toHaveBeenCalledWith("bulk_set_paper_tags", {
      p_paper_ids: ["new-paper-id"],
      p_tag_ids: ["tag-1"],
    });
    expect(rpcNames()).not.toContain("bulk_add_paper_projects");
    expect(rpcNames()).not.toContain("bulk_add_paper_tags");

    expect(outcome!.items).toEqual([{ identifier: "12345", status: "inserted" }]);
    expect(outcome!.inserted).toEqual({ projects: "applied", tags: "applied" });
    expect(outcome!.resolvedDuplicates).toEqual({
      projects: "not-requested",
      tags: "not-requested",
    });
  });

  it("ignores a resolved duplicate id entirely when the caller did NOT opt in", async () => {
    // The default path — Add Papers and PubMed Search. The id is present in the
    // RPC response and must change nothing about what this run does or reports.
    setupDuplicate({ resolved: true });
    mockRpc.mockResolvedValue({ data: null, error: null });

    const { result } = renderBulkHook();
    let outcome: Awaited<ReturnType<typeof result.current.bulkImportPapers>>;

    await act(async () => {
      outcome = await result.current.bulkImportPapers(["12345"], undefined, {
        targetProjectIds: ["proj-1"],
        targetTagIds: ["tag-1"],
      });
    });

    expect(rpcNames()).toEqual([]);
    expect(outcome!.items).toEqual([
      { identifier: "12345", status: "duplicate-unresolved" },
    ]);
    expect(outcome!.resolvedDuplicates).toEqual({
      projects: "not-requested",
      tags: "not-requested",
    });
    // The unchanged generic import report: skipped, not added, not failed.
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Bulk import complete",
        description: "0 added, 1 skipped (duplicates), 0 failed.",
      }),
    );
  });

  it("adds the selected Projects to the resolved duplicate when opted in", async () => {
    setupDuplicate({ resolved: true });
    mockRpc.mockResolvedValue({ data: null, error: null });

    const { result } = renderBulkHook();
    let outcome: Awaited<ReturnType<typeof result.current.bulkImportPapers>>;

    await act(async () => {
      outcome = await result.current.bulkImportPapers(["12345"], undefined, {
        targetProjectIds: ["proj-1"],
        applyAssignmentsToResolvedDuplicates: true,
      });
    });

    expect(mockRpc).toHaveBeenCalledWith("bulk_add_paper_projects", {
      p_paper_ids: [DUPLICATE_PAPER_ID],
      p_project_ids: ["proj-1"],
    });
    // The replace-all setter would have deleted the paper's existing Projects.
    expect(rpcNames()).not.toContain("bulk_set_paper_projects");
    expect(outcome!.items).toEqual([
      { identifier: "12345", status: "duplicate-resolved" },
    ]);
    expect(outcome!.resolvedDuplicates).toEqual({
      projects: "applied",
      tags: "not-requested",
    });
  });

  it("adds the selected Tags to the resolved duplicate when opted in", async () => {
    setupDuplicate({ resolved: true });
    mockRpc.mockResolvedValue({ data: null, error: null });

    const { result } = renderBulkHook();
    let outcome: Awaited<ReturnType<typeof result.current.bulkImportPapers>>;

    await act(async () => {
      outcome = await result.current.bulkImportPapers(["12345"], undefined, {
        targetTagIds: ["tag-1", "tag-2"],
        applyAssignmentsToResolvedDuplicates: true,
      });
    });

    expect(mockRpc).toHaveBeenCalledWith("bulk_add_paper_tags", {
      p_paper_ids: [DUPLICATE_PAPER_ID],
      p_tag_ids: ["tag-1", "tag-2"],
    });
    expect(rpcNames()).not.toContain("bulk_set_paper_tags");
    expect(outcome!.resolvedDuplicates).toEqual({
      projects: "not-requested",
      tags: "applied",
    });
  });

  it("adds both categories when both were selected", async () => {
    setupDuplicate({ resolved: true });
    mockRpc.mockResolvedValue({ data: null, error: null });

    const { result } = renderBulkHook();

    await act(async () => {
      await result.current.bulkImportPapers(["12345"], undefined, {
        targetProjectIds: ["proj-1"],
        targetTagIds: ["tag-1"],
        applyAssignmentsToResolvedDuplicates: true,
      });
    });

    expect(rpcNames()).toEqual([
      "bulk_add_paper_projects",
      "bulk_add_paper_tags",
    ]);
  });

  it("calls no additive RPC when the duplicate carries no id, even opted in", async () => {
    // THE COMPATIBILITY PROOF. This is exactly what a Production database that
    // has not yet run migration 20260903180000 returns for every duplicate, so
    // this test is what makes shipping the frontend first safe: no `bulk_add_*`
    // is invoked, so a function that does not exist yet is never called.
    setupDuplicate({ resolved: false });
    mockRpc.mockResolvedValue({ data: null, error: null });

    const { result } = renderBulkHook();
    let outcome: Awaited<ReturnType<typeof result.current.bulkImportPapers>>;

    await act(async () => {
      outcome = await result.current.bulkImportPapers(["12345"], undefined, {
        targetProjectIds: ["proj-1"],
        targetTagIds: ["tag-1"],
        applyAssignmentsToResolvedDuplicates: true,
      });
    });

    expect(mockRpc).not.toHaveBeenCalled();
    expect(outcome!.items).toEqual([
      { identifier: "12345", status: "duplicate-unresolved" },
    ]);
    expect(outcome!.resolvedDuplicates).toEqual({
      projects: "not-requested",
      tags: "not-requested",
    });
  });

  it("writes nothing when a resolved duplicate had no selections at all", async () => {
    setupDuplicate({ resolved: true });
    mockRpc.mockResolvedValue({ data: null, error: null });

    const { result } = renderBulkHook();
    let outcome: Awaited<ReturnType<typeof result.current.bulkImportPapers>>;

    await act(async () => {
      outcome = await result.current.bulkImportPapers(["12345"], undefined, {
        applyAssignmentsToResolvedDuplicates: true,
      });
    });

    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockInvalidateAndRefetch).not.toHaveBeenCalled();
    expect(outcome!.items).toEqual([
      { identifier: "12345", status: "duplicate-resolved" },
    ]);
  });

  it("records a failed additive Project call without claiming it succeeded", async () => {
    setupDuplicate({ resolved: true });
    mockRpc.mockResolvedValue({ data: null, error: { message: "RPC error" } });

    const { result } = renderBulkHook();
    let outcome: Awaited<ReturnType<typeof result.current.bulkImportPapers>>;

    await act(async () => {
      outcome = await result.current.bulkImportPapers(["12345"], undefined, {
        targetProjectIds: ["proj-1"],
        applyAssignmentsToResolvedDuplicates: true,
      });
    });

    expect(outcome!.resolvedDuplicates).toEqual({
      projects: "failed",
      tags: "not-requested",
    });
    // The toast names the existing paper rather than reusing the inserted-paper
    // sentence, which would have said papers "were imported".
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Bulk import complete with warnings",
        description: expect.stringContaining("already in your library"),
        variant: "destructive",
      }),
    );
  });

  it("records a failed additive Tag call without claiming it succeeded", async () => {
    setupDuplicate({ resolved: true });
    mockRpc.mockResolvedValue({ data: null, error: { message: "RPC error" } });

    const { result } = renderBulkHook();
    let outcome: Awaited<ReturnType<typeof result.current.bulkImportPapers>>;

    await act(async () => {
      outcome = await result.current.bulkImportPapers(["12345"], undefined, {
        targetTagIds: ["tag-1"],
        applyAssignmentsToResolvedDuplicates: true,
      });
    });

    expect(outcome!.resolvedDuplicates).toEqual({
      projects: "not-requested",
      tags: "failed",
    });
  });

  it("reports a partial failure truthfully — one applied, one failed", async () => {
    setupDuplicate({ resolved: true });
    mockRpc
      .mockResolvedValueOnce({ data: null, error: null }) // bulk_add_paper_projects
      .mockResolvedValueOnce({ data: null, error: { message: "RPC error" } }); // bulk_add_paper_tags

    const { result } = renderBulkHook();
    let outcome: Awaited<ReturnType<typeof result.current.bulkImportPapers>>;

    await act(async () => {
      outcome = await result.current.bulkImportPapers(["12345"], undefined, {
        targetProjectIds: ["proj-1"],
        targetTagIds: ["tag-1"],
        applyAssignmentsToResolvedDuplicates: true,
      });
    });

    expect(outcome!.resolvedDuplicates).toEqual({
      projects: "applied",
      tags: "failed",
    });
  });

  it("invalidates the caches when a duplicate assignment may have changed state", async () => {
    // Including the partial case: the Project write landed, so a stale list
    // would hide a real change. Invalidation follows the ATTEMPT, not success.
    setupDuplicate({ resolved: true });
    mockRpc
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: null, error: { message: "RPC error" } });

    const { result } = renderBulkHook();

    await act(async () => {
      await result.current.bulkImportPapers(["12345"], undefined, {
        targetProjectIds: ["proj-1"],
        targetTagIds: ["tag-1"],
        applyAssignmentsToResolvedDuplicates: true,
      });
    });

    expect(mockInvalidateAndRefetch).toHaveBeenCalled();
  });

  it("keeps the progress callback reporting the duplicate as skipped", async () => {
    // Phase 4 semantics are unchanged: a resolved duplicate is still SKIPPED,
    // never counted as added. The terminal result carries the extra nuance.
    setupDuplicate({ resolved: true });
    mockRpc.mockResolvedValue({ data: null, error: null });

    const snapshots: { added: string[]; skipped: string[]; failed: string[] }[] = [];
    const { result } = renderBulkHook();

    await act(async () => {
      await result.current.bulkImportPapers(
        ["12345"],
        (_current, _total, addedIds, skippedIds, failedIds) => {
          snapshots.push({
            added: [...addedIds],
            skipped: [...skippedIds],
            failed: [...failedIds],
          });
        },
        {
          targetProjectIds: ["proj-1"],
          applyAssignmentsToResolvedDuplicates: true,
        },
      );
    });

    expect(snapshots.length).toBeGreaterThan(0);
    expect(snapshots[snapshots.length - 1]).toEqual({
      added: [],
      skipped: ["12345"],
      failed: [],
    });
  });

  it("reports a failed identifier as failed in the terminal result", async () => {
    mockFetchPaperMetadata.mockResolvedValue([
      { identifier: "12345", error: "not found" },
    ]);

    const { result } = renderBulkHook();
    let outcome: Awaited<ReturnType<typeof result.current.bulkImportPapers>>;

    await act(async () => {
      outcome = await result.current.bulkImportPapers(["12345"], undefined, {
        targetProjectIds: ["proj-1"],
        applyAssignmentsToResolvedDuplicates: true,
      });
    });

    expect(outcome!.items).toEqual([{ identifier: "12345", status: "failed" }]);
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

describe("useBulkMutations – parsed-file import never assigns resolved duplicates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ignores a duplicate id the RPC now returns and writes nothing", async () => {
    // File import is a bulk operation over records the user did not inspect one
    // by one. `safe_bulk_insert_papers` returning an id here must not silently
    // re-file papers they already had — that is a separate product decision.
    mockProcessChunkedInsert.mockResolvedValue({
      results: [{ index: 0, id: "existing-paper-id-1", status: "duplicate" }],
      lastError: null,
    });
    mockRpc.mockResolvedValue({ data: null, error: null });

    const { result } = renderBulkHook();

    await act(async () => {
      await result.current.bulkImportFromParsedData(
        [
          {
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
          },
        ],
        undefined,
        { targetProjectIds: ["proj-1"], targetTagIds: ["tag-1"] },
      );
    });

    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockInvalidateAndRefetch).not.toHaveBeenCalled();
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "File import complete",
        description: "0 added, 1 skipped (duplicates), 0 failed.",
      }),
    );
  });
});
