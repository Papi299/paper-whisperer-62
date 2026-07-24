/**
 * Pure, side-effect-free set helpers for ID-based filtering.
 *
 * These back the dashboard Project/Tag multi-select filters (see
 * `useFilterState`). They are extracted here — rather than left inline in the
 * hook — so the union / dedupe / intersection / canonicalization semantics can
 * be unit-tested deterministically without React or React Query, and so the
 * hook's `useMemo` bodies stay small.
 *
 * A "set of IDs" is modelled as a `string[]` throughout (React state and React
 * Query keys are plain arrays). None of these helpers mutate their inputs.
 */

/**
 * Deduplicate a list of IDs, preserving first-seen order. Used to collapse the
 * junction-query result when a single paper belongs to several selected
 * Projects (or Tags) and therefore appears once per membership row.
 */
export function dedupeIds(ids: readonly string[]): string[] {
  return Array.from(new Set(ids));
}

/**
 * Canonicalize an ID selection into an order-insensitive, duplicate-free key.
 * Returns a NEW sorted array — never mutates the input — so it is safe to call
 * on React state arrays. Because the result depends only on the *set* of IDs,
 * `["A","B"]` and `["B","A"]` canonicalize identically, which keeps React Query
 * from creating redundant cache entries when the user toggles selections in a
 * different order.
 */
export function canonicalizeIds(ids: readonly string[]): string[] {
  return Array.from(new Set(ids)).sort();
}

/**
 * Intersect any number of ID sets (AND across categories). Returns the IDs
 * present in every provided set, deduplicated. An empty `sets` array returns
 * `[]` (the caller is responsible for treating "no active categories" as
 * "no filtering" before calling this). Each input set is treated as a set, so
 * duplicate members within one input do not distort the result.
 */
export function intersectIdSets(sets: readonly (readonly string[])[]): string[] {
  if (sets.length === 0) return [];
  let result = new Set(sets[0]);
  for (let i = 1; i < sets.length; i++) {
    const next = new Set(sets[i]);
    result = new Set([...result].filter((id) => next.has(id)));
  }
  return Array.from(result);
}

/**
 * One filter category's contribution to the intersected paper-ID set.
 *  • `active: false` — this category is not filtering; it is ignored entirely.
 *  • `active: true, ids: undefined` — an active required set that is still
 *    loading (its resolved IDs are not yet known).
 *  • `active: true, ids: string[]` — a resolved set (possibly empty).
 */
export interface IdCategoryInput {
  active: boolean;
  ids: string[] | undefined;
}

/**
 * The dashboard's four-state filter-ID model, extracted as a pure function so
 * the loading / no-filter / no-match / resolved transitions are testable
 * without React Query. Each *active* category already carries its own
 * OR-union of IDs; this resolver ANDs the active categories together:
 *
 *  • no active category            → `null`      (no ID-based filtering)
 *  • any active category loading   → `undefined` (block the papers query)
 *  • all active categories resolved → intersection (may be `[]` for no match)
 */
export function resolveFilterPaperIds(
  categories: readonly IdCategoryInput[],
): string[] | null | undefined {
  const active = categories.filter((c) => c.active);
  if (active.length === 0) return null;
  if (active.some((c) => c.ids === undefined)) return undefined;
  return intersectIdSets(active.map((c) => c.ids as string[]));
}
