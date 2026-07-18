/**
 * Database-boundary mapper for `papers.statistical_methods` (decision C20).
 *
 * The canonical stored form is SQL NULL or a top-level JSON string, but until
 * the reconciliation migration is applied remotely the column can still hold
 * transitional JSON `null`s and JSON arrays. This mapper converts whatever the
 * database returns into the domain shape (`string | null`) using the exact
 * semantics of the SQL migration's normalization, so the app reads production
 * safely during the merge → deploy → `db push` interval.
 *
 * Matching the SQL (`string_agg(elem #>> '{}', ', ' ORDER BY ord)`):
 *  - array element order is preserved;
 *  - elements join with ", ";
 *  - JSON `null` elements are omitted (string_agg skips SQL NULLs);
 *  - an empty array (or all-null array) becomes "".
 *
 * Equivalence scope: output is exactly equal to the SQL normalization for
 * null/undefined, strings, empty arrays, arrays of strings, and the tested
 * scalar JSON elements (numbers, booleans). Nested composite elements
 * (objects/arrays inside the array) are serialized deterministically with
 * JSON.stringify; that is NOT claimed to be universally byte-identical to
 * PostgreSQL's JSONB text rendering (which differs in whitespace for
 * objects). Production evidence shows all transitional arrays are empty,
 * so composite elements cannot occur in the real normalization set.
 *
 * Unsupported top-level categories (object, number, boolean) throw instead of
 * being silently converted into misleading domain text.
 */
export function normalizeStatisticalMethodsForDomain(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .filter((element) => element !== null && element !== undefined)
      .map((element) => (typeof element === "string" ? element : JSON.stringify(element)))
      .join(", ");
  }
  throw new TypeError(
    `Unsupported statistical_methods value: expected null, string, or array, got ${typeof value}`,
  );
}
