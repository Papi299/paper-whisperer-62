import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderHook, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider, type InfiniteData } from "@tanstack/react-query";

/**
 * Provenance coverage for the unfiltered total-count cache (PFA-C06 correction).
 *
 * `usePapers` treats a cached total count as authoritative — that is what
 * `isTotalCountAuthoritative` publishes, and an authoritative `0` is the one
 * thing allowed to select first-run onboarding. That contract only holds if the
 * only way a number reaches this cache is a real count query.
 *
 * Optimistic mutation helpers also write it. `adjustCount` applies a *relative*
 * delta, so seeding from zero when nothing is cached would fabricate an absolute
 * total out of an unknown one — and Dashboard deliberately renders loaded rows
 * while the count is still pending or failed (its gate also requires
 * `papers.length === 0`), so "visible papers, unknown count" is a reachable
 * state, not a theoretical one. Deleting the last row matching the active filter
 * from that state used to leave `papers = []` with a manufactured
 * `totalCount = 0` marked authoritative, telling a user who owns papers outside
 * the filter to build their library.
 *
 * These tests use the REAL `usePaperCacheHelpers`, the REAL `usePaperMutations`,
 * the REAL `queryKeys` and a REAL QueryClient — only Supabase and the toast are
 * mocked — so the delete cases exercise the actual optimistic/rollback sequence
 * rather than a re-implementation of it.
 */

// ── Supabase mock (hoisted) ────────────────────────────────────────────
//
// Since ATTACHMENT-ORPHAN-CLEANUP-HARDENING-001, `deletePaper` performs the
// deletion through `delete_papers_with_attachment_cleanup`, whose `{ error }`
// is what now decides between success and rollback — `setDeleteError` therefore
// drives the RPC. It then drains the cleanup queue, which reads
// `attachment_cleanup_queue` (empty here, so Storage is never called).
//
// `paper_attachments` and the direct `papers` DELETE remain mocked because the
// pre-migration compatibility path still uses them; these tests do not take that
// path, and a table access nobody expects still throws.
const { mockFrom, mockRpc, mockStorageRemove, setDeleteError, resetSupabase } = vi.hoisted(() => {
  let deleteError: { message: string } | null = null;

  type Thenable<T> = {
    then: (onF: (v: T) => unknown, onR?: (r: unknown) => unknown) => Promise<unknown>;
  };

  const deleteChain = () => {
    const chain: { eq: (col: string, val: unknown) => typeof chain } & Thenable<{
      error: { message: string } | null;
    }> = {
      eq: () => chain,
      then: (onF, onR) => Promise.resolve({ error: deleteError }).then(onF, onR),
    };
    return chain;
  };

  const attachmentsChain = () => {
    const chain: {
      select: () => typeof chain;
      eq: (col: string, val: unknown) => typeof chain;
      in: (col: string, val: unknown) => typeof chain;
    } & Thenable<{ data: unknown[]; error: null }> = {
      select: () => chain,
      eq: () => chain,
      in: () => chain,
      then: (onF, onR) => Promise.resolve({ data: [], error: null }).then(onF, onR),
    };
    return chain;
  };

  // The cleanup drain: `.select().eq().order().order().range()` resolves to an
  // empty page, so nothing is ever handed to Storage.
  const cleanupQueueChain = () => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      order: () => chain,
      limit: async () => ({ data: [] as unknown[], error: null }),
      delete: () => chain,
      in: async () => ({ error: null }),
    };
    return chain;
  };

  const mockStorageRemove = vi.fn(async () => ({ data: null, error: null }));
  const mockRpc = vi.fn(async (_fn: string, _args: unknown) => ({
    data: [{ deleted_count: 1, queued_count: 0 }],
    error: deleteError,
  }));
  const mockFrom = vi.fn((table: string) => {
    if (table === "paper_attachments") return attachmentsChain();
    if (table === "attachment_cleanup_queue") return cleanupQueueChain();
    if (table === "papers") return { delete: () => deleteChain() };
    throw new Error(`unexpected table access: ${table}`);
  });

  return {
    mockFrom,
    mockRpc,
    mockStorageRemove,
    setDeleteError: (e: { message: string } | null) => {
      deleteError = e;
    },
    resetSupabase: () => {
      deleteError = null;
    },
  };
});

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: mockFrom,
    rpc: mockRpc,
    storage: { from: () => ({ remove: mockStorageRemove }) },
  },
}));

const mockToast = vi.fn();
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: mockToast }) }));

