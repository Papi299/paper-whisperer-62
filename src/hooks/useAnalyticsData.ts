import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Paper } from "@/types/database";
import { ServerFilterParams, areServerFiltersReady } from "./papers/types";
import { ClientFilterParams, applyClientFilters } from "@/lib/applyClientFilters";
import { buildPapersQuery } from "@/lib/buildPapersQuery";
import { fetchAllPages } from "@/lib/fetchAllPages";
import { queryKeys } from "@/lib/queryKeys";

/** Minimal select — only fields needed by applyClientFilters + analytics aggregations. */
const ANALYTICS_SELECT =
  "id, title, authors, year, journal, study_type, keywords, mesh_terms, substances, abstract";

interface UseAnalyticsDataArgs {
  userId: string | undefined;
  serverFilterParams: ServerFilterParams;
  clientFilterParams: ClientFilterParams;
  /** Set to true when the analytics panel is open — gates the fetch. */
  enabled: boolean;
}

/**
 * Dedicated analytics data hook.
 *
 * Fetches ALL matching papers (no pagination limit) using buildPapersQuery + fetchAllPages,
 * then applies client-only filters via applyClientFilters in a useMemo.
 *
 * No junction hydration — analytics only uses Paper-level fields.
 * React Query caches by server filter params; client filter changes only re-run the memo.
 */
export function useAnalyticsData({
  userId,
  serverFilterParams,
  clientFilterParams,
  enabled,
}: UseAnalyticsDataArgs) {
  const filtersReady = areServerFiltersReady(serverFilterParams);

  const { data: rawPapers, isLoading } = useQuery<Paper[]>({
    queryKey: queryKeys.papers.analytics(userId!, serverFilterParams),
    queryFn: async () => {
      const { filterPaperIds } = serverFilterParams;

      // Short-circuit: filter resolved with no matches
      if (filterPaperIds !== null && filterPaperIds !== undefined && filterPaperIds.length === 0) {
        return [];
      }

      return fetchAllPages<Paper>(
        () => buildPapersQuery(userId!, serverFilterParams, ANALYTICS_SELECT),
      );
    },
    enabled: !!userId && filtersReady && enabled,
  });

  // Client-only filters applied as a post-filter memo — no refetch on keyword/short-search changes
  const papers = useMemo(() => {
    if (!rawPapers || rawPapers.length === 0) return [];
    return applyClientFilters(rawPapers, clientFilterParams);
  }, [rawPapers, clientFilterParams]);

  return { papers, isLoading };
}
