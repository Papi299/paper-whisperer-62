import { useCallback, useMemo, useState } from "react";
import { useInfiniteQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { retryTransient } from "@/hooks/useStudyRecords";
import { toStudyId, type StudyVersion } from "@/lib/evidence/ids";
import type { HistoryEvent } from "@/lib/evidence/types";
import { queryKeys } from "@/lib/queryKeys";
import {
  fetchHistoryChanges,
  fetchHistoryPage,
  mergeHistoryPages,
  type HistoryChangesRead,
  type HistoryOperation,
  type HistoryPageRead,
} from "@/lib/studyRecord/historyRead";
import { StudyRecordReadError } from "@/lib/studyRecord/read";

/**
 * A study record's history, as the History pane reads it (EVIDENCE-RECORDS-001C2B).
 * Owner-scoped SELECTs only — see `src/lib/studyRecord/historyRead.ts`.
 *
 * ON DEMAND, AND FRESH. Nothing is read until the History pane is shown, and
 * nothing outlives it: the pane mounts only while History is the chosen mode,
 * and these queries keep nothing once it unmounts (`gcTime: 0`). So every
 * opening of History reads the newest operations as they are now — after a
 * Save, Confirm, Flag or link change made in Edit or Review, the new operation
 * is there. While History is open:
 *   * the list of operations is stale at once (`staleTime: 0`), so a write this
 *     editor makes — every one invalidates `studyRecords.all(userId)` — reads
 *     it again; a change made in another tab or window appears on Refresh;
 *   * Refresh reads the newest page again and drops the older pages loaded so
 *     far, so it costs one request however far back the user had read;
 *   * Load older reads below the oldest version shown — never an offset — so it
 *     cannot repeat or skip an operation whatever was committed meanwhile, and
 *     after a failure it asks for the same page again;
 *   * an operation's changes are committed once and never change, so they are
 *     read when it is opened and not again while it stays open
 *     (`staleTime: "static"`).
 * Keys are user-scoped, like every study-record key: one account is never
 * shown another's history. A read that finds the study gone says so, and
 * nothing read before it is shown as if the record still existed.
 */

type Pages = InfiniteData<HistoryPageRead, StudyVersion | null>;
type ChangePages = InfiniteData<HistoryChangesRead, number>;

export type HistoryStatus =
  /** Nothing has been read yet. */
  | "loading"
  /** The first read failed: `error` says why. Never shown as an empty history. */
  | "error"
  /** The study no longer exists for this user. */
  | "gone"
  | "ready";

export interface StudyRecordHistory {
  readonly status: HistoryStatus;
  /** Newest first. Empty unless `ready`. */
  readonly operations: readonly HistoryOperation[];
  readonly error: StudyRecordReadError | null;
  /** Older operations exist below the oldest shown. */
  readonly hasOlder: boolean;
  readonly loadingOlder: boolean;
  /** The last Load older failed; what is shown stays. */
  readonly olderFailed: boolean;
  readonly refreshing: boolean;
  /** The last read of the newest operations failed; what is shown was read before. */
  readonly refreshFailed: boolean;
  /** Read the next older page. Resolves to whether it added operations. */
  readonly loadOlder: () => Promise<boolean>;
  /** Read the newest page again, dropping older pages. */
  readonly refresh: () => Promise<void>;
  /** Record that a read found the study gone (an operation's details did). */
  readonly markGone: () => void;
}

const asReadError = (error: unknown): StudyRecordReadError =>
  error instanceof StudyRecordReadError ? error : new StudyRecordReadError("transport", false);

export function useStudyRecordHistory(userId: string | null | undefined, studyId: string | null | undefined, enabled: boolean): StudyRecordHistory {
  const id = toStudyId(studyId);
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => queryKeys.studyRecords.history(userId ?? "anonymous", id ?? "none"), [userId, id]);
  const [goneSeen, setGoneSeen] = useState(false);
  const query = useInfiniteQuery<HistoryPageRead, Error, Pages, readonly unknown[], StudyVersion | null>({
    queryKey,
    queryFn: ({ pageParam, signal }) => fetchHistoryPage(supabase, userId!, id!, pageParam, signal),
    initialPageParam: null,
    getNextPageParam: (last) => (last.kind === "page" ? last.olderThan : null),
    enabled: enabled && !!userId && !!id,
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: retryTransient,
  });

  const merged = useMemo(() => {
    if (!query.data) return null;
    try {
      return mergeHistoryPages(query.data.pages);
    } catch (error) {
      return { kind: "error" as const, error: asReadError(error) };
    }
  }, [query.data]);

  const { hasNextPage, isFetching, fetchNextPage, refetch } = query;
  const pageCount = query.data?.pages.length ?? 0;

  const loadOlder = useCallback(async () => {
    if (!hasNextPage || isFetching) return false;
    const result = await fetchNextPage({ cancelRefetch: false });
    return !result.isError && (result.data?.pages.length ?? 0) > pageCount;
  }, [fetchNextPage, hasNextPage, isFetching, pageCount]);

  const refresh = useCallback(async () => {
    // Keep only the newest page, then read it again: one request, from the top.
    queryClient.setQueryData<Pages>(queryKey, (data) =>
      data && data.pages.length > 1 ? { pages: data.pages.slice(0, 1), pageParams: data.pageParams.slice(0, 1) } : data,
    );
    await refetch();
  }, [queryClient, queryKey, refetch]);

  const markGone = useCallback(() => setGoneSeen(true), []);

  let status: HistoryStatus;
  let error: StudyRecordReadError | null = null;
  if (goneSeen || merged?.kind === "gone") status = "gone";
  else if (merged?.kind === "error") {
    status = "error";
    error = merged.error;
  } else if (merged?.kind === "operations") status = "ready";
  else if (query.isError) {
    status = "error";
    error = asReadError(query.error);
  } else status = "loading";

  return {
    status,
    operations: status === "ready" && merged?.kind === "operations" ? merged.operations : [],
    error: error ?? (query.isError ? asReadError(query.error) : null),
    hasOlder: status === "ready" && !!hasNextPage,
    loadingOlder: query.isFetchingNextPage,
    olderFailed: query.isFetchNextPageError,
    refreshing: query.isRefetching,
    refreshFailed: query.isRefetchError,
    loadOlder,
    refresh,
    markGone,
  };
}

