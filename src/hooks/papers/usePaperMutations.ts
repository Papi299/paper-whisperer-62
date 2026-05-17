import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { Paper, PaperWithTags, Project, Tag } from "@/types/database";
import { queryKeys } from "@/lib/queryKeys";
import { NormalizationConfig, RawPaperData } from "@/lib/normalizePaperData";
import { ServerFilterParams, ServerSortParams } from "./types";
import { useNormalizationWorker } from "@/hooks/useNormalizationWorker";
import { usePaperCacheHelpers } from "./usePaperCacheHelpers";

export function usePaperMutations(
  userId: string | undefined,
  papers: PaperWithTags[],
  projects: Project[],
  tags: Tag[],
  normalizationConfig: NormalizationConfig | undefined,
  serverFilterParams: ServerFilterParams,
  serverSortParams: ServerSortParams,
) {
  const { snapshotCache, rollbackCache, cancelQueries, updatePapersCache, adjustCount, adjustFilteredCount, removeStaleListCaches, invalidateAndRefetch } = usePaperCacheHelpers(userId, serverFilterParams, serverSortParams);
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
    }, options?: { targetProjectIds?: string[]; targetTagIds?: string[] }): Promise<boolean> => {
      if (!userId) return false;

      const authorsArray = paperData.authors.split(",").map((a) => a.trim()).filter((a) => a.length > 0);
      const keywordsArray = paperData.keywords.split(",").map((k) => k.trim()).filter((k) => k.length > 0);
      const yearNum = paperData.year ? parseInt(paperData.year) : null;
      if (yearNum !== null && (isNaN(yearNum) || yearNum < 1800 || yearNum > new Date().getFullYear() + 1)) {
        toast({ title: "Invalid year", description: `Year must be between 1800 and ${new Date().getFullYear() + 1}.`, variant: "destructive" });
        return false;
      }

      const manualTitle = paperData.title.trim();
      const manualPmid = paperData.pmid.trim();
      if (manualPmid && !/^\d+$/.test(manualPmid)) {
        toast({ title: "Invalid PMID", description: "PMID must be a number (e.g., 12345678).", variant: "destructive" });
        return false;
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
        return false;
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
        return false;
      }

      const paperId = (insertedPaper as Paper).id;

      // Assign project/tags if specified. Failures here are NOT treated as a
      // hard rollback — the paper row already exists and removing it would
      // surprise the user. Instead, we mirror the existing bulk-import
      // pattern in `useBulkMutations.ts` (PR for "Bulk import assignment-
      // failure visibility"): capture each RPC's `{ error }`, push a short
      // human-readable label into `assignmentWarnings`, and surface a single
      // destructive toast at the end ("Paper added with warnings") with a
      // concise description that names which assignment(s) failed. The
      // function still returns `true` on this partial-success path because
      // the paper IS created and the dialog should close — the destructive
      // toast plus the missing chips in the row are the user-visible signal
      // that manual reassignment is needed.
      const assignmentWarnings: string[] = [];

      if (options?.targetProjectIds && options.targetProjectIds.length > 0) {
        const { error: projError } = await supabase.rpc("set_paper_projects", {
          p_paper_id: paperId,
          p_project_ids: options.targetProjectIds,
        });
        if (projError) {
          assignmentWarnings.push("project assignment failed");
        }
      }
      if (options?.targetTagIds && options.targetTagIds.length > 0) {
        const { error: tagError } = await supabase.rpc("set_paper_tags", {
          p_paper_id: paperId,
          p_tag_ids: options.targetTagIds,
        });
        if (tagError) {
          assignmentWarnings.push("tag assignment failed");
        }
      }

      // No optimistic insert — new paper may not match active server filter.
      // Invalidate to refetch with current filters. Always invalidate so the
      // newly-inserted row appears even when assignment(s) failed; without
      // this, a partial-success would leave the user looking at a stale list
      // and unable to see the paper that was actually created.
      invalidateAndRefetch();

      if (assignmentWarnings.length > 0) {
        toast({
          title: "Paper added with warnings",
          description: `The paper was added, but ${assignmentWarnings.join(" and ")} — you may need to assign the project/tag manually.`,
          variant: "destructive",
        });
      } else {
        toast({ title: "Paper added manually" });
      }
      return true;
    },
    [userId, papers, projects, tags, normalizationConfig, normalize, invalidateAndRefetch, queryClient, toast],
  );

  /**
   * Update an existing paper's fields, tags, and/or project assignments.
   *
   * Returns `true` only after every requested write — the `papers` row update
   * (when there are field changes), the `set_paper_tags` RPC (when `tagIds`
   * is provided), and the `set_paper_projects` RPC (when `projectIds` is
   * provided) — has succeeded. Returns `false` if `userId` is missing or any
   * of those writes fails. Existing rollback + destructive-toast behavior on
   * each handled failure path is preserved verbatim; only the return type
   * changed.
   *
   * Callers that need to keep an Edit dialog open on failure (notably
   * `EditPaperDialog` via the Dashboard `handleSavePaper` wrapper) should
   * branch on this boolean — close only when it is `true`. Callers that do
   * not care about success/failure (e.g. AI analysis flows) may ignore the
   * returned value; their error surface is unchanged.
   */
  const updatePaper = useCallback(
    async (
      paperId: string,
      updates: Partial<Paper> & { tagIds?: string[]; projectIds?: string[] },
    ): Promise<boolean> => {
      if (!userId) return false;
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
          return false;
        }
      }

      if (tagIds !== undefined) {
        const { error: tagError } = await supabase.rpc("set_paper_tags", { p_paper_id: paperId, p_tag_ids: tagIds });
        if (tagError) {
          rollbackCache(snapshot);
          toast({ title: "Error updating tags", description: tagError.message, variant: "destructive" });
          return false;
        }
      }

      if (projectIds !== undefined) {
        const { error: projError } = await supabase.rpc("set_paper_projects", { p_paper_id: paperId, p_project_ids: projectIds });
        if (projError) {
          rollbackCache(snapshot);
          toast({ title: "Error updating projects", description: projError.message, variant: "destructive" });
          return false;
        }
      }

      // If abstract was updated, invalidate its on-demand cache entry
      if ('abstract' in paperUpdates) {
        queryClient.invalidateQueries({ queryKey: queryKeys.papers.abstract(paperId) });
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
      return true;
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
