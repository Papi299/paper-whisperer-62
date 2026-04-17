import { supabase } from "@/integrations/supabase/client";
import type { ServerFilterParams, ServerSortParams } from "@/hooks/papers/types";

/**
 * Apply shared filter predicates to a PostgREST query builder.
 * Used by both the display query and the count query.
 */
function applyFilterPredicates<T extends ReturnType<typeof supabase.from>>(
  query: T,
  filterParams: ServerFilterParams,
): T {
  const { filterPaperIds, yearFrom, yearTo, studyTypes, notesPresence } = filterParams;

  // ID-based filtering (pre-resolved from junction queries + search)
  if (filterPaperIds !== null && filterPaperIds !== undefined) {
    query = query.in("id", filterPaperIds) as T;
  }

  // Year range
  if (yearFrom !== null) query = query.gte("year", yearFrom) as T;
  if (yearTo !== null) query = query.lte("year", yearTo) as T;

  // Study type
  if (studyTypes !== null && studyTypes.length > 0) {
    query = query.in("study_type", studyTypes) as T;
  }

  // Notes presence (tri-state). Semantics mirror `paper.notes?.trim()`
  // used by the list indicator — NULL and whitespace-only both count as "no notes".
  // Uses Postgres POSIX regex via PostgREST `match` operator.
  if (notesPresence === "has") {
    query = query.not("notes", "is", null).filter("notes", "match", "[^[:space:]]") as T;
  } else if (notesPresence === "none") {
    query = query.or("notes.is.null,notes.match.^[[:space:]]*$") as T;
  }

  return query;
}

/**
 * Build a PostgREST query for papers with server-side filter predicates + sort.
 * Shared between the display query (usePapers) and export query (useExportPapers).
 *
 * Caller is responsible for:
 * - Adding .range(from, to) for pagination (display only)
 * - Specifying the select columns via the `select` parameter
 * - Handling the short-circuit case when filterPaperIds === []
 */
export function buildPapersQuery(
  userId: string,
  filterParams: ServerFilterParams,
  sortParams: ServerSortParams,
  select: string,
) {
  const { sortColumn, sortAscending } = sortParams;

  let query = supabase.from("papers").select(select).eq("user_id", userId);
  query = applyFilterPredicates(query, filterParams);

  // Sort: server-side is the single source of truth
  if (sortColumn !== null && sortAscending !== null) {
    query = query.order(sortColumn, { ascending: sortAscending });
  } else {
    query = query.order("insert_order", { ascending: false });
  }

  return query;
}

/**
 * Build a lightweight HEAD query that returns only the count of matching papers.
 * Uses the same filter predicates as buildPapersQuery but no select columns or sort.
 */
export function buildPapersCountQuery(
  userId: string,
  filterParams: ServerFilterParams,
) {
  let query = supabase
    .from("papers")
    .select("*", { count: "exact", head: true })
    .eq("user_id", userId);

  query = applyFilterPredicates(query, filterParams);

  return query;
}
