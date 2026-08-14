import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, render, waitFor, screen, act } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider, type QueryKey } from "@tanstack/react-query";

const { mockFrom, mockRpc } = vi.hoisted(() => ({ mockFrom: vi.fn(), mockRpc: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: mockFrom, rpc: mockRpc },
}));

import { usePapers } from "../usePapers";
import { PaperList } from "@/components/papers/PaperList";
import type { ServerFilterParams, ServerSortParams } from "../papers/types";

/**
 * Regression for the unresolved-total-count race (PFA-C06 correction).
 *
 * The unfiltered count is a *separate* query from the filtered papers list, and
 * `usePapers` returns `totalCount ?? papers.length`. When a filter matches
 * nothing, the papers query short-circuits to `[]` at once while the count is
 * still in flight — so the fallback turns an *unknown* count into an
 * authoritative-looking `0`, and the consumer renders first-run onboarding to a
 * user who owns 120 papers.
 *
 * These tests drive the real `usePapers` against a mocked Supabase where the
 * count query is a deferred promise the test resolves by hand, so "count
 * pending" is a genuine query state rather than a hand-written prop.
 * `filterPaperIds: []` is the real short-circuit path a zero-match filter takes:
 * the papers list, filtered count, filtered IDs and keyword options all return
 * without touching Supabase, leaving the unfiltered count as the one thing still
 * in flight.
 *
 * The same fabricated zero is reachable when the count query *fails* rather than
 * stays pending, so the suite covers both endings of the unknown state: still in
 * flight, and definitively errored. Neither may be classified as an empty
 * library.
 *
 * The assertions deliberately do **not** gate on `papers.length === 0` — that is
 * true both before and after the list resolves, so gating on it would assert
 * `loading === true` for the trivial reason that nothing had loaded yet and
 * would pass with or without the fix. Instead each test waits on the real query
 * states in the cache: list/projects/tags `success`, count still `pending`.
 */

const USER_ID = "user-1";

const FILTERS_MATCHING_NOTHING: ServerFilterParams = {
  filterPaperIds: [], // resolved, zero matches → the other papers queries short-circuit
  yearFrom: null,
  yearTo: null,
  studyTypes: null,
  notesPresence: "all",
};

const SORT: ServerSortParams = { sortColumn: null, sortAscending: null };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Inert handler so the error-path tests' rejection is never reported as an
  // unhandled rejection when the query under test is the only real awaiter.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

/** Controls when the unfiltered count query settles. */
let countGate: ReturnType<typeof deferred<{ count: number | null; error: null }>>;
let client: QueryClient;

beforeEach(() => {
  vi.clearAllMocks();
  countGate = deferred<{ count: number | null; error: null }>();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  // `projects` / `tags`: `.select().eq().order()` resolves immediately.
  const listStub = () => {
    const stub = {
      select: vi.fn(() => stub),
      eq: vi.fn(() => stub),
      order: vi.fn(async () => ({ data: [], error: null })),
    };
    return stub;
  };

  // `papers`: under `filterPaperIds: []` the count is the query whose readiness
  // is under test. It is awaited directly off the builder, so the builder itself
  // is the thenable held open until the test resolves `countGate`.
  const papersStub: Record<string, unknown> = {
    select: vi.fn(() => papersStub),
    eq: vi.fn(() => papersStub),
    then: (onOk: (v: unknown) => unknown, onErr?: (e: unknown) => unknown) =>
      countGate.promise.then(onOk, onErr),
  };

  mockFrom.mockImplementation((table: string) => {
    if (table === "papers") return papersStub;
    if (table === "projects" || table === "tags") return listStub();
    throw new Error(`unexpected table read: ${table}`);
  });
  mockRpc.mockResolvedValue({ data: [], error: null });
});

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** Status of the first cached query whose key starts with `prefix`. */
function statusOf(prefix: QueryKey): string | undefined {
  const match = client
    .getQueryCache()
    .getAll()
    .find((q) => prefix.every((part, i) => Object.is(q.queryKey[i], part)));
  return match?.state.status;
}

