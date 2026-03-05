import { useState, useMemo, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { PaperWithTags } from "@/types/database";
import type { ColumnId } from "@/hooks/useColumnVisibility";
import type { SortDirection } from "@/components/papers/ResizableTableHeader";
import type { PoolStudyType } from "@/hooks/useStudyTypePool";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";

/** Minimum query length to trigger server-side full-text search. */
const SERVER_SEARCH_MIN_LENGTH = 3;
/** Debounce delay (ms) before firing server-side search. */
const SEARCH_DEBOUNCE_MS = 300;

interface UseFilteredAndSortedPapersArgs {
  papers: PaperWithTags[];
  poolStudyTypes: PoolStudyType[];
  synonymLookup: Record<string, string>;
  findMatchingKeywords: (abstract: string | null) => string[];
  userId?: string;
}

export function useFilteredAndSortedPapers({
  papers,
  poolStudyTypes,
  synonymLookup,
  findMatchingKeywords,
  userId,
}: UseFilteredAndSortedPapersArgs) {
  // Filter state
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedTagId, setSelectedTagId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [yearFrom, setYearFrom] = useState("");
  const [yearTo, setYearTo] = useState("");
  const [studyType, setStudyType] = useState("all");
  const [selectedKeywords, setSelectedKeywords] = useState<string[]>([]);

  // Sort state
  const [sortKey, setSortKey] = useState<ColumnId | null>(null);
  const [sortDirection, setSortDirection] = useState<SortDirection | null>(null);

  // Debounced search query for server-side FTS
  const debouncedSearchQuery = useDebouncedValue(searchQuery, SEARCH_DEBOUNCE_MS);
  const useServerSearch =
    !!userId && debouncedSearchQuery.length >= SERVER_SEARCH_MIN_LENGTH;

  // Server-side full-text search via the search_papers RPC
  const { data: serverSearchIds, isFetching: isSearching } = useQuery<
    Set<string>
  >({
    queryKey: ["search_papers", userId, debouncedSearchQuery],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("search_papers", {
        p_user_id: userId!,
        p_query: debouncedSearchQuery,
      });
      if (error) throw error;
      return new Set(
        (data as { paper_id: string; rank: number }[]).map((r) => r.paper_id),
      );
    },
    enabled: useServerSearch,
    staleTime: 30_000, // Cache results for 30s
    placeholderData: (prev) => prev, // Keep previous results while fetching
  });

  const handleSort = useCallback(
    (columnId: ColumnId) => {
      setSortKey((prev) => {
        if (prev === columnId) {
          setSortDirection((prevDir) => {
            if (prevDir === "asc") return "desc";
            return null;
          });
          return sortDirection === "desc" ? null : columnId;
        }
        setSortDirection("asc");
        return columnId;
      });
    },
    [sortDirection],
  );

  const handleKeywordToggle = useCallback((keyword: string) => {
    setSelectedKeywords((prev) =>
      prev.includes(keyword) ? prev.filter((k) => k !== keyword) : [...prev, keyword],
    );
  }, []);

  const hasActiveFilters =
    searchQuery !== "" ||
    yearFrom !== "" ||
    yearTo !== "" ||
    studyType !== "all" ||
    selectedKeywords.length > 0 ||
    selectedProjectId !== null ||
    selectedTagId !== null;

  const clearFilters = useCallback(() => {
    setSearchQuery("");
    setYearFrom("");
    setYearTo("");
    setStudyType("all");
    setSelectedKeywords([]);
    setSelectedProjectId(null);
    setSelectedTagId(null);
  }, []);

  // Build dynamic study type filter options: only unique group_names
  const studyTypeFilterOptions = useMemo(() => {
    const groupSet = new Set<string>();
    poolStudyTypes.forEach((st) => {
      if (st.group_name) groupSet.add(st.group_name);
    });
    return Array.from(groupSet).sort();
  }, [poolStudyTypes]);

  const filteredPapers = useMemo(() => {
    return papers.filter((paper) => {
      // Project filter
      if (selectedProjectId && !paper.projects.some((p) => p.id === selectedProjectId)) {
        return false;
      }

      // Tag filter
      if (selectedTagId && !paper.tags.some((t) => t.id === selectedTagId)) {
        return false;
      }

      // Search: server-side FTS for queries >= 3 chars, client-side for shorter
      if (debouncedSearchQuery) {
        if (useServerSearch && serverSearchIds) {
          // Use server-side results — filter to matching paper IDs
          if (!serverSearchIds.has(paper.id)) return false;
        } else if (!useServerSearch) {
          // Client-side substring matching for short queries
          const query = debouncedSearchQuery.toLowerCase();
          const matchesSearch =
            paper.title.toLowerCase().includes(query) ||
            paper.authors.some((a) => a.toLowerCase().includes(query)) ||
            (paper.journal && paper.journal.toLowerCase().includes(query)) ||
            (paper.abstract && paper.abstract.toLowerCase().includes(query));
          if (!matchesSearch) return false;
        }
        // If useServerSearch but serverSearchIds is not yet loaded, show all
        // (the query is still in-flight)
      }

      // Year range
      if (yearFrom && paper.year && paper.year < parseInt(yearFrom)) {
        return false;
      }
      if (yearTo && paper.year && paper.year > parseInt(yearTo)) {
        return false;
      }

      // Study type filter: match any subtype belonging to the selected group
      if (studyType !== "all") {
        const paperType = (paper.study_type || "").toLowerCase();
        const subtypesInGroup = poolStudyTypes
          .filter((st) => st.group_name?.toLowerCase() === studyType.toLowerCase())
          .map((st) => st.study_type.toLowerCase());
        if (!subtypesInGroup.includes(paperType)) return false;
      }

      // Keywords: combine all term sources and normalize through synonym pool
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
    selectedProjectId,
    selectedTagId,
    debouncedSearchQuery,
    useServerSearch,
    serverSearchIds,
    yearFrom,
    yearTo,
    studyType,
    poolStudyTypes,
    selectedKeywords,
    synonymLookup,
    findMatchingKeywords,
  ]);

  // Sort filtered papers
  const sortedPapers = useMemo(() => {
    if (!sortKey || !sortDirection) return filteredPapers;

    return [...filteredPapers].sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case "title":
          cmp = a.title.localeCompare(b.title);
          break;
        case "authors":
          cmp = (a.authors[0] || "").localeCompare(b.authors[0] || "");
          break;
        case "year":
          cmp = (a.year || 0) - (b.year || 0);
          break;
        case "journal":
          cmp = (a.journal || "").localeCompare(b.journal || "");
          break;
        case "studyType":
          cmp = (a.study_type || "").localeCompare(b.study_type || "");
          break;
        default:
          return 0;
      }
      return sortDirection === "desc" ? -cmp : cmp;
    });
  }, [filteredPapers, sortKey, sortDirection]);

  return {
    // Filter state
    searchQuery,
    setSearchQuery,
    yearFrom,
    setYearFrom,
    yearTo,
    setYearTo,
    studyType,
    setStudyType,
    selectedKeywords,
    selectedProjectId,
    setSelectedProjectId,
    selectedTagId,
    setSelectedTagId,
    studyTypeFilterOptions,

    // Sort state
    sortKey,
    sortDirection,
    handleSort,

    // Derived data
    filteredPapers,
    sortedPapers,
    isSearching,

    // Actions
    handleKeywordToggle,
    clearFilters,
    hasActiveFilters,
  };
}
