import type { AuthorProvenance } from "@/lib/authorProvenance";

export interface Profile {
  id: string;
  user_id: string;
  email: string | null;
  display_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface Project {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  color: string;
  created_at: string;
}

export interface Tag {
  id: string;
  user_id: string;
  name: string;
  color: string;
  created_at: string;
}

export interface PaperProject {
  paper_id: string;
  project_id: string;
}

export interface Paper {
  id: string;
  user_id: string;
  title: string;
  authors: string[];
  /**
   * Structured authorship provenance, aligned one-to-one with `authors`:
   * `author_provenance[i]` describes the source mention stored at `authors[i]`.
   *
   * Optional **and** nullable, and both halves matter:
   *  • *optional*, because the papers-list query selects an explicit column
   *    list that deliberately omits it (provenance is not list-render data, the
   *    same call `raw_publication_types` already makes). A read path that does
   *    not select it must not be typed as if it did.
   *  • *nullable*, because SQL NULL is the single stored representation of "no
   *    trustworthy structured provenance was persisted for this paper" — the
   *    truthful state for every row predating the column.
   *
   * No read path may require it. `authors` remains the display, search and
   * Analytics representation, and legacy rows stay fully usable without this.
   */
  author_provenance?: AuthorProvenance[] | null;
  year: number | null;
  journal: string | null;
  pmid: string | null;
  doi: string | null;
  /** Full abstract text. Excluded from the base list query for payload optimization;
   *  fetched on demand when expanding a row, editing, or analyzing. */
  abstract?: string | null;
  /** Lightweight boolean derived from `abstract IS NOT NULL` (stored generated column).
   *  Included in the base list query so the UI knows whether expand/analyze are available. */
  has_abstract?: boolean;
  study_type: string | null;
  raw_study_type: string | null;
  statistical_methods: string | null;
  keywords: string[];
  raw_keywords: string[] | null;
  mesh_terms: string[];
  substances: string[];
  pubmed_url: string | null;
  journal_url: string | null;
  drive_url: string | null;
  tldr: string | null;
  notes: string | null;
  insert_order: number;
  created_at: string;
  updated_at: string;
}

export interface PaperTag {
  paper_id: string;
  tag_id: string;
}

export interface PaperAttachment {
  id: string;
  file_name: string;
  file_path: string;
  file_type: string;
}

export interface PaperWithTags extends Paper {
  tags: Tag[];
  projects: Project[];
  paper_attachments?: PaperAttachment[];
}

/**
 * Metadata returned by the fetch-paper-metadata edge function.
 * Each entry corresponds to one identifier lookup attempt.
 */
/** Lightweight paper info returned by the get_duplicate_papers() RPC. */
export interface DuplicatePaperInfo {
  id: string;
  title: string;
  authors: string[];
  year: number | null;
  journal: string | null;
  pmid: string | null;
  doi: string | null;
  abstract: string | null;
  study_type: string | null;
  keywords: string[];
  created_at: string;
}

/** A non-empty set of at least two distinct papers. A duplicate group is only
 *  meaningful when it holds two or more papers to compare/merge, so the type
 *  makes that invariant unrepresentable-if-violated: `papers[0]` and `papers[1]`
 *  are always present. Constructed exclusively by `parseDuplicateGroups`, which
 *  discards any group that does not reach two distinct valid papers. */
export type DuplicatePaperSet = [
  DuplicatePaperInfo,
  DuplicatePaperInfo,
  ...DuplicatePaperInfo[],
];

/** A group of papers sharing the same PMID or DOI, returned by get_duplicate_papers().
 *  `match_type` is "doi" | "pmid" as emitted by the RPC; `mergeOverlappingGroups`
 *  additionally produces "both" when a group matches on both identifiers. */
export interface DuplicateGroup {
  match_type: "doi" | "pmid" | "both";
  match_value: string;
  papers: DuplicatePaperSet;
}

/** Per-row result from the safe_bulk_insert_papers RPC. */
export interface BulkInsertResult {
  index: number;
  id?: string;
  status: "inserted" | "duplicate" | "error";
  error_message?: string;
}

export interface PaperMetadata {
  identifier: string;
  title?: string;
  authors?: string[];
  year?: number | null;
  journal?: string | null;
  pmid?: string | null;
  doi?: string | null;
  abstract?: string | null;
  keywords?: string[];
  mesh_terms?: string[];
  substances?: string[];
  study_type?: string | null;
  /**
   * The same publication types as `study_type`, with the boundaries PubMed
   * stated still intact — an official type may contain a comma of its own
   * ("Clinical Trial, Phase II"), which the joined string cannot be split
   * back apart on.
   *
   * Optional, and must stay optional: the deployed Edge Function version may
   * predate the field, and a Crossref-only result has no publication types to
   * report. Absence means "no structured provenance", never "none exist".
   */
  publication_types?: string[];
  /**
   * Structured authorship provenance aligned one-to-one with `authors`.
   *
   * Optional, and must stay optional: the deployed Edge Function version may
   * predate the field, so its absence has to mean "no structured provenance"
   * rather than a failed import. A source path that cannot produce a complete
   * aligned array omits it rather than sending a partial one.
   */
  author_provenance?: AuthorProvenance[] | null;
  pubmed_url?: string | null;
  journal_url?: string | null;
  source?: "pubmed" | "crossref";
  error?: string;
}

