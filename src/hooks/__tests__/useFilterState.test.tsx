import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Table-aware, paginated PostgREST-style mock. Each `.from(table)` yields a
// fresh builder (matching `fetchAllPages`' fresh-builder-per-page contract) that
// records the full query chain — selected columns, the `.in(...)` column, the
// `.order(...)` calls, and every `.range(from,to)` — into `recordedQueries`, and
// serves rows by slicing that table's own row set. Projects and Tags keep
// separate row sets so cross-table behavior is unambiguous. A per-table,
// per-page error can be injected to prove page failures are not swallowed.
// State-machine tests never await a query, so the default empty row sets are
// inert for them.
interface RecordedQuery {
  table: string;
  columns: string | null;
  inColumn: string | null;
  inValues: unknown;
  orders: Array<{ column: string; ascending: boolean }>;
  ranges: Array<{ from: number; to: number }>;
}

const {
  setProjectJunctionRows,
  setTagJunctionRows,
  setErrorOnPage,
  recordedQueries,
  resetMock,
  mockFrom,
  mockRpc,
} = vi.hoisted(() => {
  type Row = Record<string, string>;
  const store: Record<string, Row[]> = { paper_projects: [], paper_tags: [] };
  let errorInjection: { table: string; page: number } | null = null;
  const recordedQueries: RecordedQueryLike[] = [];

  const makeBuilder = (table: string) => {
    const rec: RecordedQueryLike = {
      table,
      columns: null,
      inColumn: null,
      inValues: null,
      orders: [],
      ranges: [],
    };
    recordedQueries.push(rec);
    const builder = {
      select: (columns: string) => {
        rec.columns = columns;
        return builder;
      },
      in: (column: string, values: unknown) => {
        rec.inColumn = column;
        rec.inValues = values;
        return builder;
      },
      order: (column: string, options: { ascending: boolean }) => {
        rec.orders.push({ column, ascending: options.ascending });
        return builder;
      },
      range: (from: number, to: number) => {
        rec.ranges.push({ from, to });
        const page = Math.floor(from / 1000);
        if (errorInjection && errorInjection.table === table && errorInjection.page === page) {
          return Promise.resolve({ data: null, error: new Error(`page ${page} of ${table} failed`) });
        }
        return Promise.resolve({ data: (store[table] ?? []).slice(from, to + 1), error: null });
      },
    };
    return builder;
  };

  // `RecordedQueryLike` is declared inside hoisted scope; the exported interface
  // `RecordedQuery` (top-level) is structurally identical for assertions.
  type RecordedQueryLike = {
    table: string;
    columns: string | null;
    inColumn: string | null;
    inValues: unknown;
    orders: Array<{ column: string; ascending: boolean }>;
    ranges: Array<{ from: number; to: number }>;
  };

  return {
    setProjectJunctionRows: (r: Row[]) => {
      store.paper_projects = r;
    },
    setTagJunctionRows: (r: Row[]) => {
      store.paper_tags = r;
    },
    setErrorOnPage: (table: string, page: number) => {
      errorInjection = { table, page };
    },
    recordedQueries,
    resetMock: () => {
      store.paper_projects = [];
      store.paper_tags = [];
      errorInjection = null;
      recordedQueries.length = 0;
    },
    mockFrom: vi.fn((table: string) => makeBuilder(table)),
    mockRpc: vi.fn(() => Promise.resolve({ data: [], error: null })),
  };
});

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: mockFrom, rpc: mockRpc },
}));

import { useFilterState } from "../useFilterState";

/** Recorded junction queries for one table (one entry per fetched page). */
function queriesFor(table: string): RecordedQuery[] {
  return (recordedQueries as RecordedQuery[]).filter((q) => q.table === table);
}

/** All `.range()` requests recorded for a table, flattened across pages. */
function rangesFor(table: string): Array<{ from: number; to: number }> {
  return queriesFor(table).flatMap((q) => q.ranges);
}

/**
 * These tests exercise the fully-synchronous match-mode state machine. The
 * junction *query* semantics (Any union / All membership-count) live in the
 * pure `resolveJunctionPaperIds` helper and are covered exhaustively in
 * `filterSets.test.ts`; here we assert the hook's mode/selection transitions.
 */
