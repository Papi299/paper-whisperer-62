import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Mock the Supabase client so importing the hook does not spin up the real
// auth client. No query in these tests is ever `enabled` (no userId, no
// selections until we toggle synchronously), so `from`/`rpc` are never called;
// the mock exists purely to satisfy the import graph.
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
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
  beforeEach(() => vi.clearAllMocks());

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
});
