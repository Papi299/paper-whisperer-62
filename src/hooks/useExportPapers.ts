import { useState, useCallback } from "react";
import { Paper, PaperWithTags, Project, Tag } from "@/types/database";
import { ServerFilterParams, ServerSortParams, areServerFiltersReady } from "./papers/types";
import { buildPapersQuery } from "@/lib/buildPapersQuery";
import { fetchAllPages } from "@/lib/fetchAllPages";
import { fetchInChunks } from "@/lib/fetchInChunks";
import { exportToCSV, exportToRIS, exportToBibTeX, type BibTeXExportSummary } from "@/lib/exportUtils";
import { timedQueryFn } from "@/lib/queryTiming";
import { useToast, type ToastOptions } from "@/hooks/use-toast";

/** Select only the fields needed for export — no attachments. */
const EXPORT_SELECT =
  "id, title, authors, year, journal, pmid, doi, abstract, study_type, keywords, mesh_terms, substances, pubmed_url, journal_url, drive_url";

/**
 * Supported export formats. Single source of truth — imported by
 * `Dashboard.tsx` and `SearchFilters.tsx` so the export `<DropdownMenu>`
 * call sites and the `exportPapers` callback share the same union.
 */
export type ExportFormat = "csv" | "ris" | "bibtex";

/**
 * The notice for a BibTeX export that wrote a DOI or URL to a PaperLume field
 * (`paperlume-doi-v1` / `paperlume-url-v1`, see `writeIdentifierField`), shown
 * in place of "Export started"; `null` when the file has no such field, so an
 * ordinary export is announced exactly as before. Other reference managers may
 * ignore those fields and show no DOI or URL for the paper, while PaperLume's
 * own importer reads them back.
 *
 * It uses the `destructive` tier of the toast policy (`TOAST_DURATION_MS`),
 * the one for warnings a user needs to read in full: 8 s instead of 5 s, and
 * the tier "File import complete with warnings" already uses for a finished
 * operation with a caveat. The title says that the file was exported.
 */
function bibtexCompatibilityNotice(summary: BibTeXExportSummary): ToastOptions | null {
  const papers = summary.affectedPaperCount;
  if (papers === 0) return null;
  return {
    title: "BibTeX exported with compatibility notice",
    description:
      papers === 1
        ? "1 paper has a DOI or URL preserved in a PaperLume-specific field. Other reference managers may not recognize it. PaperLume can recover it when the file is reimported."
        : `${papers} papers have DOI or URL values preserved in PaperLume-specific fields. Other reference managers may not recognize them. PaperLume can recover them when the file is reimported.`,
    variant: "destructive",
  };
}

interface UseExportPapersArgs {
  userId: string | undefined;
  serverFilterParams: ServerFilterParams;
  serverSortParams: ServerSortParams;
  tags: Tag[];
  projects: Project[];
  tagsLoading: boolean;
  projectsLoading: boolean;
}

export function useExportPapers({
  userId,
  serverFilterParams,
  serverSortParams,
  tags,
  projects,
  tagsLoading,
  projectsLoading,
}: UseExportPapersArgs) {
  const { toast } = useToast();
  const [isExporting, setIsExporting] = useState(false);

  // Export is ready when:
  // - userId is available
  // - server filter params are fully resolved (filterPaperIds !== undefined)
  // - tags and projects metadata are loaded (needed for hydration)
  const isExportReady =
    !!userId &&
    areServerFiltersReady(serverFilterParams) &&
    !tagsLoading &&
    !projectsLoading;

  const exportPapers = useCallback(
    async (format: ExportFormat) => {
      // Safety guard: don't export if prerequisites aren't met
      if (!userId || !areServerFiltersReady(serverFilterParams)) return;

      const { filterPaperIds } = serverFilterParams;

      // Short-circuit: filter resolved with no matches
      if (filterPaperIds !== null && filterPaperIds !== undefined && filterPaperIds.length === 0) {
        toast({ title: "No papers to export", description: "No papers match current filters." });
        return;
      }

      setIsExporting(true);

      try {
        // 1. Fetch all matching papers via paginated helper (fixes >1000-row truncation)
        const rawPapers = await timedQueryFn("export.fetchAllPages", () =>
          fetchAllPages<Paper>(
            () => buildPapersQuery(userId, serverFilterParams, serverSortParams, EXPORT_SELECT),
          ),
        )();

        if (rawPapers.length === 0) {
          toast({ title: "No papers to export", description: "No papers match current filters." });
          return;
        }

        const paperIds = rawPapers.map((p) => p.id);

        // 2. Fetch junction tables for hydration (chunked to handle large ID arrays)
        const [paperTagRows, paperProjectRows] = await Promise.all([
          fetchInChunks<{ paper_id: string; tag_id: string }>(
            "paper_tags", "paper_id, tag_id", "paper_id", paperIds,
          ),
          fetchInChunks<{ paper_id: string; project_id: string }>(
            "paper_projects", "paper_id, project_id", "paper_id", paperIds,
          ),
        ]);

        // 3. Hydrate into PaperWithTags
        const tagsMap = new Map(tags.map((t) => [t.id, t]));
        const projectsMap = new Map(projects.map((p) => [p.id, p]));

        const hydratedPapers: PaperWithTags[] = rawPapers.map((paper) => {
          const paperTagIds = paperTagRows
            .filter((pt) => pt.paper_id === paper.id)
            .map((pt) => pt.tag_id);

          const paperProjectIds = paperProjectRows
            .filter((pp) => pp.paper_id === paper.id)
            .map((pp) => pp.project_id);

          return {
            ...paper,
            tags: paperTagIds.map((id) => tagsMap.get(id)).filter((t): t is Tag => !!t),
            projects: paperProjectIds.map((id) => projectsMap.get(id)).filter((p): p is Project => !!p),
          };
        });

        if (hydratedPapers.length === 0) {
          toast({ title: "No papers to export", description: "No papers match current filters." });
          return;
        }

        // 4. Format and download. A BibTeX file with a DOI or URL in a
        // PaperLume field gets its compatibility notice instead of the usual
        // one, decided by what the file holds; every other export is
        // announced as before.
        let compatibilityNotice: ToastOptions | null = null;
        switch (format) {
          case "csv":
            exportToCSV(hydratedPapers);
            break;
          case "ris":
            exportToRIS(hydratedPapers);
            break;
          case "bibtex":
            compatibilityNotice = bibtexCompatibilityNotice(exportToBibTeX(hydratedPapers));
            break;
        }

        toast(
          compatibilityNotice ?? {
            title: "Export started",
            description: `Downloading ${hydratedPapers.length} paper${hydratedPapers.length !== 1 ? "s" : ""} as ${format.toUpperCase()}.`,
          },
        );
      } catch (error) {
        toast({
          title: "Export failed",
          description: error instanceof Error ? error.message : "Unknown error",
          variant: "destructive",
        });
      } finally {
        setIsExporting(false);
      }
    },
    [userId, serverFilterParams, serverSortParams, tags, projects, toast],
  );

  return { exportPapers, isExporting, isExportReady };
}
