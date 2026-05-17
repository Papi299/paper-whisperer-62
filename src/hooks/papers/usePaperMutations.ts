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

      // Normalize the input DOI to match the form the DB stores (which in
      // turn matches the `idx_papers_user_doi_unique` partial index on
      // `lower(doi) WHERE doi IS NOT NULL`). Mirrors the DOI normalization
      // in `src/lib/normalizePaperData.ts` (strips `https://(dx.)?doi.org/`
      // / `doi:` prefix and lowercases). Keeping the rule inline rather
      // than importing keeps `addPaperManually`'s scope tight; if the two
      // ever drift the per-user unique index on `lower(doi)` is the
      // backstop and the post-insert `23505` branch still fires.
      const normalizedDoi = manualDoi
        ? manualDoi.replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:)/i, "").trim().toLowerCase()
        : "";

      // ── Server-side duplicate preflight ──────────────────────────────
      //
      // Replaces a previous client-side `papers.some(...)` check that
      // scanned only the currently *loaded* (paginated/filtered) papers
      // array. That check missed duplicates that were not on the visible
      // page — the user could re-add a paper they already owned and only
      // discover the collision via the post-insert `23505` toast. It also
      // hard-blocked on title equality, which **contradicts the standing
      // PMID/DOI-only product decision** in `docs/start-here.md`
      // (Duplicate detection policy). Title-based blocking is now gone.
      //
      // We run up to two narrow queries scoped to the current user via
      // RLS (and an explicit `eq("user_id", userId)` for clarity). Each
      // is `.limit(1).maybeSingle()` so the per-user partial unique
      // indexes (`idx_papers_user_pmid_unique`, `idx_papers_user_doi_unique`)
      // make the result deterministic and `null` is a non-error.
      // Sequential, not parallel: PMID first, bail on hit. Keeps mocks
      // simple, avoids PostgREST `.or()` value-escaping edge cases on
      // DOIs containing reserved chars, and saves the second RTT when
      // PMID already matched. The preflight is a UX improvement only;
      // DB unique-constraint handling on insert (the `23505` branch
      // below) remains the data-integrity backstop for races.
      const preflightFailureToast = () => {
        toast({
          title: "Could not check for duplicates",
          description: "Please check your connection and try again.",
          variant: "destructive",
        });
      };
      const duplicateToast = () => {
        toast({
          title: "Duplicate paper",
          description: `"${manualTitle}" already exists (duplicate PMID or DOI).`,
          variant: "destructive",
        });
      };

      if (manualPmid) {
        const { data: pmidHit, error: pmidErr } = await supabase
          .from("papers")
          .select("id")
          .eq("user_id", userId)
          .eq("pmid", manualPmid)
          .limit(1)
          .maybeSingle();
        if (pmidErr) {
          preflightFailureToast();
          return false;
        }
        if (pmidHit) {
          duplicateToast();
          return false;
        }
      }

      if (normalizedDoi) {
        const { data: doiHit, error: doiErr } = await supabase
          .from("papers")
          .select("id")
          .eq("user_id", userId)
          .eq("doi", normalizedDoi)
          .limit(1)
          .maybeSingle();
        if (doiErr) {
          preflightFailureToast();
          return false;
        }
        if (doiHit) {
          duplicateToast();
          return false;
        }
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
    // `papers` removed from deps: the previous client-side `papers.some(...)`
    // duplicate check has been replaced by a server-side preflight, so the
    // closure no longer reads the loaded papers array. `projects` / `tags` /
    // `queryClient` are pre-existing unused deps flagged by `react-hooks/
    // exhaustive-deps`; leaving them alone here keeps this PR strictly
    // focused on the duplicate-detection bug.
    [userId, projects, tags, normalizationConfig, normalize, invalidateAndRefetch, queryClient, toast],
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
