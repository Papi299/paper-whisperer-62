import { useEffect, useMemo } from "react";
import { useQuery, useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Paper, PaperWithTags, Project, Tag } from "@/types/database";
import { NormalizationConfig } from "@/lib/normalizePaperData";
import { queryKeys } from "@/lib/queryKeys";
import { PapersPage } from "./papers/types";
import { usePaperCacheHelpers } from "./papers/usePaperCacheHelpers";
import { useProjectMutations } from "./papers/useProjectMutations";
import { useTagMutations } from "./papers/useTagMutations";
import { usePaperMutations } from "./papers/usePaperMutations";
import { useBulkMutations } from "./papers/useBulkMutations";

const PAGE_SIZE = 100;

export function usePapers(userId: string | undefined, normalizationConfig?: NormalizationConfig) {
  const queryClient = useQueryClient();

  // ── Infinite query: papers (paginated) + projects + tags ──
  const {
    data,
    isLoading: loading,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery<PapersPage, Error>({
    queryKey: queryKeys.papers.all(userId!),
    queryFn: async ({ pageParam }): Promise<PapersPage> => {
      const page = pageParam as number;
      const from = page * PAGE_SIZE;
      const to = from + PAGE_SIZE - 1;

      // Projects and tags: always fetch all (they're small)
      const [projectsResult, tagsResult] = await Promise.all([
        supabase.from("projects").select("*").eq("user_id", userId!).order("name"),
        supabase.from("tags").select("*").eq("user_id", userId!).order("name"),
      ]);
      if (projectsResult.error) throw projectsResult.error;
      if (tagsResult.error) throw tagsResult.error;

      const fetchedProjects = (projectsResult.data as Project[]) || [];
      const fetchedTags = (tagsResult.data as Tag[]) || [];

      // Papers: paginated
      const { data: papersData, error: papersError } = await supabase
        .from("papers")
        .select("*, paper_attachments(id, file_name, file_path, file_type)")
        .eq("user_id", userId!)
        .order("created_at", { ascending: false })
        .range(from, to);
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

      // Assemble PaperWithTags
      const assembledPapers: PaperWithTags[] = rawPapers.map((paper) => {
        const paperTagIds = (paperTagsData || [])
          .filter((pt: { paper_id: string; tag_id: string }) => pt.paper_id === paper.id)
          .map((pt: { tag_id: string }) => pt.tag_id);
        const paperTags = fetchedTags.filter((t) => paperTagIds.includes(t.id));

        const paperProjectIds = (paperProjectsData || [])
          .filter((pp: { paper_id: string; project_id: string }) => pp.paper_id === paper.id)
          .map((pp: { project_id: string }) => pp.project_id);
        const paperProjects = fetchedProjects.filter((p) => paperProjectIds.includes(p.id));

        return { ...paper, tags: paperTags, projects: paperProjects };
      });

      return {
        papers: assembledPapers,
        projects: fetchedProjects,
        tags: fetchedTags,
        hasMore: rawPapers.length === PAGE_SIZE,
      };
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage, _allPages, lastPageParam) => {
      if (!lastPage.hasMore) return undefined;
      return (lastPageParam as number) + 1;
    },
    enabled: !!userId,
  });

  // ── Total paper count (separate lightweight query) ──
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

  const allLoaded = !hasNextPage && !isFetchingNextPage && !loading;

  // Flatten pages into single arrays
  const papers = useMemo(
    () => data?.pages.flatMap((p) => p.papers) ?? [],
    [data],
  );
  const rawProjects = data?.pages?.[0]?.projects;
  const rawTags = data?.pages?.[0]?.tags;
  const projects = useMemo(() => rawProjects ?? [], [rawProjects]);
  const tags = useMemo(() => rawTags ?? [], [rawTags]);

  // ── Cache helpers (only updatePapersCache needed directly in facade) ──
  const { updatePapersCache } = usePaperCacheHelpers(userId);

  // ── Taxonomy mutations (Phase 1) ──
  const { createProject, updateProject, deleteProject } = useProjectMutations(userId, projects);
  const { createTag, updateTag, deleteTag } = useTagMutations(userId, tags);

  // ── Paper mutations (Phase 2) ──
  const { addPaperManually, updatePaper, deletePaper } = usePaperMutations(userId, papers, projects, tags, normalizationConfig);

  // ── Bulk mutations (Phase 2) ──
  const { addPapers, bulkImportPapers, bulkImportFromParsedData, bulkDeletePapers, bulkSetProjects, bulkSetTags, reevaluateStudyTypes } = useBulkMutations(userId, papers, projects, tags, normalizationConfig);

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
