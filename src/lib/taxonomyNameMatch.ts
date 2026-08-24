/**
 * Reconcile a proposed *new* Project/Tag name against the taxonomy as it
 * stands **right now** — AI-PROJECT-TAG-SUGGESTIONS-001B.
 *
 * The Edge Function checked the taxonomy when it generated the suggestion, but
 * the user's library can change between then and the moment they press
 * "Create & select": another tab, another device, or simply the user creating
 * the thing themselves after reading the reason. A proposal that was new at
 * generation time is therefore never trusted to still be new at action time.
 *
 * ## The comparison, and why it is broader than the database key
 *
 * `normalizeTaxonomyName` trims and lower-cases, mirroring `normalizeName` in
 * the Edge `contract.ts` so client and server ask the same question. The
 * database's per-user unique indexes are `(user_id, lower(name))` — lower-case
 * only, **no trim** — so this key is deliberately broader:
 *
 *   "Diabetes"    → DB key "diabetes"    → this key "diabetes"
 *   " Diabetes "  → DB key " diabetes "  → this key "diabetes"
 *
 * Those are two rows one user may legitimately hold, and they collapse to a
 * single key here. That breadth is the point — it catches the near-duplicates
 * the database would accept — but it means **one key can match several rows**,
 * which is exactly why {@link matchTaxonomyName} has an `ambiguous` outcome
 * instead of returning a single best match.
 *
 * ## Why there is no tie-break
 *
 * When several rows share a normalized name, no rule here picks one. Not the
 * first, not the last, not the shortest, not the lowest UUID, and nothing
 * fuzzy: every one of those silently attaches a paper to a row the user did
 * not choose, and the user is the only party who knows which "Diabetes" they
 * meant. The caller surfaces the ambiguity and creates nothing.
 */

/** The minimum shape this module needs: an identity and a name. */
export interface NamedTaxonomyEntity {
  id: string;
  name: string;
}

/**
 * Normalize a name for application-level collision comparison: trim, then
 * lower-case. Mirrors `normalizeName` in the Edge contract so the client and
 * the server never disagree about what "the same name" means.
 */
export function normalizeTaxonomyName(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * The outcome of comparing a proposed name against the current taxonomy.
 *
 * - `none` — nothing matches; the caller may create through the normal path.
 * - `unique` — exactly one row matches; select it instead of creating a
 *   duplicate.
 * - `ambiguous` — several rows match; the caller must create nothing and
 *   select nothing, and ask the user to pick.
 */
export type TaxonomyNameMatch<T extends NamedTaxonomyEntity> =
  | { kind: "none" }
  | { kind: "unique"; entity: T }
  | { kind: "ambiguous"; matches: T[] };

/**
 * Compare `name` against `entities` under {@link normalizeTaxonomyName}.
 *
 * A blank proposal matches nothing (`none`) rather than matching every blank
 * row: a name that normalizes to the empty string is not a name, and the
 * creation path rejects it separately.
 */
export function matchTaxonomyName<T extends NamedTaxonomyEntity>(
  name: string,
  entities: readonly T[],
): TaxonomyNameMatch<T> {
  const key = normalizeTaxonomyName(name);
  if (key === "") return { kind: "none" };

  const matches = entities.filter((entity) => normalizeTaxonomyName(entity.name) === key);

  if (matches.length === 0) return { kind: "none" };
  if (matches.length === 1) return { kind: "unique", entity: matches[0] };
  return { kind: "ambiguous", matches };
}
