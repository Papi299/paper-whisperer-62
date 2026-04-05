import { useMemo, useRef } from "react";
import { useQuery, useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Paper, PaperWithTags, Project, Tag } from "@/types/database";
import { NormalizationConfig } from "@/lib/normalizePaperData";
import { queryKeys } from "@/lib/queryKeys";
import { buildPapersQuery, buildPapersCountQuery } from "@/lib/buildPapersQuery";
import { fetchAllPages } from "@/lib/fetchAllPages";
import { PapersPage, ServerFilterParams, areServerFiltersReady } from "./papers/types";
import { usePaperCacheHelpers } from "./papers/usePaperCacheHelpers";
import { useProjectMutations } from "./papers/useProjectMutations";
import { useTagMutations } from "./papers/useTagMutations";
import { usePaperMutations } from "./papers/usePaperMutations";
import { useBulkMutations } from "./papers/useBulkMutations";

const PAGE_SIZE = 100;

export function usePapers(
  userId: string | undefined,
  serverFilterParams: ServerFilterParams,
  normalizationConfig?: NormalizationConfig,
) {
  const queryClient = useQueryClient();
  const filtersReady = areServerFiltersReady(serverFilterParams);

  // Hold the last resolved filter params. The query key, queryFn, and enabled
  // all use this ref so that during filter transitions (filterPaperIds=undefined)
  // the query stays on the old key with old data rather than disabling/resetting.
  // When new filters resolve, the ref updates → key changes → placeholderData
  // bridges the gap with old results while the new query fetches.
  const resolvedParamsRef = useRef(serverFilterParams);
  if (filtersReady) {
    resolvedParamsRef.current = serverFilterParams;
  }
  const activeParams = resolvedParamsRef.current;

  // ── Infinite query: papers with server-side filtering + sorting ──
  const {
    data,
    isLoading: papersLoading,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery<PapersPage, Error>({
    queryKey: queryKeys.papers.list(userId!, activeParams),
    queryFn: async ({ pageParam }): Promise<PapersPage> => {
      const page = pageParam as number;
      const from = page * PAGE_SIZE;
      const to = from + PAGE_SIZE - 1;

      const { filterPaperIds } = activeParams;

      // Short-circuit: filter resolved with no matches
      if (filterPaperIds !== null && filterPaperIds !== undefined && filterPaperIds.length === 0) {
        return { papers: [], hasMore: false };
      }

      // Build query with shared predicate builder (display needs attachments)
      const query = buildPapersQuery(
        userId!,
        activeParams,
        "*, paper_attachments(id, file_name, file_path, file_type)",
      );

      const { data: papersData, error: papersError } = await query.range(from, to);
      if (papersError) throw papersError;

      const rawPapers = (papersData as Paper[]) || [];
      const paperIds = rawPapers.map((p) => p.id);

      // Fetch junction tables for this page's papers
      const [paperTagsResult, paperProjectsResult] =
        paperIds.length > 0
          ? await Promise.all([
              supabase.from("paper_tags").select("*").in("paper_id", paperIds),
              supabase.from("paper_projects").select("*").in("paper_id", paperIds),
            ])
          : [{ data: [], error: null }, { data: [], error: null }];

      if (paperTagsResult.error) throw paperTagsResult.error;
      if (paperProjectsResult.error) throw paperProjectsResult.error;

      const paperTagsData = paperTagsResult.data;
      const paperProjectsData = paperProjectsResult.data;

      // Build raw papers with junction IDs
      const papers = rawPapers.map((paper) => {
        const tagIds = (paperTagsData || [])
          .filter((pt: { paper_id: string; tag_id: string }) => pt.paper_id === paper.id)
          .map((pt: { tag_id: string }) => pt.tag_id);

        const projectIds = (paperProjectsData || [])
          .filter((pp: { paper_id: string; project_id: string }) => pp.paper_id === paper.id)
          .map((pp: { project_id: string }) => pp.project_id);

        return {
          ...paper,
          tagIds,
          projectIds,
          paper_attachments: (paper as Record<string, unknown>).paper_attachments as
            | { id: string; file_name: string; file_path: string; file_type: string }[]
            | undefined,
        };
      });

      return {
        papers,
        hasMore: rawPapers.length === PAGE_SIZE,
      };
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage, _allPages, lastPageParam) => {
      if (!lastPage.hasMore) return undefined;
      return (lastPageParam as number) + 1;
    },
    // Always enabled once userId exists — resolved params keep the query stable
    // during filter transitions rather than disabling/re-enabling.
    enabled: !!userId && areServerFiltersReady(activeParams),
    // Keep previous results visible while new filter/search query fetches
    placeholderData: (prev) => prev,
  });

  // ── Projects (single query, not per-page) ──
  const { data: projectsData, isLoading: projectsLoading } = useQuery({
    queryKey: queryKeys.projects.all(userId!),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("projects")
        .select("*")
        .eq("user_id", userId!)
        .order("name");
      if (error) throw error;
      return (data as Project[]) || [];
    },
    enabled: !!userId,
  });

  // ── Tags (single query, not per-page) ──
  const { data: tagsData, isLoading: tagsLoading } = useQuery({
    queryKey: queryKeys.tags.all(userId!),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tags")
        .select("*")
        .eq("user_id", userId!)
        .order("name");
      if (error) throw error;
      return (data as Tag[]) || [];
    },
    enabled: !!userId,
  });

  // ── Total paper count (separate lightweight query — stays unfiltered) ──
  const { data: totalCount } = useQuery({
    queryKey: queryKeys.papers.count(userId!),
    queryFn: async () => {
      const { count, error } = await supabase
        .from("papers")
        .select("*", { count: "exact", head: true })
        .eq("user_id", userId!);
      if (error) throw error;
      return count ?? 0;
    },
    enabled: !!userId,
  });

  // ── Filtered count (lightweight HEAD query with same filters) ──
  const { data: filteredCount } = useQuery({
    queryKey: queryKeys.papers.filteredCount(userId!, activeParams),
    queryFn: async () => {
      const { filterPaperIds } = activeParams;
      // Short-circuit: filter resolved with no matches
      if (filterPaperIds !== null && filterPaperIds !== undefined && filterPaperIds.length === 0) {
        return 0;
      }
      const { count, error } = await buildPapersCountQuery(userId!, activeParams);
      if (error) throw error;
      return count ?? 0;
    },
    enabled: !!userId && areServerFiltersReady(activeParams),
    placeholderData: (prev) => prev,
  });

  // ── All filtered paper IDs (for select-all semantics — IDs only, lightweight) ──
  const { data: allFilteredIds } = useQuery<string[]>({
    queryKey: queryKeys.papers.filteredIds(userId!, activeParams),
    queryFn: async () => {
      const { filterPaperIds } = activeParams;
      // Short-circuit: filter resolved with no matches
      if (filterPaperIds !== null && filterPaperIds !== undefined && filterPaperIds.length === 0) {
        return [];
      }
      const papers = await fetchAllPages<{ id: string }>(
        () => buildPapersQuery(userId!, activeParams, "id"),
      );
      return papers.map((p) => p.id);
    },
    enabled: !!userId && areServerFiltersReady(activeParams),
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });

  // ── Server-side keyword options (distinct terms from all filtered papers) ──
  const { data: serverKeywordOptions } = useQuery<string[]>({
    queryKey: queryKeys.papers.keywordOptions(userId!, activeParams),
    queryFn: async () => {
      const { filterPaperIds, yearFrom, yearTo, studyTypes } = activeParams;
      // Short-circuit: filter resolved with no matches
      if (filterPaperIds !== null && filterPaperIds !== undefined && filterPaperIds.length === 0) {
        return [];
      }
      const { data, error } = await supabase.rpc("get_keyword_options", {
        p_user_id: userId!,
        p_paper_ids: filterPaperIds ?? null,
        p_year_from: yearFrom ?? null,
        p_year_to: yearTo ?? null,
        p_study_types: studyTypes ?? null,
      });
      if (error) throw error;
      return (data as { keyword: string }[]).map((r) => r.keyword);
    },
    enabled: !!userId && areServerFiltersReady(activeParams),
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });

  // NOTE: auto-fetch-all useEffect removed — pages now load lazily via
  // IntersectionObserver sentinel in PaperList.

  const loading = papersLoading || projectsLoading || tagsLoading;

  // Stable references
  const projects = useMemo(() => projectsData ?? [], [projectsData]);
  const tags = useMemo(() => tagsData ?? [], [tagsData]);

  // Hydrate raw papers + junction IDs -> PaperWithTags (with safety dedup by ID)
  const papers = useMemo(() => {
    const rawPapers = data?.pages.flatMap((p) => p.papers) ?? [];
    if (rawPapers.length === 0) return [];

    // Safety dedup: first occurrence wins (preserves optimistic state from page 0)
    const seen = new Set<string>();
    const unique = rawPapers.filter((p) => {
      if (seen.has(p.id)) return false;
      seen.add(p.id);
      return true;
    });

    const tagsMap = new Map(tags.map((t) => [t.id, t]));
    const projectsMap = new Map(projects.map((p) => [p.id, p]));

    return unique.map((raw): PaperWithTags => ({
      ...raw,
      tags: raw.tagIds.map((id) => tagsMap.get(id)).filter((t): t is Tag => !!t),
      projects: raw.projectIds.map((id) => projectsMap.get(id)).filter((p): p is Project => !!p),
    }));
  }, [data, tags, projects]);

  // ── Cache helpers ──
  const { updatePapersCache, invalidateAndRefetch } = usePaperCacheHelpers(userId, serverFilterParams);

  // ── Taxonomy mutations ──
  const { createProject, updateProject, deleteProject } = useProjectMutations(userId, projects);
  const { createTag, updateTag, deleteTag } = useTagMutations(userId, tags);

  // ── Paper mutations ──
  const { addPaperManually, updatePaper, deletePaper } = usePaperMutations(userId, papers, projects, tags, normalizationConfig, serverFilterParams);

  // ── Bulk mutations ──
  const { addPapers, bulkImportPapers, bulkImportFromParsedData, bulkDeletePapers, bulkSetProjects, bulkSetTags, reevaluateStudyTypes, reevaluateKeywords } = useBulkMutations(userId, papers, projects, tags, normalizationConfig, serverFilterParams);

  // ── All keywords across ALL papers (unfiltered — for Sidebar import suggestions) ──
  // Replaces the old loaded-papers-only memo to preserve eager-load-era completeness.
  const { data: allKeywords } = useQuery<string[]>({
    queryKey: queryKeys.papers.allKeywords(userId!),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("papers")
        .select("keywords")
        .eq("user_id", userId!);
      if (error) throw error;
      const set = new Set<string>();
      (data || []).forEach((row: { keywords: string[] | null }) => {
        (row.keywords || []).forEach((kw: string) => set.add(kw));
      });
      return Array.from(set).sort();
    },
    enabled: !!userId,
    staleTime: 60_000,
  });

  // ── All study types across ALL papers (unfiltered — for Sidebar import suggestions) ──
  // Replaces the old loaded-papers-only memo to preserve eager-load-era completeness.
  const { data: allStudyTypes } = useQuery<string[]>({
    queryKey: queryKeys.papers.allStudyTypes(userId!),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("papers")
        .select("study_type")
        .eq("user_id", userId!);
      if (error) throw error;
      const set = new Set<string>();
      (data || []).forEach((row: { study_type: string | null }) => {
        if (row.study_type) {
          row.study_type
            .split(/[,;]+/)
            .map((t: string) => t.trim())
            .filter(Boolean)
            .forEach((t: string) => set.add(t));
        }
      });
      return Array.from(set).sort();
    },
    enabled: !!userId,
    staleTime: 60_000,
  });

  return {
    papers,
    projects,
    tags,
    loading,
    tagsLoading,
    projectsLoading,
    allKeywords: allKeywords ?? [],
    allStudyTypes: allStudyTypes ?? [],
    totalCount: totalCount ?? papers.length,
    filteredCount: filteredCount ?? papers.length,
    allFilteredIds,
    serverKeywordOptions,
    fetchNextPage,
    hasNextPage: hasNextPage ?? false,
    isFetchingNextPage,
    createProject,
    updateProject,
    deleteProject,
    createTag,
    updateTag,
    deleteTag,
    addPapers,
    addPaperManually,
    bulkImportPapers,
    bulkImportFromParsedData,
    updatePaper,
    deletePaper,
    bulkDeletePapers,
    bulkSetProjects,
    bulkSetTags,
    reevaluateStudyTypes,
    reevaluateKeywords,
    updatePapersCache,
    refetch: () => queryClient.invalidateQueries({ queryKey: queryKeys.papers.all(userId!) }),
  };
}
