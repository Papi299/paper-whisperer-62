import { useCallback, useMemo } from "react";
import { useQueryClient, InfiniteData } from "@tanstack/react-query";
import { PaperWithTags, Project, Tag } from "@/types/database";
import { queryKeys } from "@/lib/queryKeys";
import { PapersPage, RawPaperWithJunctions, CacheSnapshot, ServerFilterParams, ServerSortParams } from "./types";

export function usePaperCacheHelpers(
  userId: string | undefined,
  serverFilterParams: ServerFilterParams,
  serverSortParams: ServerSortParams,
) {
  const queryClient = useQueryClient();

  /** Exact key for the currently active papers list query. */
  const activeListKey = useMemo(
    () => (userId ? queryKeys.papers.list(userId, serverFilterParams, serverSortParams) : null),
    [userId, serverFilterParams, serverSortParams],
  );

  const snapshotCache = useCallback((): CacheSnapshot => {
    if (!userId || !activeListKey)
      return { papers: undefined, count: undefined, projects: undefined, tags: undefined };
    return {
      papers: queryClient.getQueryData<InfiniteData<PapersPage>>(activeListKey),
      count: queryClient.getQueryData<number>(queryKeys.papers.count(userId)),
      projects: queryClient.getQueryData<Project[]>(queryKeys.projects.all(userId)),
      tags: queryClient.getQueryData<Tag[]>(queryKeys.tags.all(userId)),
    };
  }, [userId, activeListKey, queryClient]);

  const rollbackCache = useCallback(
    (snapshot: CacheSnapshot) => {
      if (!userId || !activeListKey) return;
      if (snapshot.papers !== undefined) {
        queryClient.setQueryData(activeListKey, snapshot.papers);
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
    [userId, activeListKey, queryClient],
  );

  const cancelQueries = useCallback(async () => {
    if (!activeListKey) return;
    await queryClient.cancelQueries({ queryKey: activeListKey });
  }, [activeListKey, queryClient]);

  /**
   * Update the papers cache on the exact active list key.
   * Accepts an updater that works with hydrated PaperWithTags[].
   * Internally hydrates raw cache -> PaperWithTags, runs updater, strips back.
   */
  const updatePapersCache = useCallback(
    (updater: (papers: PaperWithTags[]) => PaperWithTags[]) => {
      if (!userId || !activeListKey) return;

      const projects = queryClient.getQueryData<Project[]>(queryKeys.projects.all(userId)) ?? [];
      const tags = queryClient.getQueryData<Tag[]>(queryKeys.tags.all(userId)) ?? [];
      const tagsMap = new Map(tags.map((t) => [t.id, t]));
      const projectsMap = new Map(projects.map((p) => [p.id, p]));

      queryClient.setQueryData(
        activeListKey,
        (old: InfiniteData<PapersPage> | undefined) => {
          if (!old) return old;

          // Hydrate raw -> PaperWithTags
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
    [userId, activeListKey, queryClient],
  );

  /**
   * Update projects and tags caches.
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

  /**
   * Adjust the filtered count by a delta (e.g., -1 on delete).
   * Only updates if a cached filtered count exists for the active params.
   */
  const adjustFilteredCount = useCallback(
    (delta: number) => {
      if (!userId) return;
      const key = queryKeys.papers.filteredCount(userId, serverFilterParams);
      queryClient.setQueryData(
        key,
        (old: number | undefined) => old !== undefined ? Math.max(0, old + delta) : undefined,
      );
    },
    [userId, serverFilterParams, queryClient],
  );

  /**
   * Remove stale non-active list caches to prevent cross-filter contamination.
   * Called after successful server mutations (not on rollback).
   */
  const removeStaleListCaches = useCallback(() => {
    if (!userId || !activeListKey) return;
    const activeKeyStr = JSON.stringify(activeListKey);
    queryClient.removeQueries({
      queryKey: queryKeys.papers.all(userId),
      predicate: (query) => {
        const key = query.queryKey;
        return (
          key.length > 2 &&
          key[2] === "list" &&
          JSON.stringify(key) !== activeKeyStr
        );
      },
    });
  }, [userId, activeListKey, queryClient]);

  /**
   * Invalidate all papers queries (active + stale) and junction pre-query caches.
   * Used after add/import mutations where new papers may not match active filter.
   */
  const invalidateAndRefetch = useCallback(() => {
    if (!userId) return;
    queryClient.invalidateQueries({ queryKey: queryKeys.papers.all(userId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.papers.count(userId) });
    queryClient.invalidateQueries({ queryKey: ["junction"] });
  }, [userId, queryClient]);

  /**
   * Invalidate junction pre-query caches only.
   * Used after mutations that change junction membership (bulk set projects/tags).
   */
  const invalidateJunctionCaches = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["junction"] });
  }, [queryClient]);

  return {
    snapshotCache,
    rollbackCache,
    cancelQueries,
    updatePapersCache,
    updateMetaCache,
    adjustCount,
    adjustFilteredCount,
    removeStaleListCaches,
    invalidateAndRefetch,
    invalidateJunctionCaches,
  };
}
