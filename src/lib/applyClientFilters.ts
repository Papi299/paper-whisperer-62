import type { Paper } from "@/types/database";

/** Minimum query length for server-side FTS. Below this, client-side substring match is used. */
const SERVER_SEARCH_MIN_LENGTH = 3;

export interface ClientFilterParams {
  /** Debounced search query string. */
  debouncedSearchQuery: string;
  /** Whether server-side search is active (query >= 3 chars). */
  useServerSearch: boolean;
  /** Active keyword filter selections. */
  selectedKeywords: string[];
  /** Synonym lookup for keyword normalization. */
  synonymLookup: Record<string, string>;
  /** Returns matching keywords from abstract text. */
  findMatchingKeywords: (abstract: string | null) => string[];
}

/**
 * Apply client-only post-filters to a set of papers.
 * Handles keyword filter (synonym-normalized) and short-query search (<3 chars).
 *
 * This is a pure function — no React hooks. Shared between:
 * - useFilteredPapers (display, wrapped in useMemo)
 * - useExportPapers (export, called after fetch)
 * - useAnalyticsData (analytics, called after fetch)
 *
 * Generic over T extends Paper — works with PaperWithTags (display/export)
 * and plain Paper (analytics, no junction hydration needed).
 *
 * Does NOT sort — input order is preserved by Array.filter().
 */
export function applyClientFilters<T extends Paper>(
  papers: T[],
  params: ClientFilterParams,
): T[] {
  const { debouncedSearchQuery, useServerSearch, selectedKeywords, synonymLookup, findMatchingKeywords } = params;

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
}
