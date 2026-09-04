import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/types";
import { useToast } from "@/hooks/use-toast";
import { Paper, PaperWithTags, Project, Tag, BulkInsertResult } from "@/types/database";
import { queryKeys } from "@/lib/queryKeys";
import { NormalizationConfig, RawPaperData, computeEnrichedKeywords } from "@/lib/normalizePaperData";
import { normalizeAuthorProvenanceForStorage } from "@/lib/authorProvenance";
import { fetchAllPages } from "@/lib/fetchAllPages";
import { evaluateStudyType, StudyTypePoolEntry } from "@/lib/evaluateStudyType";
import {
  isMissingRawPublicationTypesColumn,
  normalizePublicationTypes,
  toEvaluatorPublicationTypes,
} from "@/lib/publicationTypes";
import { fetchPaperMetadata } from "@/lib/fetchPaperMetadataEdge";
import { getErrorMessage } from "@/lib/errorUtils";
import { processChunkedInsert } from "@/lib/chunkedInsert";
import type {
  BulkImportAssignmentReport,
  BulkImportItemStatus,
  BulkImportOutcome,
  ServerFilterParams,
  ServerSortParams,
} from "./types";
import { useNormalizationWorker } from "@/hooks/useNormalizationWorker";
import { usePaperCacheHelpers } from "./usePaperCacheHelpers";
import { drainAttachmentCleanupQueue } from "@/lib/attachmentCleanup";
import {
  isAttachmentCleanupSchemaMissing,
  noteAttachmentCleanupObjectPresent,
} from "@/lib/attachmentCleanupAvailability";
import { legacyDeletePapersWithBestEffortCleanup } from "./deletePapersCompat";

/**
 * Study-type re-evaluation reads exactly the columns it evaluates on — never
 * `*`. The two variants differ only by the structured provenance column, so a
 * database that predates it can serve the same work from the legacy list.
 */
const STRUCTURED_REEVALUATION_SELECT =
  "id, title, abstract, study_type, raw_study_type, raw_publication_types";
const LEGACY_REEVALUATION_SELECT =
  "id, title, abstract, study_type, raw_study_type";

/**
 * Options accepted by both bulk importers.
 *
 * `applyAssignmentsToResolvedDuplicates` is the ONLY switch that lets a run
 * touch a paper it did not create, and it is deliberately opt-in per call
 * rather than a property of the importer:
 *
 *   - default (`false` / omitted) — a duplicate is skipped and nothing about it
 *     is read or written, exactly as before this option existed. Add Papers,
 *     PubMed Search and parsed-file import all take this path; whether they
 *     should ever assign to existing papers is a separate product decision.
 *   - `true` — a duplicate that `safe_bulk_insert_papers` resolved to exactly
 *     one owned row has the selected Projects/Tags ADDED to it, through
 *     `bulk_add_*` rather than the replace-all `bulk_set_*`, so nothing it was
 *     already filed under is removed. `/extension-import` is the one caller
 *     that opts in, because it is the one surface whose user just picked
 *     taxonomy for this specific paper.
 *
 * A duplicate the database could not resolve carries no id, and is never
 * assigned to under either setting — which is also what makes this safe to
 * deploy against a database that predates the resolving RPC.
 */
export interface BulkImportOptions {
  targetProjectIds?: string[];
  targetTagIds?: string[];
  applyAssignmentsToResolvedDuplicates?: boolean;
}

/** An assignment report before any RPC has run: nothing requested, nothing claimed. */
function emptyAssignmentReport(): BulkImportAssignmentReport {
  return { projects: "not-requested", tags: "not-requested" };
}