// Real key shapes: ["papers", userId, "list", filters, sort] / ["papers", userId, "count"].
const LIST_KEY = ["papers", USER_ID, "list"] as const;
const COUNT_KEY = ["papers", USER_ID, "count"] as const;
const PROJECTS_KEY = ["projects", USER_ID] as const;
const TAGS_KEY = ["tags", USER_ID] as const;

/**
 * Block until everything that *can* settle has settled while the count query is
 * still in flight. This is the precise "papers resolved empty, count unknown"
 * moment the race occurs in — before the fix, `loading` is already false here.
 */
async function waitForListResolvedCountPending() {
  await waitFor(() => {
    expect(statusOf(LIST_KEY)).toBe("success");
    expect(statusOf(PROJECTS_KEY)).toBe("success");
    expect(statusOf(TAGS_KEY)).toBe("success");
  });
  // The count must still be genuinely unresolved, or these tests prove nothing.
  expect(statusOf(COUNT_KEY)).toBe("pending");
}

describe("usePapers — unfiltered count readiness", () => {
  it("stays loading once the list has resolved empty but the authoritative count is still pending", async () => {
    const { result } = renderHook(() => usePapers(USER_ID, FILTERS_MATCHING_NOTHING, SORT), {
      wrapper,
    });

    await waitForListResolvedCountPending();
    expect(result.current.papers).toEqual([]);

    // The library-empty question is still unanswered, so the hook must not
    // present itself as ready. This is the assertion that fails on the pre-fix
    // head, where `loading` omitted the count query.
    expect(result.current.loading).toBe(true);
  });

  it("unknown → nonzero: reports the real count and is only then ready", async () => {
    const { result } = renderHook(() => usePapers(USER_ID, FILTERS_MATCHING_NOTHING, SORT), {
      wrapper,
    });

    await waitForListResolvedCountPending();
    expect(result.current.loading).toBe(true);

    await act(async () => {
      countGate.resolve({ count: 120, error: null });
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.totalCount).toBe(120);
  });

  it("unknown → zero: a genuinely empty library reports zero only after resolution", async () => {
    const { result } = renderHook(() => usePapers(USER_ID, FILTERS_MATCHING_NOTHING, SORT), {
      wrapper,
    });

    await waitForListResolvedCountPending();
    expect(result.current.loading).toBe(true);

    await act(async () => {
      countGate.resolve({ count: 0, error: null });
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.totalCount).toBe(0);
  });
});

/**
 * The readiness signal only matters if it survives the trip through Dashboard's
 * gate, so this harness composes the real `usePapers`, the real
 * `loading && papers.length === 0` gate Dashboard applies, and the real
 * `PaperList` empty branch — same wiring, driven by the same live query states.
 */
function Harness() {
  const { papers, loading, totalCount, isTotalCountAuthoritative } = usePapers(
    USER_ID,
    FILTERS_MATCHING_NOTHING,
    SORT,
  );
  const [addOpen, setAddOpen] = useState(false);

  if (loading && papers.length === 0) return <div>loading-spinner</div>;

  return (
    <>
      <span>dialog-open:{String(addOpen)}</span>
      <PaperList
        papers={papers}
        userId={USER_ID}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        findMatchingKeywords={() => []}
        visibleColumns={["title"]}
        columnWidths={{ title: 200 }}
        onColumnResize={vi.fn()}
        normalizeKeyword={(k) => k}
        excludedKeywords={new Set()}
        excludedStudyTypes={new Set()}
        onExcludeStudyType={vi.fn(async () => true)}
        onExcludeKeyword={vi.fn(async () => true)}
        onUpdateDriveUrl={vi.fn(async () => {})}
        selectedPaperIds={new Set()}
        onToggleSelect={vi.fn()}
        onToggleSelectAll={vi.fn()}
        totalCount={totalCount}
        isTotalCountAuthoritative={isTotalCountAuthoritative}
        hasActiveFilters={true}
        onAddPapers={() => setAddOpen(true)}
        onClearFilters={vi.fn()}
      />
    </>
  );
}

describe("count readiness through Dashboard's gate", () => {
  it("classifies nothing at all while the count is pending", async () => {
    render(<Harness />, { wrapper });
    await waitForListResolvedCountPending();

    // The defect this guards: a user who owns 120 papers being told they have
    // none, because the unresolved count read as an authoritative zero.
    expect(screen.queryByText(/build your research library/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /add your first papers/i })).toBeNull();
    // No premature no-results verdict either — the question is still unanswered.
    expect(screen.queryByText(/no papers match your current filters/i)).toBeNull();
    expect(screen.queryByText(/no papers to display/i)).toBeNull();
    // What should be on screen instead: the existing loading boundary.
    expect(screen.getByText("loading-spinner")).toBeInTheDocument();
  });

  it("pending → nonzero renders filtered no-results, never first-run onboarding", async () => {
    render(<Harness />, { wrapper });
    await waitForListResolvedCountPending();

    await act(async () => {
      countGate.resolve({ count: 120, error: null });
    });

    expect(
      await screen.findByRole("heading", { name: /no papers match your current filters/i }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/build your research library/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /add your first papers/i })).toBeNull();
  });

  it("pending → zero renders first-run onboarding, only after resolution", async () => {
    render(<Harness />, { wrapper });
    await waitForListResolvedCountPending();

    await act(async () => {
      countGate.resolve({ count: 0, error: null });
    });

    expect(
      await screen.findByRole("heading", { name: /build your research library/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /add your first papers/i })).toBeInTheDocument();
    expect(screen.queryByText(/no papers match your current filters/i)).toBeNull();
  });
});

