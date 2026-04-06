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
