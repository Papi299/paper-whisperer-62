/**
 * The user-specific normalization configuration, assembled from their pools.
 *
 * Extracted from `Dashboard` unchanged so a second import surface cannot build a
 * *different* one. This matters more than ordinary deduplication: the canonical
 * importer treats a missing config as "skip normalization" rather than as an
 * error —
 *
 *   normalizedPapers = normalizationConfig ? await normalize(…) : rawPapers
 *
 * — so an import that runs without it succeeds, is owned, satisfies every
 * constraint, and silently stores a second-class row: HTML entities undecoded,
 * keywords un-canonicalised and un-enriched, no synonym-group extraction and no
 * Winner-Takes-All study type. Nothing fails, and the user finds out later.
 *
 * One assembly, one shape, one place to be wrong.
 */

import { useMemo } from "react";

import { usePools } from "@/contexts/PoolsContext";
import type { NormalizationConfig } from "@/lib/normalizePaperData";

/**
 * Build the current user's `NormalizationConfig` from `PoolsProvider` data.
 *
 * Must be called inside a `PoolsProvider`. The mapping is verbatim what
 * `Dashboard` did before this hook existed — the same four fields, the same
 * projections, the same memo dependencies — so no normalization behaviour
 * changes by moving it here.
 */
export function useNormalizationConfig(): NormalizationConfig {
  const { synonymLookup, poolStudyTypes, poolKeywords, synonymGroups } = usePools();

  return useMemo<NormalizationConfig>(
    () => ({
      synonymLookup: synonymLookup || {},
      poolStudyTypes: poolStudyTypes.map((st) => ({
        study_type: st.study_type,
        specificity_weight: st.specificity_weight,
        hierarchy_rank: st.hierarchy_rank,
      })),
      poolKeywords: poolKeywords.map((pk) => pk.keyword),
      synonymGroups: synonymGroups.map((sg) => ({
        canonical_term: sg.canonical_term,
        synonyms: sg.synonyms,
      })),
    }),
    [synonymLookup, poolStudyTypes, poolKeywords, synonymGroups],
  );
}
