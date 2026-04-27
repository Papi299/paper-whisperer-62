import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { fetchAbstract, fetchAbstractsBatch } from "@/hooks/useAbstract";
import { useToast } from "@/hooks/use-toast";
import { buildAnalysisUpdates } from "@/lib/studyTypeUtils";
import type { Paper, PaperWithTags } from "@/types/database";

/**
 * AI-analysis orchestration extracted from `Dashboard.tsx`.
 *
 * Owns:
 *   - per-paper "currently analyzing" state (`analyzingPaperId`)
 *   - bulk-analyze active flag (`bulkAnalyzing`)
 *   - bulk-analyze progress (`bulkAnalyzeProgress`)
 *   - the single-paper handler (`handleAnalyzePaper`)
 *   - the bulk handler (`handleBulkAnalyze`)
 *
 * **Pure-orchestration extraction — no behavior change** vs. the previously
 * inline Dashboard code. Bodies are lifted verbatim from `Dashboard.tsx`'s
 * `handleAnalyzePaper` / `handleBulkAnalyze`, with **only one substitution**:
 * the inline `new Promise(resolve => setTimeout(resolve, 3000))` cooldown
 * becomes `await sleep(3000)`. `sleep` defaults to a real 3-second sleep in
 * production; tests inject `vi.fn().mockResolvedValue(undefined)` to make
 * the cooldown a synchronous no-op while still asserting the call shape.
 *
 * **Cooldown control flow (locked-in current behavior):** the `await sleep`
 * runs after success and after caught per-paper failures, but **NOT** after
 * missing-abstract skips — because the bulk loop's `if (!abstract) {
 * failCount++; continue; }` jumps to the next iteration BEFORE the cooldown
 * line. Do not relocate `sleep` into a `finally` or to the top of the loop;
 * doing so would change the cooldown control flow.
 */

const DEFAULT_SLEEP = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface UsePaperAnalysisActionsArgs {
  papers: PaperWithTags[];
  selectedPaperIds: Set<string>;
  /** From `usePapers().updatePaper`. */
  updatePaper: (
    paperId: string,
    updates: Partial<Paper> & { tagIds?: string[]; projectIds?: string[] },
  ) => Promise<void>;
  /**
   * Optional cooldown function — defaults to a real 3-second sleep via
   * `setTimeout`. Tests inject `vi.fn().mockResolvedValue(undefined)`.
   */
  sleep?: (ms: number) => Promise<void>;
}

export interface UsePaperAnalysisActionsResult {
  analyzingPaperId: string | null;
  bulkAnalyzing: boolean;
  bulkAnalyzeProgress: { current: number; total: number };
  handleAnalyzePaper: (paper: PaperWithTags) => Promise<void>;
  handleBulkAnalyze: () => Promise<void>;
}

export function usePaperAnalysisActions({
  papers,
  selectedPaperIds,
  updatePaper,
  sleep = DEFAULT_SLEEP,
}: UsePaperAnalysisActionsArgs): UsePaperAnalysisActionsResult {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [analyzingPaperId, setAnalyzingPaperId] = useState<string | null>(null);
  const [bulkAnalyzing, setBulkAnalyzing] = useState(false);
  const [bulkAnalyzeProgress, setBulkAnalyzeProgress] = useState({ current: 0, total: 0 });

  const handleAnalyzePaper = useCallback(async (paper: PaperWithTags) => {
    if (!paper.has_abstract) return;
    setAnalyzingPaperId(paper.id);
    try {
      // Fetch abstract on demand (uses cache if already loaded)
      const abstract = await fetchAbstract(paper.id, queryClient);
      if (!abstract) {
        toast({ title: "No abstract", description: "Paper has no abstract to analyze.", variant: "destructive" });
        return;
      }

      const { data, error } = await supabase.functions.invoke("analyze-paper", {
        body: { title: paper.title, abstract },
      });
      if (error) throw error;

      const aiData = data as { tldr?: string; studyType?: string; statisticalMethods?: string };

      // Smart merge: keep existing study_type if it's specific.
      // See `src/lib/studyTypeUtils.ts` for the merge rule + tests.
      const { updates, keptStudyType } = buildAnalysisUpdates(paper, aiData);

      await updatePaper(paper.id, updates);

      toast({
        title: "Analysis complete and saved",
        description: keptStudyType
          ? "TLDR updated. Kept existing study type from PubMed."
          : "TLDR, study type, and statistical methods updated.",
      });
    } catch (err: unknown) {
      toast({
        title: "AI Analysis failed",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setAnalyzingPaperId(null);
    }
  }, [updatePaper, queryClient, toast]);

  const handleBulkAnalyze = useCallback(async () => {
    const selectedPapers = papers.filter(p => selectedPaperIds.has(p.id));
    const papersToAnalyze = selectedPapers.filter(p => p.has_abstract); // skip papers without abstract
    if (papersToAnalyze.length === 0) {
      toast({ title: "No papers to analyze", description: "Selected papers have no abstracts.", variant: "destructive" });
      return;
    }

    setBulkAnalyzing(true);
    setBulkAnalyzeProgress({ current: 0, total: papersToAnalyze.length });
    let successCount = 0;
    let failCount = 0;

    // Batch-fetch all abstracts in one query (avoids N+1)
    const abstractMap = await fetchAbstractsBatch(
      papersToAnalyze.map(p => p.id),
      queryClient,
    );

    for (const paper of papersToAnalyze) {
      setBulkAnalyzeProgress(prev => ({ ...prev, current: prev.current + 1 }));
      const abstract = abstractMap.get(paper.id);
      if (!abstract) {
        failCount++;
        continue;
      }
      try {
        const { data, error } = await supabase.functions.invoke("analyze-paper", {
          body: { title: paper.title, abstract },
        });
        if (error) throw error;

        const aiData = data as { tldr?: string; studyType?: string; statisticalMethods?: string };
        // Same smart-merge as the single-paper path above.
        const { updates } = buildAnalysisUpdates(paper, aiData);
        await updatePaper(paper.id, updates);
        successCount++;
      } catch (err: unknown) {
        failCount++;
        toast({
          title: `Failed: ${paper.title?.slice(0, 50)}...`,
          description: err instanceof Error ? err.message : "Unknown error",
          variant: "destructive",
        });
      }

      // 3-second cooldown to avoid Gemini rate limits.
      // Reachable only when the missing-abstract `continue` above did NOT
      // fire, so missing-abstract skips do not consume cooldown time —
      // see hook JSDoc for the locked-in cooldown control flow.
      await sleep(3000);
    }

    setBulkAnalyzing(false);
    setBulkAnalyzeProgress({ current: 0, total: 0 });
    toast({
      title: "Bulk analysis complete",
      description: `${successCount} succeeded, ${failCount} failed out of ${papersToAnalyze.length} papers.`,
    });
  }, [papers, selectedPaperIds, updatePaper, queryClient, toast, sleep]);

  return {
    analyzingPaperId,
    bulkAnalyzing,
    bulkAnalyzeProgress,
    handleAnalyzePaper,
    handleBulkAnalyze,
  };
}
