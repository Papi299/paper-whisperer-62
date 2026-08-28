/**
 * PoolsContext: provides keyword pool, study type pool, synonym pool,
 * and exclusion pool data + CRUD methods to the component tree.
 *
 * Eliminates the 37+ prop drilling path Dashboard → Sidebar → Modals.
 * Both Dashboard (for normalization/filtering) and Sidebar (for display/CRUD)
 * consume from this single context.
 */

import { createContext, useCallback, useContext, ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useKeywordPool, PoolKeyword } from "@/hooks/useKeywordPool";
import { useStudyTypePool, PoolStudyType } from "@/hooks/useStudyTypePool";
import { useSynonymPool, Synonym } from "@/hooks/useSynonymPool";
import { queryKeys } from "@/lib/queryKeys";
import {
  useExclusionPools,
  ExcludedKeyword,
  ExcludedStudyType,
} from "@/hooks/useExclusionPools";

/**
 * How far along the three pools that feed `NormalizationConfig` are.
 *
 * Three states rather than a boolean, because `!loading` is not readiness. Each
 * pool query defaults its data to `[]`, so once React Query has exhausted its
 * retries a *failed* read settles at exactly the shape of a *successful* read of
 * an empty pool: `isLoading === false`, `data === []`. Collapsing those two into
 * one flag is how a read failure turns into an apparently valid configuration.
 *
 *   loading — at least one pool has not settled yet
 *   error   — every pool has settled and at least one failed
 *   ready   — every pool loaded, however few rows it returned
 *
 * `ready` is a positive fact about all three queries, never the absence of
 * loading, and an errored pool is never mistaken for an intentionally empty one.
 * A genuinely empty pool is `ready`: a user who has added no keywords has a
 * valid — if minimal — normalization configuration.
 */
export type NormalizationPoolsStatus = "loading" | "ready" | "error";

export interface PoolsContextValue {
  /**
   * Readiness of the three pools that feed `NormalizationConfig`.
   *
   * Exposed because "empty", "not loaded yet" and "the read failed" are all the
   * same array, and the difference is load-bearing: the canonical importer
   * treats a missing configuration as *skip normalization* rather than as an
   * error, so an import that runs against an unloaded or failed config silently
   * stores an unnormalized row. A surface that imports must require `"ready"`;
   * the Dashboard, whose import is behind several deliberate clicks, never had
   * to.
   *
   * Only the keyword, study-type and synonym pools count. The exclusion pools
   * are display filters and contribute nothing to normalization.
   */
  normalizationPoolsStatus: NormalizationPoolsStatus;

  /**
   * Refetch the three normalization pools.
   *
   * The recovery path for `"error"`, so a transient read failure costs a click
   * rather than a full page reload. `refetchQueries` rather than
   * `invalidateQueries` because the queries being retried are the ones that
   * failed, and refetching them is the whole intent.
   */
  retryNormalizationPools: () => void;

  // Keyword Pool
  poolKeywords: PoolKeyword[];
  addKeyword: (keyword: string) => Promise<boolean>;
  addMultipleKeywords: (keywords: string[]) => Promise<number>;
  deleteKeyword: (keywordId: string) => void;
  deleteAllKeywords: () => void;
  findMatchingKeywords: (abstract: string | null) => string[];

  // Study Type Pool
  poolStudyTypes: PoolStudyType[];
  addStudyType: (
    studyType: string,
    groupName?: string | null,
    hierarchyRank?: number
  ) => Promise<boolean>;
  addMultipleStudyTypes: (studyTypes: string[]) => Promise<number>;
  updateStudyType: (
    id: string,
    updates: Partial<Pick<PoolStudyType, "study_type" | "group_name" | "hierarchy_rank">>
  ) => Promise<void>;
  deleteStudyType: (id: string) => Promise<void>;
  deleteAllStudyTypes: () => Promise<void>;
  renameGroup: (oldName: string, newName: string, newRank?: number) => Promise<void>;
  deleteGroup: (groupName: string) => Promise<void>;

  // Synonym Pool
  synonymGroups: Synonym[];
  addSynonymGroup: (canonicalTerm: string, synonyms: string[]) => Promise<void>;
  updateSynonymGroup: (id: string, canonicalTerm: string, synonyms: string[]) => Promise<void>;
  deleteSynonymGroup: (id: string) => Promise<void>;
  normalizeKeyword: (keyword: string) => string;
  synonymLookup: Record<string, string>;