export interface HistoryOperationChanges {
  readonly status: HistoryStatus;
  /** In ordinal order. */
  readonly changes: readonly HistoryEvent[];
  readonly error: StudyRecordReadError | null;
  readonly hasMore: boolean;
  readonly loadingMore: boolean;
  readonly moreFailed: boolean;
  readonly loadMore: () => Promise<boolean>;
  readonly retry: () => Promise<void>;
}

/** The change events of one committed operation, read while `enabled` (its details are open). */
export function useStudyRecordHistoryChanges(
  userId: string | null | undefined,
  studyId: string | null | undefined,
  operation: Pick<HistoryOperation, "studyVersion" | "requestId">,
  enabled: boolean,
): HistoryOperationChanges {
  const id = toStudyId(studyId);
  const query = useInfiniteQuery<HistoryChangesRead, Error, ChangePages, readonly unknown[], number>({
    queryKey: queryKeys.studyRecords.historyOperation(userId ?? "anonymous", id ?? "none", operation.studyVersion),
    queryFn: ({ pageParam, signal }) => fetchHistoryChanges(supabase, userId!, id!, operation, pageParam, signal),
    initialPageParam: 0,
    getNextPageParam: (last) => (last.kind === "page" ? last.after : null),
    enabled: enabled && !!userId && !!id,
    staleTime: "static",
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: retryTransient,
  });

  const { hasNextPage, isFetching, fetchNextPage, refetch } = query;
  const pageCount = query.data?.pages.length ?? 0;
  const loadMore = useCallback(async () => {
    if (!hasNextPage || isFetching) return false;
    const result = await fetchNextPage({ cancelRefetch: false });
    return !result.isError && (result.data?.pages.length ?? 0) > pageCount;
  }, [fetchNextPage, hasNextPage, isFetching, pageCount]);
  const retry = useCallback(async () => {
    await refetch();
  }, [refetch]);

  const pages = query.data?.pages ?? null;
  const gone = pages?.some((page) => page.kind === "gone") ?? false;
  const changes = useMemo(() => (pages ? pages.flatMap((page) => (page.kind === "page" ? page.changes : [])) : []), [pages]);
  const status: HistoryStatus = gone ? "gone" : pages ? "ready" : query.isError ? "error" : "loading";

  return {
    status,
    changes: status === "ready" ? changes : [],
    error: query.isError ? asReadError(query.error) : null,
    hasMore: status === "ready" && !!hasNextPage,
    loadingMore: query.isFetchingNextPage,
    moreFailed: query.isFetchNextPageError,
    loadMore,
    retry,
  };
}
