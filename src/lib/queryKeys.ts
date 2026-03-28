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
