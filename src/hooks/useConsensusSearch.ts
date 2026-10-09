/**
 * Ephemeral Consensus discovery state for one Add Papers session.
 *
 * The sibling of `usePubMedSearch`, built the same way and for the same
 * reasons: plain React state (nothing to revalidate, nothing shared, nothing
 * worth caching across sessions), owned by `AddPaperDialog` rather than the
 * panel so that switching the Search source or the top-level mode preserves
 * the work in progress, and reset when the dialog closes.
 *
 * ## Quota-conscious by construction
 *
 * The owner's Consensus allowance is small and every search may spend part of
 * it, so the ONLY thing in this file that can cause a request is
 * {@link ConsensusSearchActions.submitSearch} — called from an explicit Search
 * press. Typing, editing or resetting filters, switching sources, selecting,
 * importing and resetting never search. There is one result page and no
 * pagination, one request in flight at a time, and no retry: a failed search
 * stays failed until the owner presses Search again.
 *
 * ## Draft filters, committed filters (CONSENSUS-ADVANCED-FILTERS-001A)
 *
 * The advanced filters exist twice. `draftFilters` is what the owner is
 * editing; changing it searches nothing and touches nothing on screen.
 * `committedFilters` is the frozen snapshot taken when Search was pressed, sent
 * with that search, and the only thing its results are ever described with. A
 * search's identity is its question AND its filters: the same question under
 * different filters is a new search, whose predecessor's results and selection
 * go — exactly as a new question's do.
 *
 * ## Selection is keyed by DOI equivalence
 *
 * The only selectable value is a result's validated `importDoi`. Selection is
 * keyed by its DOI-equivalence key (ASCII case-folding, DOI Handbook §4.3.4),
 * so two results whose DOIs differ only in letter case occupy ONE slot and can
 * never become two import identifiers. The first spelling selected is the one
 * kept and later imported; nothing is rewritten.
 *
 * Nothing here writes to the library. Selected DOI strings are the only thing
 * that leaves, and they leave through the existing canonical importer.
 */

import { useCallback, useRef, useState } from "react";
import {
  CONSENSUS_SEARCH_MAX_QUERY_LENGTH,
  ConsensusSearchError,
  consensusSelectionKey,
  toImportableDoi,
  type ConsensusSearchErrorKind,
  type ConsensusSearchRequest,
  type ConsensusSearchResponse,
  type ConsensusSearchResult,
} from "@/lib/searchConsensusEdge";
import {
  EMPTY_CONSENSUS_FILTER_DRAFT,
  canonicalStudyTypes,
  sameAppliedFilters,
  validateConsensusFilterDraft,
  type ConsensusAppliedFilters,
  type ConsensusFilterDraft,
} from "@/lib/consensusSearchFilters";

/** The Edge-backed search, injected so the dialog stays callback-oriented. */
export type ConsensusSearchFn = (request: ConsensusSearchRequest) => Promise<ConsensusSearchResponse>;

/**
 * The ADVISORY gate for offering Consensus in the UI, from the
 * `useCurrentUserAccess` result: resolved, not failed, and role exactly
 * `owner`. Loading and error fail closed, and so does every other role —
 * a manager included. The `search-consensus` Edge Function re-checks the role
 * server-side on every request; this only decides what the dialog offers.
 */
export function isConsensusSearchAvailable(result: {
  access: { role: string };
  isLoading: boolean;
  isError: boolean;
}): boolean {
  return !result.isLoading && !result.isError && result.access.role === "owner";
}

export interface ConsensusSearchErrorState {
  kind: ConsensusSearchErrorKind;
  message: string;
}

export interface ConsensusSearchState {
  /** What is currently typed. Changing it searches nothing and clears nothing. */
  draftQuery: string;
  /** The advanced filters being edited. Changing them searches nothing and clears nothing. */
  draftFilters: ConsensusFilterDraft;
  /** The query whose results are on screen (or whose brand-new attempt failed). */
  committedQuery: string | null;
  /**
   * The filters that search applied — the frozen snapshot taken when Search
   * was pressed, never the draft. `null` before the first search; `{}` for an
   * unfiltered one.
   */
  committedFilters: ConsensusAppliedFilters | null;
  /** The one result page, or `null` before the first successful search. */
  results: ConsensusSearchResult[] | null;
  /**
   * Selected DOIs in their original spellings, in selection order, at most one
   * per DOI-equivalence key. Exactly what an import would hand to the importer.
   */
  selectedDois: string[];
  loading: boolean;
  error: ConsensusSearchErrorState | null;
}

