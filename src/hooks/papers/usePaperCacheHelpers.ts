import { useCallback } from "react";
import { useQueryClient, InfiniteData } from "@tanstack/react-query";
import { PaperWithTags, Project, Tag } from "@/types/database";
import { queryKeys } from "@/lib/queryKeys";
import { PapersPage, RawPaperWithJunctions, CacheSnapshot } from "./types";

export function usePaperCacheHelpers(userId: string | undefined) {
  const queryClient = useQueryClient();

  const snapshotCache = useCallback((): CacheSnapshot => {
    if (!userId) return { papers: undefined, count: undefined, projects: undefined, tags: undefined };
    return {
      papers: queryClient.getQueryData<InfiniteData<PapersPage>>(queryKeys.papers.all(userId)),
      count: queryClient.getQueryData<number>(queryKeys.papers.count(userId)),
      projects: queryClient.getQueryData<Project[]>(queryKeys.projects.all(userId)),
      tags: queryClient.getQueryData<Tag[]>(queryKeys.tags.all(userId)),
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
      if (snapshot.projects !== undefined) {
        queryClient.setQueryData(queryKeys.projects.all(userId), snapshot.projects);
      }
      if (snapshot.tags !== undefined) {
        queryClient.setQueryData(queryKeys.tags.all(userId), snapshot.tags);
      }
    },
    [userId, queryClient],
  );

  const cancelQueries = useCallback(async () => {
    if (!userId) return;
    await queryClient.cancelQueries({ queryKey: queryKeys.papers.all(userId) });
  }, [userId, queryClient]);

  /**
   * Update the papers cache. Accepts an updater that works with hydrated PaperWithTags[].
   * Internally hydrates raw cache → PaperWithTags, runs updater, strips back.
   */
  const updatePapersCache = useCallback(
    (updater: (papers: PaperWithTags[]) => PaperWithTags[]) => {
      if (!userId) return;

      const projects = queryClient.getQueryData<Project[]>(queryKeys.projects.all(userId)) ?? [];
      const tags = queryClient.getQueryData<Tag[]>(queryKeys.tags.all(userId)) ?? [];
      const tagsMap = new Map(tags.map((t) => [t.id, t]));
      const projectsMap = new Map(projects.map((p) => [p.id, p]));

      queryClient.setQueryData(
        queryKeys.papers.all(userId),
        (old: InfiniteData<PapersPage> | undefined) => {
          if (!old) return old;

          // Hydrate raw → PaperWithTags
          const allRaw = old.pages.flatMap((p) => p.papers);
          const hydrated: PaperWithTags[] = allRaw.map((raw) => ({
            ...raw,
            tags: raw.tagIds.map((id) => tagsMap.get(id)).filter((t): t is Tag => !!t),
            projects: raw.projectIds.map((id) => projectsMap.get(id)).filter((p): p is Project => !!p),
          }));

          // Run caller's updater
          const updated = updater(hydrated);

          // Strip back to RawPaperWithJunctions
          const stripped: RawPaperWithJunctions[] = updated.map((p) => {
            const { tags: pTags, projects: pProjects, ...rest } = p;
            return {
              ...rest,
              tagIds: pTags.map((t) => t.id),
              projectIds: pProjects.map((pr) => pr.id),
            };
          });

          return {
            ...old,
            pages: old.pages.map((page, i) =>
              i === 0
                ? { ...page, papers: stripped }
                : { ...page, papers: [] },
            ),
          };
        },
      );
    },
    [userId, queryClient],
  );

  /**
   * Update projects and tags caches. Same signature as before —
   * now reads/writes separate caches instead of PapersPage entries.
   */
  const updateMetaCache = useCallback(
    (updater: (projects: Project[], tags: Tag[]) => { projects: Project[]; tags: Tag[] }) => {
      if (!userId) return;
      const oldProjects = queryClient.getQueryData<Project[]>(queryKeys.projects.all(userId)) ?? [];
      const oldTags = queryClient.getQueryData<Tag[]>(queryKeys.tags.all(userId)) ?? [];
      const { projects: newProjects, tags: newTags } = updater(oldProjects, oldTags);
      queryClient.setQueryData(queryKeys.projects.all(userId), newProjects);
      queryClient.setQueryData(queryKeys.tags.all(userId), newTags);
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
