import type { ServerFilterParams } from "@/hooks/papers/types";

/**
 * Centralized query key factory for React Query.
 *
 * Every key is a function that takes userId to scope queries per user.
 * Using `as const` ensures proper type inference for invalidation.
 *
 * papers.all(userId) is a prefix for invalidation — matches all papers queries.
 * papers.list(userId, params) is the parameterized infinite query key.
 */
export const queryKeys = {
  papers: {
    /** Prefix key for cache operations — matches all papers queries for this user. */
    all: (userId: string) => ["papers", userId] as const,
    /** Parameterized key for the infinite papers query (includes filter/sort state). */
    list: (userId: string, params: ServerFilterParams) =>
      ["papers", userId, "list", params] as const,
    /** Parameterized key for the analytics fetch-all query (includes filter/sort state). */
    analytics: (userId: string, params: ServerFilterParams) =>
      ["papers", userId, "analytics", params] as const,
    count: (userId: string) => ["papers", userId, "count"] as const,
    /** Filtered count for the current server filter params (lightweight HEAD query). */
    filteredCount: (userId: string, params: ServerFilterParams) =>
      ["papers", userId, "filteredCount", params] as const,
    /** All paper IDs matching the current server filter params (for select-all). */
    filteredIds: (userId: string, params: ServerFilterParams) =>
      ["papers", userId, "filteredIds", params] as const,
    /** Distinct keyword options from all filtered papers (server-side aggregation). */
    keywordOptions: (userId: string, params: ServerFilterParams) =>
      ["papers", userId, "keywordOptions", params] as const,
    /** All distinct keywords across ALL user papers (unfiltered — for Sidebar import). */
    allKeywords: (userId: string) =>
      ["papers", userId, "allKeywords"] as const,
    /** All distinct study types across ALL user papers (unfiltered — for Sidebar import). */
    allStudyTypes: (userId: string) =>
      ["papers", userId, "allStudyTypes"] as const,
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