export interface ConsensusSearchActions {
  setDraftQuery(value: string): void;
  /**
   * Edit the draft filters. Searches nothing, and leaves the committed search —
   * its results, selection and applied filters — exactly as it was.
   */
  setDraftFilters(patch: Partial<ConsensusFilterDraft>): void;
  /** Put every draft filter back to unset. Keeps the question; searches nothing. */
  resetDraftFilters(): void;
  /** Run the draft query under the draft filters — the only action that can reach Consensus. */
  submitSearch(): void;
  /** Toggle one importable DOI. A value that is not importable is ignored. */
  toggleSelection(doi: string): void;
  /** Add every importable result not already selected, in result order. */
  selectAllImportable(): void;
  clearSelection(): void;
  /** Drop the DOIs a completed import consumed (matched by DOI equivalence). */
  clearImported(dois: string[]): void;
  /** Full reset — also invalidates any in-flight response. */
  reset(): void;
}

const EMPTY_STATE: ConsensusSearchState = {
  draftQuery: "",
  draftFilters: EMPTY_CONSENSUS_FILTER_DRAFT,
  committedQuery: null,
  committedFilters: null,
  results: null,
  selectedDois: [],
  loading: false,
  error: null,
};

function toErrorState(error: unknown): ConsensusSearchErrorState {
  if (error instanceof ConsensusSearchError) {
    return { kind: error.kind, message: error.message };
  }
  return { kind: "unexpected", message: "Consensus search failed. Please try again." };
}

