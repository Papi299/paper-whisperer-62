import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";

// The hook never touches Supabase; the wrapper module it imports types and the
// error class from does. Mocked so this suite needs no client environment.
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

import { isConsensusSearchAvailable, useConsensusSearch, type ConsensusSearchFn } from "../useConsensusSearch";
import { ConsensusSearchError, type ConsensusSearchResponse, type ConsensusSearchResult } from "@/lib/searchConsensusEdge";
import {
  EMPTY_CONSENSUS_FILTER_DRAFT,
  consensusFilterMaxYear,
  type ConsensusFilterDraft,
  type ConsensusStudyType,
} from "@/lib/consensusSearchFilters";

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
      draftFilters: EMPTY_CONSENSUS_FILTER_DRAFT,
      committedQuery: null,
      committedFilters: null,
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

  it("two submissions in the same tick still start exactly one request", () => {
    const { search } = deferredSearch();
    const { result: hook } = renderHook(() => useConsensusSearch(search));
    act(() => hook.current.setDraftQuery("creatine"));
    act(() => {
      hook.current.submitSearch();
      hook.current.submitSearch();
    });
    expect(search).toHaveBeenCalledTimes(1);
  });

  it("a reset releases the in-flight guard, so the reopened dialog can search again", async () => {
    const { search, pending } = deferredSearch();
    const { result: hook } = renderHook(() => useConsensusSearch(search));
    act(() => hook.current.setDraftQuery("first"));
    act(() => hook.current.submitSearch());
    act(() => hook.current.reset());
    act(() => hook.current.setDraftQuery("second"));
    act(() => hook.current.submitSearch());
    expect(search).toHaveBeenCalledTimes(2);

    // The superseded request settling later must not release the newer one's guard.
    await act(async () => {
      pending[0].resolve({ results: RESULTS });
    });
    act(() => hook.current.submitSearch());
    expect(search).toHaveBeenCalledTimes(2);
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

describe("useConsensusSearch — a same-query re-run never leaves an invisible selection", () => {
  it("drops selected DOIs the new page no longer shows, and keeps the ones it still shows", async () => {
    let page: ConsensusSearchResult[] = [result(1, "10.5555/a"), result(2, "10.5555/b")];
    const search = vi.fn<ConsensusSearchFn>(async () => ({ results: page }));
    const { result: hook } = renderHook(() => useConsensusSearch(search));
    act(() => hook.current.setDraftQuery("creatine"));
    await act(async () => {
      hook.current.submitSearch();
    });
    act(() => hook.current.toggleSelection("10.5555/a"));
    act(() => hook.current.toggleSelection("10.5555/b"));

    page = [result(1, "10.5555/B"), result(2, "10.5555/c")];
    await act(async () => {
      hook.current.submitSearch(); // same query, different page
    });

    // a is gone from the page, so it is gone from the selection; b is still
    // shown (as a DOI-equivalent spelling), so it stays.
    expect(hook.current.selectedDois).toEqual(["10.5555/b"]);
  });

  it("keeps the selection when the re-run fails — the old page is still on screen", async () => {
    let fail = false;
    const search = vi.fn<ConsensusSearchFn>(async () => {
      if (fail) throw new ConsensusSearchError("upstream", "down");
      return { results: [result(1, "10.5555/a")] };
    });
    const { result: hook } = renderHook(() => useConsensusSearch(search));
    act(() => hook.current.setDraftQuery("creatine"));
    await act(async () => {
      hook.current.submitSearch();
    });
    act(() => hook.current.toggleSelection("10.5555/a"));
    fail = true;
    await act(async () => {
      hook.current.submitSearch();
    });
    expect(hook.current.selectedDois).toEqual(["10.5555/a"]);
    expect(hook.current.results).toHaveLength(1);
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

// ══════════════════════════════════════════════════════════════════════════
// CONSENSUS-ADVANCED-FILTERS-001A — draft filters, committed filters
// ══════════════════════════════════════════════════════════════════════════

describe("useConsensusSearch — editing filters never searches", () => {
  it("draft filter edits and a filter reset reach nothing: no request, no change on screen", async () => {
    const { hook, search } = await searched();
    act(() => hook.result.current.toggleSelection("10.5555/two"));
    search.mockClear();
    const before = hook.result.current;

    act(() => {
      hook.result.current.setDraftFilters({ yearMin: "2020", yearMax: "2026" });
      hook.result.current.setDraftFilters({ studyTypes: ["rct", "meta-analysis"] });
      hook.result.current.setDraftFilters({ human: true, excludePreprints: true });
    });
    act(() => hook.result.current.resetDraftFilters());

    expect(search).not.toHaveBeenCalled();
    expect(hook.result.current.results).toBe(before.results);
    expect(hook.result.current.selectedDois).toEqual(["10.5555/two"]);
    expect(hook.result.current.committedFilters).toBe(before.committedFilters);
    expect(hook.result.current.committedQuery).toBe("creatine cognition");
  });

  it("resetting filters clears only the filter draft — the question stays, and nothing is searched", async () => {
    const { hook, search } = await searched();
    act(() => hook.result.current.setDraftQuery("a question in progress"));
    act(() => hook.result.current.setDraftFilters({ yearMin: "2020", human: true, studyTypes: ["rct"] }));
    search.mockClear();

    act(() => hook.result.current.resetDraftFilters());

    expect(hook.result.current.draftFilters).toEqual(EMPTY_CONSENSUS_FILTER_DRAFT);
    expect(hook.result.current.draftQuery).toBe("a question in progress");
    expect(hook.result.current.results).toEqual(RESULTS);
    expect(search).not.toHaveBeenCalled();
  });

  it("keeps only allowlisted designs in the draft, once each, in allowlist order", () => {
    const { result: hook } = renderHook(() => useConsensusSearch(vi.fn<ConsensusSearchFn>()));
    act(() =>
      hook.current.setDraftFilters({
        studyTypes: ["cohort study", "RCT", "rct", "rct", "case report"] as unknown as ConsensusStudyType[],
      }),
    );
    expect(hook.current.draftFilters.studyTypes).toEqual(["rct", "cohort study"]);
  });
});

describe("useConsensusSearch — one Search commits one frozen filter snapshot", () => {
  it("sends the draft filters with the question, once, and commits exactly what it sent", async () => {
    const search = vi.fn<ConsensusSearchFn>(async () => ({ results: RESULTS }));
    const { result: hook } = renderHook(() => useConsensusSearch(search));
    act(() => hook.current.setDraftQuery("  creatine cognition  "));
    act(() =>
      hook.current.setDraftFilters({
        yearMin: "2020",
        yearMax: "2026",
        studyTypes: ["meta-analysis", "rct"],
        human: true,
        excludePreprints: true,
      }),
    );
    expect(search).not.toHaveBeenCalled();

    await act(async () => {
      hook.current.submitSearch();
    });

    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith({
      query: "creatine cognition",
      yearMin: 2020,
      yearMax: 2026,
      studyTypes: ["rct", "meta-analysis"],
      human: true,
      excludePreprints: true,
    });
    expect(hook.current.committedFilters).toEqual({
      yearMin: 2020,
      yearMax: 2026,
      studyTypes: ["rct", "meta-analysis"],
      human: true,
      excludePreprints: true,
    });
    expect(Object.isFrozen(hook.current.committedFilters)).toBe(true);
  });

  it("an unfiltered search sends exactly { query } and commits no restriction", async () => {
    const { hook, search } = await searched();
    expect(search).toHaveBeenCalledWith({ query: "creatine cognition" });
    expect(hook.result.current.committedFilters).toEqual({});
  });

  it("later draft edits never reach the committed snapshot", async () => {
    const search = vi.fn<ConsensusSearchFn>(async () => ({ results: RESULTS }));
    const { result: hook } = renderHook(() => useConsensusSearch(search));
    act(() => hook.current.setDraftQuery("creatine"));
    act(() => hook.current.setDraftFilters({ yearMin: "2020", studyTypes: ["rct"] }));
    await act(async () => {
      hook.current.submitSearch();
    });
    const committed = hook.current.committedFilters;

    act(() => hook.current.setDraftFilters({ yearMin: "2001", studyTypes: ["cohort study"], human: true }));

    expect(hook.current.committedFilters).toBe(committed);
    expect(hook.current.committedFilters).toEqual({ yearMin: 2020, studyTypes: ["rct"] });
  });

  it.each([
    ["a year below the floor", { yearMin: "1800" }],
    ["a year past the ceiling", { yearMax: String(consensusFilterMaxYear() + 1) }],
    ["a half-typed year", { yearMin: "20" }],
    ["a reversed range", { yearMin: "2024", yearMax: "2020" }],
  ])("never sends %s — no request, nothing committed", (_label, years) => {
    const search = vi.fn<ConsensusSearchFn>();
    const { result: hook } = renderHook(() => useConsensusSearch(search));
    act(() => hook.current.setDraftQuery("creatine"));
    act(() => hook.current.setDraftFilters(years));
    act(() => hook.current.submitSearch());
    expect(search).not.toHaveBeenCalled();
    expect(hook.current).toMatchObject({ loading: false, committedQuery: null, committedFilters: null });
  });
});

describe("useConsensusSearch — the same question under different filters is a new search", () => {
  /** Search once with `initial` filters, select a DOI, then apply `change` and search again. */
  async function changedSearch(initial: Partial<ConsensusFilterDraft>, change: Partial<ConsensusFilterDraft>) {
    const { search, pending } = deferredSearch();
    const { result: hook } = renderHook(() => useConsensusSearch(search));
    act(() => hook.current.setDraftQuery("creatine"));
    act(() => hook.current.setDraftFilters(initial));
    act(() => hook.current.submitSearch());
    await act(async () => {
      pending[0].resolve({ results: RESULTS });
    });
    act(() => hook.current.toggleSelection("10.5555/two"));

    act(() => hook.current.setDraftFilters(change));
    act(() => hook.current.submitSearch());
    return { hook, search, pending };
  }

  it.each([
    ["the year changes", { yearMin: "2020" }, { yearMin: "2021" }],
    ["a year is added", {}, { yearMax: "2024" }],
    ["a study design is added", { studyTypes: ["rct"] as const }, { studyTypes: ["rct", "meta-analysis"] as const }],
    ["a study design is removed", { studyTypes: ["rct", "meta-analysis"] as const }, { studyTypes: ["rct"] as const }],
    ["human-only is toggled on", {}, { human: true }],
    ["human-only is toggled off", { human: true }, { human: false }],
    ["preprint exclusion is toggled on", {}, { excludePreprints: true }],
    ["preprint exclusion is toggled off", { excludePreprints: true }, { excludePreprints: false }],
  ])("when %s: one new request, and the old results and selection go at once", async (_label, initial, change) => {
    const { hook, search } = await changedSearch(initial, change);

    expect(search).toHaveBeenCalledTimes(2);
    expect(search.mock.calls[1][0].query).toBe("creatine");
    // The superseded search's cards and selection are gone while the new one runs.
    expect(hook.current).toMatchObject({ loading: true, results: null, selectedDois: [] });
  });

  it("several filter changes before one Search press make ONE request carrying all of them", async () => {
    const { hook, search, pending } = await changedSearch({ yearMin: "2020" }, { yearMin: "2015" });
    await act(async () => {
      pending[1].resolve({ results: RESULTS });
    });
    search.mockClear();

    act(() => {
      hook.current.setDraftFilters({ yearMax: "2024" });
      hook.current.setDraftFilters({ studyTypes: ["systematic review"] });
      hook.current.setDraftFilters({ human: true });
      hook.current.setDraftFilters({ excludePreprints: true });
    });
    expect(search).not.toHaveBeenCalled();
    act(() => hook.current.submitSearch());

    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith({
      query: "creatine",
      yearMin: 2015,
      yearMax: 2024,
      studyTypes: ["systematic review"],
      human: true,
      excludePreprints: true,
    });
  });

  it("re-running the same question under the SAME filters keeps the selection (the V1 rule)", async () => {
    const search = vi.fn<ConsensusSearchFn>(async () => ({ results: RESULTS }));
    const { result: hook } = renderHook(() => useConsensusSearch(search));
    act(() => hook.current.setDraftQuery("creatine"));
    act(() => hook.current.setDraftFilters({ yearMin: "2020", studyTypes: ["rct"] }));
    await act(async () => {
      hook.current.submitSearch();
    });
    act(() => hook.current.toggleSelection("10.5555/two"));

    // Edit away and back: the same restriction, so the same search.
    act(() => hook.current.setDraftFilters({ yearMin: "2021" }));
    act(() => hook.current.setDraftFilters({ yearMin: " 2020 " }));
    await act(async () => {
      hook.current.submitSearch();
    });

    expect(search).toHaveBeenCalledTimes(2);
    expect(hook.current.selectedDois).toEqual(["10.5555/two"]);
  });

  it("the results always carry the snapshot of the search that produced them", async () => {
    const { hook, pending } = await changedSearch({ yearMin: "2020" }, { yearMin: "2015", human: true });
    const newer = [result(1, "10.5555/newer")];
    await act(async () => {
      pending[1].resolve({ results: newer });
    });
    expect(hook.current.results).toEqual(newer);
    expect(hook.current.committedFilters).toEqual({ yearMin: 2015, human: true });
  });
});

describe("useConsensusSearch — filters across close and stale responses", () => {
  it("closing the dialog during a pending filtered search discards its answer and clears the filters", async () => {
    const { search, pending } = deferredSearch();
    const { result: hook } = renderHook(() => useConsensusSearch(search));
    act(() => hook.current.setDraftQuery("creatine"));
    act(() => hook.current.setDraftFilters({ yearMin: "2020", studyTypes: ["rct"], excludePreprints: true }));
    act(() => hook.current.submitSearch());

    act(() => hook.current.reset());
    await act(async () => {
      pending[0].resolve({ results: RESULTS });
    });

    expect(hook.current).toMatchObject({
      draftQuery: "",
      draftFilters: EMPTY_CONSENSUS_FILTER_DRAFT,
      committedQuery: null,
      committedFilters: null,
      results: null,
      loading: false,
    });
  });

  it("an older filtered response cannot overwrite a newer search's results or snapshot", async () => {
    const { search, pending } = deferredSearch();
    const { result: hook } = renderHook(() => useConsensusSearch(search));
    act(() => hook.current.setDraftQuery("creatine"));
    act(() => hook.current.setDraftFilters({ yearMin: "2020" }));
    act(() => hook.current.submitSearch());
    act(() => hook.current.reset());
    act(() => hook.current.setDraftQuery("creatine"));
    act(() => hook.current.setDraftFilters({ studyTypes: ["cohort study"] }));
    act(() => hook.current.submitSearch());

    const newer = [result(1, "10.5555/newer")];
    await act(async () => {
      pending[1].resolve({ results: newer });
    });
    await act(async () => {
      pending[0].resolve({ results: RESULTS });
    });

    expect(hook.current.results).toEqual(newer);
    expect(hook.current.committedFilters).toEqual({ studyTypes: ["cohort study"] });
  });

  it("an error from an older filtered search is discarded too", async () => {
    const { search, pending } = deferredSearch();
    const { result: hook } = renderHook(() => useConsensusSearch(search));
    act(() => hook.current.setDraftQuery("creatine"));
    act(() => hook.current.setDraftFilters({ human: true }));
    act(() => hook.current.submitSearch());
    act(() => hook.current.reset());
    await act(async () => {
      pending[0].reject(new ConsensusSearchError("filters_not_allowed", "refused"));
    });
    expect(hook.current.error).toBeNull();
  });

  it("does not retry a refused filtered search — with or without the filters", async () => {
    const search = vi.fn<ConsensusSearchFn>(async () => {
      throw new ConsensusSearchError("filters_not_allowed", "Consensus did not allow this filtered search.");
    });
    const { result: hook } = renderHook(() => useConsensusSearch(search));
    act(() => hook.current.setDraftQuery("creatine"));
    act(() => hook.current.setDraftFilters({ studyTypes: ["rct"] }));
    await act(async () => {
      hook.current.submitSearch();
    });
    expect(search).toHaveBeenCalledTimes(1);
    expect(hook.current.error).toEqual({
      kind: "filters_not_allowed",
      message: "Consensus did not allow this filtered search.",
    });
    // The filters the owner chose are still set: nothing quietly dropped them.
    expect(hook.current.draftFilters.studyTypes).toEqual(["rct"]);
  });
});
