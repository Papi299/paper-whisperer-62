import { useState, useMemo, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { ColumnId } from "@/hooks/useColumnVisibility";
import type { SortDirection } from "@/components/papers/ResizableTableHeader";
import type { PoolStudyType } from "@/hooks/useStudyTypePool";
import type { MatchFlags, NotesPresence, ServerFilterParams, ServerSortParams } from "@/hooks/papers/types";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { timedQueryFn } from "@/lib/queryTiming";

/** Minimum query length to trigger server-side full-text search. */
const SERVER_SEARCH_MIN_LENGTH = 3;
/** Debounce delay (ms) before firing server-side search. */
const SEARCH_DEBOUNCE_MS = 300;

/** Map UI column IDs to PostgREST column names for server-side sorting. */
const SORT_COLUMN_MAP: Record<string, string> = {
  title: "title",
  authors: "authors",
  year: "year",
  journal: "journal",
  studyType: "study_type",
};

interface UseFilterStateArgs {
  poolStudyTypes: PoolStudyType[];
  userId?: string;
}

export function useFilterState({ poolStudyTypes, userId }: UseFilterStateArgs) {
  // ── Filter state ──
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedTagId, setSelectedTagId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [yearFrom, setYearFrom] = useState("");
  const [yearTo, setYearTo] = useState("");
  const [studyType, setStudyType] = useState("all");
  const [notesPresence, setNotesPresence] = useState<NotesPresence>("all");
  const [selectedKeywords, setSelectedKeywords] = useState<string[]>([]);

  // ── Sort state ──
  const [sortKey, setSortKey] = useState<ColumnId | null>(null);
  const [sortDirection, setSortDirection] = useState<SortDirection | null>(null);

  // ── Debounced search ──
  const debouncedSearchQuery = useDebouncedValue(searchQuery, SEARCH_DEBOUNCE_MS);

  /**
   * Exact-phrase mode: a query wrapped in double quotes (e.g.
   * `"muscle protein synthesis"`) is treated as a literal contiguous phrase
   * and matched via case-insensitive ILIKE substring across all six
   * searchable fields. Returns the inner phrase (quotes stripped, trimmed)
   * when the query is in phrase mode, otherwise null.
   *
   * Why ILIKE rather than `phraseto_tsquery`/`<->`: ILIKE is literal — what
   * the user types is what gets matched, with no English-stemmer surprises
   * (a user typing `"muscles"` will not match `muscle`), no Unicode
   * fragility, and no tokenizer edge cases on punctuation like `"COX-2"`.
   * The cost — a sequential scan instead of GIN — is sub-millisecond at
   * the current paper-count scale and bounded by the user's library size.
   */
  const phraseQuery: string | null = useMemo(() => {
    const trimmed = debouncedSearchQuery.trim();
    if (trimmed.length < 2) return null;
    if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) return null;
    const inner = trimmed.slice(1, -1).trim();
    return inner.length > 0 ? inner : null;
  }, [debouncedSearchQuery]);

  // Three mutually-exclusive search routes:
  //   • Phrase  — quoted query → ILIKE substring of the inner phrase
  //   • FTS    — unquoted query ≥3 chars → prefix-aware tsquery
  //   • Short  — unquoted query 1-2 chars → ILIKE substring
  // Phrase takes priority and suppresses the other two so the existing
  // unquoted behavior is preserved exactly when the query is not quoted.
  const usePhraseSearch = !!userId && phraseQuery !== null;
  const useFtsSearch =
    !!userId && !usePhraseSearch && debouncedSearchQuery.length >= SERVER_SEARCH_MIN_LENGTH;
  const useShortSearch =
    !!userId && !usePhraseSearch && debouncedSearchQuery.length > 0 && debouncedSearchQuery.length < SERVER_SEARCH_MIN_LENGTH;

  // ── Server-side full-text search via search_papers RPC ──
  // Returns a Map<paper_id, MatchFlags> so the UI can render authoritative
  // per-field "Matched in:" badges without re-deriving anything client-side.
  // The Set of matching IDs (used for filter intersection below) is derived
  // from `.keys()` — same data, two views.
  const { data: serverSearchMatches, isFetching: isSearching } = useQuery<
    Map<string, MatchFlags>
  >({
    queryKey: ["search_papers", userId, debouncedSearchQuery],
    queryFn: timedQueryFn("search_papers (FTS)", async () => {
      const { data, error } = await supabase.rpc("search_papers", {
        p_user_id: userId!,
        p_query: debouncedSearchQuery,
      });
      if (error) throw error;
      const rows = data as Array<{ paper_id: string; rank: number } & MatchFlags>;
      return new Map(
        rows.map((r) => [
          r.paper_id,
          {
            matched_title: r.matched_title,
            matched_abstract: r.matched_abstract,
            matched_authors: r.matched_authors,
            matched_journal: r.matched_journal,
            matched_notes: r.matched_notes,
            matched_keywords: r.matched_keywords,
          },
        ]),
      );
    }),
    enabled: useFtsSearch,
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });

  // ── Server-side short search via ILIKE (1-2 char queries) ──
  // Same Map<paper_id, MatchFlags> shape — RPC also returns per-field flags.
  const { data: shortSearchMatches } = useQuery<Map<string, MatchFlags>>({
    queryKey: ["search_papers_short", userId, debouncedSearchQuery],
    queryFn: timedQueryFn("search_papers_short (ILIKE)", async () => {
      const { data, error } = await supabase.rpc("search_papers_short", {
        p_user_id: userId!,
        p_query: debouncedSearchQuery,
      });
      if (error) throw error;
      const rows = data as Array<{ paper_id: string } & MatchFlags>;
      return new Map(
        rows.map((r) => [
          r.paper_id,
          {
            matched_title: r.matched_title,
            matched_abstract: r.matched_abstract,
            matched_authors: r.matched_authors,
            matched_journal: r.matched_journal,
            matched_notes: r.matched_notes,
            matched_keywords: r.matched_keywords,
          },
        ]),
      );
    }),
    enabled: useShortSearch,
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });

  // ── Server-side phrase search via search_papers_short RPC ──
  // Reuses the existing ILIKE-substring RPC with the inner (unquoted) phrase
  // as the query. The RPC tests `field ILIKE '%<phrase>%'` per scalar field
  // and `EXISTS (... element ILIKE '%<phrase>%')` over the jsonb arrays
  // `authors` / `keywords` — exactly the contiguous-phrase semantics the
  // product spec asks for. Same Map<paper_id, MatchFlags> shape as the
  // other two paths, so the UI and intersection logic need no special-casing.
  const { data: phraseSearchMatches } = useQuery<Map<string, MatchFlags>>({
    queryKey: ["search_papers_phrase", userId, phraseQuery],
    queryFn: timedQueryFn("search_papers_short (phrase)", async () => {
      const { data, error } = await supabase.rpc("search_papers_short", {
        p_user_id: userId!,
        p_query: phraseQuery!,
      });
      if (error) throw error;
      const rows = data as Array<{ paper_id: string } & MatchFlags>;
      return new Map(
        rows.map((r) => [
          r.paper_id,
          {
            matched_title: r.matched_title,
            matched_abstract: r.matched_abstract,
            matched_authors: r.matched_authors,
            matched_journal: r.matched_journal,
            matched_notes: r.matched_notes,
            matched_keywords: r.matched_keywords,
          },
        ]),
      );
    }),
    enabled: usePhraseSearch,
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });

  /**
   * Combined per-row match flags for the active search path. Whichever path
   * (phrase / FTS / short) is enabled supplies the Map; null when no search
   * is active or the query has not yet resolved. The UI consumes this
   * directly and looks up `paper.id`.
   */
  const searchMatchFlags: Map<string, MatchFlags> | null = useMemo(() => {
    if (usePhraseSearch) return phraseSearchMatches ?? null;
    if (useFtsSearch) return serverSearchMatches ?? null;
    if (useShortSearch) return shortSearchMatches ?? null;
    return null;
  }, [
    usePhraseSearch,
    phraseSearchMatches,
    useFtsSearch,
    serverSearchMatches,
    useShortSearch,
    shortSearchMatches,
  ]);

  // ── Junction pre-queries (project/tag ID resolution) ──
  const { data: projectPaperIds } = useQuery<string[]>({
    queryKey: ["junction", "paper_projects", selectedProjectId],
    queryFn: timedQueryFn("junction.paper_projects", async () => {
      const { data, error } = await supabase
        .from("paper_projects")
        .select("paper_id")
        .eq("project_id", selectedProjectId!);
      if (error) throw error;
      return data.map((r) => r.paper_id);
    }),
    enabled: !!selectedProjectId,
    staleTime: 30_000,
  });

  const { data: tagPaperIds } = useQuery<string[]>({
    queryKey: ["junction", "paper_tags", selectedTagId],
    queryFn: timedQueryFn("junction.paper_tags", async () => {
      const { data, error } = await supabase
        .from("paper_tags")
        .select("paper_id")
        .eq("tag_id", selectedTagId!);
      if (error) throw error;
      return data.map((r) => r.paper_id);
    }),
    enabled: !!selectedTagId,
    staleTime: 30_000,
  });

  // ── Server-side keyword filter via RPC ──
  const { data: keywordPaperIds } = useQuery<string[]>({
    queryKey: ["filter_keywords", userId, selectedKeywords],
    queryFn: timedQueryFn("filter_papers_by_keywords (RPC)", async () => {
      const { data, error } = await supabase.rpc("filter_papers_by_keywords", {
        p_user_id: userId!,
        p_keywords: selectedKeywords,
      });
      if (error) throw error;
      return (data as { paper_id: string }[]).map((r) => r.paper_id);
    }),
    enabled: !!userId && selectedKeywords.length > 0,
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });

  // ── ID intersection (4-state model) ──
  const filterPaperIds = useMemo((): string[] | null | undefined => {
    const needsProject = !!selectedProjectId;
    const needsTag = !!selectedTagId;
    const needsPhraseSearch = usePhraseSearch;
    const needsFtsSearch = useFtsSearch;
    const needsShortSearch = useShortSearch;
    const needsKeywords = selectedKeywords.length > 0;

    // No ID-based filter active → null (no filtering)
    if (!needsProject && !needsTag && !needsPhraseSearch && !needsFtsSearch && !needsShortSearch && !needsKeywords) return null;

    // Any required ID set still loading → undefined (block papers query)
    if (needsProject && projectPaperIds === undefined) return undefined;
    if (needsTag && tagPaperIds === undefined) return undefined;
    if (needsPhraseSearch && phraseSearchMatches === undefined) return undefined;
    if (needsFtsSearch && serverSearchMatches === undefined) return undefined;
    if (needsShortSearch && shortSearchMatches === undefined) return undefined;
    if (needsKeywords && keywordPaperIds === undefined) return undefined;

    // All required sets resolved — intersect them
    const idSets: string[][] = [];
    if (needsProject) idSets.push(projectPaperIds!);
    if (needsTag) idSets.push(tagPaperIds!);
    if (needsPhraseSearch) idSets.push(Array.from(phraseSearchMatches!.keys()));
    if (needsFtsSearch) idSets.push(Array.from(serverSearchMatches!.keys()));
    if (needsShortSearch) idSets.push(Array.from(shortSearchMatches!.keys()));
    if (needsKeywords) idSets.push(keywordPaperIds!);

    if (idSets.length === 0) return null; // shouldn't happen, safe fallback

    let result = new Set(idSets[0]);
    for (let i = 1; i < idSets.length; i++) {
      const next = new Set(idSets[i]);
      result = new Set([...result].filter((id) => next.has(id)));
    }
    return Array.from(result);
  }, [
    selectedProjectId,
    projectPaperIds,
    selectedTagId,
    tagPaperIds,
    usePhraseSearch,
    phraseSearchMatches,
    useFtsSearch,
    serverSearchMatches,
    useShortSearch,
    shortSearchMatches,
    selectedKeywords,
    keywordPaperIds,
  ]);

  // ── Resolve study type subtypes from group name ──
  const resolvedStudyTypes = useMemo((): string[] | null => {
    if (studyType === "all") return null;
    return poolStudyTypes
      .filter((st) => st.group_name?.toLowerCase() === studyType.toLowerCase())
      .map((st) => st.study_type);
  }, [studyType, poolStudyTypes]);

  // ── Build server params (split into filter + sort) ──
  const serverFilterParams = useMemo((): ServerFilterParams => ({
    filterPaperIds,
    yearFrom: yearFrom ? parseInt(yearFrom) : null,
    yearTo: yearTo ? parseInt(yearTo) : null,
    studyTypes: resolvedStudyTypes,
    notesPresence,
  }), [filterPaperIds, yearFrom, yearTo, resolvedStudyTypes, notesPresence]);

  const serverSortParams = useMemo((): ServerSortParams => ({
    sortColumn: sortKey ? (SORT_COLUMN_MAP[sortKey] ?? null) : null,
    sortAscending: sortDirection === "asc" ? true : sortDirection === "desc" ? false : null,
  }), [sortKey, sortDirection]);

  // ── Sort handler ──
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

  // ── Keyword toggle ──
  const handleKeywordToggle = useCallback((keyword: string) => {
    setSelectedKeywords((prev) =>
      prev.includes(keyword) ? prev.filter((k) => k !== keyword) : [...prev, keyword],
    );
  }, []);

  // ── Study type filter options (unique group names) ──
  const studyTypeFilterOptions = useMemo(() => {
    const groupSet = new Set<string>();
    poolStudyTypes.forEach((st) => {
      if (st.group_name) groupSet.add(st.group_name);
    });
    return Array.from(groupSet).sort();
  }, [poolStudyTypes]);

  // ── Active filter check ──
  const hasActiveFilters =
    searchQuery !== "" ||
    yearFrom !== "" ||
    yearTo !== "" ||
    studyType !== "all" ||
    notesPresence !== "all" ||
    selectedKeywords.length > 0 ||
    selectedProjectId !== null ||
    selectedTagId !== null;

  const clearFilters = useCallback(() => {
    setSearchQuery("");
    setYearFrom("");
    setYearTo("");
    setStudyType("all");
    setNotesPresence("all");
    setSelectedKeywords([]);
    setSelectedProjectId(null);
    setSelectedTagId(null);
  }, []);

  return {
    // Server params for usePapers (split: filter-only + sort-only)
    serverFilterParams,
    serverSortParams,

    // Filter state + setters
    searchQuery,
    setSearchQuery,
    yearFrom,
    setYearFrom,
    yearTo,
    setYearTo,
    studyType,
    setStudyType,
    notesPresence,
    setNotesPresence,
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

    // Actions
    handleKeywordToggle,
    clearFilters,
    hasActiveFilters,

    /**
     * Authoritative per-paper match attribution from the active search RPC,
     * keyed by paper_id. Null when no search query is active or the result
     * has not yet resolved. Consumed by `PaperList` to render the
     * "Matched in:" sub-line in each row.
     */
    searchMatchFlags,
  };
}
