/**
 * Structured authorship provenance — what a bibliographic source actually told
 * Paperlume about each authorship mention.
 *
 * The load-bearing distinction this module exists to hold, and must never blur:
 *
 *   Provenance records what a source *stated*. It does not turn
 *   similar-looking names into a shared human identity.
 *
 * So one paper may carry `S M Phillips`, another `Stuart M Phillips`, and a
 * third `Stuart Phillips`, and this module may hold richer structured data for
 * any of them — given/family components, affiliations, even a checksum-valid
 * ORCID — without any of that linking the three. A matching ORCID is still
 * provenance: it is a value two sources supplied, not a proof this application
 * has resolved a person. Deciding that two mentions are one researcher needs an
 * identity model that deliberately does not exist yet.
 *
 * Relationship to the two neighbouring concepts:
 *
 *   • `papers.authors` (string[]) is unchanged. It remains THE display, search
 *     and Analytics representation, and every read path keeps working from it
 *     alone. Provenance is additive and never required.
 *   • `authorMentionKey` (`src/lib/authorNames.ts`) answers a different
 *     question — are two author *strings* the same mention written differently
 *     — and keeps doing so from `papers.authors`. It is not a person ID either,
 *     and nothing here changes how it groups.
 *
 * Storage shape: `papers.author_provenance` is a nullable JSONB array whose
 * order corresponds one-to-one with `papers.authors`. `author_provenance[i]`
 * describes the source mention stored at `authors[i]`. SQL NULL is the single
 * representation of "no trustworthy structured provenance was persisted for
 * this paper" — which is the truthful state for every row predating the column,
 * and for every source that cannot produce a complete aligned representation.
 */

import { deriveCanonicalOrcid } from "./orcid";

/**
 * How confidently the source established what kind of author this mention is.
 *
 * `personal` and `collective` are only ever used when the source *format*
 * establishes it — a MEDLINE `FAU` field, a PubMed `<CollectiveName>` element,
 * a Crossref `family`/`given` pair. They are never inferred from the shape or
 * the wording of a name: a free-form string containing "Consortium" is not
 * thereby collective, and one that looks like a person's name is not thereby
 * personal. Everything else is honestly `unknown`.
 */
export type AuthorProvenanceKind = "personal" | "collective" | "unknown";

/**
 * One source-supplied identifier for an authorship mention, uninterpreted.
 *
 * Declared as a type alias rather than an `interface` deliberately, as is
 * `AuthorProvenance` below. Both are closed JSON payloads written straight into
 * a `jsonb` column, and TypeScript gives an object type alias the implicit
 * index signature the generated `Json` type requires — an interface, being open
 * to declaration merging, does not, and would force a cast at every write site.
 * A cast there would silence exactly the check that proves these shapes are
 * serializable, so the alias is the safer construct as well as the tidier one.
 */
export type AuthorIdentifierProvenance = {
  /** The authority the source named — `ORCID`, `ISNI`, … Never invented. */
  scheme: string;
  /** The identifier exactly as the source supplied it, whitespace trimmed. */
  value: string;
};

/** Structured provenance for exactly one authorship mention. */
export type AuthorProvenance = {
  /** Stable machine-readable source/format identifier. Never a paper or user id. */
  source: string;
  /** Which source-level field produced this mention, when that distinction is useful. */
  source_field: string | null;
  kind: AuthorProvenanceKind;
  /**
   * The name representation that source/parser produced for the corresponding
   * `authors` entry, before Paperlume's general paper normalization. Source
   * spelling, punctuation, diacritics and ordering are preserved exactly — this
   * is provenance, not a canonical person name.
   */
  source_name: string;

  /** Populated only when the source explicitly exposes these concepts. */
  given_name: string | null;
  family_name: string | null;
  initials: string | null;
  suffix: string | null;
  /** Populated only for an explicitly collective source author. */
  collective_name: string | null;

  /** Per-author affiliation text the source explicitly associated with this mention. */
  affiliations: string[];
  /** Author-associated identifiers exactly as supplied. */
  identifiers: AuthorIdentifierProvenance[];

  /** Checksum-valid canonical ORCID derived from ORCID-labelled `identifiers`, else null. */
  orcid: string | null;
  /**
   * The provider's own authentication/assertion flag for the ORCID, when — and
   * only when — the provider directly supplies such a boolean. Never
   * synthesized, never inferred from the presence of an ORCID, and never treated
   * as evidence that two mentions are the same person.
   */
  orcid_authenticated: boolean | null;
};

/**
 * Stable `source` values for the ingestion paths that exist today.
 *
 * Kept as plain strings rather than a database enum so that adding a future
 * import format is a code change, not a schema migration — the column's CHECK
 * requires a non-blank string and deliberately does not enumerate them.
 */
export const AUTHOR_PROVENANCE_SOURCES = {
  pubmedApi: "pubmed_api",
  crossrefApi: "crossref_api",
  nbib: "nbib",
  bibtex: "bibtex",
  ris: "ris",
  endnote: "endnote",
  csv: "csv",
  manual: "manual",
} as const;

