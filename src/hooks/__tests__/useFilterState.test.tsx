import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Mock the Supabase client with a paginated PostgREST-style builder. `.range()`
// returns a slice of a shared, per-test row set, so `fetchAllPages` walks real
// page boundaries. The state-machine tests never await a query (they assert
// synchronous transitions), so the default empty row set is inert for them; the
// pagination test drives the junction query to resolution against >1 page.
const { setJunctionRows, mockFrom, mockRpc } = vi.hoisted(() => {
  let rows: Array<Record<string, string>> = [];
  const makeBuilder = () => {
    const builder = {
      select: () => builder,
      in: () => builder,
      range: (from: number, to: number) =>
        Promise.resolve({ data: rows.slice(from, to + 1), error: null }),
    };
    return builder;
  };
  return {
    setJunctionRows: (r: Array<Record<string, string>>) => {
      rows = r;
    },
    mockFrom: vi.fn(() => makeBuilder()),
    mockRpc: vi.fn(() => Promise.resolve({ data: [], error: null })),
  };
});

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: mockFrom, rpc: mockRpc },
}));

import { useFilterState } from "../useFilterState";

/**
 * These tests exercise the fully-synchronous match-mode state machine. The
 * junction *query* semantics (Any union / All membership-count) live in the
 * pure `resolveJunctionPaperIds` helper and are covered exhaustively in
 * `filterSets.test.ts`; here we assert the hook's mode/selection transitions.
 */
function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function setup() {
  return renderHook(() => useFilterState({ poolStudyTypes: [], userId: undefined }), {
    wrapper,
  });
}

describe("useFilterState — match modes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setJunctionRows([]);
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

  // ── Junction pagination (PROJECT-TAG-MATCH-MODE-001A) ──
  // Regression guard: the junction fetch must paginate. A paper whose second
  // required membership row lands beyond the first PostgREST page (>1000 rows)
  // must still resolve under All mode — an unpaginated `.in(...)` would only see
  // page one and falsely reject it.
  it("resolves All against junction rows spanning more than one page", async () => {
    // 1001 rows: "target" is linked to pA at index 0 and pB at index 1000; the
    // 999 filler papers (indices 1..999) are linked only to pA.
    const rows: Array<Record<string, string>> = [
      { paper_id: "target", project_id: "pA" },
    ];
    for (let i = 1; i < 1000; i++) {
      rows.push({ paper_id: `filler-${i}`, project_id: "pA" });
    }
    rows.push({ paper_id: "target", project_id: "pB" }); // index 1000 → page 2
    setJunctionRows(rows);

    const { result } = setup();
    act(() => {
      result.current.handleProjectToggle("pA");
      result.current.handleProjectToggle("pB");
      result.current.setProjectMatchMode("all");
    });

    // Only "target" is linked to BOTH pA and pB, and pB is only visible after
    // the second page is fetched.
    await waitFor(() =>
      expect(result.current.serverFilterParams.filterPaperIds).toEqual(["target"]),
    );
  });
});
