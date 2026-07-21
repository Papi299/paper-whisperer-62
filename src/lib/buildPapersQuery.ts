import { supabase } from "@/integrations/supabase/client";
import type { ServerFilterParams, ServerSortParams } from "@/hooks/papers/types";

/**
 * The subset of PostgREST filter-builder methods used by the papers query.
 * Each returns the same builder type (`this`), so `T` threads through unchanged.
 * Constraining to this structural shape — rather than `ReturnType<typeof
 * supabase.from>` (the pre-`.select()` builder, which lacks filter methods) —
 * lets the predicates type-check without per-call `as T` casts, and works for
 * both the display query and the head/count query.
 */
type PapersFilterOps<T> = {
  in(column: string, values: readonly (string | number)[]): T;
  gte(column: string, value: number): T;
  lte(column: string, value: number): T;
  not(column: string, operator: string, value: unknown): T;
  filter(column: string, operator: string, value: unknown): T;
  or(filters: string): T;
};

/**
 * Apply shared filter predicates to a PostgREST query builder.
 * Used by both the display query and the count query.
 */
function applyFilterPredicates<T extends PapersFilterOps<T>>(
  query: T,
  filterParams: ServerFilterParams,
): T {
  const { filterPaperIds, yearFrom, yearTo, studyTypes, notesPresence } = filterParams;

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

  // Notes presence (tri-state). Semantics mirror `paper.notes?.trim()`
  // used by the list indicator — NULL and whitespace-only both count as "no notes".
  // Uses Postgres POSIX regex via PostgREST `match` operator.
  if (notesPresence === "has") {
    query = query.not("notes", "is", null).filter("notes", "match", "[^[:space:]]");
  } else if (notesPresence === "none") {
    query = query.or("notes.is.null,notes.match.^[[:space:]]*$");
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