/**
 * Affiliation strings, cleaned for storage: trimmed, blanks dropped, source
 * order preserved, exact duplicates collapsed.
 *
 * Nothing is parsed. An affiliation stays the text the source wrote — no
 * institution is resolved to a canonical organization, and no email address in
 * it is treated as identity evidence.
 */
export function cleanAffiliations(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

/**
 * Identifier provenance, cleaned for storage.
 *
 * An entry survives only when the source supplied BOTH a non-blank authority
 * and a non-blank value: half an identifier cannot be represented honestly, and
 * inventing the missing half is exactly the fabrication this column exists to
 * avoid. Values are never deduplicated across papers and never made globally
 * unique — two papers stating the same ORCID remain two independent statements.
 */
export function cleanIdentifiers(
  values: readonly { scheme: string; value: string }[],
): AuthorIdentifierProvenance[] {
  const result: AuthorIdentifierProvenance[] = [];
  for (const { scheme, value } of values) {
    const cleanScheme = scheme.trim();
    const cleanValue = value.trim();
    if (!cleanScheme || !cleanValue) continue;
    result.push({ scheme: cleanScheme, value: cleanValue });
  }
  return result;
}

/**
 * Build one provenance entry, filling every field the caller did not establish
 * with its "the source did not state this" value.
 *
 * Callers pass only what their source genuinely supports, so a field is absent
 * from a call site precisely when that format cannot establish it — which is
 * easier to review than a literal repeating eleven nulls at every site.
 * `orcid` is derived here from the cleaned identifiers rather than accepted
 * from the caller, so no parser can hand-place an ORCID that its own identifier
 * provenance does not support.
 */
export function makeAuthorProvenance(fields: {
  source: string;
  source_field?: string | null;
  kind: AuthorProvenanceKind;
  source_name: string;
  given_name?: string | null;
  family_name?: string | null;
  initials?: string | null;
  suffix?: string | null;
  collective_name?: string | null;
  affiliations?: readonly string[];
  identifiers?: readonly { scheme: string; value: string }[];
  orcid_authenticated?: boolean | null;
}): AuthorProvenance {
  const identifiers = cleanIdentifiers(fields.identifiers ?? []);
  const orcid = deriveCanonicalOrcid(identifiers);
  return {
    source: fields.source,
    source_field: fields.source_field ?? null,
    kind: fields.kind,
    source_name: fields.source_name,
    given_name: fields.given_name ?? null,
    family_name: fields.family_name ?? null,
    initials: fields.initials ?? null,
    suffix: fields.suffix ?? null,
    collective_name: fields.collective_name ?? null,
    affiliations: cleanAffiliations(fields.affiliations ?? []),
    identifiers,
    // An assertion flag is only meaningful about an ORCID we actually derived.
    // Reporting one next to `orcid: null` would describe an authentication of
    // nothing, so it is dropped with the value it qualified.
    orcid: orcid,
    orcid_authenticated: orcid === null ? null : fields.orcid_authenticated ?? null,
  };
}

/**
 * Aligned provenance for a source that states author names as opaque strings —
 * BibTeX, RIS, EndNote, CSV, and manual entry.
 *
 * Every entry is `kind: "unknown"` with the parser-produced name preserved and
 * no structure guessed: `Smith, John` is one mention whose source_name contains
 * a comma, not evidence of a family/given split. That inference needs the
 * authoritative grammar of the specific source, which none of these formats
 * supplies in the paths Paperlume parses today.
 *
 * Returns `null` for an empty author list, because an empty array carries no
 * more information than absence and NULL is the single representation of that.
 */
export function buildUnstructuredAuthorProvenance(
  authors: readonly string[],
  source: string,
  sourceField: string | null,
): AuthorProvenance[] | null {
  if (authors.length === 0) return null;
  return authors.map((sourceName) =>
    makeAuthorProvenance({
      source,
      source_field: sourceField,
      kind: "unknown",
      source_name: sourceName,
    }),
  );
}

/**
 * Canonicalize a candidate provenance value at the database write boundary.
 *
 * Returns `null` — the single representation of "no trustworthy provenance" —
 * for anything that cannot be stored as a complete aligned array: missing, not
 * an array, empty, or a different length from the `authors` it must describe.
 *
 * The length rule is the important one. A partial provenance subset is worse
 * than none: once the indexes no longer map onto `authors`, every entry
 * describes the wrong mention, and an ORCID attached to the wrong name is a
 * false claim about a person. So a misaligned array degrades to NULL rather
 * than being stored and trusted.
 */
export function normalizeAuthorProvenanceForStorage(
  provenance: unknown,
  authors: readonly string[],
): AuthorProvenance[] | null {
  if (!Array.isArray(provenance)) return null;
  if (provenance.length === 0) return null;
  if (provenance.length !== authors.length) return null;
  return provenance as AuthorProvenance[];
}

/**
 * Whether two author arrays are the same mentions in the same order.
 *
 * Used by the edit path to decide whether stored structured provenance still
 * describes the submitted author strings. Deliberately exact — not the 001A
 * mention key — because provenance is bound to the literal string a source
 * supplied: a punctuation-only edit still means the user retyped that name, and
 * the previous source's given/family/ORCID can no longer be claimed for it.
 */
export function authorsArraysEqual(
  a: readonly string[],
  b: readonly string[],
): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
