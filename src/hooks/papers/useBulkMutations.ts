import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/types";
import { useToast } from "@/hooks/use-toast";
import { Paper, PaperWithTags, Project, Tag, BulkInsertResult } from "@/types/database";
import { queryKeys } from "@/lib/queryKeys";
import { NormalizationConfig, RawPaperData, computeEnrichedKeywords } from "@/lib/normalizePaperData";
import { fetchAllPages } from "@/lib/fetchAllPages";
import { evaluateStudyType, StudyTypePoolEntry } from "@/lib/evaluateStudyType";
import { fetchPaperMetadata } from "@/lib/fetchPaperMetadataEdge";
import { getErrorMessage } from "@/lib/errorUtils";
import { processChunkedInsert } from "@/lib/chunkedInsert";
import { ServerFilterParams, ServerSortParams } from "./types";
import { useNormalizationWorker } from "@/hooks/useNormalizationWorker";
import { usePaperCacheHelpers } from "./usePaperCacheHelpers";

export function useBulkMutations(
  userId: string | undefined,
  papers: PaperWithTags[],
  projects: Project[],
  tags: Tag[],
  normalizationConfig: NormalizationConfig | undefined,
  serverFilterParams: ServerFilterParams,
  serverSortParams: ServerSortParams,
) {
  const { snapshotCache, rollbackCache, cancelQueries, updatePapersCache, adjustCount, adjustFilteredCount, removeStaleListCaches, invalidateAndRefetch, invalidateJunctionCaches } = usePaperCacheHelpers(userId, serverFilterParams, serverSortParams);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { normalize } = useNormalizationWorker();

  const addPapers = useCallback(
    async (identifiers: string[], driveUrl?: string) => {
      if (!userId) return;

      try {
        const fetchedPapers = await fetchPaperMetadata(identifiers);
        const successfulPapers: PaperWithTags[] = [];

        // Collect non-duplicate, successfully-fetched raw papers for batch normalization
        const rawPapersForNormalization: { raw: RawPaperData; result: typeof fetchedPapers[number] }[] = [];

        for (const result of fetchedPapers) {
          if (result.error) {
            toast({ title: "Could not fetch paper", description: `${result.identifier}: ${result.error}`, variant: "destructive" });
            continue;
          }

          const isDuplicate = papers.some((existing) => {
            if (result.pmid && existing.pmid && result.pmid === existing.pmid) return true;
            if (result.doi && existing.doi && result.doi.toLowerCase() === existing.doi.toLowerCase()) return true;
            if (result.title && existing.title && result.title.replace(/\.\s*$/, "").trim().toLowerCase() === existing.title.toLowerCase()) return true;
            return false;
          });

          if (isDuplicate) {
            toast({ title: "Duplicate paper", description: `"${result.title}" already exists in the index.`, variant: "destructive" });
            continue;
          }

          if (result.source === "crossref") {
            toast({ title: "Paper fetched via Crossref", description: `"${result.title}" — PubMed unavailable. Some metadata (MeSH terms, keywords) may be limited.` });
          }

          const combinedKeywords = [...(result.keywords || []), ...(result.mesh_terms || []), ...(result.substances || [])];

          rawPapersForNormalization.push({
            result,
            raw: {
              title: result.title,
              authors: result.authors || [],
              year: result.year,
              journal: result.journal,
              pmid: result.pmid,
              doi: result.doi,
              abstract: result.abstract,
              keywords: combinedKeywords,
              mesh_terms: result.mesh_terms || [],
              substances: result.substances || [],
              study_type: result.study_type || null,
              pubmed_url: result.pubmed_url,
              journal_url: result.journal_url,
              drive_url: driveUrl || null,
            },
          });
        }

        // Batch normalize via Web Worker (falls back to main thread for small batches)
        const normalizedPapers = normalizationConfig
          ? await normalize(rawPapersForNormalization.map((r) => r.raw), normalizationConfig)
          : rawPapersForNormalization.map((r) => r.raw);

        // Insert each normalized paper
        for (let i = 0; i < normalizedPapers.length; i++) {
          const normalized = normalizedPapers[i];
          const { result } = rawPapersForNormalization[i];

          const paperData = {
            user_id: userId,
            ...normalized,
            raw_study_type: result.study_type || null,
            raw_keywords: rawPapersForNormalization[i].raw.keywords || [],
            mesh_terms: normalized.mesh_terms || [],
            substances: normalized.substances || [],
          };

          const { data: insertedPaper, error: insertError } = await supabase
            .from("papers")
            .insert(paperData)
            .select()
            .single();

          if (insertError) {
            if (insertError.code === "23505") {
              toast({ title: "Duplicate paper", description: `"${result.title}" already exists (duplicate PMID or DOI).`, variant: "destructive" });
            } else {
              toast({ title: "Error saving paper", description: insertError.message, variant: "destructive" });
            }
            continue;
          }

          successfulPapers.push({ ...(insertedPaper as Paper), tags: [], projects: [] });
        }

        if (successfulPapers.length > 0) {
          // No optimistic insert — new papers may not match active filter.
          // Invalidate to refetch with current filters.
          invalidateAndRefetch();
          toast({ title: "Papers added", description: `Successfully added ${successfulPapers.length} paper(s).` });
        }
      } catch (error: unknown) {
        toast({ title: "Error fetching papers", description: getErrorMessage(error), variant: "destructive" });
      }
    },
    [userId, papers, normalizationConfig, normalize, invalidateAndRefetch, queryClient, toast],
  );

  const bulkImportPapers = useCallback(
    async (
      identifiers: string[],
      onProgress?: (current: number, total: number, addedIds: string[], skippedIds: string[], failedIds: string[]) => void,
      options?: { targetProjectIds?: string[]; targetTagIds?: string[] }
    ) => {
      if (!userId || identifiers.length === 0) return;

      const addedIds: string[] = [];
      const skippedIds: string[] = [];
      const failedIds: string[] = [];
      const total = identifiers.length;

      // Phase 1: Batch fetch all metadata via edge function
      onProgress?.(0, total, addedIds, skippedIds, failedIds);
      const allMetadata = await fetchPaperMetadata(identifiers);

      // Separate successful fetches from failures
      const successfulResults: { identifier: string; meta: typeof allMetadata[0] }[] = [];
      for (const meta of allMetadata) {
        if (meta.error || !meta.title) {
          failedIds.push(meta.identifier);
        } else {
          successfulResults.push({ identifier: meta.identifier, meta });
        }
      }

      // Report after fetch phase
      onProgress?.(Math.ceil(total * 0.6), total, addedIds, skippedIds, failedIds);

      if (successfulResults.length === 0) {
        onProgress?.(total, total, addedIds, skippedIds, failedIds);
        toast({
          title: "Bulk import complete",
          description: `0 added, 0 skipped (duplicates), ${failedIds.length} failed.`,
        });
        return;
      }

      // Phase 2: Batch normalize all successful results
      const rawPapers: RawPaperData[] = successfulResults.map(({ meta }) => ({
        title: meta.title!,
        authors: meta.authors || [],
        year: meta.year ?? null,
        journal: meta.journal ?? null,
        pmid: meta.pmid ?? null,
        doi: meta.doi ?? null,
        abstract: meta.abstract ?? null,
        keywords: meta.keywords || [],
        mesh_terms: meta.mesh_terms || [],
        substances: meta.substances || [],
        study_type: meta.study_type || null,
        pubmed_url: meta.pubmed_url ?? null,
        journal_url: meta.journal_url ?? null,
        drive_url: null,
      }));

      const normalizedPapers = normalizationConfig
        ? await normalize(rawPapers, normalizationConfig)
        : rawPapers;

      // Phase 3: Build payload and call safe_bulk_insert_papers RPC
      const insertPayload = normalizedPapers.map((normalized, i) => ({
        title: normalized.title,
        authors: normalized.authors || [],
        year: normalized.year ?? null,
        journal: normalized.journal ?? null,
        pmid: normalized.pmid ?? null,
        doi: normalized.doi ?? null,
        abstract: normalized.abstract ?? null,
        study_type: normalized.study_type ?? null,
        raw_study_type: successfulResults[i].meta.study_type || null,
        raw_keywords: successfulResults[i].meta.keywords || [],
        statistical_methods: null,
        keywords: normalized.keywords || [],
        mesh_terms: normalized.mesh_terms || [],
        substances: normalized.substances || [],
        pubmed_url: normalized.pubmed_url ?? null,
        journal_url: normalized.journal_url ?? null,
        drive_url: normalized.drive_url ?? null,
      }));

      // Sequential batching to avoid connection limits
      const CHUNK_SIZE = 50;
      const { results: allRpcResults, lastError } = await processChunkedInsert(
        insertPayload,
        (chunk) => supabase.rpc("safe_bulk_insert_papers", {
          p_user_id: userId,
          p_papers: chunk as unknown as Json,
        }),
        { chunkSize: CHUNK_SIZE },
      );

      if (allRpcResults.length === 0) {
        for (const { identifier } of successfulResults) {
          failedIds.push(identifier);
        }
        onProgress?.(total, total, addedIds, skippedIds, failedIds);
        toast({
          title: "Bulk import failed",
          description: lastError || "Unknown error",
          variant: "destructive",
        });
        return;
      }

      // Phase 4: Process RPC results
      const results = allRpcResults;
      const insertedPaperIds: string[] = [];

      for (const row of results) {
        const { identifier } = successfulResults[row.index];
        if (row.status === "inserted" && row.id) {
          addedIds.push(identifier);
          insertedPaperIds.push(row.id);
        } else if (row.status === "duplicate") {
          skippedIds.push(identifier);
        } else {
          failedIds.push(identifier);
        }
      }

      onProgress?.(total, total, addedIds, skippedIds, failedIds);

      // Phase 5: Assign project/tags to newly inserted papers
      const assignmentWarnings: string[] = [];

      if (insertedPaperIds.length > 0) {
        const projectIds = options?.targetProjectIds;
        const tagIds = options?.targetTagIds;

        if (projectIds && projectIds.length > 0) {
          const { error: projError } = await supabase.rpc("bulk_set_paper_projects", {
            p_paper_ids: insertedPaperIds,
            p_project_ids: projectIds,
          });
          if (projError) {
            assignmentWarnings.push("project assignment failed");
          }
        }

        if (tagIds && tagIds.length > 0) {
          const { error: tagError } = await supabase.rpc("bulk_set_paper_tags", {
            p_paper_ids: insertedPaperIds,
            p_tag_ids: tagIds,
          });
          if (tagError) {
            assignmentWarnings.push("tag assignment failed");
          }
        }

        // No optimistic insert — invalidate to refetch with current filters
        invalidateAndRefetch();
      }

      const summary = `${addedIds.length} added, ${skippedIds.length} skipped (duplicates), ${failedIds.length} failed.`;

      if (assignmentWarnings.length > 0) {
        toast({
          title: "Bulk import complete with warnings",
          description: `${summary} Note: ${assignmentWarnings.join(" and ")} — papers were imported but may need manual project/tag assignment.`,
          variant: "destructive",
        });
      } else {
        toast({
          title: "Bulk import complete",
          description: summary,
        });
      }
    },
    [userId, projects, tags, normalizationConfig, normalize, toast, invalidateAndRefetch, queryClient],
  );

  /**
   * Import pre-parsed papers (from .bib, .ris, .csv file parsers).
   * Skips the metadata fetch phase — goes directly to normalize -> RPC -> cache.
   */
  const bulkImportFromParsedData = useCallback(
    async (
      parsedPapers: RawPaperData[],
      onProgress?: (current: number, total: number, added: number, skipped: number, failed: number) => void,
      options?: { targetProjectIds?: string[]; targetTagIds?: string[] }
    ) => {
      if (!userId || parsedPapers.length === 0) return;

      const total = parsedPapers.length;
      let addedCount = 0;
      let skippedCount = 0;
      let failedCount = 0;

      onProgress?.(0, total, 0, 0, 0);

      // Phase 1: Normalize via Web Worker
      const normalizedPapers = normalizationConfig
        ? await normalize(parsedPapers, normalizationConfig)
        : parsedPapers.map((p) => ({
            ...p,
            mesh_terms: p.mesh_terms || [],
            substances: p.substances || [],
          }));

      onProgress?.(Math.ceil(total * 0.3), total, 0, 0, 0);

      // Phase 2: Build payload and call safe_bulk_insert_papers RPC
      const insertPayload = normalizedPapers.map((normalized, i) => ({
        title: normalized.title,
        authors: normalized.authors || [],
        year: normalized.year ?? null,
        journal: normalized.journal ?? null,
        pmid: normalized.pmid ?? null,
        doi: normalized.doi ?? null,
        abstract: normalized.abstract ?? null,
        study_type: normalized.study_type ?? null,
        raw_study_type: parsedPapers[i].study_type || null,
        raw_keywords: parsedPapers[i].keywords || [],
        statistical_methods: null,
        keywords: normalized.keywords || [],
        mesh_terms: normalized.mesh_terms || [],
        substances: normalized.substances || [],
        pubmed_url: normalized.pubmed_url ?? null,
        journal_url: normalized.journal_url ?? null,
        drive_url: normalized.drive_url ?? null,
      }));

      // Sequential batching to avoid connection limits
      const CHUNK_SIZE = 50;
      const { results: allRpcResults, lastError } = await processChunkedInsert(
        insertPayload,
        (chunk) => supabase.rpc("safe_bulk_insert_papers", {
          p_user_id: userId,
          p_papers: chunk as unknown as Json,
        }),
        { chunkSize: CHUNK_SIZE },
      );

      if (allRpcResults.length === 0) {
        onProgress?.(total, total, 0, 0, total);
        toast({
          title: "File import failed",
          description: lastError || "Unknown error",
          variant: "destructive",
        });
        return;
      }

      // Phase 3: Process RPC results
      const results = allRpcResults;
      const insertedPaperIds: string[] = [];

      for (const row of results) {
        if (row.status === "inserted" && row.id) {
          addedCount++;
          insertedPaperIds.push(row.id);
        } else if (row.status === "duplicate") {
          skippedCount++;
        } else {
          failedCount++;
        }
      }

      onProgress?.(total, total, addedCount, skippedCount, failedCount);

      // Phase 4: Assign project/tags to newly inserted papers
      const assignmentWarnings: string[] = [];

      if (insertedPaperIds.length > 0) {
        const projectIds = options?.targetProjectIds;
        const tagIds = options?.targetTagIds;

        if (projectIds && projectIds.length > 0) {
          const { error: projError } = await supabase.rpc("bulk_set_paper_projects", {
            p_paper_ids: insertedPaperIds,
            p_project_ids: projectIds,
          });
          if (projError) {
            assignmentWarnings.push("project assignment failed");
          }
        }

        if (tagIds && tagIds.length > 0) {
          const { error: tagError } = await supabase.rpc("bulk_set_paper_tags", {
            p_paper_ids: insertedPaperIds,
            p_tag_ids: tagIds,
          });
          if (tagError) {
            assignmentWarnings.push("tag assignment failed");
          }
        }

        // No optimistic insert — invalidate to refetch with current filters
        invalidateAndRefetch();
      }

      const summary = `${addedCount} added, ${skippedCount} skipped (duplicates), ${failedCount} failed.`;

      if (assignmentWarnings.length > 0) {
        toast({
          title: "File import complete with warnings",
          description: `${summary} Note: ${assignmentWarnings.join(" and ")} — papers were imported but may need manual project/tag assignment.`,
          variant: "destructive",
        });
      } else {
        toast({
          title: "File import complete",
          description: summary,
        });
      }
    },
    [userId, projects, tags, normalizationConfig, normalize, toast, invalidateAndRefetch, queryClient],
  );

  const bulkDeletePapers = useCallback(
    async (paperIds: string[]) => {
      if (!userId || paperIds.length === 0) return;

      await cancelQueries();
      const snapshot = snapshotCache();

      // 1. Query attachment paths BEFORE deletion (CASCADE will remove rows)
      const { data: attachments } = await supabase
        .from("paper_attachments")
        .select("file_path")
        .in("paper_id", paperIds);
      const storagePaths = (attachments || []).map((a) => a.file_path);

      // Optimistic: remove papers and adjust counts immediately (always safe)
      const idSet = new Set(paperIds);
      updatePapersCache((old) => old.filter((p) => !idSet.has(p.id)));
      adjustCount(-paperIds.length);
      adjustFilteredCount(-paperIds.length);

      // 2. Delete from DB
      const { error } = await supabase.from("papers").delete().in("id", paperIds);
      if (error) {
        rollbackCache(snapshot);
        toast({ title: "Error deleting papers", description: error.message, variant: "destructive" });
        return;
      }

      // 3. Best-effort storage cleanup (only after successful DB deletion)
      if (storagePaths.length > 0) {
        try {
          await supabase.storage.from("attachments").remove(storagePaths);
        } catch (e) {
          console.warn("Bulk storage cleanup failed (non-critical):", e);
        }
      }

      removeStaleListCaches();
      toast({ title: `Deleted ${paperIds.length} paper(s)` });
    },
    [userId, cancelQueries, snapshotCache, updatePapersCache, adjustCount, adjustFilteredCount, rollbackCache, removeStaleListCaches, toast],
  );

  const bulkSetProjects = useCallback(
    async (paperIds: string[], projectIds: string[]) => {
      if (!userId || paperIds.length === 0) return;

      await cancelQueries();
      const snapshot = snapshotCache();

      // Optimistic: assign projects immediately (papers are visible in list)
      const newProjects = projects.filter((p) => projectIds.includes(p.id));
      updatePapersCache((allPapers) =>
        allPapers.map((p) => (paperIds.includes(p.id) ? { ...p, projects: newProjects } : p)),
      );

      const { error } = await supabase.rpc("bulk_set_paper_projects", { p_paper_ids: paperIds, p_project_ids: projectIds });
      if (error) {
        rollbackCache(snapshot);
        toast({ title: "Error setting projects", description: getErrorMessage(error), variant: "destructive" });
        return;
      }

      // Post-confirm: invalidate junction caches + papers list (membership changed)
      removeStaleListCaches();
      invalidateJunctionCaches();
      queryClient.invalidateQueries({ queryKey: queryKeys.papers.all(userId) });

      toast({ title: `Updated projects for ${paperIds.length} paper(s)` });
    },
    [userId, projects, cancelQueries, snapshotCache, updatePapersCache, rollbackCache, removeStaleListCaches, invalidateJunctionCaches, queryClient, toast],
  );

  const bulkSetTags = useCallback(
    async (paperIds: string[], tagIds: string[]) => {
      if (!userId || paperIds.length === 0) return;

      await cancelQueries();
      const snapshot = snapshotCache();

      // Optimistic: assign tags immediately (papers are visible in list)
      const newTags = tags.filter((t) => tagIds.includes(t.id));
      updatePapersCache((allPapers) =>
        allPapers.map((p) => (paperIds.includes(p.id) ? { ...p, tags: newTags } : p)),
      );

      const { error } = await supabase.rpc("bulk_set_paper_tags", { p_paper_ids: paperIds, p_tag_ids: tagIds });
      if (error) {
        rollbackCache(snapshot);
        toast({ title: "Error setting tags", description: getErrorMessage(error), variant: "destructive" });
        return;
      }

      // Post-confirm: invalidate junction caches + papers list (membership changed)
      removeStaleListCaches();
      invalidateJunctionCaches();
      queryClient.invalidateQueries({ queryKey: queryKeys.papers.all(userId) });

      toast({ title: `Updated tags for ${paperIds.length} paper(s)` });
    },
    [userId, tags, cancelQueries, snapshotCache, updatePapersCache, rollbackCache, removeStaleListCaches, invalidateJunctionCaches, queryClient, toast],
  );

  /**
   * Re-evaluate study types for all papers against the given pool.
   * Updates cache immediately and persists changes to DB.
   */
  const reevaluateStudyTypes = useCallback(
    async (pool: StudyTypePoolEntry[]) => {
      if (!userId || papers.length === 0) return;

      // Fetch own data including abstract — the list cache no longer carries abstract
      const { data: freshPapers, error: fetchError } = await supabase
        .from("papers")
        .select("id, title, abstract, study_type, raw_study_type")
        .eq("user_id", userId);
      if (fetchError) throw fetchError;

      // Compute updates first — early return if nothing changed
      const updates: { id: string; newType: string }[] = [];

      for (const paper of (freshPapers || [])) {
        const rawFallback = paper.raw_study_type ?? paper.study_type;
        const newType = evaluateStudyType(paper.title, paper.abstract, rawFallback, pool);
        const current = (paper.study_type || "").trim();
        const evaluated = (newType || "").trim();
        if (current !== evaluated) {
          updates.push({ id: paper.id, newType: evaluated });
        }
      }

      if (updates.length === 0) return;

      // Snapshot + optimistic update + RPC
      await cancelQueries();
      const snapshot = snapshotCache();

      updatePapersCache((allPapers) =>
        allPapers.map((p) => {
          const upd = updates.find((u) => u.id === p.id);
          return upd ? { ...p, study_type: upd.newType || null } : p;
        }),
      );

      try {
        const payload = updates.map(({ id, newType }) => ({ id, study_type: newType || null }));
        const { error } = await supabase.rpc("bulk_update_study_types", { updates: payload });
        if (error) throw error;

        // Post-confirm: invalidate papers list (study_type may affect filter membership)
        removeStaleListCaches();
        queryClient.invalidateQueries({ queryKey: queryKeys.papers.all(userId) });

        toast({ title: "Study types updated", description: `Re-classified ${updates.length} paper(s) based on updated pool.` });
      } catch (err: unknown) {
        rollbackCache(snapshot);
        toast({ title: "Error saving study type updates", description: getErrorMessage(err), variant: "destructive" });
      }
    },
    [userId, papers, cancelQueries, snapshotCache, updatePapersCache, rollbackCache, removeStaleListCaches, queryClient, toast],
  );

  /**
   * Re-evaluate keywords for ALL user papers against the current normalization config.
   * Fetches full library via fetchAllPages (pagination-safe), recomputes enriched keywords
   * from raw_keywords + title + abstract, and batch-updates only changed papers.
   *
   * NOTE on raw_keywords provenance (migration 20260330010000):
   * Papers imported BEFORE 2026-03-30 had their raw_keywords backfilled as a copy of
   * the already-enriched `keywords` column (the original pre-enrichment values no longer
   * exist anywhere in the system). For these papers, reevaluation starts from the enriched
   * set rather than the true raw import values. Because enrichment is additive (adds terms
   * from title/abstract/pool, never removes), this produces a correct superset — the result
   * may include slightly more terms than a true-raw reevaluation would, but no terms are
   * lost. The original raw values are fundamentally unrecoverable: they were overwritten
   * in-place by the enrichment pipeline before the raw_keywords column existed. Papers
   * imported AFTER the migration have exact raw_keywords captured at import time.
   */
  const reevaluateKeywords = useCallback(
    async (config: NormalizationConfig) => {
      if (!userId) return;

      // 1. Fetch ALL papers (safe pagination via fetchAllPages)
      let allPapers: { id: string; raw_keywords: string[]; title: string; abstract: string | null; keywords: string[] }[];
      try {
        allPapers = await fetchAllPages(() =>
          supabase
            .from("papers")
            .select("id, raw_keywords, title, abstract, keywords")
            .eq("user_id", userId)
        );
      } catch (err) {
        toast({ title: "Error loading papers for keyword update", description: getErrorMessage(err), variant: "destructive" });
        return;
      }

      if (allPapers.length === 0) return;

      // 2. Compute enriched keywords, collect changes
      const updates: { id: string; keywords: string[] }[] = [];
      for (const paper of allPapers) {
        const newKeywords = computeEnrichedKeywords(
          paper.raw_keywords || [], paper.title, paper.abstract, config
        );
        const oldSet = new Set((paper.keywords || []).map(k => k.toLowerCase()));
        const newSet = new Set(newKeywords.map(k => k.toLowerCase()));
        if (oldSet.size !== newSet.size || ![...newSet].every(k => oldSet.has(k))) {
          updates.push({ id: paper.id, keywords: newKeywords });
        }
      }
      if (updates.length === 0) return;

      // 3. Batch update via RPC (chunked for safety)
      try {
        const CHUNK_SIZE = 500;
        for (let i = 0; i < updates.length; i += CHUNK_SIZE) {
          const chunk = updates.slice(i, i + CHUNK_SIZE);
          const { error } = await supabase.rpc("bulk_update_keywords", {
            updates: chunk.map(({ id, keywords }) => ({ id, keywords })),
          });
          if (error) throw error;
        }

        // 4. Invalidate cache
        removeStaleListCaches();
        queryClient.invalidateQueries({ queryKey: queryKeys.papers.all(userId) });
        toast({ title: "Keywords updated", description: `Updated keywords for ${updates.length} paper(s).` });
      } catch (err) {
        toast({ title: "Error saving keyword updates", description: getErrorMessage(err), variant: "destructive" });
      }
    },
    [userId, removeStaleListCaches, queryClient, toast],
  );

  return { addPapers, bulkImportPapers, bulkImportFromParsedData, bulkDeletePapers, bulkSetProjects, bulkSetTags, reevaluateStudyTypes, reevaluateKeywords };
}
