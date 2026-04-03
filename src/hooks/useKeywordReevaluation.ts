import { useState, useEffect, useCallback, useRef } from "react";
import type { NormalizationConfig } from "@/lib/normalizePaperData";

interface UseKeywordReevaluationArgs {
  normalizationConfig: NormalizationConfig | undefined;
  reevaluateKeywords: (config: NormalizationConfig) => Promise<void>;
}

/**
 * Dirty-flag + version-counter trigger for keyword reevaluation.
 *
 * Unlike study type reevaluation (which fires on every modal close),
 * keyword reevaluation is gated by a dirty flag because it performs a
 * full-library fetch + update — too expensive for no-op modal closes.
 *
 * Usage:
 * - Call `markDirty()` whenever a pool change happens (add/delete keyword, add/delete/edit synonym)
 * - Call `handlePoolModalClose()` when any keyword or synonym modal closes
 * - Reevaluation only fires if the dirty flag is set when the modal closes
 */
export function useKeywordReevaluation({
  normalizationConfig,
  reevaluateKeywords,
}: UseKeywordReevaluationArgs) {
  const dirtyRef = useRef(false);
  const [reevalVersion, setReevalVersion] = useState(0);

  // Fires reevaluation after the re-render where normalizationConfig is fresh
  useEffect(() => {
    if (reevalVersion > 0 && normalizationConfig) {
      reevaluateKeywords(normalizationConfig);
    }
  }, [reevalVersion]); // intentionally only depend on version counter

  // Called when a pool change actually happens (add, delete, edit)
  const markDirty = useCallback(() => {
    dirtyRef.current = true;
  }, []);

  // Called when any keyword/synonym modal closes
  const handlePoolModalClose = useCallback(() => {
    if (dirtyRef.current) {
      dirtyRef.current = false;
      setReevalVersion((v) => v + 1);
    }
  }, []);

  return { markDirty, handlePoolModalClose };
}
