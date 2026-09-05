import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

/**
 * ATTACHMENT-ORPHAN-CLEANUP-HARDENING-001 — single-paper deletion.
 *
 * The old sequence read the attachment paths, deleted the paper, and then made
 * one best-effort `remove()` whose failure was swallowed. After that delete the
 * paths existed nowhere but a local variable, so a failure at that exact moment
 * left a binary nothing in the system knew about.
 *
 * Two properties replace it, and they are the ones asserted here:
 *
 *  * the deletion goes through the RPC that queues the paths in the SAME
 *    transaction, so nothing can be lost by the statement that orphans it;
 *  * once that RPC commits, the paper stays deleted. A Storage failure afterwards
 *    is a warning, never a rollback — restoring the row would show the user a
 *    paper their database no longer holds.
 */

const { mockFrom, mockRpc, mockStorageRemove, state, resetSupabase } = vi.hoisted(() => {
  const state = {
    rpcResult: { data: [{ deleted_count: 1, queued_count: 0 }] as unknown, error: null as unknown },
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
      const chain = {
        select: () => chain,
        in: async () => state.attachmentsResult,
        eq: async () => state.attachmentsResult,
      };
      return chain;
    }
    if (table === "attachment_cleanup_queue") {
      const chain = {
        select: () => chain,
        eq: () => chain,
        order: () => chain,
        limit: async () => {
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
    return { delete: () => deleteChain };
  });

  return {
    mockFrom,
    mockRpc,
    mockStorageRemove,
    state,
    resetSupabase: () => {
      state.rpcResult = { data: [{ deleted_count: 1, queued_count: 0 }], error: null };
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

const mockInvalidateQueries = vi.fn();
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: mockInvalidateQueries }),
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

import { usePaperMutations } from "../usePaperMutations";
import { resetAttachmentCleanupAvailabilityForTests } from "@/lib/attachmentCleanupAvailability";
import type { ServerFilterParams, ServerSortParams } from "../types";

const USER = "11111111-1111-1111-1111-111111111111";
const PAPER = "33333333-3333-3333-3333-333333333333";
const PATH = `${USER}/${PAPER}/a.pdf`;

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

function renderMutations() {
  return renderHook(() => usePaperMutations(USER, [], [], [], undefined, filters, sort));
}

function deleteToast() {
  const call = mockToast.mock.calls.find(
    (c) => typeof (c[0] as { title?: string })?.title === "string"
      && /^(Paper deleted|Error deleting paper)$/.test((c[0] as { title: string }).title),
  );
  return call?.[0] as { title: string; description?: string; variant?: string } | undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetSupabase();
  resetAttachmentCleanupAvailabilityForTests();
  mockStorageRemove.mockResolvedValue({ data: null, error: null });
});

describe("deletePaper — the durable path", () => {
  it("deletes through the bulk-capable RPC with a one-element array", async () => {
    const { result } = renderMutations();

    await act(async () => {
      await result.current.deletePaper(PAPER);
    });

    expect(mockRpc).toHaveBeenCalledWith("delete_papers_with_attachment_cleanup", {
      p_paper_ids: [PAPER],
    });
    // No pre-read of attachment paths: the RPC collects them server-side, inside
    // the transaction, which is the only place the collection is safe.
    expect(mockFrom).not.toHaveBeenCalledWith("paper_attachments");
    // No direct DELETE either.
    expect(state.legacyDeleteIn).toEqual([]);
  });

  it("removes the paper from the cache and reports plain success on a clean drain", async () => {
    const { result } = renderMutations();

    await act(async () => {
      await result.current.deletePaper(PAPER);
    });

    expect(cache.updatePapersCache).toHaveBeenCalled();
    expect(cache.adjustCount).toHaveBeenCalledWith(-1);
    expect(cache.adjustFilteredCount).toHaveBeenCalledWith(-1);
    expect(cache.rollbackCache).not.toHaveBeenCalled();
    expect(deleteToast()).toEqual({ title: "Paper deleted" });
  });

  it("does NOT roll back a committed deletion when Storage cleanup fails", async () => {
    state.cleanupPages = [{ data: [{ id: "job-1", file_path: PATH }], error: null }];
    mockStorageRemove.mockResolvedValue({ data: null, error: { message: "storage unavailable" } });
    const { result } = renderMutations();

    await act(async () => {
      await result.current.deletePaper(PAPER);
    });

    expect(cache.rollbackCache).not.toHaveBeenCalled();
    const toast = deleteToast();
    expect(toast?.title).toBe("Paper deleted");
    expect(toast?.description).toMatch(/cleanup is pending and will retry automatically/i);
    // Not destructive: the paper deletion succeeded, and saying otherwise would
    // contradict the database.
    expect(toast?.variant).toBeUndefined();
  });

  it("rolls the optimistic cache back when the RPC itself fails", async () => {
    state.rpcResult = { data: null, error: { code: "P0001", message: "does not belong to the caller" } };
    const { result } = renderMutations();

    await act(async () => {
      await result.current.deletePaper(PAPER);
    });

    expect(cache.rollbackCache).toHaveBeenCalledWith({ marker: "snapshot" });
    expect(deleteToast()).toEqual(
      expect.objectContaining({ title: "Error deleting paper", variant: "destructive" }),
    );
    // Nothing committed, so nothing may be cleaned up.
    expect(mockStorageRemove).not.toHaveBeenCalled();
  });

  it("does not convert an unrelated RPC error into the pre-migration path", async () => {
    state.rpcResult = { data: null, error: { code: "42501", message: "permission denied" } };
    const { result } = renderMutations();

    await act(async () => {
      await result.current.deletePaper(PAPER);
    });

    expect(state.legacyDeleteIn).toEqual([]);
    expect(cache.rollbackCache).toHaveBeenCalled();
  });
});

describe("deletePaper — the pre-migration path", () => {
  beforeEach(() => {
    state.rpcResult = { data: null, error: missingRpcError };
  });

  it("falls back to reading paths, deleting, then removing", async () => {
    state.attachmentsResult = { data: [{ file_path: PATH }], error: null };
    const { result } = renderMutations();

    await act(async () => {
      await result.current.deletePaper(PAPER);
    });

    expect(state.legacyDeleteIn).toEqual([["id", [PAPER]]]);
    expect(state.legacyDeleteEq).toEqual([["user_id", USER]]);
    expect(mockStorageRemove).toHaveBeenCalledWith([PATH]);
    expect(cache.rollbackCache).not.toHaveBeenCalled();
    expect(deleteToast()).toEqual({ title: "Paper deleted" });
  });

  it("observes a RETURNED Storage error and says the files remain", async () => {
    state.attachmentsResult = { data: [{ file_path: PATH }], error: null };
    mockStorageRemove.mockResolvedValue({ data: null, error: { message: "storage unavailable" } });
    const { result } = renderMutations();

    await act(async () => {
      await result.current.deletePaper(PAPER);
    });

    // The paper is still deleted — no rollback — but the user is told the truth
    // instead of the old silent `console.warn`.
    expect(cache.rollbackCache).not.toHaveBeenCalled();
    const toast = deleteToast();
    expect(toast?.title).toBe("Paper deleted");
    expect(toast?.description).toMatch(/could not be removed/i);
  });

  it("rolls back when the fallback delete itself fails", async () => {
    state.legacyDeleteResult = { error: { message: "permission denied" } };
    const { result } = renderMutations();

    await act(async () => {
      await result.current.deletePaper(PAPER);
    });

    expect(cache.rollbackCache).toHaveBeenCalledWith({ marker: "snapshot" });
    expect(deleteToast()).toEqual(
      expect.objectContaining({ title: "Error deleting paper", variant: "destructive" }),
    );
  });
});
