import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

/**
 * ATTACHMENT-ORPHAN-CLEANUP-HARDENING-001 — bulk paper deletion.
 *
 * Same rules as the single delete, and deliberately the same RPC: bulk passes
 * the whole selection, single passes a one-element array. What is specific to
 * this path is the count in the toast, which must stay truthful — the RPC
 * validates every id before mutating anything, so the operation is
 * all-or-nothing and `Deleted N paper(s)` is either right or never shown.
 */

const { mockFrom, mockRpc, mockStorageRemove, state, resetSupabase } = vi.hoisted(() => {
  const state = {
    rpcResult: { data: [{ deleted_count: 3, queued_count: 0 }] as unknown, error: null as unknown },
    attachmentsResult: { data: [] as { file_path: string }[], error: null as unknown },
    legacyDeleteResult: { error: null as unknown },
    cleanupPages: [{ data: [] as unknown[], error: null as unknown }],
    cleanupCursor: 0,
    legacyDeleteIn: [] as [string, unknown][],
    legacyDeleteEq: [] as [string, unknown][],
  };

  const mockStorageRemove = vi.fn(async (_paths: string[]) => ({ data: null, error: null as unknown }));
  const mockRpc = vi.fn(async () => state.rpcResult);

  const mockFrom = vi.fn((table: string) => {
    if (table === "paper_attachments") {
      const chain = { select: () => chain, in: async () => state.attachmentsResult };
      return chain;
    }
    if (table === "attachment_cleanup_queue") {
      const chain = {
        select: () => chain,
        eq: () => chain,
        order: () => chain,
        range: async () => {
          const page = state.cleanupPages[Math.min(state.cleanupCursor, state.cleanupPages.length - 1)];
          state.cleanupCursor += 1;
          return page;
        },
        delete: () => chain,
        in: async () => ({ error: null }),
      };
      return chain;
    }
    const deleteChain = {
      in: (column: string, values: unknown) => {
        state.legacyDeleteIn.push([column, values]);
        return deleteChain;
      },
      eq: (column: string, value: unknown) => {
        state.legacyDeleteEq.push([column, value]);
        return deleteChain;
      },
      then: (onF: (v: unknown) => unknown, onR?: (r: unknown) => unknown) =>
        Promise.resolve(state.legacyDeleteResult).then(onF, onR),
    };
    return { delete: () => deleteChain, select: () => ({ eq: vi.fn() }) };
  });

  return {
    mockFrom,
    mockRpc,
    mockStorageRemove,
    state,
    resetSupabase: () => {
      state.rpcResult = { data: [{ deleted_count: 3, queued_count: 0 }], error: null };
      state.attachmentsResult = { data: [], error: null };
      state.legacyDeleteResult = { error: null };
      state.cleanupPages = [{ data: [], error: null }];
      state.cleanupCursor = 0;
      state.legacyDeleteIn = [];
      state.legacyDeleteEq = [];
    },
  };
});

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: mockFrom, rpc: mockRpc, storage: { from: () => ({ remove: mockStorageRemove }) } },
}));

const mockToast = vi.fn();
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: mockToast }) }));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

const cache = {
  snapshotCache: vi.fn(() => ({ marker: "snapshot" })),
  rollbackCache: vi.fn(),
  cancelQueries: vi.fn(),
  updatePapersCache: vi.fn(),
  adjustCount: vi.fn(),
  adjustFilteredCount: vi.fn(),
  removeStaleListCaches: vi.fn(),
  invalidateAndRefetch: vi.fn(),
  invalidateJunctionCaches: vi.fn(),
};
vi.mock("../usePaperCacheHelpers", () => ({ usePaperCacheHelpers: () => cache }));

vi.mock("@/hooks/useNormalizationWorker", () => ({
  useNormalizationWorker: () => ({ normalize: vi.fn(async (p: unknown[]) => p) }),
}));

import { useBulkMutations } from "../useBulkMutations";
import { resetAttachmentCleanupAvailabilityForTests } from "@/lib/attachmentCleanupAvailability";
import type { ServerFilterParams, ServerSortParams } from "../types";

const USER = "11111111-1111-1111-1111-111111111111";
const IDS = ["paper-1", "paper-2", "paper-3"];
const PATH = `${USER}/paper-1/a.pdf`;

const filters: ServerFilterParams = {
  filterPaperIds: null,
  yearFrom: null,
  yearTo: null,
  studyTypes: [],
  notesPresence: "all",
};
const sort: ServerSortParams = { sortColumn: "year", sortAscending: true };

