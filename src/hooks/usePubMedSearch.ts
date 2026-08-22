/**
 * Ephemeral PubMed discovery state for one Add Papers session.
 *
 * Deliberately plain React state, not TanStack Query and not a store. This
 * search is explicit, modal, user-driven and short-lived: there is nothing to
 * revalidate in the background, nothing another component reads, and caching a
 * PubMed page across sessions would only serve stale external data. A local
 * request state machine is both simpler and a better fit for the two behaviours
 * that actually matter here — stale-response rejection and a single in-flight
 * page request.
 *
 * It lives in a hook rather than inside `PubMedSearchPanel` because Radix
 * unmounts an inactive `TabsContent`: the identifier and file runs already keep
 * their state in `AddPaperDialog` for exactly that reason, and PubMed discovery
 * follows the same rule, so switching to Import IDs and back preserves the
 * query, the page and the selection. Closing the dialog resets everything.
 *
 * Nothing here writes to the library. The selected PMIDs are the only thing
 * that leaves, and they leave through the existing canonical importer.
 */

import { useCallback, useRef, useState } from "react";
import {
  PubMedSearchError,
  PUBMED_SEARCH_MAX_REACHABLE,
  PUBMED_SEARCH_PAGE_SIZE,
  type PubMedSearchPage,
  type PubMedSearchRequest,
} from "@/lib/searchPubMedEdge";

/** The Edge-backed search, injected so the dialog stays callback-oriented. */
export type PubMedSearchFn = (request: PubMedSearchRequest) => Promise<PubMedSearchPage>;

export interface PubMedSearchErrorState {
  kind: PubMedSearchError["kind"];
  message: string;
}

export interface PubMedSearchState {
  /** What is currently typed. Changing it fetches nothing and clears nothing. */
  draftQuery: string;
  /** The query whose results are on screen (or whose brand-new attempt failed). */
  committedQuery: string | null;
  /** The displayed page, or `null` before the first successful search. */
  page: PubMedSearchPage | null;
  /** Selected PMIDs across every page of the committed query, in import order. */
  selectedPmids: string[];
  loading: boolean;
  error: PubMedSearchErrorState | null;
}

export interface PubMedSearchActions {
  setDraftQuery(value: string): void;
  /** Run the draft query. Page 1; a materially different query clears selection. */
  submitSearch(): void;
  /** Move by whole pages within the committed query. Selection is preserved. */
  goToPage(direction: -1 | 1): void;
  toggleSelection(pmid: string): void;
  /** Add every unselected PMID on the current page, in PubMed result order. */
  selectAllOnPage(): void;
  /** Remove only the current page's PMIDs; selections on other pages remain. */
  clearPageSelection(): void;
  clearSelection(): void;
  /** Drop exactly the PMIDs a completed import consumed. */
  clearImported(pmids: string[]): void;
  /** Full reset — also invalidates any in-flight response. */
  reset(): void;
}

const EMPTY_STATE: PubMedSearchState = {
  draftQuery: "",
  committedQuery: null,
  page: null,
  selectedPmids: [],
  loading: false,
  error: null,
};

function toErrorState(error: unknown): PubMedSearchErrorState {
  if (error instanceof PubMedSearchError) {
    return { kind: error.kind, message: error.message };
  }
  return { kind: "unexpected", message: "PubMed search failed. Please try again." };
}

