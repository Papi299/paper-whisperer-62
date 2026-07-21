/** A PostgREST builder that can be paginated with `.range()`. The resolved
 *  `data` is `unknown` because callers build the query with a dynamic select
 *  string, which erases PostgREST's row inference; the caller supplies the
 *  runtime row shape via the `T` type parameter. `error` is `Error | null`,
 *  which the PostgREST `PostgrestError` (a subclass of `Error`) satisfies. */
type RangeableQuery = {
  range: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: unknown; error: Error | null }>;
};

/**
 * Fetch all rows matching a PostgREST query by paginating internally.
 * Works around the default 1000-row PostgREST limit.
 *
 * Accepts a query-factory function because PostgREST builders are mutable —
 * calling .range() modifies internal state, so a fresh builder is needed per page.
 *
 * @param buildQuery Factory that returns a fresh PostgREST query builder (without .range())
 * @param pageSize Number of rows per page (default 1000 — matches PostgREST default limit)
 */
export async function fetchAllPages<T>(
  buildQuery: () => RangeableQuery,
  pageSize = 1000,
): Promise<T[]> {
  const allRows: T[] = [];
  let page = 0;
  while (true) {
    const from = page * pageSize;
    const to = from + pageSize - 1;
    const { data, error } = await buildQuery().range(from, to);
    if (error) throw error;
    // `data` is `unknown` (dynamic select erases inference); the caller asserts
    // the concrete row shape via `T` at this typed query boundary.
    const rows = (data as T[] | null) ?? [];
    allRows.push(...rows);
    if (rows.length < pageSize) break; // last page
    page++;
  }
  return allRows;
}
