import { useState, useCallback } from "react";
import { useQueryClient, InfiniteData } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { DuplicateGroup, DuplicatePaperInfo, PaperWithTags, Project, Tag } from "@/types/database";
import { useToast } from "@/hooks/use-toast";
import { queryKeys } from "@/lib/queryKeys";

/** Shape of each page in the infinite papers query. */
interface PapersPage {
  papers: PaperWithTags[];
  projects: Project[];
  tags: Tag[];
  hasMore: boolean;
}

/**
 * Merges duplicate groups that share overlapping paper IDs.
 * E.g. if a pair of papers matches on BOTH DOI and PMID, they appear in two
 * separate groups from the RPC — this function consolidates them into one
 * group with match_type "both".
 */
function mergeOverlappingGroups(groups: DuplicateGroup[]): DuplicateGroup[] {
  if (groups.length === 0) return [];

  // Build a union-find structure based on paper IDs
  const paperToGroupIdx = new Map<string, number>();
  const mergedGroups: DuplicateGroup[] = [];

  for (const group of groups) {
    const paperIds = group.papers.map((p) => p.id);

    // Find if any paper in this group is already in a merged group
    let existingIdx: number | undefined;
    for (const pid of paperIds) {
      if (paperToGroupIdx.has(pid)) {
        existingIdx = paperToGroupIdx.get(pid);
        break;
      }
    }

    if (existingIdx !== undefined) {
      // Merge into existing group
      const existing = mergedGroups[existingIdx];
      const existingIds = new Set(existing.papers.map((p) => p.id));

      for (const paper of group.papers) {
        if (!existingIds.has(paper.id)) {
          existing.papers.push(paper);
          existingIds.add(paper.id);
        }
      }

      // Update match_type to indicate both identifiers matched
      if (existing.match_type !== group.match_type) {
        (existing as DuplicateGroup & { match_type: string }).match_type = "both";
      }

      // Update index for all papers
      for (const pid of paperIds) {
        paperToGroupIdx.set(pid, existingIdx);
      }
    } else {
      // New group
      const idx = mergedGroups.length;
      mergedGroups.push({ ...group });
      for (const pid of paperIds) {
        paperToGroupIdx.set(pid, idx);
      }
    }
  }

  return mergedGroups;
}

/**
 * Scores a paper by counting its non-null/non-empty fields.
 * Used to suggest the most complete paper as the "keep" candidate.
 */
function scorePaper(paper: DuplicatePaperInfo): number {
  let score = 0;
  if (paper.title) score++;
  if (paper.authors && paper.authors.length > 0) score++;
  if (paper.year) score++;
  if (paper.journal) score++;
  if (paper.pmid) score++;
  if (paper.doi) score++;
  if (paper.abstract) score += 2; // abstract is especially valuable
  if (paper.study_type) score++;
  if (paper.keywords && paper.keywords.length > 0) score++;
  return score;
}

/**
 * Returns the paper ID with the highest metadata completeness score.
 */
export function suggestKeepPaper(group: DuplicateGroup): string {
  let bestId = group.papers[0].id;
  let bestScore = -1;

  for (const paper of group.papers) {
    const s = scorePaper(paper);
    if (s > bestScore) {
      bestScore = s;
      bestId = paper.id;
    }
  }

  return bestId;
}

export function useDeduplication(userId: string | undefined) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [scanning, setScanning] = useState(false);
  const [duplicateGroups, setDuplicateGroups] = useState<DuplicateGroup[]>([]);
  const [merging, setMerging] = useState(false);

  // ── Detection ──

  const scanForDuplicates = useCallback(async () => {
    if (!userId) return;
    setScanning(true);
    setDuplicateGroups([]);

    try {
      const { data, error } = await supabase.rpc("get_duplicate_papers");

      if (error) {
        toast({
          title: "Error scanning for duplicates",
          description: error.message,
          variant: "destructive",
        });
        return;
      }

      const rawGroups: DuplicateGroup[] = (data as DuplicateGroup[]) || [];
      const merged = mergeOverlappingGroups(rawGroups);
      setDuplicateGroups(merged);
    } catch (err) {
      toast({
        title: "Error scanning for duplicates",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setScanning(false);
    }
  }, [userId, toast]);

  // ── Merge ──

  const mergeDuplicateGroup = useCallback(
    async (keepId: string, discardIds: string[]) => {
      if (!userId || discardIds.length === 0) return false;

      // Snapshot for rollback
      const papersSnapshot = queryClient.getQueryData<InfiniteData<PapersPage>>(
        queryKeys.papers.all(userId),
      );
      const countSnapshot = queryClient.getQueryData<number>(
        queryKeys.papers.count(userId),
      );

      // Optimistic: remove discards from cache and adjust count
      await queryClient.cancelQueries({ queryKey: queryKeys.papers.all(userId) });
      const discardSet = new Set(discardIds);

      queryClient.setQueryData(
        queryKeys.papers.all(userId),
        (old: InfiniteData<PapersPage> | undefined) => {
          if (!old) return old;
          const allPapers = old.pages.flatMap((p) => p.papers);
          const updated = allPapers.filter((p) => !discardSet.has(p.id));
          return {
            ...old,
            pages: old.pages.map((page, i) =>
              i === 0 ? { ...page, papers: updated } : { ...page, papers: [] },
            ),
          };
        },
      );

      queryClient.setQueryData(
        queryKeys.papers.count(userId),
        (old: number | undefined) => Math.max(0, (old ?? 0) - discardIds.length),
      );

      // Server call
      const { error } = await supabase.rpc("merge_exact_duplicates", {
        p_keep_id: keepId,
        p_discard_ids: discardIds,
      });

      if (error) {
        // Rollback
        if (papersSnapshot !== undefined) {
          queryClient.setQueryData(queryKeys.papers.all(userId), papersSnapshot);
        }
        if (countSnapshot !== undefined) {
          queryClient.setQueryData(queryKeys.papers.count(userId), countSnapshot);
        }
        toast({
          title: "Error merging duplicates",
          description: error.message,
          variant: "destructive",
        });
        return false;
      }

      // Invalidate to refresh the kept paper with its coalesced fields
      queryClient.invalidateQueries({ queryKey: queryKeys.papers.all(userId) });

      return true;
    },
    [userId, queryClient, toast],
  );

  /** Merge all groups sequentially with the given keep selections. */
  const mergeAllGroups = useCallback(
    async (selections: Map<number, string>) => {
      if (!userId) return;
      setMerging(true);

      let successCount = 0;
      let failCount = 0;

      for (const [groupIdx, keepId] of selections.entries()) {
        const group = duplicateGroups[groupIdx];
        if (!group) continue;

        const discardIds = group.papers
          .map((p) => p.id)
          .filter((id) => id !== keepId);

        if (discardIds.length === 0) continue;

        const ok = await mergeDuplicateGroup(keepId, discardIds);
        if (ok) {
          successCount++;
        } else {
          failCount++;
        }
      }

      setMerging(false);

      if (failCount === 0) {
        toast({
          title: "Duplicates merged",
          description: `Successfully merged ${successCount} duplicate group${successCount !== 1 ? "s" : ""}.`,
        });
      } else {
        toast({
          title: "Merge partially failed",
          description: `${successCount} merged, ${failCount} failed. Check your data and try again.`,
          variant: "destructive",
        });
      }

      // Clear groups after merge
      setDuplicateGroups([]);
    },
    [userId, duplicateGroups, mergeDuplicateGroup, toast],
  );

  return {
    scanning,
    duplicateGroups,
    merging,
    scanForDuplicates,
    mergeAllGroups,
  };
}
