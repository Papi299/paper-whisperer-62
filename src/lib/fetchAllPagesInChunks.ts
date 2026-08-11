import { fetchAllPages, type RangeableQuery } from "./fetchAllPages";

/**
 * Fetch **every** row matching an `.in(column, ids)` predicate, for an ID list
 * of any size.
 *
 * This composes the repository's two existing completeness helpers rather than
 * choosing between them, because each solves only half of the problem:
 *
 *  - `fetchInChunks` batches a large `.in()` list so the PostgREST URL stays
 *    within length limits — but issues **one** request per batch, so a batch
 *    matching more than 1000 rows is silently truncated by PostgREST's default
 *    limit. For a junction table that is entirely reachable: 500 papers with
 *    three projects each is 1500 rows from a single batch.
 *  - `fetchAllPages` paginates past the 1000-row limit — but takes a single
 *    query factory, so it cannot batch the ID list.
 *
 * Here every chunk is itself fully paginated, so neither limit can drop a row.
 *
 * @param ids          IDs to match (chunked into `.in()` batches)
 * @param buildQuery   Factory returning a **fresh** builder for one chunk;
 *                     called once per page because `.range()` mutates the
 *                     builder's internal state
 * @param chunkSize    IDs per batch (default 500 — ~18KB of UUIDs in the URL)
 * @param pageSize     Rows per page (default 1000 — PostgREST's default limit)
 */
export async function fetchAllPagesInChunks<T>(
  ids: string[],
  buildQuery: (chunk: string[]) => RangeableQuery,
  { chunkSize = 500, pageSize = 1000 }: { chunkSize?: number; pageSize?: number } = {},
): Promise<T[]> {
  if (ids.length === 0) return [];

  const allRows: T[] = [];
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const rows = await fetchAllPages<T>(() => buildQuery(chunk), pageSize);
    allRows.push(...rows);
  }
  return allRows;
}
