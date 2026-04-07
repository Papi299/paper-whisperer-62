import { useQuery, QueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { queryKeys } from "@/lib/queryKeys";

/**
 * On-demand abstract fetcher for a single paper.
 *
 * Used when the UI needs the full abstract text (expand row, edit dialog,
 * AI analyze) after it was excluded from the base list payload.
 *
 * - `staleTime: Infinity` — abstract rarely changes; mutations invalidate explicitly.
 * - `gcTime: 30 min` — keep fetched abstracts warm across repeated opens.
 */
export function useAbstract(paperId: string | null) {
  return useQuery({
    queryKey: queryKeys.papers.abstract(paperId!),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("papers")
        .select("abstract")
        .eq("id", paperId!)
        .single();
      if (error) throw error;
      return (data.abstract as string | null) ?? null;
    },
    enabled: !!paperId,
    staleTime: Infinity,
    gcTime: 30 * 60 * 1000, // 30 minutes
  });
}

/**
 * Imperative helper for fetching a paper's abstract outside of component render.
 * Checks the React Query cache first; falls back to a network fetch.
 *
 * Used by analyze flows (single + bulk) where we need the abstract before
 * invoking the edge function but aren't inside a hook.
 */
export async function fetchAbstract(
  paperId: string,
  queryClient: QueryClient,
): Promise<string | null> {
  return queryClient.fetchQuery({
    queryKey: queryKeys.papers.abstract(paperId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("papers")
        .select("abstract")
        .eq("id", paperId)
        .single();
      if (error) throw error;
      return (data.abstract as string | null) ?? null;
    },
    staleTime: Infinity,
  });
}

/**
 * Batch-fetch abstracts for multiple papers.
 * Returns a Map<paperId, abstract>.
 * Checks individual cache entries first; only fetches missing ones from the DB.
 */
export async function fetchAbstractsBatch(
  paperIds: string[],
  queryClient: QueryClient,
): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>();
  const uncached: string[] = [];

  // Check cache first
  for (const id of paperIds) {
    const cached = queryClient.getQueryData<string | null>(queryKeys.papers.abstract(id));
    if (cached !== undefined) {
      result.set(id, cached);
    } else {
      uncached.push(id);
    }
  }

  // Batch-fetch uncached abstracts in one query
  if (uncached.length > 0) {
    const { data, error } = await supabase
      .from("papers")
      .select("id, abstract")
      .in("id", uncached);

    if (error) throw error;

    for (const row of data || []) {
      const abstract = (row.abstract as string | null) ?? null;
      result.set(row.id, abstract);
      // Warm the individual cache entries
      queryClient.setQueryData(queryKeys.papers.abstract(row.id), abstract);
    }
  }

  return result;
}
