import { useState, useCallback } from "react";
import type { PaperWithTags } from "@/types/database";

interface UseBulkSelectionArgs {
  papers: PaperWithTags[];
  /** All filtered paper IDs from the server (for full-set select-all). */
  allFilteredIds?: string[];
  bulkDeletePapers: (ids: string[]) => Promise<void>;
  bulkSetProjects: (paperIds: string[], projectIds: string[]) => Promise<void>;
  bulkSetTags: (paperIds: string[], tagIds: string[]) => Promise<void>;
}

export function useBulkSelection({
  papers,
  allFilteredIds,
  bulkDeletePapers,
  bulkSetProjects,
  bulkSetTags,
}: UseBulkSelectionArgs) {
  const [selectedPaperIds, setSelectedPaperIds] = useState<Set<string>>(new Set());

  const handleToggleSelect = useCallback((paperId: string) => {
    setSelectedPaperIds((prev) => {
      const next = new Set(prev);
      if (next.has(paperId)) next.delete(paperId);
      else next.add(paperId);
      return next;
    });
  }, []);

  const handleToggleSelectAll = useCallback(() => {
    setSelectedPaperIds((prev) => {
      // Prefer full filtered set from server; fall back to loaded papers
      const ids = allFilteredIds ?? papers.map((p) => p.id);
      const allSelected = ids.every((id) => prev.has(id));
      if (allSelected) return new Set<string>();
      return new Set(ids);
    });
  }, [allFilteredIds, papers]);

  const handleClearSelection = useCallback(() => {
    setSelectedPaperIds(new Set());
  }, []);

  const handleBulkDelete = useCallback(async () => {
    await bulkDeletePapers(Array.from(selectedPaperIds));
    setSelectedPaperIds(new Set());
  }, [selectedPaperIds, bulkDeletePapers]);

  const handleBulkSetProjects = useCallback(
    async (projectIds: string[]) => {
      await bulkSetProjects(Array.from(selectedPaperIds), projectIds);
      setSelectedPaperIds(new Set());
    },
    [selectedPaperIds, bulkSetProjects],
  );

  const handleBulkSetTags = useCallback(
    async (tagIds: string[]) => {
      await bulkSetTags(Array.from(selectedPaperIds), tagIds);
      setSelectedPaperIds(new Set());
    },
    [selectedPaperIds, bulkSetTags],
  );

  return {
    selectedPaperIds,
    handleToggleSelect,
    handleToggleSelectAll,
    handleClearSelection,
    handleBulkDelete,
    handleBulkSetProjects,
    handleBulkSetTags,
  };
}