const missingRpcError = {
  code: "PGRST202",
  message:
    "Could not find the function public.delete_papers_with_attachment_cleanup(p_paper_ids) in the schema cache",
};

function renderBulk() {
  return renderHook(() => useBulkMutations(USER, [], [], [], undefined, filters, sort));
}

function deleteToast() {
  const call = mockToast.mock.calls.find(
    (c) => typeof (c[0] as { title?: string })?.title === "string"
      && /^(Deleted \d+ paper\(s\)|Error deleting papers)$/.test((c[0] as { title: string }).title),
  );
  return call?.[0] as { title: string; description?: string; variant?: string } | undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetSupabase();
  resetAttachmentCleanupAvailabilityForTests();
  mockStorageRemove.mockResolvedValue({ data: null, error: null });
});

describe("bulkDeletePapers — the durable path", () => {
  it("hands the whole selection to the same RPC the single delete uses", async () => {
    const { result } = renderBulk();

    await act(async () => {
      await result.current.bulkDeletePapers(IDS);
    });

    expect(mockRpc).toHaveBeenCalledWith("delete_papers_with_attachment_cleanup", {
      p_paper_ids: IDS,
    });
    expect(state.legacyDeleteIn).toEqual([]);
    expect(deleteToast()).toEqual({ title: "Deleted 3 paper(s)" });
  });

  it("keeps the count truthful and does not restore papers when cleanup fails", async () => {
    state.cleanupPages = [{ data: [{ id: "job-1", file_path: PATH }], error: null }];
    mockStorageRemove.mockResolvedValue({ data: null, error: { message: "storage unavailable" } });
    const { result } = renderBulk();

    await act(async () => {
      await result.current.bulkDeletePapers(IDS);
    });

    expect(cache.rollbackCache).not.toHaveBeenCalled();
    const toast = deleteToast();
    expect(toast?.title).toBe("Deleted 3 paper(s)");
    expect(toast?.description).toMatch(/cleanup is pending and will retry automatically/i);
    expect(toast?.variant).toBeUndefined();
  });

  it("rolls back and reports failure when the RPC rejects the selection", async () => {
    // One foreign id among owned ids rejects the whole call server-side, which
    // is why the count above can be trusted: there is no partial outcome.
    state.rpcResult = { data: null, error: { code: "P0001", message: "do not belong to the caller" } };
    const { result } = renderBulk();

    await act(async () => {
      await result.current.bulkDeletePapers(IDS);
    });

    expect(cache.rollbackCache).toHaveBeenCalledWith({ marker: "snapshot" });
    expect(deleteToast()).toEqual(
      expect.objectContaining({ title: "Error deleting papers", variant: "destructive" }),
    );
    expect(mockStorageRemove).not.toHaveBeenCalled();
  });

  it("does nothing at all for an empty selection", async () => {
    const { result } = renderBulk();

    await act(async () => {
      await result.current.bulkDeletePapers([]);
    });

    expect(mockRpc).not.toHaveBeenCalled();
  });
});

describe("bulkDeletePapers — the pre-migration path", () => {
  beforeEach(() => {
    state.rpcResult = { data: null, error: missingRpcError };
  });

  it("falls back and still reports the count", async () => {
    state.attachmentsResult = { data: [{ file_path: PATH }], error: null };
    const { result } = renderBulk();

    await act(async () => {
      await result.current.bulkDeletePapers(IDS);
    });

    expect(state.legacyDeleteIn).toEqual([["id", IDS]]);
    expect(state.legacyDeleteEq).toEqual([["user_id", USER]]);
    expect(mockStorageRemove).toHaveBeenCalledWith([PATH]);
    expect(deleteToast()).toEqual({ title: "Deleted 3 paper(s)" });
  });

  it("observes a RETURNED Storage error rather than swallowing it", async () => {
    state.attachmentsResult = { data: [{ file_path: PATH }], error: null };
    mockStorageRemove.mockResolvedValue({ data: null, error: { message: "storage unavailable" } });
    const { result } = renderBulk();

    await act(async () => {
      await result.current.bulkDeletePapers(IDS);
    });

    expect(cache.rollbackCache).not.toHaveBeenCalled();
    expect(deleteToast()?.description).toMatch(/could not be removed/i);
  });

  it("rolls back when the fallback delete fails", async () => {
    state.legacyDeleteResult = { error: { message: "permission denied" } };
    const { result } = renderBulk();

    await act(async () => {
      await result.current.bulkDeletePapers(IDS);
    });

    expect(cache.rollbackCache).toHaveBeenCalledWith({ marker: "snapshot" });
    expect(deleteToast()?.variant).toBe("destructive");
  });
});