function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const utils = renderHook(() => useFilterState({ poolStudyTypes: [], userId: undefined }), {
    wrapper,
  });
  return { ...utils, client };
}

describe("useFilterState — match modes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMock();
  });

  it("defaults both categories to Any", () => {
    const { result } = setup();
    expect(result.current.projectMatchMode).toBe("any");
    expect(result.current.tagMatchMode).toBe("any");
  });

  it("sets the project mode independently of the tag mode", () => {
    const { result } = setup();
    act(() => result.current.setProjectMatchMode("all"));
    expect(result.current.projectMatchMode).toBe("all");
    expect(result.current.tagMatchMode).toBe("any");
  });

  it("sets the tag mode independently of the project mode", () => {
    const { result } = setup();
    act(() => result.current.setTagMatchMode("all"));
    expect(result.current.tagMatchMode).toBe("all");
    expect(result.current.projectMatchMode).toBe("any");
  });

  it("rejects an out-of-enum mode value (defensive guard)", () => {
    const { result } = setup();
    act(() =>
      (result.current.setProjectMatchMode as (m: string) => void)("bogus"),
    );
    expect(result.current.projectMatchMode).toBe("any");
  });

  it("clearProjects resets only the project mode", () => {
    const { result } = setup();
    act(() => {
      result.current.handleProjectToggle("p1");
      result.current.handleProjectToggle("p2");
      result.current.setProjectMatchMode("all");
      result.current.setTagMatchMode("all");
    });
    expect(result.current.projectMatchMode).toBe("all");

    act(() => result.current.clearProjects());
    expect(result.current.selectedProjectIds).toEqual([]);
    expect(result.current.projectMatchMode).toBe("any");
    // Tag mode is untouched.
    expect(result.current.tagMatchMode).toBe("all");
  });

  it("clearTags resets only the tag mode", () => {
    const { result } = setup();
    act(() => {
      result.current.handleTagToggle("t1");
      result.current.handleTagToggle("t2");
      result.current.setTagMatchMode("all");
      result.current.setProjectMatchMode("all");
    });
    act(() => result.current.clearTags());
    expect(result.current.selectedTagIds).toEqual([]);
    expect(result.current.tagMatchMode).toBe("any");
    expect(result.current.projectMatchMode).toBe("all");
  });

  it("global clearFilters resets both modes to Any", () => {
    const { result } = setup();
    act(() => {
      result.current.handleProjectToggle("p1");
      result.current.handleTagToggle("t1");
      result.current.setProjectMatchMode("all");
      result.current.setTagMatchMode("all");
    });
    act(() => result.current.clearFilters());
    expect(result.current.projectMatchMode).toBe("any");
    expect(result.current.tagMatchMode).toBe("any");
    expect(result.current.selectedProjectIds).toEqual([]);
    expect(result.current.selectedTagIds).toEqual([]);
  });

  it("resets the project mode to Any when the last project is deselected", () => {
    const { result } = setup();
    act(() => {
      result.current.handleProjectToggle("p1");
      result.current.handleProjectToggle("p2");
      result.current.setProjectMatchMode("all");
    });
    expect(result.current.projectMatchMode).toBe("all");
    // Remove down to one — mode is preserved.
    act(() => result.current.handleProjectToggle("p2"));
    expect(result.current.selectedProjectIds).toEqual(["p1"]);
    expect(result.current.projectMatchMode).toBe("all");
    // Remove the last one — mode resets.
    act(() => result.current.handleProjectToggle("p1"));
    expect(result.current.selectedProjectIds).toEqual([]);
    expect(result.current.projectMatchMode).toBe("any");
  });

  it("resets the tag mode to Any when the last tag is deselected", () => {
    const { result } = setup();
    act(() => {
      result.current.handleTagToggle("t1");
      result.current.setTagMatchMode("all");
    });
    act(() => result.current.handleTagToggle("t1"));
    expect(result.current.selectedTagIds).toEqual([]);
    expect(result.current.tagMatchMode).toBe("any");
  });

  it("preserves the mode when reducing from two selections to one", () => {
    const { result } = setup();
    act(() => {
      result.current.handleTagToggle("t1");
      result.current.handleTagToggle("t2");
      result.current.setTagMatchMode("all");
    });
    act(() => result.current.handleTagToggle("t1"));
    expect(result.current.selectedTagIds).toEqual(["t2"]);
    expect(result.current.tagMatchMode).toBe("all");
  });

  it("a mode with zero selected items does not make filters active", () => {
    const { result } = setup();
    act(() => result.current.setProjectMatchMode("all"));
    // No selections anywhere → not active despite a non-default mode.
    expect(result.current.hasActiveFilters).toBe(false);
  });

  it("restores modes via replace setters (preset-load path)", () => {
    const { result } = setup();
    act(() => {
      result.current.replaceSelectedProjectIds(["p1", "p2"]);
      result.current.setProjectMatchMode("all");
    });
    expect(result.current.selectedProjectIds).toEqual(["p1", "p2"]);
    expect(result.current.projectMatchMode).toBe("all");
  });

  // ── Deterministic paginated junction retrieval (PROJECT-TAG-MATCH-MODE-001) ──
  // These integration tests drive the real junction queryFns through the
  // paginated, table-aware mock: they prove cross-page Any/All correctness for
  // both categories, the stable composite ORDER BY, and that a page failure is
  // surfaced (never swallowed into a partial success).

  it("8.1 Project All: resolves a paper whose second membership row is on page 2", async () => {
    // 1001 rows: target/pA at index 0; 999 fillers/pA; target/pB at index 1000.
    const rows: Array<Record<string, string>> = [{ paper_id: "target", project_id: "pA" }];
    for (let i = 1; i < 1000; i++) rows.push({ paper_id: `filler-${i}`, project_id: "pA" });
    rows.push({ paper_id: "target", project_id: "pB" }); // page 2
    setProjectJunctionRows(rows);

    const { result } = setup();
    act(() => {
      result.current.handleProjectToggle("pA");
      result.current.handleProjectToggle("pB");
      result.current.setProjectMatchMode("all");
    });

    await waitFor(() =>
      expect(result.current.serverFilterParams.filterPaperIds).toEqual(["target"]),
    );
    // At least two pages were requested (fresh builder per page).
    expect(rangesFor("paper_projects").length).toBeGreaterThanOrEqual(2);
    expect(rangesFor("paper_projects").some((r) => r.from === 1000)).toBe(true);
  });

  it("8.2 Project Any: includes a paper found only on page 2 (unique output)", async () => {
    // Page 1: 1000 filler papers linked to pA. Page 2: one paper linked to pB.
    const rows: Array<Record<string, string>> = [];
    for (let i = 0; i < 1000; i++) rows.push({ paper_id: `filler-${i}`, project_id: "pA" });
    rows.push({ paper_id: "page2", project_id: "pB" }); // index 1000 → page 2
    setProjectJunctionRows(rows);

    const { result } = setup();
    act(() => {
      result.current.handleProjectToggle("pA");
      result.current.handleProjectToggle("pB");
      // Any is the default; set explicitly for clarity.
      result.current.setProjectMatchMode("any");
    });

    await waitFor(() => {
      const ids = result.current.serverFilterParams.filterPaperIds;
      expect(ids).toBeTruthy();
      expect(ids).toContain("page2");
    });
    const ids = result.current.serverFilterParams.filterPaperIds!;
    expect(new Set(ids).size).toBe(ids.length); // unique
    expect(rangesFor("paper_projects").some((r) => r.from === 1000)).toBe(true);
  });

  it("8.3 Tag All: resolves across pages and excludes a single-tag paper", async () => {
    // Page 1: target-tag/tA (idx0), only-one/tA (idx1), 998 fillers/tA. Page 2:
    // target-tag/tB (idx1000).
    const rows: Array<Record<string, string>> = [
      { paper_id: "target-tag", tag_id: "tA" },
      { paper_id: "only-one", tag_id: "tA" },
    ];
    for (let i = 2; i < 1000; i++) rows.push({ paper_id: `filler-${i}`, tag_id: "tA" });
    rows.push({ paper_id: "target-tag", tag_id: "tB" }); // page 2
    setTagJunctionRows(rows);

    const { result } = setup();
    act(() => {
      result.current.handleTagToggle("tA");
      result.current.handleTagToggle("tB");
      result.current.setTagMatchMode("all");
    });

    await waitFor(() =>
      expect(result.current.serverFilterParams.filterPaperIds).toEqual(["target-tag"]),
    );
    // Tag query used; Project query never issued (no projects selected).
    expect(queriesFor("paper_tags").length).toBeGreaterThan(0);
    expect(queriesFor("paper_projects").length).toBe(0);
    expect(rangesFor("paper_tags").length).toBeGreaterThanOrEqual(2);
  });

  it("8.4 Tag Any: includes a paper found only on page 2", async () => {
    const rows: Array<Record<string, string>> = [];
    for (let i = 0; i < 1000; i++) rows.push({ paper_id: `filler-${i}`, tag_id: "tA" });
    rows.push({ paper_id: "tag-page2", tag_id: "tB" }); // page 2
    setTagJunctionRows(rows);

    const { result } = setup();
    act(() => {
      result.current.handleTagToggle("tA");
      result.current.handleTagToggle("tB");
      result.current.setTagMatchMode("any");
    });

    await waitFor(() =>
      expect(result.current.serverFilterParams.filterPaperIds).toContain("tag-page2"),
    );
    expect(rangesFor("paper_tags").some((r) => r.from === 1000)).toBe(true);
  });

  it("8.5 applies a deterministic composite ORDER BY to the Project query", async () => {
    setProjectJunctionRows([{ paper_id: "p", project_id: "pA" }]);
    const { result } = setup();
    act(() => result.current.handleProjectToggle("pA"));

    await waitFor(() => expect(queriesFor("paper_projects").length).toBeGreaterThan(0));
    const q = queriesFor("paper_projects")[0];
    expect(q.columns).toBe("paper_id, project_id");
    expect(q.inColumn).toBe("project_id");
    expect(q.orders).toEqual([
      { column: "paper_id", ascending: true },
      { column: "project_id", ascending: true },
    ]);
  });

  it("8.6 applies a deterministic composite ORDER BY to the Tag query", async () => {
    setTagJunctionRows([{ paper_id: "p", tag_id: "tA" }]);
    const { result } = setup();
    act(() => result.current.handleTagToggle("tA"));

    await waitFor(() => expect(queriesFor("paper_tags").length).toBeGreaterThan(0));
    const q = queriesFor("paper_tags")[0];
    expect(q.columns).toBe("paper_id, tag_id");
    expect(q.inColumn).toBe("tag_id");
    expect(q.orders).toEqual([
      { column: "paper_id", ascending: true },
      { column: "tag_id", ascending: true },
    ]);
  });

  it("8.7 surfaces a second-page error instead of a partial success", async () => {
    // 1001 rows so a second page is requested; fail that second page.
    const rows: Array<Record<string, string>> = [];
    for (let i = 0; i < 1000; i++) rows.push({ paper_id: `filler-${i}`, project_id: "pA" });
    rows.push({ paper_id: "page2", project_id: "pA" });
    setProjectJunctionRows(rows);
    setErrorOnPage("paper_projects", 1); // second page (from=1000)

    const { result, client } = setup();
    act(() => result.current.handleProjectToggle("pA"));

    // The junction query reaches an error state (page failure not swallowed)…
    await waitFor(() => {
      const q = client
        .getQueryCache()
        .getAll()
        .find((entry) => Array.isArray(entry.queryKey) && entry.queryKey[1] === "paper_projects");
      expect(q?.state.status).toBe("error");
    });
    // …and no partial paper-ID set is exposed as a resolved filter result.
    expect(result.current.serverFilterParams.filterPaperIds).toBeUndefined();
    expect(rangesFor("paper_projects").some((r) => r.from === 1000)).toBe(true);
  });
});
