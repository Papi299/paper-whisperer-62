import { useMemo } from "react";
import type { PaperWithTags } from "@/types/database";

/** Minimum query length for server-side FTS. Below this, client-side substring match is used. */
const SERVER_SEARCH_MIN_LENGTH = 3;

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
  /** Whether server-side search is active (query >= 3 chars). */
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
    return papers.filter((paper) => {
      // Short-query search (<3 chars): client-side substring matching
      // Server-side search (>=3 chars) is already handled via filterPaperIds
      if (debouncedSearchQuery && !useServerSearch) {
        const query = debouncedSearchQuery.toLowerCase();
        const matchesSearch =
          paper.title.toLowerCase().includes(query) ||
          paper.authors.some((a) => a.toLowerCase().includes(query)) ||
          (paper.journal && paper.journal.toLowerCase().includes(query)) ||
          (paper.abstract && paper.abstract.toLowerCase().includes(query));
        if (!matchesSearch) return false;
      }

      // Keyword filter: combine all term sources and normalize through synonym pool
      if (selectedKeywords.length > 0) {
        const allTerms = [
          ...(paper.keywords || []),
          ...((paper.substances as string[]) || []),
          ...((paper.mesh_terms as string[]) || []),
          ...findMatchingKeywords(paper.abstract),
        ];
        const normalizedTerms = allTerms.map((term) => {
          const canonical = synonymLookup[term.toLowerCase()];
          return (canonical || term).toLowerCase();
        });
        const hasAllKeywords = selectedKeywords.every((kw) =>
          normalizedTerms.includes(kw.toLowerCase()),
        );
        if (!hasAllKeywords) return false;
      }

      return true;
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
