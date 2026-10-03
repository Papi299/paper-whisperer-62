import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";

// The hook never touches Supabase; the wrapper module it imports types and the
// error class from does. Mocked so this suite needs no client environment.
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

import { isConsensusSearchAvailable, useConsensusSearch, type ConsensusSearchFn } from "../useConsensusSearch";
import { ConsensusSearchError, type ConsensusSearchResponse, type ConsensusSearchResult } from "@/lib/searchConsensusEdge";

/**
 * CONSENSUS-SEARCH-MVP-001A — the dialog-owned Consensus discovery state.
 *
 * The properties that matter most are about what does NOT happen: no action
 * other than an explicit search reaches Consensus, a second search cannot start
 * while one is in flight, a late response cannot repopulate a reset session,
 * and two DOI-equivalent results can never become two import identifiers.
 */

function result(rank: number, importDoi: string | null, overrides: Partial<ConsensusSearchResult> = {}): ConsensusSearchResult {
  return {
    rank,
    title: `Paper ${rank}`,
    authors: ["Ada Fixture"],
    journal: "Journal of Synthetic Fixtures",
    year: 2024,
    abstract: "An invented abstract.",
    citationCount: 3,
    studyType: "rct",
    takeaway: "Synthetic takeaway.",
    consensusUrl: null,
    importDoi,
    ...overrides,
  };
}

const RESULTS: ConsensusSearchResult[] = [
  result(1, "10.5555/A.One"),
  result(2, null),
  result(3, "10.5555/a.one"), // DOI-equivalent to rank 1 (ASCII case only)
  result(4, "10.5555/two"),
];

/** A search whose promises the test resolves or rejects by hand. */
function deferredSearch() {
  const pending: Array<{ resolve(r: ConsensusSearchResponse): void; reject(e: unknown): void }> = [];
  const search = vi.fn<ConsensusSearchFn>(
    () =>
      new Promise<ConsensusSearchResponse>((resolve, reject) => {
        pending.push({ resolve, reject });
      }),
  );
  return { search, pending };
}

async function searched(results: ConsensusSearchResult[] = RESULTS) {
  const search = vi.fn<ConsensusSearchFn>(async () => ({ results }));
  const hook = renderHook(() => useConsensusSearch(search));
  act(() => hook.result.current.setDraftQuery("creatine cognition"));
  await act(async () => {
    hook.result.current.submitSearch();
  });
  return { hook, search };
}

describe("useConsensusSearch — what can and cannot reach Consensus", () => {
  it("starts empty and idle", () => {
    const { result: hook } = renderHook(() => useConsensusSearch(vi.fn()));
    expect(hook.current).toMatchObject({
      draftQuery: "",
      committedQuery: null,
      results: null,
      selectedDois: [],
      loading: false,
      error: null,
    });
  });

  it("searches only on submit, once, with exactly the trimmed query", async () => {
    const search = vi.fn<ConsensusSearchFn>(async () => ({ results: RESULTS }));
    const { result: hook } = renderHook(() => useConsensusSearch(search));

    act(() => hook.current.setDraftQuery("  creatine cognition  "));
    expect(search).not.toHaveBeenCalled();

    await act(async () => {
      hook.current.submitSearch();
    });

    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith({ query: "creatine cognition" });
    expect(hook.current).toMatchObject({ committedQuery: "creatine cognition", loading: false, results: RESULTS });
  });

  it("never searches from typing, selecting, clearing, importing or resetting", async () => {
    const { hook, search } = await searched();
    search.mockClear();

    act(() => {
      hook.result.current.setDraftQuery("something else entirely");
      hook.result.current.toggleSelection("10.5555/two");
      hook.result.current.selectAllImportable();
      hook.result.current.clearSelection();
      hook.result.current.clearImported(["10.5555/two"]);
      hook.result.current.reset();
    });

    expect(search).not.toHaveBeenCalled();
  });

  it("does not start a second request while one is in flight", () => {
    const { search } = deferredSearch();
    const { result: hook } = renderHook(() => useConsensusSearch(search));
    act(() => hook.current.setDraftQuery("creatine"));
    act(() => hook.current.submitSearch());
    expect(hook.current.loading).toBe(true);

    act(() => hook.current.submitSearch());
    act(() => hook.current.setDraftQuery("a different query"));
    act(() => hook.current.submitSearch());

    expect(search).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["an empty draft", ""],
    ["a whitespace draft", "   "],
    ["a draft over the 500-character bound", "q".repeat(501)],
  ])("does not search %s", (_label, draft) => {
    const search = vi.fn<ConsensusSearchFn>();
    const { result: hook } = renderHook(() => useConsensusSearch(search));
    act(() => hook.current.setDraftQuery(draft));
    act(() => hook.current.submitSearch());
    expect(search).not.toHaveBeenCalled();
    expect(hook.current.loading).toBe(false);
  });

  it("is inert without a search callback", () => {
    const { result: hook } = renderHook(() => useConsensusSearch(undefined));
    act(() => hook.current.setDraftQuery("creatine"));
    act(() => hook.current.submitSearch());
    expect(hook.current).toMatchObject({ loading: false, committedQuery: null });
  });
});

