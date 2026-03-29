import { useMemo } from "react";
import type { PaperWithTags } from "@/types/database";
import { applyClientFilters } from "@/lib/applyClientFilters";

interface UseFilteredPapersArgs {
  /** Papers from server (already filtered + sorted server-side). */
  papers: PaperWithTags[];
  /** Active keyword filter selections. */
  selectedKeywords: string[];
  /** Synonym lookup for keyword normalization. */
  synonymLookup: Record<string, string>;
  /** Returns matching keywords from abstract text. */
  findMatchingKeywords: (abstract: string | null) => string[];
  /** Debounced search query string. */
  debouncedSearchQuery: string;
  /** Whether server-side search is active (true for all non-empty queries). */
  useServerSearch: boolean;
  /** Server search result IDs (for gating, not filtering — filtering is done server-side). */
  serverSearchIds: Set<string> | undefined;
}

/**
 * Client-side post-filter for dimensions that can't be handled server-side in Phase 1:
 * - Keyword filter (requires synonym normalization + abstract matching)
 * - Short-query search (<3 chars, client-side substring match)
 *
 * Does NOT sort — server order is preserved by Array.filter().
 * Returns filteredPapers as the final output.
 */
export function useFilteredPapers({
  papers,
  selectedKeywords,
  synonymLookup,
  findMatchingKeywords,
  debouncedSearchQuery,
  useServerSearch,
  serverSearchIds,
}: UseFilteredPapersArgs): PaperWithTags[] {
  return useMemo(() => {
    return applyClientFilters(papers, {
      debouncedSearchQuery,
      useServerSearch,
      selectedKeywords,
      synonymLookup,
      findMatchingKeywords,
    });
  }, [
    papers,
    debouncedSearchQuery,
    useServerSearch,
    selectedKeywords,
    synonymLookup,
    findMatchingKeywords,
  ]);
}
