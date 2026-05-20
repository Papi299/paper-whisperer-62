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
 *
 * **Ownership scoping.** The `.eq("user_id", userId)` predicate is
 * defense-in-depth on top of the `papers` table's RLS — RLS already
 * restricts reads to rows owned by the calling user, so for legitimate
 * callers the row set returned is identical with or without this
 * predicate. Adding it makes ownership intent visible at the call site
 * and prevents an accidental cross-user read if RLS were ever loosened.
 * Matches the S2 client-side hardening pattern established by PRs #133
 * and #134.
 *
 * **Note on the query key.** `queryKeys.papers.abstract(paperId)` is
 * intentionally NOT user-scoped in this hardening wave. The defense-in-
 * depth value is in the query predicate; cache-key correctness for a
 * hypothetical multi-tenant future is a separate, smaller fix tracked
 * outside this PR. In the current single-user MVP, sign-out garbage-
 * collects the cache via TanStack Query's `gcTime`, so there is no
 * practical leakage risk.
 */
export function useAbstract(paperId: string | null, userId: string | null | undefined) {
  return useQuery({
    queryKey: queryKeys.papers.abstract(paperId!),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("papers")
        .select("abstract")
        .eq("id", paperId!)
        .eq("user_id", userId!)
        .single();
      if (error) throw error;
      return (data.abstract as string | null) ?? null;
    },
    enabled: !!paperId && !!userId,
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
 *
 * Ownership-scoping rationale: see `useAbstract` JSDoc above.
 */
export async function fetchAbstract(
  paperId: string,
  userId: string,
  queryClient: QueryClient,
): Promise<string | null> {
  return queryClient.fetchQuery({
    queryKey: queryKeys.papers.abstract(paperId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("papers")
        .select("abstract")
        .eq("id", paperId)
        .eq("user_id", userId)
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
 *
 * Ownership-scoping rationale: see `useAbstract` JSDoc above. The
 * `.eq("user_id", userId)` predicate is combined with `.in("id", uncached)`
 * so the server returns only rows owned by the calling user — same set RLS
 * would have returned anyway, but the intent is explicit at the call site.
 */
export async function fetchAbstractsBatch(
  paperIds: string[],
  userId: string,
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
      .in("id", uncached)
      .eq("user_id", userId);

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
