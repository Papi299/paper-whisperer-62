import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { fetchAbstract, fetchAbstractsBatch } from "@/hooks/useAbstract";
import { useToast } from "@/hooks/use-toast";
import { buildAnalysisUpdates } from "@/lib/studyTypeUtils";
import { parseAnalyzeError, formatQuotaExceededMessage } from "@/lib/analyzeError";
import type { QuotaExceededInfo } from "@/lib/analyzeError";
import { queryKeys } from "@/lib/queryKeys";
import type { AiQuotaStatus } from "@/hooks/useAiQuota";
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
 * **Quota experience (PFA-C01).** The server (`analyze-paper` +
 * `consume_ai_quota`) is the authoritative enforcement boundary and returns a
 * structured **HTTP 402** when the quota is exhausted. This hook:
 *   - parses that 402 (via `parseAnalyzeError`) and shows a specific,
 *     actionable message instead of the generic non-2xx string — with **no**
 *     upgrade/paywall language;
 *   - stops a bulk run the moment the server reports quota exhaustion; the
 *     quota-denied paper counts as failed and the papers after it are reported
 *     as unattempted, so every selected paper stays accounted for
 *     (successCount + failCount + unattempted === total). The run emits
 *     exactly ONE quota notification (never one per remaining paper);
 *   - optionally intercepts a click **before** invoking when the read-only
 *     quota status (`quotaStatus`) is known to be zero — convenience only;
 *   - keeps the indicator fresh by invalidating the quota-status query: the
 *     single-paper path invalidates only when the Edge Function was actually
 *     invoked (a pre-invoke failure such as an abstract-fetch rejection does
 *     not), and the bulk path invalidates once after the whole run completes.
 *     A completed attempt may have consumed a unit (success) or
 *     consumed-then-refunded (upstream provider failure).
 * The client `quotaStatus.remaining` is advisory and may be stale; it is
 * NEVER used as the enforcement boundary — the server 402 is authoritative.
 *
 * **Cooldown control flow (locked-in current behavior):** the `await sleep`
 * runs after success and after caught **non-terminal** (non-quota) per-paper
 * failures, but NOT after missing-abstract skips (the bulk loop's
 * `if (!abstract) { failCount++; continue; }` jumps to the next iteration
 * BEFORE the cooldown line) and NOT after a terminal quota-exhausted response
 * (the loop `break`s before the cooldown). Do not relocate `sleep`.
 */