/** A row from either select; the structured column is simply absent from the legacy one. */
type ReevaluationRow = {
  id: string;
  title: string;
  abstract: string | null;
  study_type: string | null;
  raw_study_type: string | null;
  raw_publication_types?: Json | null;
};

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

  const bulkImportPapers = useCallback(
    async (
      identifiers: string[],
      onProgress?: (current: number, total: number, addedIds: string[], skippedIds: string[], failedIds: string[]) => void,
      options?: BulkImportOptions,
    ): Promise<BulkImportOutcome | undefined> => {
      if (!userId || identifiers.length === 0) return undefined;

      const addedIds: string[] = [];
      const skippedIds: string[] = [];
      const failedIds: string[] = [];
      const total = identifiers.length;

      /**
       * Terminal per-identifier status, keyed by identifier and filled in as
       * each phase decides. Seeded as `failed` so an identifier that never
       * reaches a verdict — a fetch that failed, a normalization that threw, a
       * chunk that never came back — is reported as failed rather than silently
       * omitted from the outcome.
       */
      const itemStatus = new Map<string, BulkImportItemStatus>(
        identifiers.map((identifier) => [identifier, "failed" as BulkImportItemStatus]),
      );
      const insertedReport = emptyAssignmentReport();
      const resolvedDuplicateReport = emptyAssignmentReport();
      const buildOutcome = (): BulkImportOutcome => ({
        items: identifiers.map((identifier) => ({
          identifier,
          status: itemStatus.get(identifier) ?? "failed",
        })),
        inserted: insertedReport,
        resolvedDuplicates: resolvedDuplicateReport,
      });

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
        return buildOutcome();
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
        // Structured authorship provenance exactly as the Edge Function stated
        // it, aligned with `authors` above. An older deployed Edge version
        // omits the field entirely, which simply means no provenance — the
        // import succeeds either way.
        author_provenance: meta.author_provenance,
        // PubMed states publication types discretely; the joined `study_type`
        // above cannot be split back apart without breaking an official type
        // that contains a comma. Forwarding the structured values lets
        // normalization evaluate them as whole values — the same path native
        // NBIB already takes.
        publication_types: meta.publication_types,
        pubmed_url: meta.pubmed_url ?? null,
        journal_url: meta.journal_url ?? null,
        drive_url: null,
      }));

      let normalizedPapers: typeof rawPapers;
      try {
        normalizedPapers = normalizationConfig
          ? await normalize(rawPapers, normalizationConfig)
          : rawPapers;
      } catch (normError: unknown) {
        // Mark only the successfully-fetched identifiers as failed (fetch-phase failures are already in failedIds)
        for (const { identifier } of successfulResults) {
          failedIds.push(identifier);
        }
        onProgress?.(total, total, addedIds, skippedIds, failedIds);
        toast({
          title: "Normalization failed",
          description: getErrorMessage(normError),
          variant: "destructive",
        });
        return buildOutcome();
      }

      // Phase 3: Build payload and call safe_bulk_insert_papers RPC
      const insertPayload = normalizedPapers.map((normalized, i) => ({
        title: normalized.title,
        authors: normalized.authors || [],
        // Aligned against the SAME `authors` array being stored, and degraded
        // to NULL by `normalizeAuthorProvenanceForStorage` if it is not — a
        // misaligned array would attach every mention's structure to the wrong
        // name, so absence is the only safe alternative to correctness.
        author_provenance: normalizeAuthorProvenanceForStorage(
          normalized.author_provenance,
          normalized.authors || [],
        ),
        year: normalized.year ?? null,
        journal: normalized.journal ?? null,
        pmid: normalized.pmid ?? null,
        doi: normalized.doi ?? null,
        abstract: normalized.abstract ?? null,
        study_type: normalized.study_type ?? null,
        raw_study_type: successfulResults[i].meta.study_type || null,
        // Structured provenance alongside the legacy joined string — null
        // whenever the source stated no boundaries (an older deployed Edge
        // version, or a Crossref-only result), never reconstructed by
        // splitting `raw_study_type`.
        raw_publication_types: normalizePublicationTypes(
          successfulResults[i].meta.publication_types,
        ),
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
        async (chunk) => supabase.rpc("safe_bulk_insert_papers", {
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
        return buildOutcome();
      }

      // Phase 4: Process RPC results
      const results = allRpcResults;
      const insertedPaperIds: string[] = [];
      /**
       * Existing papers this run may assign to.
       *
       * Populated ONLY when the caller opted in. Without the opt-in the id is
       * not even read, so a duplicate behaves exactly as it did before the
       * resolving RPC existed — the feature cannot leak into Add Papers or
       * PubMed Search by a later refactor forgetting to check the flag here.
       */
      const applyToResolvedDuplicates = options?.applyAssignmentsToResolvedDuplicates === true;
      const resolvedDuplicateIds: string[] = [];

      for (const row of results) {
        const { identifier } = successfulResults[row.index];
        if (row.status === "inserted" && row.id) {
          addedIds.push(identifier);
          insertedPaperIds.push(row.id);
          itemStatus.set(identifier, "inserted");
        } else if (row.status === "duplicate") {
          // A duplicate is a duplicate for the counters either way: nothing was
          // inserted, so it is skipped and never counted as added.
          skippedIds.push(identifier);
          const resolvedId =
            applyToResolvedDuplicates && typeof row.id === "string" && row.id.length > 0
              ? row.id
              : null;
          if (resolvedId) {
            resolvedDuplicateIds.push(resolvedId);
            itemStatus.set(identifier, "duplicate-resolved");
          } else {
            itemStatus.set(identifier, "duplicate-unresolved");
          }
        } else {
          failedIds.push(identifier);
          itemStatus.set(identifier, "failed");
        }
      }

      onProgress?.(total, total, addedIds, skippedIds, failedIds);

      // Phase 5: Assign project/tags
      const projectIds = options?.targetProjectIds ?? [];
      const tagIds = options?.targetTagIds ?? [];
      const wantsProjects = projectIds.length > 0;
      const wantsTags = tagIds.length > 0;

      // Warnings are kept in two lists because the two sentences they produce
      // say different things: a newly inserted paper "may need manual
      // assignment", while an existing paper kept everything it already had and
      // merely did not gain the new selection.
      const assignmentWarnings: string[] = [];
      const duplicateAssignmentWarnings: string[] = [];

      // 5a. Newly inserted rows — unchanged replace-all semantics. The row was
      // created moments ago and owns nothing, so setting its exact selection
      // and adding to an empty set are the same operation.
      if (insertedPaperIds.length > 0) {
        if (wantsProjects) {
          const { error: projError } = await supabase.rpc("bulk_set_paper_projects", {
            p_paper_ids: insertedPaperIds,
            p_project_ids: projectIds,
          });
          insertedReport.projects = projError ? "failed" : "applied";
          if (projError) {
            assignmentWarnings.push("project assignment failed");
          }
        }

        if (wantsTags) {
          const { error: tagError } = await supabase.rpc("bulk_set_paper_tags", {
            p_paper_ids: insertedPaperIds,
            p_tag_ids: tagIds,
          });
          insertedReport.tags = tagError ? "failed" : "applied";
          if (tagError) {
            assignmentWarnings.push("tag assignment failed");
          }
        }

        // No optimistic insert — invalidate to refetch with current filters
        invalidateAndRefetch();
      }

      // 5b. Deterministically resolved duplicates — ADDITIVE only.
      //
      // `bulk_add_*`, never `bulk_set_*`: these papers have a history, and the
      // replace-all setter called with just this handoff's selection would
      // delete every other Project and Tag they were filed under. The two RPCs
      // are independent, so one can land while the other fails, and the report
      // records that rather than collapsing it to a single verdict.
      if (resolvedDuplicateIds.length > 0 && (wantsProjects || wantsTags)) {
        if (wantsProjects) {
          const { error: projError } = await supabase.rpc("bulk_add_paper_projects", {
            p_paper_ids: resolvedDuplicateIds,
            p_project_ids: projectIds,
          });
          resolvedDuplicateReport.projects = projError ? "failed" : "applied";
          if (projError) {
            duplicateAssignmentWarnings.push("project assignment failed");
          }
        }

        if (wantsTags) {
          const { error: tagError } = await supabase.rpc("bulk_add_paper_tags", {
            p_paper_ids: resolvedDuplicateIds,
            p_tag_ids: tagIds,
          });
          resolvedDuplicateReport.tags = tagError ? "failed" : "applied";
          if (tagError) {
            duplicateAssignmentWarnings.push("tag assignment failed");
          }
        }

        // Invalidate whenever a write was ATTEMPTED, not only when both
        // succeeded: a partial success still changed persisted state, and a
        // stale list would hide the half that landed.
        invalidateAndRefetch();
      }

      const summary = `${addedIds.length} added, ${skippedIds.length} skipped (duplicates), ${failedIds.length} failed.`;

      const notes: string[] = [];
      if (assignmentWarnings.length > 0) {
        notes.push(
          `Note: ${assignmentWarnings.join(" and ")} — papers were imported but may need manual project/tag assignment.`,
        );
      }
      if (duplicateAssignmentWarnings.length > 0) {
        notes.push(
          `Note: ${duplicateAssignmentWarnings.join(" and ")} on a paper already in your library — its existing projects and tags are unchanged.`,
        );
      }

      if (notes.length > 0) {
        toast({
          title: "Bulk import complete with warnings",
          description: `${summary} ${notes.join(" ")}`,
          variant: "destructive",
        });
      } else {
        toast({
          title: "Bulk import complete",
          description: summary,
        });
      }

      return buildOutcome();
    },
    [userId, projects, tags, normalizationConfig, normalize, toast, invalidateAndRefetch, queryClient],
  );

  /**
   * Import pre-parsed papers (from .bib, .ris, .csv file parsers).
   * Skips the metadata fetch phase — goes directly to normalize -> RPC -> cache.
   *
   * Duplicate semantics are deliberately unchanged by
   * CHROME-EXTENSION-IMPORT-001D. `safe_bulk_insert_papers` may now return an
   * existing paper id alongside `status: "duplicate"`, and this function
   * ignores it: a file import is a bulk operation over records the user did not
   * inspect one by one, so silently re-filing papers they already had would be
   * a product decision nobody has made. The options parameter therefore does
   * NOT accept `applyAssignmentsToResolvedDuplicates` — passing it here is a
   * type error rather than a no-op that reads as support.
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
      let normalizedPapers: typeof parsedPapers;
      try {
        normalizedPapers = normalizationConfig
          ? await normalize(parsedPapers, normalizationConfig)
          : parsedPapers.map((p) => ({
              ...p,
              mesh_terms: p.mesh_terms || [],
              substances: p.substances || [],
            }));
      } catch (normError: unknown) {
        onProgress?.(total, total, 0, 0, total);
        toast({
          title: "Normalization failed",
          description: getErrorMessage(normError),
          variant: "destructive",
        });
        return;
      }

      onProgress?.(Math.ceil(total * 0.3), total, 0, 0, 0);

      // Phase 2: Build payload and call safe_bulk_insert_papers RPC
      const insertPayload = normalizedPapers.map((normalized, i) => ({
        title: normalized.title,
        authors: normalized.authors || [],
        // Aligned against the SAME `authors` array being stored, and degraded
        // to NULL by `normalizeAuthorProvenanceForStorage` if it is not — a
        // misaligned array would attach every mention's structure to the wrong
        // name, so absence is the only safe alternative to correctness.
        author_provenance: normalizeAuthorProvenanceForStorage(
          normalized.author_provenance,
          normalized.authors || [],
        ),
        year: normalized.year ?? null,
        journal: normalized.journal ?? null,
        pmid: normalized.pmid ?? null,
        doi: normalized.doi ?? null,
        abstract: normalized.abstract ?? null,
        study_type: normalized.study_type ?? null,
        raw_study_type: parsedPapers[i].study_type || null,
        // Native NBIB states one publication type per `PT` field, so those
        // boundaries are now persisted rather than surviving only in memory
        // for the import-time evaluation. Formats that state no boundaries
        // (RIS, BibTeX, CSV, EndNote) keep `raw_study_type` alone.
        raw_publication_types: normalizePublicationTypes(parsedPapers[i].publication_types),
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
        async (chunk) => supabase.rpc("safe_bulk_insert_papers", {
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

      // Optimistic: remove papers and adjust counts immediately (always safe)
      const idSet = new Set(paperIds);
      updatePapersCache((old) => old.filter((p) => !idSet.has(p.id)));
      adjustCount(-paperIds.length);
      adjustFilteredCount(-paperIds.length);

      // ATTACHMENT-ORPHAN-CLEANUP-HARDENING-001. The same RPC the single-paper
      // delete uses, given the whole selection. It validates every id against
      // the caller BEFORE mutating anything, so one foreign or unknown id
      // rejects the entire call rather than producing a partial deletion, and it
      // queues every attachment path in the same transaction that removes the
      // papers. Counts below stay truthful because the operation is
      // all-or-nothing.
      const { error: rpcError } = await supabase.rpc("delete_papers_with_attachment_cleanup", {
        p_paper_ids: paperIds,
      });

      if (rpcError) {
        if (!isAttachmentCleanupSchemaMissing(rpcError)) {
          rollbackCache(snapshot);
          toast({ title: "Error deleting papers", description: getErrorMessage(rpcError), variant: "destructive" });
          return;
        }

        // Pre-migration database — same fallback the single delete takes, with
        // the same honest reporting of a returned Storage `{ error }`.
        const legacy = await legacyDeletePapersWithBestEffortCleanup(userId, paperIds);
        if (!legacy.ok) {
          rollbackCache(snapshot);
          toast({ title: "Error deleting papers", description: legacy.message, variant: "destructive" });
          return;
        }
        removeStaleListCaches();
        toast(legacy.cleanupFailed
          ? { title: `Deleted ${paperIds.length} paper(s)`, description: "One or more attachment files could not be removed." }
          : { title: `Deleted ${paperIds.length} paper(s)` });
        return;
      }

      noteAttachmentCleanupObjectPresent("delete_papers_with_attachment_cleanup");

      // Committed. Selected papers stay deleted; a Storage failure is a warning,
      // never a restore — restoring them would show the user papers the database
      // no longer holds.
      const cleanup = await drainAttachmentCleanupQueue(userId);
      removeStaleListCaches();
      toast(cleanup.status === "pending"
        ? { title: `Deleted ${paperIds.length} paper(s)`, description: "Attachment file cleanup is pending and will retry automatically." }
        : { title: `Deleted ${paperIds.length} paper(s)` });
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

      // Fetch own data including abstract — the list cache no longer carries
      // abstract, and `raw_publication_types` is deliberately not in the list
      // query either: it is provenance needed only here, not by the paper list.
      //
      // Version skew: merging auto-deploys this frontend, while applying the
      // migration that adds `raw_publication_types` is a separate later
      // decision, so for that interval this runs against a schema without the
      // column. PostgREST resolves the select list before permissions or RLS,
      // so the structured read fails outright — and only that one specific
      // failure earns a single retry with the exact pre-existing select. Any
      // other error keeps its current behavior and is rethrown untouched.
      let freshPapers: ReevaluationRow[] | null = null;

      const structuredRead = await supabase
        .from("papers")
        .select(STRUCTURED_REEVALUATION_SELECT)
        .eq("user_id", userId);

      if (structuredRead.error) {
        if (!isMissingRawPublicationTypesColumn(structuredRead.error)) {
          throw structuredRead.error;
        }
        const legacyRead = await supabase
          .from("papers")
          .select(LEGACY_REEVALUATION_SELECT)
          .eq("user_id", userId);
        // A failure of the fallback itself is a real failure: surface it.
        if (legacyRead.error) throw legacyRead.error;
        freshPapers = legacyRead.data;
      } else {
        freshPapers = structuredRead.data;
      }

      // Compute updates first — early return if nothing changed
      const updates: { id: string; newType: string }[] = [];

      for (const paper of (freshPapers || [])) {
        const rawFallback = paper.raw_study_type ?? paper.study_type;
        // Rows imported from a structured source re-evaluate against the
        // boundaries that source stated. A row with NULL / absent / unusable
        // provenance — every row predating this column — yields undefined and
        // keeps the existing joined-string behavior exactly.
        const structuredTypes = toEvaluatorPublicationTypes(paper.raw_publication_types);
        const newType = evaluateStudyType(
          paper.title,
          paper.abstract,
          rawFallback,
          pool,
          structuredTypes,
        );
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
      type ReevalKeywordRow = { id: string; raw_keywords: string[] | null; title: string; abstract: string | null; keywords: string[] };
      let allPapers: ReevalKeywordRow[];
      try {
        // jsonb array columns (raw_keywords, keywords) deserialize to string[] at
        // runtime; `fetchAllPages<ReevalKeywordRow>` asserts that shape at the boundary.
        allPapers = await fetchAllPages<ReevalKeywordRow>(() =>
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

  return { bulkImportPapers, bulkImportFromParsedData, bulkDeletePapers, bulkSetProjects, bulkSetTags, reevaluateStudyTypes, reevaluateKeywords };
}