describe("useConsensusSearch — stale responses", () => {
  it("a response arriving after reset does not repopulate the session", async () => {
    const { search, pending } = deferredSearch();
    const { result: hook } = renderHook(() => useConsensusSearch(search));
    act(() => hook.current.setDraftQuery("creatine"));
    act(() => hook.current.submitSearch());

    act(() => hook.current.reset());
    await act(async () => {
      pending[0].resolve({ results: RESULTS });
    });

    expect(hook.current).toMatchObject({ results: null, committedQuery: null, loading: false, draftQuery: "" });
  });

  it("an error arriving after reset is discarded too", async () => {
    const { search, pending } = deferredSearch();
    const { result: hook } = renderHook(() => useConsensusSearch(search));
    act(() => hook.current.setDraftQuery("creatine"));
    act(() => hook.current.submitSearch());
    act(() => hook.current.reset());
    await act(async () => {
      pending[0].reject(new ConsensusSearchError("rate_limited", "slow down"));
    });
    expect(hook.current.error).toBeNull();
  });

  it("a response from before a reset cannot overwrite a newer search's results", async () => {
    const { search, pending } = deferredSearch();
    const { result: hook } = renderHook(() => useConsensusSearch(search));
    act(() => hook.current.setDraftQuery("first"));
    act(() => hook.current.submitSearch());
    act(() => hook.current.reset());
    act(() => hook.current.setDraftQuery("second"));
    act(() => hook.current.submitSearch());

    const newer = [result(1, "10.5555/newer")];
    await act(async () => {
      pending[1].resolve({ results: newer });
    });
    await act(async () => {
      pending[0].resolve({ results: RESULTS });
    });

    expect(hook.current.committedQuery).toBe("second");
    expect(hook.current.results).toEqual(newer);
  });
});

describe("useConsensusSearch — errors and re-runs", () => {
  it("keeps the typed error kind and message", async () => {
    const search = vi.fn<ConsensusSearchFn>(async () => {
      throw new ConsensusSearchError("quota_exhausted", "The connected Consensus API allowance has been used up.");
    });
    const { result: hook } = renderHook(() => useConsensusSearch(search));
    act(() => hook.current.setDraftQuery("creatine"));
    await act(async () => {
      hook.current.submitSearch();
    });
    expect(hook.current.error).toEqual({
      kind: "quota_exhausted",
      message: "The connected Consensus API allowance has been used up.",
    });
    expect(hook.current.loading).toBe(false);
  });

  it("describes a non-typed failure generically", async () => {
    const search = vi.fn<ConsensusSearchFn>(async () => {
      throw new Error("raw internal detail");
    });
    const { result: hook } = renderHook(() => useConsensusSearch(search));
    act(() => hook.current.setDraftQuery("creatine"));
    await act(async () => {
      hook.current.submitSearch();
    });
    expect(hook.current.error).toEqual({ kind: "unexpected", message: "Consensus search failed. Please try again." });
  });

  it("does not retry a failure — the owner must press Search again", async () => {
    const search = vi.fn<ConsensusSearchFn>(async () => {
      throw new ConsensusSearchError("upstream", "Consensus could not be reached right now.");
    });
    const { result: hook } = renderHook(() => useConsensusSearch(search));
    act(() => hook.current.setDraftQuery("creatine"));
    await act(async () => {
      hook.current.submitSearch();
    });
    expect(search).toHaveBeenCalledTimes(1);
  });

  it("a new query clears the previous results and selection; the same query keeps the selection", async () => {
    const { hook, search } = await searched();
    act(() => hook.result.current.toggleSelection("10.5555/two"));

    await act(async () => {
      hook.result.current.submitSearch(); // same query, deliberate re-run
    });
    expect(search).toHaveBeenCalledTimes(2);
    expect(hook.result.current.selectedDois).toEqual(["10.5555/two"]);

    act(() => hook.result.current.setDraftQuery("a different question"));
    await act(async () => {
      hook.result.current.submitSearch();
    });
    expect(hook.result.current.committedQuery).toBe("a different question");
    expect(hook.result.current.selectedDois).toEqual([]);
  });
});

