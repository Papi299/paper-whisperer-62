import { useState, useEffect, useCallback } from "react";
import type { StudyTypePoolEntry } from "@/lib/evaluateStudyType";
import type { PoolStudyType } from "@/hooks/useStudyTypePool";

function toPoolEntry(st: PoolStudyType): StudyTypePoolEntry {
  return {
    study_type: st.study_type,
    specificity_weight: st.specificity_weight,
    hierarchy_rank: st.hierarchy_rank,
  };
}

interface UseStudyTypeReevaluationArgs {
  poolStudyTypes: PoolStudyType[];
  reevaluateStudyTypes: (pool: StudyTypePoolEntry[]) => Promise<void>;
  deleteStudyType: (id: string) => Promise<void>;
  deleteAllStudyTypes: () => Promise<void>;
}

export function useStudyTypeReevaluation({
  poolStudyTypes,
  reevaluateStudyTypes,
  deleteStudyType,
  deleteAllStudyTypes,
}: UseStudyTypeReevaluationArgs) {
  // Version counter triggers re-evaluation when the modal closes
  const [studyTypePoolVersion, setStudyTypePoolVersion] = useState(0);

  useEffect(() => {
    if (studyTypePoolVersion > 0) {
      reevaluateStudyTypes(poolStudyTypes.map(toPoolEntry));
    }
  }, [studyTypePoolVersion]); // intentionally only depend on version counter

  const handleStudyTypePoolModalClose = useCallback(() => {
    setStudyTypePoolVersion((v) => v + 1);
  }, []);

  // Wrap delete to immediately re-evaluate with a fresh pool (avoids stale state)
  const handleDeletePoolStudyType = useCallback(
    async (id: string) => {
      await deleteStudyType(id);
      const freshPool = poolStudyTypes.filter((st) => st.id !== id).map(toPoolEntry);
      reevaluateStudyTypes(freshPool);
    },
    [deleteStudyType, poolStudyTypes, reevaluateStudyTypes],
  );

  const handleDeleteAllPoolStudyTypes = useCallback(async () => {
    await deleteAllStudyTypes();
    reevaluateStudyTypes([]);
  }, [deleteAllStudyTypes, reevaluateStudyTypes]);

  return {
    handleStudyTypePoolModalClose,
    handleDeletePoolStudyType,
    handleDeleteAllPoolStudyTypes,
  };
}