import { usePaperCacheHelpers } from "../usePaperCacheHelpers";
import { usePaperMutations } from "../usePaperMutations";
import { queryKeys } from "@/lib/queryKeys";
import type { Paper, PaperWithTags } from "@/types/database";
import type {
  PapersPage,
  RawPaperWithJunctions,
  ServerFilterParams,
  ServerSortParams,
} from "../types";

const userId = "user-1";

const filters: ServerFilterParams = {
  filterPaperIds: null,
  yearFrom: null,
  yearTo: null,
  studyTypes: ["RCT"],
  notesPresence: "all",
};
const sort: ServerSortParams = { sortColumn: "year", sortAscending: true };

const COUNT_KEY = queryKeys.papers.count(userId);
const LIST_KEY = queryKeys.papers.list(userId, filters, sort);

const basePaper: Paper = {
  id: "paper-1",
  user_id: userId,
  title: "The only paper matching the active filter",
  authors: [],
  year: 2021,
  journal: null,
  pmid: null,
  doi: null,
  study_type: "RCT",
  raw_study_type: null,
  statistical_methods: null,
  keywords: [],
  raw_keywords: null,
  mesh_terms: [],
  substances: [],
  pubmed_url: null,
  journal_url: null,
  drive_url: null,
  tldr: null,
  notes: null,
  insert_order: 1,
  created_at: "2021-01-01",
  updated_at: "2021-01-01",
};

const rawPaper: RawPaperWithJunctions = { ...basePaper, tagIds: [], projectIds: [] };
const hydratedPaper: PaperWithTags = { ...basePaper, tags: [], projects: [] };

function seededList(): InfiniteData<PapersPage> {
  return { pages: [{ papers: [rawPaper], hasMore: false }], pageParams: [0] };
}

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function wrapperFor(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children);
}

/** The count as consumers read it, plus whether an entry exists at all. */
function countState(qc: QueryClient) {
  return {
    data: qc.getQueryData<number>(COUNT_KEY),
    hasEntry: qc.getQueryCache().find({ queryKey: COUNT_KEY }) !== undefined,
  };
}

function visiblePaperIds(qc: QueryClient): string[] {
  const data = qc.getQueryData<InfiniteData<PapersPage>>(LIST_KEY);
  return (data?.pages ?? []).flatMap((p) => p.papers).map((p) => p.id);
}

function renderHelpers(qc: QueryClient) {
  return renderHook(() => usePaperCacheHelpers(userId, filters, sort), {
    wrapper: wrapperFor(qc),
  });
}

beforeEach(() => {
  resetSupabase();
  mockToast.mockClear();
  mockFrom.mockClear();
  mockStorageRemove.mockClear();
});

describe("adjustCount — an unknown total count stays unknown", () => {
  it("does not invent a count from a negative delta (the single-delete path)", () => {
    const qc = makeClient();
    const { result } = renderHelpers(qc);

    act(() => result.current.adjustCount(-1));

    // The pre-correction `(old ?? 0) + delta` clamped to `0` here, which
    // `usePapers` then published as an authoritative empty library.
    expect(countState(qc).data).toBeUndefined();
  });

  it("does not invent a count from a bulk-sized negative delta", () => {
    const qc = makeClient();
    const { result } = renderHelpers(qc);

    act(() => result.current.adjustCount(-12));

    expect(countState(qc).data).toBeUndefined();
  });

  it("does not invent a count from a positive delta", () => {
    const qc = makeClient();
    const { result } = renderHelpers(qc);

    // No current caller passes a positive delta, but the helper is generic and
    // the invariant is about the unknown base, not the sign of the delta.
    act(() => result.current.adjustCount(3));

    expect(countState(qc).data).toBeUndefined();
  });

  it("leaves no count cache entry behind at all", () => {
    const qc = makeClient();
    const { result } = renderHelpers(qc);

    act(() => result.current.adjustCount(-1));

    // Not merely `undefined` data: no entry is created, so the real count query
    // still starts from a clean slate rather than an empty seeded one.
    expect(countState(qc).hasEntry).toBe(false);
  });
});

