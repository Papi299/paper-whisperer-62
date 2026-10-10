/**
 * The comparison read model's contract (EVIDENCE-MATRIX-001A).
 *
 * Everything here describes what the user's library *stores* for a paper and
 * where that value came from. Nothing here is, or may be presented as, an
 * independently verified finding about the paper: there is deliberately no
 * agreement, correctness, PICO, effect-size or risk-of-bias field.
 */

/**
 * Where a displayed value came from, as far as the library records it.
 *
 * Each category maps to one caveat the UI must show with the value:
 *
 * - `library_metadata` — title, authors, year, journal, PMID, DOI: imported or
 *   edited by the user; which one is not recorded.
 * - `import_recorded_publication_types` — `raw_publication_types`, the discrete
 *   types a PubMed metadata fetch or a native NBIB file stated at import. Not
 *   re-checked against PubMed since; NULL for every other import path and for
 *   rows imported before the column existed.
 * - `imported_source_unrecorded` — `raw_study_type`, MeSH terms, substances and
 *   imported keywords: text saved at import whose source (PubMed, Crossref, a
 *   reference-manager file, a spreadsheet column, older PaperLume data) is not
 *   recorded.
 * - `classification_lineage_unrecorded` — `study_type`: PaperLume's recorded
 *   classification. It may come from the Study Types pool, the publication-type
 *   fallback, AI analysis, a manual edit, pool re-evaluation or a duplicate
 *   merge; which one is not recorded, and it is not independently verified.
 * - `stored_abstract` — the abstract text as stored: imported or edited, and
 *   possibly stripped of source formatting. Not the full paper.
 * - `ai_or_user_annotation` — TL;DR and statistical methods: written by AI
 *   analysis or by the user; PaperLume does not record which.
 * - `user_entered` — the user's own notes, Projects and Tags.
 * - `derived_keywords` — `keywords`: imported terms merged with Keyword-pool
 *   matches and edits; the mix is not recorded.
 * - `display_derivation` — computed now from stored values (links built from a
 *   validated PMID/DOI, attachment counts). Adds no information of its own.
 */
export type ProvenanceCategory =
  | "library_metadata"
  | "import_recorded_publication_types"
  | "imported_source_unrecorded"
  | "classification_lineage_unrecorded"
  | "stored_abstract"
  | "ai_or_user_annotation"
  | "user_entered"
  | "derived_keywords"
  | "display_derivation";

/**
 * One stored value, or the documented reason there is none to show.
 *
 * - `present` — the value exactly as stored (strings are not trimmed, decoded
 *   or reformatted).
 * - `not_recorded` — NULL, blank or an empty list: the library stores nothing.
 *   That is never evidence that the paper did not report it.
 * - `unreadable` — a stored value of an unexpected shape. Shown as such, never
 *   coerced or partially repaired.
 * - `stored_placeholder` — the literal "Not specified" saved as the value (see
 *   `NOT_SPECIFIED_PLACEHOLDER`). `value` is the stored text, verbatim.
 */
export type FieldValue<T> =
  | { readonly kind: "present"; readonly value: T }
  | { readonly kind: "not_recorded" }
  | { readonly kind: "unreadable" }
  | { readonly kind: "stored_placeholder"; readonly value: string };

/** A stored value paired with its provenance; `P` pins the category per field. */
export interface ComparisonField<T, P extends ProvenanceCategory = ProvenanceCategory> {
  readonly provenance: P;
  readonly value: FieldValue<T>;
}

/** A value computed now from stored values, labelled as such. */
export interface ComparisonDerived<T> {
  readonly provenance: "display_derivation";
  readonly value: T;
}

/** Outbound links built only from a validated PMID / usable DOI name. */
export interface ComparisonLinks {
  readonly pubmed: string | null;
  readonly doi: string | null;
}

/**
 * Counts from the attachment metadata recorded at upload. `file_type` is the
 * type the browser reported then; the files themselves are never read.
 */
export interface AttachmentSummary {
  readonly total: number;
  readonly pdf: number;
  readonly image: number;
  readonly other: number;
}

