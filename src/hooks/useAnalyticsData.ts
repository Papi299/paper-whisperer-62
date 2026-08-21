import { useQuery } from "@tanstack/react-query";
import { Paper } from "@/types/database";
import { ServerFilterParams, ServerSortParams, areServerFiltersReady } from "./papers/types";
import { buildPapersQuery } from "@/lib/buildPapersQuery";
import { fetchAllPages } from "@/lib/fetchAllPages";
import { queryKeys } from "@/lib/queryKeys";
import { timedQueryFn } from "@/lib/queryTiming";

/**
 * Minimal select — only fields needed for analytics aggregations.
 *
 * `author_provenance` is here for AUTHOR-IDENTITY-RESOLUTION-001C, and it is the
 * one field that serves the identity surface rather than a chart. The identity
 * manager needs it for two things it cannot do without:
 *
 *   • the ORCID a source stated for a mention, which is the strongest
 *     deterministic candidate the feature offers;
 *   • whether a source explicitly marked an author `collective`, which is what
 *     stops a consortium being offered as a person.
 *
 * Without it both degrade silently — no ORCID suggestions, and a study group
 * listed as someone to resolve — which is worse than either failing loudly.
 *
 * The cost is bounded by where this query runs: it is gated on the analytics
 * panel actually being open, and the identity manager lives inside that same
 * panel, so nothing pays for this until the user opens the surface that uses it.
 * The already-selected `abstract` is by far the larger field.
 */
const ANALYTICS_SELECT =
  "id, title, authors, author_provenance, year, journal, study_type, keywords, mesh_terms, substances, abstract";

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
