import { useCallback } from "react";
import { useQueryClient, InfiniteData } from "@tanstack/react-query";
import { PaperWithTags, Project, Tag } from "@/types/database";
import { queryKeys } from "@/lib/queryKeys";
import { PapersPage, CacheSnapshot } from "./types";

export function usePaperCacheHelpers(userId: string | undefined) {
  const queryClient = useQueryClient();

  const snapshotCache = useCallback((): CacheSnapshot => {
    if (!userId) return { papers: undefined, count: undefined };
    return {
      papers: queryClient.getQueryData<InfiniteData<PapersPage>>(queryKeys.papers.all(userId)),
      count: queryClient.getQueryData<number>(queryKeys.papers.count(userId)),
    };
  }, [userId, queryClient]);

  const rollbackCache = useCallback(
    (snapshot: CacheSnapshot) => {
      if (!userId) return;
      if (snapshot.papers !== undefined) {
        queryClient.setQueryData(queryKeys.papers.all(userId), snapshot.papers);
      }
      if (snapshot.count !== undefined) {
        queryClient.setQueryData(queryKeys.papers.count(userId), snapshot.count);
      }
    },
    [userId, queryClient],
  );

  const cancelQueries = useCallback(async () => {
    if (!userId) return;
    await queryClient.cancelQueries({ queryKey: queryKeys.papers.all(userId) });
  }, [userId, queryClient]);

  const updatePapersCache = useCallback(
    (updater: (papers: PaperWithTags[]) => PaperWithTags[]) => {
      if (!userId) return;
      queryClient.setQueryData(
        queryKeys.papers.all(userId),
        (old: InfiniteData<PapersPage> | undefined) => {
          if (!old) return old;
          const allPapers = old.pages.flatMap((p) => p.papers);
          const updated = updater(allPapers);
          return {
            ...old,
            pages: old.pages.map((page, i) =>
              i === 0
                ? { ...page, papers: updated }
                : { ...page, papers: [] },
            ),
          };
        },
      );
    },
    [userId, queryClient],
  );

  const updateMetaCache = useCallback(
    (updater: (projects: Project[], tags: Tag[]) => { projects: Project[]; tags: Tag[] }) => {
      if (!userId) return;
      queryClient.setQueryData(
        queryKeys.papers.all(userId),
        (old: InfiniteData<PapersPage> | undefined) => {
          if (!old) return old;
          const { projects: newProjects, tags: newTags } = updater(
            old.pages[0]?.projects ?? [],
            old.pages[0]?.tags ?? [],
          );
          return {
            ...old,
            pages: old.pages.map((page) => ({
              ...page,
              projects: newProjects,
              tags: newTags,
            })),
          };
        },
      );
    },
    [userId, queryClient],
  );

  const adjustCount = useCallback(
    (delta: number) => {
      if (!userId) return;
      queryClient.setQueryData(
        queryKeys.papers.count(userId),
        (old: number | undefined) => Math.max(0, (old ?? 0) + delta),
      );
    },
    [userId, queryClient],
  );

  return {
    snapshotCache,
    rollbackCache,
    cancelQueries,
    updatePapersCache,
    updateMetaCache,
    adjustCount,
  };
}
