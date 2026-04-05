import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { Paper, PaperWithTags, Project, Tag } from "@/types/database";
import { queryKeys } from "@/lib/queryKeys";
import { NormalizationConfig, RawPaperData } from "@/lib/normalizePaperData";
import { ServerFilterParams } from "./types";
import { useNormalizationWorker } from "@/hooks/useNormalizationWorker";
import { usePaperCacheHelpers } from "./usePaperCacheHelpers";

export function usePaperMutations(
  userId: string | undefined,
  papers: PaperWithTags[],
  projects: Project[],
  tags: Tag[],
  normalizationConfig: NormalizationConfig | undefined,
  serverFilterParams: ServerFilterParams,
) {
  const { snapshotCache, rollbackCache, cancelQueries, updatePapersCache, adjustCount, adjustFilteredCount, removeStaleListCaches, invalidateAndRefetch } = usePaperCacheHelpers(userId, serverFilterParams);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { normalize } = useNormalizationWorker();

  const addPaperManually = useCallback(
    async (paperData: {
      title: string;
      authors: string;
      year: string;
      journal: string;
      pmid: string;
      doi: string;
      abstract: string;
      keywords: string;
      driveUrl: string;
      pubmedUrl?: string;
    }, options?: { targetProjectIds?: string[]; targetTagIds?: string[] }) => {
      if (!userId) return;

      const authorsArray = paperData.authors.split(",").map((a) => a.trim()).filter((a) => a.length > 0);
      const keywordsArray = paperData.keywords.split(",").map((k) => k.trim()).filter((k) => k.length > 0);
      const yearNum = paperData.year ? parseInt(paperData.year) : null;
      if (yearNum !== null && (isNaN(yearNum) || yearNum < 1800 || yearNum > new Date().getFullYear() + 1)) {
        toast({ title: "Invalid year", description: `Year must be between 1800 and ${new Date().getFullYear() + 1}.`, variant: "destructive" });
        return;
      }

      const manualTitle = paperData.title.trim();
      const manualPmid = paperData.pmid.trim();
      if (manualPmid && !/^\d+$/.test(manualPmid)) {
        toast({ title: "Invalid PMID", description: "PMID must be a number (e.g., 12345678).", variant: "destructive" });
        return;
      }
      const manualDoi = paperData.doi.trim();
      const isDuplicate = papers.some((existing) => {
        if (manualPmid && existing.pmid && manualPmid === existing.pmid) return true;
        if (manualDoi && existing.doi && manualDoi.toLowerCase() === existing.doi.toLowerCase()) return true;
        if (manualTitle && existing.title && manualTitle.toLowerCase() === existing.title.toLowerCase()) return true;
        return false;
      });

      if (isDuplicate) {
        toast({ title: "Duplicate paper", description: `"${manualTitle}" already exists in the index.`, variant: "destructive" });
        return;
      }

      const rawPaper: RawPaperData = {
        title: manualTitle,
        authors: authorsArray,
        year: yearNum,
        journal: paperData.journal.trim() || null,
        pmid: manualPmid || null,
        doi: manualDoi || null,
        abstract: paperData.abstract.trim() || null,
        keywords: keywordsArray,
        mesh_terms: [],
        substances: [],
        study_type: null,
        pubmed_url: paperData.pubmedUrl?.trim() || (manualPmid ? `https://pubmed.ncbi.nlm.nih.gov/${manualPmid}/` : null),
        journal_url: null,
        drive_url: paperData.driveUrl.trim() || null,
      };

      const [normalized] = normalizationConfig
        ? await normalize([rawPaper], normalizationConfig)
        : [rawPaper];

      const insertData = { user_id: userId, ...normalized, raw_study_type: null, raw_keywords: rawPaper.keywords || [] };

      const { data: insertedPaper, error } = await supabase.from("papers").insert(insertData).select().single();

      if (error) {
        if (error.code === "23505") {
          toast({ title: "Duplicate paper", description: `"${manualTitle}" already exists (duplicate PMID or DOI).`, variant: "destructive" });
        } else {
          toast({ title: "Error adding paper", description: error.message, variant: "destructive" });
        }
        return;
      }

      const paperId = (insertedPaper as Paper).id;

      // Assign project/tags if specified
      if (options?.targetProjectIds && options.targetProjectIds.length > 0) {
        await supabase.rpc("set_paper_projects", { p_paper_id: paperId, p_project_ids: options.targetProjectIds });
      }
      if (options?.targetTagIds && options.targetTagIds.length > 0) {
        await supabase.rpc("set_paper_tags", { p_paper_id: paperId, p_tag_ids: options.targetTagIds });
      }

      // No optimistic insert — new paper may not match active server filter.
      // Invalidate to refetch with current filters.
      invalidateAndRefetch();
      toast({ title: "Paper added manually" });
    },
    [userId, papers, projects, tags, normalizationConfig, normalize, invalidateAndRefetch, queryClient, toast],
  );

  const updatePaper = useCallback(
    async (
      paperId: string,
      updates: Partial<Paper> & { tagIds?: string[]; projectIds?: string[] },
    ) => {
      if (!userId) return;
      const { tagIds, projectIds, ...paperUpdates } = updates;

      await cancelQueries();
      const snapshot = snapshotCache();

      // Optimistic: apply field changes immediately (paper is already in the visible list)
      updatePapersCache((allPapers) =>
        allPapers.map((p) => {
          if (p.id !== paperId) return p;
          const updatedTags = tagIds ? tags.filter((t) => tagIds.includes(t.id)) : p.tags;
          const updatedProjects = projectIds !== undefined ? projects.filter((pr) => projectIds.includes(pr.id)) : p.projects;
          return { ...p, ...paperUpdates, tags: updatedTags, projects: updatedProjects };
        }),
      );

      // Persist to DB
      if (Object.keys(paperUpdates).length > 0) {
        const { error } = await supabase.from("papers").update(paperUpdates).eq("id", paperId);
        if (error) {
          rollbackCache(snapshot);
          toast({ title: "Error updating paper", description: error.message, variant: "destructive" });
          return;
        }
      }

      if (tagIds !== undefined) {
        const { error: tagError } = await supabase.rpc("set_paper_tags", { p_paper_id: paperId, p_tag_ids: tagIds });
        if (tagError) {
          rollbackCache(snapshot);
          toast({ title: "Error updating tags", description: tagError.message, variant: "destructive" });
          return;
        }
      }

      if (projectIds !== undefined) {
        const { error: projError } = await supabase.rpc("set_paper_projects", { p_paper_id: paperId, p_project_ids: projectIds });
        if (projError) {
          rollbackCache(snapshot);
          toast({ title: "Error updating projects", description: projError.message, variant: "destructive" });
          return;
        }
      }

      // Post-confirm: invalidate to fix any filter membership changes
      // (e.g., year/study_type edit may take paper out of active filter)
      removeStaleListCaches();
      if (tagIds !== undefined || projectIds !== undefined) {
        // Junction membership changed — invalidate junction caches
        queryClient.invalidateQueries({ queryKey: ["junction"] });
      }
      // Invalidate the active papers list so it refetches with correct membership
      queryClient.invalidateQueries({ queryKey: queryKeys.papers.all(userId) });

      toast({ title: "Paper updated" });
    },
    [userId, tags, projects, cancelQueries, snapshotCache, updatePapersCache, rollbackCache, removeStaleListCaches, queryClient, toast],
  );

  const deletePaper = useCallback(
    async (paperId: string) => {
      if (!userId) return;

      await cancelQueries();
      const snapshot = snapshotCache();

      // 1. Query attachment paths BEFORE deletion (CASCADE will remove rows)
      const { data: attachments } = await supabase
        .from("paper_attachments")
        .select("file_path")
        .eq("paper_id", paperId);
      const storagePaths = (attachments || []).map((a) => a.file_path);

      // Optimistic: remove paper and decrement counts immediately (always safe)
      updatePapersCache((old) => old.filter((p) => p.id !== paperId));
      adjustCount(-1);
      adjustFilteredCount(-1);

      // 2. Delete from DB
      const { error } = await supabase.from("papers").delete().eq("id", paperId);
      if (error) {
        rollbackCache(snapshot);
        toast({ title: "Error deleting paper", description: error.message, variant: "destructive" });
        return;
      }

      // 3. Best-effort storage cleanup (only after successful DB deletion)
      if (storagePaths.length > 0) {
        try {
          await supabase.storage.from("attachments").remove(storagePaths);
        } catch (e) {
          console.warn("Storage cleanup failed (non-critical):", e);
        }
      }

      removeStaleListCaches();
      toast({ title: "Paper deleted" });
    },
    [userId, cancelQueries, snapshotCache, updatePapersCache, adjustCount, adjustFilteredCount, rollbackCache, removeStaleListCaches, toast],
  );

  return { addPaperManually, updatePaper, deletePaper };
}