/**
 * The count query can also *fail*, which the pending-race fix alone does not
 * cover: on a definitive error React Query clears `isLoading`, so `loading` goes
 * false with `data` still undefined and the `totalCount ?? papers.length`
 * fallback yields a fabricated `0`. A failed authoritative query means the
 * library size is unknown, never that the library is empty.
 *
 * The failure is driven through the real query — the deferred count promise is
 * rejected — so this is a genuine React Query error state rather than a
 * hand-written prop.
 */
describe("a failed unfiltered count is never treated as an empty library", () => {
  it("releases the loading gate but reports the count as non-authoritative", async () => {
    const { result } = renderHook(() => usePapers(USER_ID, FILTERS_MATCHING_NOTHING, SORT), {
      wrapper,
    });

    await waitForListResolvedCountPending();

    await act(async () => {
      countGate.reject(new Error("count request failed"));
    });

    // Definitive failure, not an unresolved state: the hook must let go of the
    // loading boundary rather than spin forever behind a question that now has
    // no answer coming.
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(statusOf(COUNT_KEY)).toBe("error");

    // ...and must not let the `?? papers.length` fallback pass itself off as the
    // answer. This is the assertion that fails on the pre-correction head, where
    // no authority signal existed at all.
    expect(result.current.isTotalCountAuthoritative).toBe(false);
  });

  it("renders the neutral fallback rather than first-run onboarding", async () => {
    render(<Harness />, { wrapper });
    await waitForListResolvedCountPending();

    await act(async () => {
      countGate.reject(new Error("count request failed"));
    });

    // Something must render — hanging on the initial spinner forever is not an
    // acceptable answer to a definitively failed query either.
    expect(
      await screen.findByRole("heading", { name: /no papers to display/i }),
    ).toBeInTheDocument();
    expect(screen.queryByText("loading-spinner")).toBeNull();

    // The defect: the failed count fell through to a fabricated `0` and told a
    // user who owns papers to start building their library.
    expect(screen.queryByText(/build your research library/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /add your first papers/i })).toBeNull();

    // Nor may it blame the filters — that asserts the library is non-empty,
    // which is precisely what is unknown here.
    expect(screen.queryByText(/no papers match your current filters/i)).toBeNull();
  });
});

/**
 * Guards the other side of the fix: folding the count into `loading` must not
 * make a *populated* library wait on it. Dashboard's gate also requires
 * `papers.length === 0`, so rows that have already arrived must render even
 * while the count is still in flight.
 */