describe("useConsensusSearch — selection", () => {
  it("toggles an importable DOI on and off", async () => {
    const { hook } = await searched();
    act(() => hook.result.current.toggleSelection("10.5555/two"));
    expect(hook.result.current.selectedDois).toEqual(["10.5555/two"]);
    act(() => hook.result.current.toggleSelection("10.5555/two"));
    expect(hook.result.current.selectedDois).toEqual([]);
  });

  it.each([
    ["a non-DOI", "not a doi"],
    ["a prefix-only DOI", "10.5555"],
    ["a doi: presentation form", "doi:10.5555/two"],
    ["a resolver URL", "https://doi.org/10.5555/two"],
    ["a DOI with whitespace", "10.5555/t wo"],
  ])("refuses to select %s", async (_label, value) => {
    const { hook } = await searched();
    act(() => hook.result.current.toggleSelection(value));
    expect(hook.result.current.selectedDois).toEqual([]);
  });

  it("treats DOI-equivalent spellings as ONE selection, keeping the first spelling", async () => {
    const { hook } = await searched();
    act(() => hook.result.current.toggleSelection("10.5555/A.One"));
    act(() => hook.result.current.toggleSelection("10.5555/a.one")); // same DOI, other spelling → deselects
    expect(hook.result.current.selectedDois).toEqual([]);

    act(() => hook.result.current.toggleSelection("10.5555/a.one"));
    act(() => hook.result.current.selectAllImportable());
    expect(hook.result.current.selectedDois).toEqual(["10.5555/a.one", "10.5555/two"]);
  });

  it("select-all adds only importable results, once per DOI, in result order", async () => {
    const { hook } = await searched();
    act(() => hook.result.current.selectAllImportable());
    // Rank 2 has no DOI; rank 3 is DOI-equivalent to rank 1 and is not added twice.
    expect(hook.result.current.selectedDois).toEqual(["10.5555/A.One", "10.5555/two"]);
    act(() => hook.result.current.selectAllImportable());
    expect(hook.result.current.selectedDois).toEqual(["10.5555/A.One", "10.5555/two"]);
  });

  it("select-all skips a result whose importDoi does not re-validate", async () => {
    const { hook } = await searched([result(1, "doi:10.5555/forged"), result(2, "10.5555/real")]);
    act(() => hook.result.current.selectAllImportable());
    expect(hook.result.current.selectedDois).toEqual(["10.5555/real"]);
  });

  it("clearSelection empties the selection without touching results", async () => {
    const { hook } = await searched();
    act(() => hook.result.current.selectAllImportable());
    act(() => hook.result.current.clearSelection());
    expect(hook.result.current.selectedDois).toEqual([]);
    expect(hook.result.current.results).toEqual(RESULTS);
  });

  it("clearImported removes exactly the imported DOIs, matched by DOI equivalence", async () => {
    const { hook } = await searched([result(1, "10.5555/A.One"), result(2, "10.5555/two"), result(3, "10.5555/three")]);
    act(() => hook.result.current.selectAllImportable());
    act(() => hook.result.current.clearImported(["10.5555/a.ONE", "10.5555/three"]));
    expect(hook.result.current.selectedDois).toEqual(["10.5555/two"]);
  });

  it("reset clears the selection, the results, the error and the drafts", async () => {
    const { hook } = await searched();
    act(() => hook.result.current.selectAllImportable());
    act(() => hook.result.current.reset());
    expect(hook.result.current).toMatchObject({
      draftQuery: "",
      committedQuery: null,
      results: null,
      selectedDois: [],
      loading: false,
      error: null,
    });
  });
});

describe("isConsensusSearchAvailable — the Dashboard's advisory owner gate", () => {
  const resolved = (role: string) => ({ access: { role }, isLoading: false, isError: false });

  it("offers Consensus to a resolved owner", () => {
    expect(isConsensusSearchAvailable(resolved("owner"))).toBe(true);
  });

  it.each(["manager", "user", "Owner", "owner ", ""])("withholds it from role %j", (role) => {
    expect(isConsensusSearchAvailable(resolved(role))).toBe(false);
  });

  it("fails closed while the access lookup is loading, even if a stale owner value is present", () => {
    expect(isConsensusSearchAvailable({ access: { role: "owner" }, isLoading: true, isError: false })).toBe(false);
  });

  it("fails closed when the access lookup failed, even if a stale owner value is present", () => {
    expect(isConsensusSearchAvailable({ access: { role: "owner" }, isLoading: false, isError: true })).toBe(false);
  });
});