describe("adjustCount — a known total count still adjusts", () => {
  it("decrements on delete", () => {
    const qc = makeClient();
    qc.setQueryData(COUNT_KEY, 5);
    const { result } = renderHelpers(qc);

    act(() => result.current.adjustCount(-1));

    expect(qc.getQueryData<number>(COUNT_KEY)).toBe(4);
  });

  it("increments on a positive delta", () => {
    const qc = makeClient();
    qc.setQueryData(COUNT_KEY, 5);
    const { result } = renderHelpers(qc);

    act(() => result.current.adjustCount(2));

    expect(qc.getQueryData<number>(COUNT_KEY)).toBe(7);
  });

  it("clamps at zero rather than going negative", () => {
    const qc = makeClient();
    qc.setQueryData(COUNT_KEY, 1);
    const { result } = renderHelpers(qc);

    act(() => result.current.adjustCount(-10));

    expect(qc.getQueryData<number>(COUNT_KEY)).toBe(0);
  });

  it("keeps a real zero, which stays authoritative", () => {
    const qc = makeClient();
    qc.setQueryData(COUNT_KEY, 0);
    const { result } = renderHelpers(qc);

    act(() => result.current.adjustCount(-1));

    // A successfully counted empty library is the genuine first-run signal and
    // must survive intact — the correction only suppresses *invented* zeros.
    expect(countState(qc)).toEqual({ data: 0, hasEntry: true });
  });
});

describe("snapshot/rollback preserves count provenance", () => {
  it("restores a known count after an optimistic adjustment is rolled back", () => {
    const qc = makeClient();
    qc.setQueryData(COUNT_KEY, 120);
    const { result } = renderHelpers(qc);

    let snapshot!: ReturnType<typeof result.current.snapshotCache>;
    act(() => {
      snapshot = result.current.snapshotCache();
      result.current.adjustCount(-1);
    });
    expect(qc.getQueryData<number>(COUNT_KEY)).toBe(119);

    act(() => result.current.rollbackCache(snapshot));

    expect(qc.getQueryData<number>(COUNT_KEY)).toBe(120);
  });

  it("leaves an unknown count unknown across adjust + rollback", () => {
    const qc = makeClient();
    const { result } = renderHelpers(qc);

    let snapshot!: ReturnType<typeof result.current.snapshotCache>;
    act(() => {
      snapshot = result.current.snapshotCache();
      result.current.adjustCount(-1);
    });
    expect(snapshot.count).toBeUndefined();

    act(() => result.current.rollbackCache(snapshot));

    // `rollbackCache` restores only defined snapshot values, so a manufactured
    // number would have survived the rollback with nothing left to undo it.
    expect(countState(qc).data).toBeUndefined();
  });
});

describe("deletePaper through the real optimistic path", () => {
  function renderDelete(qc: QueryClient) {
    return renderHook(
      () => usePaperMutations(userId, [hydratedPaper], [], [], undefined, filters, sort),
      { wrapper: wrapperFor(qc) },
    );
  }

  it("empties the visible list without manufacturing a total count", async () => {
    const qc = makeClient();
    qc.setQueryData(LIST_KEY, seededList());
    const { result } = renderDelete(qc);

    await act(async () => {
      await result.current.deletePaper("paper-1");
    });

    // The exact PFA-C06 end state: nothing visible, library size still unknown.
    expect(visiblePaperIds(qc)).toEqual([]);
    expect(countState(qc)).toEqual({ data: undefined, hasEntry: false });
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Paper deleted" }));
  });

  it("leaves no manufactured count behind when the server delete fails", async () => {
    const qc = makeClient();
    qc.setQueryData(LIST_KEY, seededList());
    setDeleteError({ message: "permission denied" });
    const { result } = renderDelete(qc);

    await act(async () => {
      await result.current.deletePaper("paper-1");
    });

    // Rollback restores the row; the count was never fabricated to begin with,
    // which is what makes the restore complete rather than partial.
    expect(visiblePaperIds(qc)).toEqual(["paper-1"]);
    expect(countState(qc).data).toBeUndefined();
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Error deleting paper", variant: "destructive" }),
    );
  });

  it("still decrements a known total count immediately", async () => {
    const qc = makeClient();
    qc.setQueryData(LIST_KEY, seededList());
    qc.setQueryData(COUNT_KEY, 120);
    const { result } = renderDelete(qc);

    await act(async () => {
      await result.current.deletePaper("paper-1");
    });

    expect(qc.getQueryData<number>(COUNT_KEY)).toBe(119);
  });

  it("still restores a known total count when the server delete fails", async () => {
    const qc = makeClient();
    qc.setQueryData(LIST_KEY, seededList());
    qc.setQueryData(COUNT_KEY, 120);
    setDeleteError({ message: "permission denied" });
    const { result } = renderDelete(qc);

    await act(async () => {
      await result.current.deletePaper("paper-1");
    });

    expect(qc.getQueryData<number>(COUNT_KEY)).toBe(120);
    expect(visiblePaperIds(qc)).toEqual(["paper-1"]);
  });
});
