import type { ServerFilterParams, ServerSortParams } from "@/hooks/papers/types";

/**
 * Centralized query key factory for React Query.
 *
 * Every key is a function that takes userId to scope queries per user.
 * Using `as const` ensures proper type inference for invalidation.
 *
 * papers.all(userId) is a prefix for invalidation — matches all papers queries.
 * papers.list(userId, filterParams, sortParams) is the parameterized infinite query key.
 *
 * IMPORTANT: filter-derived caches (filteredCount, filteredIds, keywordOptions) use
 * filter-only params so that changing sort order does NOT invalidate them.
 * Only the list and analytics keys include sort params.
 */
export const queryKeys = {
  papers: {
    /** Prefix key for cache operations — matches all papers queries for this user. */
    all: (userId: string) => ["papers", userId] as const,
    /** Parameterized key for the infinite papers query (includes filter + sort state). */
    list: (userId: string, filterParams: ServerFilterParams, sortParams: ServerSortParams) =>
      ["papers", userId, "list", filterParams, sortParams] as const,
    /** Parameterized key for the analytics fetch-all query (includes filter + sort state). */
    analytics: (userId: string, filterParams: ServerFilterParams, sortParams: ServerSortParams) =>
      ["papers", userId, "analytics", filterParams, sortParams] as const,
    count: (userId: string) => ["papers", userId, "count"] as const,
    /** Filtered count — filter-only key (sort changes do NOT invalidate). */
    filteredCount: (userId: string, params: ServerFilterParams) =>
      ["papers", userId, "filteredCount", params] as const,
    /** All paper IDs matching filters — filter-only key (sort changes do NOT invalidate). */
    filteredIds: (userId: string, params: ServerFilterParams) =>
      ["papers", userId, "filteredIds", params] as const,
    /** Distinct keyword options — filter-only key (sort changes do NOT invalidate). */
    keywordOptions: (userId: string, params: ServerFilterParams) =>
      ["papers", userId, "keywordOptions", params] as const,
    /** All distinct keywords across ALL user papers (unfiltered — for Sidebar import). */
    allKeywords: (userId: string) =>
      ["papers", userId, "allKeywords"] as const,
    /** All distinct study types across ALL user papers (unfiltered — for Sidebar import). */
    allStudyTypes: (userId: string) =>
      ["papers", userId, "allStudyTypes"] as const,
    /** Single paper abstract — fetched on demand (expand, edit, analyze). */
    abstract: (paperId: string) =>
      ["papers", "abstract", paperId] as const,
  },
  projects: {
    all: (userId: string) => ["projects", userId] as const,
  },
  tags: {
    all: (userId: string) => ["tags", userId] as const,
  },
  keywordPool: {
    all: (userId: string) => ["keywordPool", userId] as const,
  },
  studyTypePool: {
    all: (userId: string) => ["studyTypePool", userId] as const,
  },
  synonymPool: {
    all: (userId: string) => ["synonymPool", userId] as const,
  },
  exclusions: {
    all: (userId: string) => ["exclusions", userId] as const,
  },
} as const;
