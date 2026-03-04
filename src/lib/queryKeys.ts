/**
 * Centralized query key factory for React Query.
 *
 * Every key is a function that takes userId to scope queries per user.
 * Using `as const` ensures proper type inference for invalidation.
 */
export const queryKeys = {
  papers: {
    all: (userId: string) => ["papers", userId] as const,
    list: (userId: string) => ["papers", userId, "list"] as const,
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