export function usePubMedSearch(search?: PubMedSearchFn): PubMedSearchState & PubMedSearchActions {
  const [state, setState] = useState<PubMedSearchState>(EMPTY_STATE);

  /**
   * Monotonic request generation. Every request captures the value it was
   * issued under and applies its result only while that value is still current.
   *
   * One counter covers all three staleness cases, and covers them
   * deterministically rather than by waiting: a newer query, a newer page, and
   * a dialog close/reset each bump it, so a response that arrives afterwards is
   * discarded instead of repopulating a session the user has already moved on
   * from. There is no timer anywhere in this file.
   */
  const generation = useRef(0);
  /** Mirrors `state` for the callbacks that must read it without re-creating. */
  const stateRef = useRef(state);
  stateRef.current = state;

  const run = useCallback(
    (query: string, offset: number, options: { clearResults: boolean; clearSelection: boolean }) => {
      if (!search) return;

      const requestId = ++generation.current;

      setState((prev) => ({
        ...prev,
        committedQuery: query,
        // A different query's results must not sit under the new query's
        // heading, so they go at submit time. A same-query refresh or a page
        // move keeps the valid page on screen until the new one arrives, so a
        // failed Next never destroys results the user could still use.
        page: options.clearResults ? null : prev.page,
        selectedPmids: options.clearSelection ? [] : prev.selectedPmids,
        loading: true,
        error: null,
      }));

      void search({ query, offset, limit: PUBMED_SEARCH_PAGE_SIZE })
        .then((page) => {
          if (generation.current !== requestId) return;
          setState((prev) => ({ ...prev, page, loading: false, error: null }));
        })
        .catch((error: unknown) => {
          if (generation.current !== requestId) return;
          setState((prev) => ({ ...prev, loading: false, error: toErrorState(error) }));
        });
    },
    [search],
  );

  const setDraftQuery = useCallback((value: string) => {
    setState((prev) => ({ ...prev, draftQuery: value }));
  }, []);

  const submitSearch = useCallback(() => {
    const current = stateRef.current;
    // One in-flight request at a time. The running request belongs to the query
    // that was submitted, and the input's current text has no say in what its
    // response means.
    if (current.loading) return;

    const query = current.draftQuery.trim();
    if (query.length === 0) return;

    // A materially different query is a new search: page 1, and the previous
    // selection goes with the results it came from — selections from unrelated
    // searches are never silently mixed into one import. Re-submitting the same
    // query is an explicit refresh of that query: it also returns to page 1, but
    // the already-selected PMIDs are stable identifiers and are kept.
    const isNewQuery = query !== current.committedQuery;
    run(query, 0, { clearResults: isNewQuery, clearSelection: isNewQuery });
  }, [run]);

  const goToPage = useCallback(
    (direction: -1 | 1) => {
      const current = stateRef.current;
      // A second page request cannot start while one is in flight, so a slower
      // page N can never overwrite a newer page N+1.
      if (current.loading || !current.page || !current.committedQuery) return;

      const nextOffset = current.page.offset + direction * PUBMED_SEARCH_PAGE_SIZE;
      // Bounded by the result set AND by how far PubMed will page: ESearch
      // refuses a `retstart` above 9998, so a query with 200,000 matches still
      // stops at the 9,999th. Asking anyway would earn a 400, so the button
      // that would do it is disabled instead — see `canGoNext` in the panel.
      if (nextOffset < 0 || nextOffset >= current.page.total) return;
      if (nextOffset >= PUBMED_SEARCH_MAX_REACHABLE) return;

      run(current.committedQuery, nextOffset, { clearResults: false, clearSelection: false });
    },
    [run],
  );

  const toggleSelection = useCallback((pmid: string) => {
    setState((prev) => ({
      ...prev,
      selectedPmids: prev.selectedPmids.includes(pmid)
        ? prev.selectedPmids.filter((id) => id !== pmid)
        : [...prev.selectedPmids, pmid],
    }));
  }, []);

  const selectAllOnPage = useCallback(() => {
    setState((prev) => {
      if (!prev.page) return prev;
      // Appended in PubMed result order, and only the ones not already chosen —
      // so the import order stays deterministic and no PMID is added twice.
      const additions = prev.page.results
        .map((result) => result.pmid)
        .filter((pmid) => !prev.selectedPmids.includes(pmid));
      if (additions.length === 0) return prev;
      return { ...prev, selectedPmids: [...prev.selectedPmids, ...additions] };
    });
  }, []);

  const clearPageSelection = useCallback(() => {
    setState((prev) => {
      if (!prev.page) return prev;
      const onPage = new Set(prev.page.results.map((result) => result.pmid));
      return { ...prev, selectedPmids: prev.selectedPmids.filter((pmid) => !onPage.has(pmid)) };
    });
  }, []);

  const clearSelection = useCallback(() => {
    setState((prev) => (prev.selectedPmids.length === 0 ? prev : { ...prev, selectedPmids: [] }));
  }, []);

  const clearImported = useCallback((pmids: string[]) => {
    const imported = new Set(pmids);
    setState((prev) => ({
      ...prev,
      selectedPmids: prev.selectedPmids.filter((pmid) => !imported.has(pmid)),
    }));
  }, []);

  const reset = useCallback(() => {
    // Bumping the generation is the point: a response still in flight when the
    // dialog closes must not repopulate the reopened dialog.
    generation.current++;
    setState(EMPTY_STATE);
  }, []);

  return {
    ...state,
    setDraftQuery,
    submitSearch,
    goToPage,
    toggleSelection,
    selectAllOnPage,
    clearPageSelection,
    clearSelection,
    clearImported,
    reset,
  };
}
