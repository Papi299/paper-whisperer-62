import { supabase } from "@/integrations/supabase/client";
import type { ServerFilterParams } from "@/hooks/papers/types";

/**
 * Build a PostgREST query for papers with server-side filter predicates.
 * Shared between the display query (usePapers) and export query (useExportPapers).
 *
 * Caller is responsible for:
 * - Adding .range(from, to) for pagination (display only)
 * - Specifying the select columns via the `select` parameter
 * - Handling the short-circuit case when filterPaperIds === []
 */
export function buildPapersQuery(
  userId: string,
  serverFilterParams: ServerFilterParams,
  select: string,
) {
  const { filterPaperIds, yearFrom, yearTo, studyTypes, sortColumn, sortAscending } =
    serverFilterParams;

  let query = supabase.from("papers").select(select).eq("user_id", userId);

  // ID-based filtering (pre-resolved from junction queries + search)
  if (filterPaperIds !== null && filterPaperIds !== undefined) {
    query = query.in("id", filterPaperIds);
  }

  // Year range
  if (yearFrom !== null) query = query.gte("year", yearFrom);
  if (yearTo !== null) query = query.lte("year", yearTo);

  // Study type
  if (studyTypes !== null && studyTypes.length > 0) {
    query = query.in("study_type", studyTypes);
  }

  // Sort: server-side is the single source of truth
  if (sortColumn !== null && sortAscending !== null) {
    query = query.order(sortColumn, { ascending: sortAscending });
  } else {
    query = query.order("insert_order", { ascending: false });
  }

  return query;
}