describe("a populated library is not blocked by a pending count", () => {
  const ROW = {
    id: "p1",
    user_id: USER_ID,
    title: "An already-loaded paper",
    authors: null,
    year: 2020,
    journal: null,
    pmid: null,
    doi: null,
    has_abstract: false,
    study_type: null,
    raw_study_type: null,
    statistical_methods: null,
    keywords: null,
    raw_keywords: null,
    mesh_terms: null,
    substances: null,
    pubmed_url: null,
    journal_url: null,
    drive_url: null,
    tldr: null,
    notes: null,
    insert_order: 1,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    paper_attachments: [],
  };

  beforeEach(() => {
    // No ID filter this time, so the list query really runs. One `papers` stub
    // serves both callers and branches on the `head: true` count option: the
    // count stays gated, the row query resolves immediately.
    const papersStub: Record<string, unknown> = {
      select: vi.fn((_cols: string, opts?: { head?: boolean }) => {
        (papersStub as { _head?: boolean })._head = !!opts?.head;
        return papersStub;
      }),
      eq: vi.fn(() => papersStub),
      in: vi.fn(() => papersStub),
      gte: vi.fn(() => papersStub),
      lte: vi.fn(() => papersStub),
      not: vi.fn(() => papersStub),
      filter: vi.fn(() => papersStub),
      or: vi.fn(() => papersStub),
      order: vi.fn(() => papersStub),
      range: vi.fn(async () => ({ data: [ROW], error: null })),
      then: (onOk: (v: unknown) => unknown, onErr?: (e: unknown) => unknown) =>
        countGate.promise.then(onOk, onErr),
    };
    const junctionStub = () => {
      const stub = {
        select: vi.fn(() => stub),
        in: vi.fn(async () => ({ data: [], error: null })),
      };
      return stub;
    };
    const listStub = () => {
      const stub = {
        select: vi.fn(() => stub),
        eq: vi.fn(() => stub),
        order: vi.fn(async () => ({ data: [], error: null })),
      };
      return stub;
    };
    mockFrom.mockImplementation((table: string) => {
      if (table === "papers") return papersStub;
      if (table === "paper_tags" || table === "paper_projects") return junctionStub();
      if (table === "projects" || table === "tags") return listStub();
      throw new Error(`unexpected table read: ${table}`);
    });
  });

  it("renders the loaded rows while the unfiltered count is still pending", async () => {
    const noIdFilter: ServerFilterParams = { ...FILTERS_MATCHING_NOTHING, filterPaperIds: null };

    function PopulatedHarness() {
      const { papers, loading } = usePapers(USER_ID, noIdFilter, SORT);
      if (loading && papers.length === 0) return <div>loading-spinner</div>;
      return <div>rows:{papers.length}</div>;
    }

    render(<PopulatedHarness />, { wrapper });

    // The row is on screen even though the count has never resolved.
    expect(await screen.findByText("rows:1")).toBeInTheDocument();
    expect(statusOf(COUNT_KEY)).toBe("pending");
    expect(screen.queryByText("loading-spinner")).toBeNull();
  });

  it("keeps the loaded rows after the unfiltered count has failed", async () => {
    const noIdFilter: ServerFilterParams = { ...FILTERS_MATCHING_NOTHING, filterPaperIds: null };

    function PopulatedHarness() {
      const { papers, loading } = usePapers(USER_ID, noIdFilter, SORT);
      if (loading && papers.length === 0) return <div>loading-spinner</div>;
      return <div>rows:{papers.length}</div>;
    }

    render(<PopulatedHarness />, { wrapper });
    expect(await screen.findByText("rows:1")).toBeInTheDocument();

    await act(async () => {
      countGate.reject(new Error("count request failed"));
    });

    // An unknown library size is only ever used to classify the *empty* view.
    // Rows that already arrived stay on screen.
    await waitFor(() => expect(statusOf(COUNT_KEY)).toBe("error"));
    expect(screen.getByText("rows:1")).toBeInTheDocument();
    expect(screen.queryByText("loading-spinner")).toBeNull();
  });
});