export function useConsensusSearch(search?: ConsensusSearchFn): ConsensusSearchState & ConsensusSearchActions {
  const [state, setState] = useState<ConsensusSearchState>(EMPTY_STATE);

  /**
   * Monotonic request generation, exactly as in `usePubMedSearch`: every
   * request applies its result only while the generation it was issued under
   * is still current, and a newer search or a reset/close bumps it — so a
   * response that arrives late is discarded instead of repopulating a session
   * the owner has already left.
   */
  const generation = useRef(0);
  /**
   * The generation of the request currently in flight, or `null`. Set and read
   * synchronously, unlike `state.loading`, which only reaches `stateRef` on the
   * next render — so two submissions in the same tick cannot both start a
   * request. It is the hook's own guarantee of "one request in flight", not a
   * property it borrows from how React happens to flush click events.
   */
  const inFlight = useRef<number | null>(null);
  /** Mirrors `state` for callbacks that must read it without re-creating. */
  const stateRef = useRef(state);
  stateRef.current = state;

  const setDraftQuery = useCallback((value: string) => {
    setState((prev) => ({ ...prev, draftQuery: value }));
  }, []);

  const setDraftFilters = useCallback((patch: Partial<ConsensusFilterDraft>) => {
    setState((prev) => ({
      ...prev,
      draftFilters: {
        ...prev.draftFilters,
        ...patch,
        // Only allowlisted designs, once each, in allowlist order — whatever
        // the caller passed.
        studyTypes: patch.studyTypes ? canonicalStudyTypes(patch.studyTypes) : prev.draftFilters.studyTypes,
      },
    }));
  }, []);

  const resetDraftFilters = useCallback(() => {
    setState((prev) =>
      prev.draftFilters === EMPTY_CONSENSUS_FILTER_DRAFT ? prev : { ...prev, draftFilters: EMPTY_CONSENSUS_FILTER_DRAFT },
    );
  }, []);

  const submitSearch = useCallback(() => {
    if (!search) return;
    const current = stateRef.current;
    // One request in flight at a time: a second press cannot spend a second call.
    if (inFlight.current !== null || current.loading) return;

    const query = current.draftQuery.trim();
    if (query.length === 0 || query.length > CONSENSUS_SEARCH_MAX_QUERY_LENGTH) return;

    // The filters are checked here as well as in the panel: a draft the server
    // would refuse is never sent. Valid ones become the frozen snapshot this
    // search sends and its results are described with.
    const checked = validateConsensusFilterDraft(current.draftFilters);
    if (!checked.ok) return;
    const filters = checked.filters;

    // A different question or different filters make a new discovery session:
    // its predecessor's results and selection go. Re-running the same search
    // keeps the selected DOIs — stable identifiers — and leaves the current page
    // on screen until the new one arrives, so a failed re-run never destroys
    // usable results; when the re-run succeeds, only the selected DOIs its page
    // still shows are kept.
    const isNewSearch = query !== current.committedQuery || !sameAppliedFilters(filters, current.committedFilters);
    const requestId = ++generation.current;
    inFlight.current = requestId;

    setState((prev) => ({
      ...prev,
      committedQuery: query,
      committedFilters: filters,
      results: isNewSearch ? null : prev.results,
      selectedDois: isNewSearch ? [] : prev.selectedDois,
      loading: true,
      error: null,
    }));

    const settle = () => {
      // Only the request that set the flag clears it: a reset has already
      // released it, and a newer request owns it from then on.
      if (inFlight.current === requestId) inFlight.current = null;
    };

    void search({ query, ...filters })
      .then((response) => {
        settle();
        if (generation.current !== requestId) return;
        // A same-search re-run kept the selection, but Consensus may answer it
        // with a different page. A selected DOI the new page no longer shows
        // would otherwise stay counted — and be imported — with no row to see or
        // uncheck, so only DOIs still on screen survive.
        const visible = new Set(
          response.results.flatMap((result) => {
            const doi = toImportableDoi(result.importDoi);
            return doi === null ? [] : [consensusSelectionKey(doi)];
          }),
        );
        setState((prev) => ({
          ...prev,
          results: response.results,
          selectedDois: prev.selectedDois.filter((doi) => visible.has(consensusSelectionKey(doi))),
          loading: false,
          error: null,
        }));
      })
      .catch((error: unknown) => {
        settle();
        if (generation.current !== requestId) return;
        setState((prev) => ({ ...prev, loading: false, error: toErrorState(error) }));
      });
  }, [search]);

  const toggleSelection = useCallback((doi: string) => {
    const importable = toImportableDoi(doi);
    if (importable === null) return;
    const key = consensusSelectionKey(importable);
    setState((prev) => {
      const selected = prev.selectedDois.some((existing) => consensusSelectionKey(existing) === key);
      return {
        ...prev,
        selectedDois: selected
          ? prev.selectedDois.filter((existing) => consensusSelectionKey(existing) !== key)
          : [...prev.selectedDois, importable],
      };
    });
  }, []);

  const selectAllImportable = useCallback(() => {
    setState((prev) => {
      if (!prev.results) return prev;
      const keys = new Set(prev.selectedDois.map(consensusSelectionKey));
      const additions: string[] = [];
      for (const result of prev.results) {
        // Re-validated here as well: selection must never depend on the
        // results array having been produced by the defensive parser.
        const doi = toImportableDoi(result.importDoi);
        if (doi === null) continue;
        const key = consensusSelectionKey(doi);
        if (keys.has(key)) continue;
        keys.add(key);
        additions.push(doi);
      }
      if (additions.length === 0) return prev;
      return { ...prev, selectedDois: [...prev.selectedDois, ...additions] };
    });
  }, []);

  const clearSelection = useCallback(() => {
    setState((prev) => (prev.selectedDois.length === 0 ? prev : { ...prev, selectedDois: [] }));
  }, []);

  const clearImported = useCallback((dois: string[]) => {
    const imported = new Set(dois.map(consensusSelectionKey));
    if (imported.size === 0) return;
    setState((prev) => ({
      ...prev,
      selectedDois: prev.selectedDois.filter((doi) => !imported.has(consensusSelectionKey(doi))),
    }));
  }, []);

  const reset = useCallback(() => {
    // Bumping the generation is the point: a response still in flight when the
    // dialog closes must not repopulate the reopened dialog.
    generation.current++;
    inFlight.current = null;
    setState(EMPTY_STATE);
  }, []);

  return {
    ...state,
    setDraftQuery,
    setDraftFilters,
    resetDraftFilters,
    submitSearch,
    toggleSelection,
    selectAllImportable,
    clearSelection,
    clearImported,
    reset,
  };
}