export interface TaxonomyItem {
  readonly id: string;
  readonly name: string;
  readonly color: string | null;
}

/** The user's Projects or Tags on one paper. */
export interface ComparisonTaxonomy {
  readonly provenance: "user_entered";
  /** Sorted by name, then id, so the order never depends on the response. */
  readonly items: readonly TaxonomyItem[];
  /** Assignments whose Project/Tag could not be read: counted, never guessed. */
  readonly unavailableCount: number;
}

/**
 * One paper's stored values. `paperId` is the only key that associates a value
 * with a paper — never title, authors, DOI or position.
 */
export interface ComparisonRow {
  readonly paperId: string;
  readonly title: ComparisonField<string, "library_metadata">;
  readonly authors: ComparisonField<readonly string[], "library_metadata">;
  readonly year: ComparisonField<number, "library_metadata">;
  readonly journal: ComparisonField<string, "library_metadata">;
  readonly pmid: ComparisonField<string, "library_metadata">;
  readonly doi: ComparisonField<string, "library_metadata">;
  readonly links: ComparisonDerived<ComparisonLinks>;
  readonly publicationTypes: ComparisonField<readonly string[], "import_recorded_publication_types">;
  readonly importedTypeText: ComparisonField<string, "imported_source_unrecorded">;
  readonly studyTypeClassification: ComparisonField<string, "classification_lineage_unrecorded">;
  readonly abstract: ComparisonField<string, "stored_abstract">;
  readonly tldr: ComparisonField<string, "ai_or_user_annotation">;
  readonly statisticalMethods: ComparisonField<string, "ai_or_user_annotation">;
  readonly notes: ComparisonField<string, "user_entered">;
  readonly projects: ComparisonTaxonomy;
  readonly tags: ComparisonTaxonomy;
  readonly keywords: ComparisonField<readonly string[], "derived_keywords">;
  readonly importedKeywords: ComparisonField<readonly string[], "imported_source_unrecorded">;
  readonly meshTerms: ComparisonField<readonly string[], "imported_source_unrecorded">;
  readonly substances: ComparisonField<readonly string[], "imported_source_unrecorded">;
  readonly attachments: ComparisonDerived<AttachmentSummary>;
}

/**
 * A frozen, owner-bound comparison request: the selection as it was when the
 * user asked to compare. Later selection changes never reach it.
 */
export interface ComparisonRequest {
  /** Canonical (lowercase) id of the user the request was built for. */
  readonly ownerUserId: string;
  /** Unique per built request, so every open is a fresh comparison session. */
  readonly sessionId: number;
  /** Every distinct selected id, normalized (trimmed, lowercased) and sorted. */
  readonly selectedIds: readonly string[];
  /** The well-formed UUIDs among `selectedIds` — the only ids ever queried. */
  readonly queryIds: readonly string[];
}

export type ComparisonRequestRefusal = "no_user" | "too_few" | "too_many";

export type ComparisonRequestOutcome =
  | { readonly ok: true; readonly request: ComparisonRequest }
  | {
      readonly ok: false;
      readonly reason: ComparisonRequestRefusal;
      /** Distinct selected ids counted (0 when the reason is `no_user`). */
      readonly selectedCount: number;
    };

/**
 * The outcome of a successful read.
 *
 * `unavailablePaperIds` lists the selected ids that produced no row — deleted,
 * nonexistent, not the user's, or malformed — without saying which. It exists
 * for selection bookkeeping and must not be rendered: user-facing copy uses
 * `unavailableCount` only.
 */
export type ComparisonResult =
  | {
      readonly kind: "comparable";
      /** At least `MIN_COMPARISON_PAPERS` rows, in the default sort order. */
      readonly rows: readonly ComparisonRow[];
      readonly selectedCount: number;
      readonly unavailableCount: number;
      readonly unavailablePaperIds: readonly string[];
    }
  | {
      readonly kind: "insufficient";
      readonly selectedCount: number;
      readonly availableCount: number;
      readonly unavailableCount: number;
      readonly unavailablePaperIds: readonly string[];
    };
