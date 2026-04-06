import { useQuery } from "@tanstack/react-query";
import { Paper } from "@/types/database";
import { ServerFilterParams, ServerSortParams, areServerFiltersReady } from "./papers/types";
import { buildPapersQuery } from "@/lib/buildPapersQuery";
import { fetchAllPages } from "@/lib/fetchAllPages";
import { queryKeys } from "@/lib/queryKeys";
import { timedQueryFn } from "@/lib/queryTiming";

/** Minimal select — only fields needed for analytics aggregations. */
const ANALYTICS_SELECT =
  "id, title, authors, year, journal, study_type, keywords, mesh_terms, substances, abstract";

interface UseAnalyticsDataArgs {
  userId: string | undefined;
  serverFilterParams: ServerFilterParams;
  serverSortParams: ServerSortParams;
  /** Set to true when the analytics panel is open — gates the fetch. */
  enabled: boolean;
}

/**
 * Dedicated analytics data hook.
 *
 * Fetches ALL matching papers (no pagination limit) using buildPapersQuery + fetchAllPages.
 * All filters (including keywords) are server-side via filterPaperIds.
 *
 * No junction hydration — analytics only uses Paper-level fields.
 * React Query caches by server filter params.
 */
export function useAnalyticsData({
  userId,
  serverFilterParams,
  serverSortParams,
  enabled,
}: UseAnalyticsDataArgs) {
  const filtersReady = areServerFiltersReady(serverFilterParams);

  const { data: rawPapers, isLoading } = useQuery<Paper[]>({
    queryKey: queryKeys.papers.analytics(userId!, serverFilterParams, serverSortParams),
    queryFn: timedQueryFn("analytics.fetchAllPages", async () => {
      const { filterPaperIds } = serverFilterParams;

      // Short-circuit: filter resolved with no matches
      if (filterPaperIds !== null && filterPaperIds !== undefined && filterPaperIds.length === 0) {
        return [];
      }

      return fetchAllPages<Paper>(
        () => buildPapersQuery(userId!, serverFilterParams, serverSortParams, ANALYTICS_SELECT),
      );
    }),
    enabled: !!userId && filtersReady && enabled,
  });

  return { papers: rawPapers ?? [], isLoading };
}