  // Exclusion Pools
  excludedKeywords: ExcludedKeyword[];
  excludedStudyTypes: ExcludedStudyType[];
  addExcludedKeyword: (keyword: string) => Promise<boolean>;
  deleteExcludedKeyword: (id: string) => Promise<void>;
  clearExcludedKeywords: () => Promise<void>;
  addExcludedStudyType: (studyType: string) => Promise<boolean>;
  deleteExcludedStudyType: (id: string) => Promise<void>;
  clearExcludedStudyTypes: () => Promise<void>;
  getExcludedKeywordSet: () => Set<string>;
  getExcludedStudyTypeSet: () => Set<string>;
}

const PoolsContext = createContext<PoolsContextValue | null>(null);

export function usePools(): PoolsContextValue {
  const ctx = useContext(PoolsContext);
  if (!ctx) throw new Error("usePools must be used within a PoolsProvider");
  return ctx;
}

interface PoolsProviderProps {
  userId: string | undefined;
  children: ReactNode;
}

export function PoolsProvider({ userId, children }: PoolsProviderProps) {
  const queryClient = useQueryClient();
  const keywordPool = useKeywordPool(userId);
  const studyTypePool = useStudyTypePool(userId);
  const synonymPool = useSynonymPool(userId);
  const exclusionPools = useExclusionPools(userId);

  // Loading is checked before failure so a pool still in flight can never be
  // reported as an error, and neither state can ever be reported as ready.
  // `isLoading` is false for a disabled query, so a signed-out tree settles
  // rather than hanging — the pools genuinely are not coming.
  const normalizationPoolsStatus: NormalizationPoolsStatus =
    keywordPool.loading || studyTypePool.loading || synonymPool.loading
      ? "loading"
      : keywordPool.isError || studyTypePool.isError || synonymPool.isError
        ? "error"
        : "ready";

  const retryNormalizationPools = useCallback(() => {
    if (!userId) return;
    void queryClient.refetchQueries({ queryKey: queryKeys.keywordPool.all(userId) });
    void queryClient.refetchQueries({ queryKey: queryKeys.studyTypePool.all(userId) });
    void queryClient.refetchQueries({ queryKey: queryKeys.synonymPool.all(userId) });
  }, [queryClient, userId]);

  const value: PoolsContextValue = {
    normalizationPoolsStatus,
    retryNormalizationPools,

    // Keyword Pool
    poolKeywords: keywordPool.poolKeywords,
    addKeyword: keywordPool.addKeyword,
    addMultipleKeywords: keywordPool.addMultipleKeywords,
    deleteKeyword: keywordPool.deleteKeyword,
    deleteAllKeywords: keywordPool.deleteAllKeywords,
    findMatchingKeywords: keywordPool.findMatchingKeywords,

    // Study Type Pool
    poolStudyTypes: studyTypePool.poolStudyTypes,
    addStudyType: studyTypePool.addStudyType,
    addMultipleStudyTypes: studyTypePool.addMultipleStudyTypes,
    updateStudyType: studyTypePool.updateStudyType,
    deleteStudyType: studyTypePool.deleteStudyType,
    deleteAllStudyTypes: studyTypePool.deleteAllStudyTypes,
    renameGroup: studyTypePool.renameGroup,
    deleteGroup: studyTypePool.deleteGroup,

    // Synonym Pool
    synonymGroups: synonymPool.synonymGroups,
    addSynonymGroup: synonymPool.addSynonymGroup,
    updateSynonymGroup: synonymPool.updateSynonymGroup,
    deleteSynonymGroup: synonymPool.deleteSynonymGroup,
    normalizeKeyword: synonymPool.normalizeKeyword,
    synonymLookup: synonymPool.synonymLookup,

    // Exclusion Pools
    excludedKeywords: exclusionPools.excludedKeywords,
    excludedStudyTypes: exclusionPools.excludedStudyTypes,
    addExcludedKeyword: exclusionPools.addExcludedKeyword,
    deleteExcludedKeyword: exclusionPools.deleteExcludedKeyword,
    clearExcludedKeywords: exclusionPools.clearExcludedKeywords,
    addExcludedStudyType: exclusionPools.addExcludedStudyType,
    deleteExcludedStudyType: exclusionPools.deleteExcludedStudyType,
    clearExcludedStudyTypes: exclusionPools.clearExcludedStudyTypes,
    getExcludedKeywordSet: exclusionPools.getExcludedKeywordSet,
    getExcludedStudyTypeSet: exclusionPools.getExcludedStudyTypeSet,
  };

  return <PoolsContext.Provider value={value}>{children}</PoolsContext.Provider>;
}
