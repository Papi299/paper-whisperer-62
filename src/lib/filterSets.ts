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
 * How a category (Projects or Tags) combines its own selected members:
 *  • `"any"` — a paper matches when it belongs to *at least one* selected member
 *    (OR-union). This is the behavior shipped by PROJECT-TAG-SELECTOR-UX-001 and
 *    remains the backward-compatible default.
 *  • `"all"` — a paper matches only when it belongs to *every* selected member
 *    (AND-intersection by membership).
 *
 * The two categories are still combined with AND across each other and with the
 * other filter dimensions (see `resolveFilterPaperIds`); this mode only governs
 * how members *within* one category combine.
 */
export type EntityMatchMode = "any" | "all";

/**
 * A single junction row linking a paper to one selected entity (a Project via
 * `paper_projects.project_id`, or a Tag via `paper_tags.tag_id`). The category
 * hook normalizes its table-specific column onto `entity_id` before calling
 * `resolveJunctionPaperIds`, so the resolver is shared by both categories.
 */
export interface JunctionRow {
  paper_id: string;
  entity_id: string;
}

/**
 * Deduplicate a list of IDs, preserving first-seen order. Used to collapse the
 * junction-query result when a single paper belongs to several selected
 * Projects (or Tags) and therefore appears once per membership row.
 */
export function dedupeIds(ids: readonly string[]): string[] {
  return Array.from(new Set(ids));
}

/**
 * Resolve a category's junction rows into the set of matching paper IDs, honoring
 * the Any/All match mode. Pure, deterministic, and non-mutating.
 *
 * `selectedIds` is treated as a set: it is deduplicated, and any junction row
 * whose `entity_id` is not currently selected is ignored defensively (a bounded
 * `.in(...)` query should never return such a row, but the resolver must not
 * depend on that).
 *
 *  • `"any"` — return every paper that appears in at least one selected row,
 *    deduplicated. Duplicate rows are harmless.
 *  • `"all"` — group rows by paper and track the *unique* selected entities each
 *    paper matched; include a paper only when its unique matched-entity count
 *    equals the number of unique selected IDs. Duplicate rows (e.g. the same
 *    `paper/entity` pair twice) cannot inflate the count because membership is
 *    tracked in a `Set`.
 *
 * An empty selection yields `[]` for both modes — the caller treats an inactive
 * category as "no filtering" before this is ever reached, and an empty "all"
 * must never trivially match every paper.
 */
export function resolveJunctionPaperIds(
  rows: readonly JunctionRow[],
  selectedIds: readonly string[],
  matchMode: EntityMatchMode,
): string[] {
  const selected = new Set(selectedIds);
  if (selected.size === 0) return [];

  if (matchMode === "any") {
    const matched = new Set<string>();
    for (const row of rows) {
      if (selected.has(row.entity_id)) matched.add(row.paper_id);
    }
    return Array.from(matched);
  }

  // "all": a paper must be linked to every unique selected entity.
  const matchedEntitiesByPaper = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!selected.has(row.entity_id)) continue; // ignore unselected rows defensively
    let entities = matchedEntitiesByPaper.get(row.paper_id);
    if (!entities) {
      entities = new Set<string>();
      matchedEntitiesByPaper.set(row.paper_id, entities);
    }
    entities.add(row.entity_id);
  }
  const required = selected.size;
  const result: string[] = [];
  for (const [paperId, entities] of matchedEntitiesByPaper) {
    if (entities.size === required) result.push(paperId);
  }
  return result;
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

/**
 * Build the React Query key for a junction pre-query. The active `matchMode` is
 * part of the key so an `"any"` result and an `"all"` result for the same
 * selection never share a cache entry — switching the mode resolves the correct
 * set immediately instead of showing the previous mode's stale answer. The IDs
 * are canonicalized (deduped + sorted) so toggling the same members in a
 * different order reuses one entry rather than spawning a redundant fetch.
 * Returns a new array; the input selection is never mutated.
 */
export function junctionQueryKey(
  table: "paper_projects" | "paper_tags",
  matchMode: EntityMatchMode,
  selectedIds: readonly string[],
): [string, string, EntityMatchMode, string[]] {
  return ["junction", table, matchMode, canonicalizeIds(selectedIds)];
}
