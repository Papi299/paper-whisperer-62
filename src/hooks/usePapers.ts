import { useEffect, useMemo } from "react";
import { useQuery, useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Paper, PaperWithTags, Project, Tag } from "@/types/database";
import { NormalizationConfig } from "@/lib/normalizePaperData";
import { queryKeys } from "@/lib/queryKeys";
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

  // ── Infinite query: papers with server-side filtering + sorting ──
  const {
    data,
    isLoading: papersLoading,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery<PapersPage, Error>({
    queryKey: queryKeys.papers.list(userId!, serverFilterParams),
    queryFn: async ({ pageParam }): Promise<PapersPage> => {
      const page = pageParam as number;
      const from = page * PAGE_SIZE;
      const to = from + PAGE_SIZE - 1;

      const { filterPaperIds, yearFrom, yearTo, studyTypes, sortColumn, sortAscending } =
        serverFilterParams;

      // Short-circuit: filter resolved with no matches
      if (filterPaperIds !== null && filterPaperIds !== undefined && filterPaperIds.length === 0) {
        return { papers: [], hasMore: false };
      }

      // Build query with server-side predicates
      let query = supabase
        .from("papers")
        .select("*, paper_attachments(id, file_name, file_path, file_type)")
        .eq("user_id", userId!);

      // ID-based filtering (pre-resolved from junction queries + search)
      if (filterPaperIds !== null && filterPaperIds !== undefined) {
        query = query.in("id", filterPaperIds);
      }

      // Year range
      if (yearFrom !== null) query = query.gte("year", yearFrom);
      if (yearTo !== null) query = query.lte("year", yearTo);

      // Study type
      if (studyTypes !== null && studyTypes.length > 0) {
        query = query.in("study_type", studyTypes);
      }

      // Sort: server-side is the single source of truth
      if (sortColumn !== null && sortAscending !== null) {
        query = query.order(sortColumn, { ascending: sortAscending });
      } else {
        query = query.order("insert_order", { ascending: false });
      }

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
    // Gated: don't run when ID-based filters are still loading
    enabled: !!userId && filtersReady,
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

  // ── Auto-fetch all pages for whole-library correctness ──
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const loading = papersLoading || projectsLoading || tagsLoading;
  const allLoaded = !hasNextPage && !isFetchingNextPage && !loading;

  // Stable references
  const projects = useMemo(() => projectsData ?? [], [projectsData]);
  const tags = useMemo(() => tagsData ?? [], [tagsData]);

  // Hydrate raw papers + junction IDs -> PaperWithTags
  const papers = useMemo(() => {
    const rawPapers = data?.pages.flatMap((p) => p.papers) ?? [];
    if (rawPapers.length === 0) return [];

    const tagsMap = new Map(tags.map((t) => [t.id, t]));
    const projectsMap = new Map(projects.map((p) => [p.id, p]));

    return rawPapers.map((raw): PaperWithTags => ({
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
  const { addPapers, bulkImportPapers, bulkImportFromParsedData, bulkDeletePapers, bulkSetProjects, bulkSetTags, reevaluateStudyTypes } = useBulkMutations(userId, papers, projects, tags, normalizationConfig, serverFilterParams);

  // Extract all unique keywords from papers
  const allKeywords = useMemo(() => {
    const keywordSet = new Set<string>();
    papers.forEach((paper) => {
      paper.keywords.forEach((kw) => keywordSet.add(kw));
    });
    return Array.from(keywordSet).sort();
  }, [papers]);

  return {
    papers,
    projects,
    tags,
    loading,
    allLoaded,
    allKeywords,
    totalCount: totalCount ?? papers.length,
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
    updatePapersCache,
    refetch: () => queryClient.invalidateQueries({ queryKey: queryKeys.papers.all(userId!) }),
  };
}
