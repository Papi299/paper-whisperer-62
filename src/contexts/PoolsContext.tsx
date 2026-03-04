/**
 * PoolsContext: provides keyword pool, study type pool, synonym pool,
 * and exclusion pool data + CRUD methods to the component tree.
 *
 * Eliminates the 37+ prop drilling path Dashboard → Sidebar → Modals.
 * Both Dashboard (for normalization/filtering) and Sidebar (for display/CRUD)
 * consume from this single context.
 */

import { createContext, useContext, ReactNode } from "react";
import { useKeywordPool, PoolKeyword } from "@/hooks/useKeywordPool";
import { useStudyTypePool, PoolStudyType } from "@/hooks/useStudyTypePool";
import { useSynonymPool, Synonym } from "@/hooks/useSynonymPool";
import {
  useExclusionPools,
  ExcludedKeyword,
  ExcludedStudyType,
} from "@/hooks/useExclusionPools";

export interface PoolsContextValue {
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
  deleteStudyType: (id: string) => void;
  deleteAllStudyTypes: () => void;
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
  const keywordPool = useKeywordPool(userId);
  const studyTypePool = useStudyTypePool(userId);
  const synonymPool = useSynonymPool(userId);
  const exclusionPools = useExclusionPools(userId);

  const value: PoolsContextValue = {
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
