import { InfiniteData } from "@tanstack/react-query";
import { Paper, PaperAttachment, Project, Tag } from "@/types/database";

/** Raw paper with junction IDs (not hydrated with full Project/Tag objects). */
export interface RawPaperWithJunctions extends Paper {
  tagIds: string[];
  projectIds: string[];
  paper_attachments?: PaperAttachment[];
}

/** Shape of each page in the infinite papers query. */
export interface PapersPage {
  papers: RawPaperWithJunctions[];
  hasMore: boolean;
}

export type CacheSnapshot = {
  papers: InfiniteData<PapersPage> | undefined;
  count: number | undefined;
  projects: Project[] | undefined;
  tags: Tag[] | undefined;
};

/**
 * Tri-state filter for notes presence.
 * - "all"  — no filter (default)
 * - "has"  — notes IS NOT NULL AND contains at least one non-whitespace character
 * - "none" — notes IS NULL OR contains only whitespace
 * Semantics match the list row sticky-note indicator (`paper.notes?.trim()`).
 */
export type NotesPresence = "all" | "has" | "none";

/**
 * Server-side filter parameters (filter predicates only — no sort).
 * Used in query keys for count, filtered IDs, keyword options, etc.
 * Changing sort order does NOT invalidate these caches.
 */
export interface ServerFilterParams {
  /**
   * Pre-resolved paper IDs from junction queries + search.
   * - undefined = an ID-based filter is active but not yet resolved (papers query must NOT run)
   * - null = no ID-based filter is active (papers query runs without .in())
   * - [] = ID-based filter resolved with no matches (short-circuit empty result)
   * - [...ids] = ID-based filter resolved with matches (apply .in("id", ids))
   */
  filterPaperIds: string[] | null | undefined;
  yearFrom: number | null;
  yearTo: number | null;
  /** Resolved study type subtypes (not group name). */
  studyTypes: string[] | null;
  /** Notes presence tri-state. "all" = no predicate applied. */
  notesPresence: NotesPresence;
}

/**
 * Server-side sort parameters. Separated from filter params so that
 * changing sort order does not invalidate filter-derived caches
 * (count, filtered IDs, keyword options).
 */
export interface ServerSortParams {
  /** PostgREST column name for sorting. */
  sortColumn: string | null;
  sortAscending: boolean | null;
}

/** Whether all ID-based filters have resolved and the papers query can run. */
export function areServerFiltersReady(params: ServerFilterParams): boolean {
  return params.filterPaperIds !== undefined;
}

/**
 * Per-field match flags returned by `search_papers` and `search_papers_short`.
 * Each flag is true iff the corresponding paper field matched the active
 * search query under the path-appropriate rule (FTS prefix or ILIKE substring).
 *
 * Authoritative — derived server-side, not inferred on the client. The UI
 * renders the "Matched in: …" sub-line in the paper row directly from these
 * flags, in fixed UI order (Title → Abstract → Authors → Journal → Notes →
 * Keywords).
 *
 * Snake_case mirrors the SQL return columns to keep the row → state mapping
 * trivial.
 */
export interface MatchFlags {
  matched_title: boolean;
  matched_abstract: boolean;
  matched_authors: boolean;
  matched_journal: boolean;
  matched_notes: boolean;
  matched_keywords: boolean;
}

/**
 * What happened to one identifier the canonical importer was given.
 *
 * `duplicate-resolved` and `duplicate-unresolved` are both duplicates — the
 * paper was already in the library either way and nothing was inserted. They
 * differ only in whether `safe_bulk_insert_papers` could prove which existing
 * row collided, which is the only thing that makes an additive assignment
 * safe. A database that predates CHROME-EXTENSION-IMPORT-001D reports every
 * duplicate as `duplicate-unresolved`, and so does an importer that did not
 * opt into duplicate assignment.
 */
export type BulkImportItemStatus =
  | "inserted"
  | "duplicate-resolved"
  | "duplicate-unresolved"
  | "failed";

/**
 * What happened to one category of assignment work, for one group of papers.
 *
 * `not-requested` is deliberately distinct from `applied`: a caller must be
 * able to tell "no assignment RPC ran" from "the user's selection landed",
 * because only the second one may ever be reported to the user as applied.
 *
 * It covers both reasons no RPC ran — the user selected nothing in this
 * category, and this group held no papers to assign to (a run with no inserted
 * rows leaves the inserted report `not-requested` even when the user selected
 * plenty, because nothing was requested *of that group*). Read a group's report
 * alongside the item statuses that put papers in it.
 */
export type BulkImportAssignmentOutcome = "not-requested" | "applied" | "failed";

/** Assignment evidence for one group of papers (newly inserted, or resolved duplicates). */
export interface BulkImportAssignmentReport {
  projects: BulkImportAssignmentOutcome;
  tags: BulkImportAssignmentOutcome;
}

/**
 * The canonical importer's terminal result, returned AFTER its assignment phase.
 *
 * The `onProgress` callback reports the insert phase and is emitted before any
 * assignment RPC runs, so it can prove a row was inserted and can prove nothing
 * at all about whether the user's Projects and Tags landed on it. A caller that
 * needs to say something truthful about assignment reads this instead — and
 * reads it rather than querying the database itself, which would fork the
 * importer's ownership of that decision.
 */
export interface BulkImportOutcome {
  /** One entry per identifier passed in, in input order. */
  items: { identifier: string; status: BulkImportItemStatus }[];
  /** Assignment evidence for the rows inserted by this run (`bulk_set_*`, replace-all). */
  inserted: BulkImportAssignmentReport;
  /** Assignment evidence for deterministically resolved duplicates (`bulk_add_*`, additive). */
  resolvedDuplicates: BulkImportAssignmentReport;
}
