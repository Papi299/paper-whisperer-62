import { supabase } from "@/integrations/supabase/client";

/**
 * Fetch rows from a table where a column matches any ID in a large array,
 * batching the .in() predicate to avoid oversized URL/query limits.
 *
 * PostgREST encodes .in() values into the URL query string. UUIDs are 36 chars
 * each — at 500 IDs the parameter is ~18KB, well within URL length limits.
 *
 * @param table Supabase table name
 * @param select PostgREST select string
 * @param filterColumn Column to filter with .in()
 * @param ids Array of IDs to match
 * @param chunkSize Number of IDs per batch (default 500)
 */
export async function fetchInChunks<T>(
  table: string,
  select: string,
  filterColumn: string,
  ids: string[],
  chunkSize = 500,
): Promise<T[]> {
  if (ids.length === 0) return [];
  const allRows: T[] = [];
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const { data, error } = await supabase
      .from(table)
      .select(select)
      .in(filterColumn, chunk);
    if (error) throw error;
    allRows.push(...((data as T[]) || []));
  }
  return allRows;
}