const DEFAULT_SLEEP = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface UsePaperAnalysisActionsArgs {
  papers: PaperWithTags[];
  selectedPaperIds: Set<string>;
  /**
   * Authenticated user id (from `useAuth().user?.id`). Threaded into the
   * abstract-fetch helpers (`fetchAbstract` / `fetchAbstractsBatch`) so
   * the underlying Supabase queries carry an explicit `.eq("user_id",
   * userId)` predicate. Defense-in-depth on top of the `papers` table's
   * RLS — same S2 client-side hardening pattern PRs #133 and #134 used
   * for mutations.
   *
   * Accepts `null | undefined` because `useAuth()` can yield `user ===
   * null` on an intermediate render during sign-out / sign-in transitions
   * (the post-PR-#135 hotfix). Both handlers short-circuit with a no-op
   * (single) or destructive toast (bulk) when `userId` is falsy — they
   * MUST NOT call `fetchAbstract`, `fetchAbstractsBatch`, or the
   * `analyze-paper` Edge Function with a missing user id.
   */
  userId: string | null | undefined;
  /**
   * From `usePapers().updatePaper`. Returns `true` on full success, `false`
   * on any handled failure path (the mutation already shows a destructive
   * toast and rolls back optimistic state). This hook does not branch on
   * the boolean — its only consumer that cares is `EditPaperDialog`, which
   * keeps its dialog open on `false`. The type is kept aligned so the real
   * mutation drops in without a cast.
   */
  updatePaper: (
    paperId: string,
    updates: Partial<Paper> & { tagIds?: string[]; projectIds?: string[] },
  ) => Promise<boolean>;
  /**
   * Read-only AI quota status (from `useAiQuota`). Optional and advisory:
   *   - `undefined` / `null` → unknown (loading or failed) → NEVER block; the
   *     server stays authoritative.
   *   - `remaining <= 0` → known-zero → the handlers intercept the click and
   *     show the quota message instead of making a doomed request.
   */
  quotaStatus?: AiQuotaStatus | null;
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
  userId,
  updatePaper,
  quotaStatus,
  sleep = DEFAULT_SLEEP,
}: UsePaperAnalysisActionsArgs): UsePaperAnalysisActionsResult {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [analyzingPaperId, setAnalyzingPaperId] = useState<string | null>(null);
  const [bulkAnalyzing, setBulkAnalyzing] = useState(false);
  const [bulkAnalyzeProgress, setBulkAnalyzeProgress] = useState({ current: 0, total: 0 });

  /**
   * true only when we positively know the user has zero remaining analyses.
   * An AI-quota-exempt internal user is NEVER known-zero: their commercial
   * `remaining` can read 0 (usage past the nominal cap) while the server still
   * allows every analysis, so exempt users must skip the intercept and let the
   * server respond.
   */
  const isKnownZeroQuota = !!quotaStatus && !quotaStatus.isExempt && quotaStatus.remaining <= 0;

  /** Refresh the quota indicator after any server attempt (consume/refund). */
  const invalidateQuota = useCallback(() => {
    if (!userId) return;
    queryClient.invalidateQueries({ queryKey: queryKeys.aiQuota.status(userId) });
  }, [queryClient, userId]);

  /** Consistent, non-commercial quota-exhausted toast. */
  const toastQuotaExhausted = useCallback(
    (info: { periodType: string | null; used: number; quota: number; resetAt: string | null }) => {
      toast({
        title: "AI analyses used up",
        description: formatQuotaExceededMessage(info),
        variant: "destructive",
      });
    },
    [toast],
  );

  const handleAnalyzePaper = useCallback(async (paper: PaperWithTags) => {
    if (!paper.has_abstract) return;
    // Hotfix guard: skip silently when auth context is mid-transition and
    // `userId` is null/undefined. Mirrors the no-op behavior of the
    // missing-abstract early return above — no fetch, no Edge Function
    // invoke, no toast spam. The button is gated by `has_abstract` in
    // the UI, so a legitimate user click can never reach this branch.
    if (!userId) return;

    // Known-zero convenience intercept: if the read-only quota status says
    // the user has none left, surface the message without a doomed request.
    // When status is unknown (loading/failed) this is false → we proceed and
    // let the server's 402 be authoritative.
    if (isKnownZeroQuota && quotaStatus) {
      toastQuotaExhausted(quotaStatus);
      return;
    }

    setAnalyzingPaperId(paper.id);
    // Track whether an Edge Function attempt actually happened. Only then may a
    // consume/refund have occurred, so only then do we sync the quota query.
    // A failure BEFORE invocation (e.g. `fetchAbstract` rejecting) must not
    // trigger an invalidation, because the server was never called.
    let attempted = false;
    try {
      // Fetch abstract on demand (uses cache if already loaded).
      // `userId` is threaded for defense-in-depth ownership scoping on
      // the underlying Supabase query — see useAbstract.ts JSDoc.
      const abstract = await fetchAbstract(paper.id, userId, queryClient);
      if (!abstract) {
        toast({ title: "No abstract", description: "Paper has no abstract to analyze.", variant: "destructive" });
        return;
      }

      attempted = true;
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
      // Single failure boundary around the WHOLE operation (abstract fetch,
      // invoke, merge, update). `parseAnalyzeError` distinguishes a structured
      // quota-exhausted 402 from every other failure — including a
      // `fetchAbstract` rejection, which falls through to the generic branch
      // with its original message preserved. On quota exhaustion the paper is
      // NOT updated (the throw precedes `updatePaper`).
      const parsed = await parseAnalyzeError(err);
      if (parsed.kind === "quota_exceeded") {
        toastQuotaExhausted(parsed.info);
      } else if (parsed.kind === "provider_failure") {
        // Upstream provider failure (rate limit / unavailable / malformed) — NOT
        // a plan wall. Show the neutral, non-operational server message; no
        // Google/project detail reaches the user.
        toast({
          title: "AI analysis unavailable",
          description: parsed.message,
          variant: "destructive",
        });
      } else {
        toast({
          title: "AI Analysis failed",
          description: parsed.message,
          variant: "destructive",
        });
      }
    } finally {
      // Sync the indicator only when the server was actually called: it may
      // have consumed a unit (success) or consumed-then-refunded (upstream
      // provider failure). Skip when we failed before invoking.
      if (attempted) invalidateQuota();
      setAnalyzingPaperId(null);
    }
  }, [updatePaper, queryClient, toast, userId, isKnownZeroQuota, quotaStatus, toastQuotaExhausted, invalidateQuota]);

  const handleBulkAnalyze = useCallback(async () => {
    // Hotfix guard: bail early when auth context is mid-transition and
    // `userId` is null/undefined. Surfaces a destructive toast (the bulk
    // button is more visible than the per-row analyze button, so a silent
    // no-op would be confusing). Skips abstract batch-fetch and Edge
    // Function invoke entirely.
    if (!userId) {
      toast({ title: "Not signed in", description: "Please wait for sign-in to complete, then try again.", variant: "destructive" });
      return;
    }
    const selectedPapers = papers.filter(p => selectedPaperIds.has(p.id));
    const papersToAnalyze = selectedPapers.filter(p => p.has_abstract); // skip papers without abstract
    if (papersToAnalyze.length === 0) {
      toast({ title: "No papers to analyze", description: "Selected papers have no abstracts.", variant: "destructive" });
      return;
    }

    // Known-zero convenience intercept before any batch-fetch / invoke.
    if (isKnownZeroQuota && quotaStatus) {
      toastQuotaExhausted(quotaStatus);
      return;
    }

    setBulkAnalyzing(true);
    setBulkAnalyzeProgress({ current: 0, total: papersToAnalyze.length });
    let successCount = 0;
    let failCount = 0;
    let unattempted = 0;
    let quotaExhausted = false;
    // Parsed authoritative details from the terminal 402, used to build the
    // ONE quota notification after the loop (never toasted inside the loop).
    let quotaInfo: QuotaExceededInfo | null = null;

    // Batch-fetch all abstracts in one query (avoids N+1).
    // `userId` is threaded for defense-in-depth ownership scoping on
    // the underlying Supabase query — see useAbstract.ts JSDoc.
    const abstractMap = await fetchAbstractsBatch(
      papersToAnalyze.map(p => p.id),
      userId,
      queryClient,
    );

    for (let i = 0; i < papersToAnalyze.length; i++) {
      const paper = papersToAnalyze[i];
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
        const parsed = await parseAnalyzeError(err);
        if (parsed.kind === "quota_exceeded") {
          // Terminal: the server enforced the quota wall. Stop making further
          // Edge Function calls; the remaining papers (after this one) are
          // UNATTEMPTED. This current paper WAS attempted and denied, so it is
          // counted as failed — every selected paper stays accounted for
          // (successCount + failCount + unattempted === papersToAnalyze.length).
          // No toast here: the single combined notification is emitted after
          // the loop. Break BEFORE the cooldown — no sleep.
          quotaExhausted = true;
          quotaInfo = parsed.info;
          failCount++;
          unattempted = papersToAnalyze.length - (i + 1);
          break;
        }
        // Non-terminal per-paper failure: count, notify, and continue (with cooldown).
        failCount++;
        toast({
          title: `Failed: ${paper.title?.slice(0, 50)}...`,
          description: parsed.message,
          variant: "destructive",
        });
      }

      // 3-second cooldown to avoid Gemini rate limits.
      // Reachable only when the missing-abstract `continue` and the terminal
      // quota `break` above did NOT fire — see hook JSDoc for the locked-in
      // cooldown control flow.
      await sleep(3000);
    }

    setBulkAnalyzing(false);
    setBulkAnalyzeProgress({ current: 0, total: 0 });
    // Sync the indicator once after the run (consumption / refunds).
    invalidateQuota();

    if (quotaExhausted) {
      // EXACTLY ONE quota notification for the whole run: the authoritative
      // allowance/reset detail from the parsed 402 plus the run accounting.
      const allowance = quotaInfo ? `${formatQuotaExceededMessage(quotaInfo)} ` : "";
      toast({
        title: "AI analyses used up",
        description: `${allowance}This run: ${successCount} analyzed, ${failCount} failed, ${unattempted} not attempted.`,
        variant: "destructive",
      });
    } else {
      toast({
        title: "Bulk analysis complete",
        description: `${successCount} succeeded, ${failCount} failed out of ${papersToAnalyze.length} papers.`,
      });
    }
  }, [papers, selectedPaperIds, updatePaper, queryClient, toast, sleep, userId, isKnownZeroQuota, quotaStatus, toastQuotaExhausted, invalidateQuota]);

  return {
    analyzingPaperId,
    bulkAnalyzing,
    bulkAnalyzeProgress,
    handleAnalyzePaper,
    handleBulkAnalyze,
  };
}
