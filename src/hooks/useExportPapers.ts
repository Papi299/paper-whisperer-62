import { useState, useCallback } from "react";
import { Paper, PaperWithTags, Project, Tag } from "@/types/database";
import { ServerFilterParams, areServerFiltersReady } from "./papers/types";
import { buildPapersQuery } from "@/lib/buildPapersQuery";
import { fetchAllPages } from "@/lib/fetchAllPages";
import { fetchInChunks } from "@/lib/fetchInChunks";
import { exportToCSV, exportToRIS, exportToBibTeX } from "@/lib/exportUtils";
import { useToast } from "@/hooks/use-toast";

/** Select only the fields needed for export — no attachments. */
const EXPORT_SELECT =
  "id, title, authors, year, journal, pmid, doi, abstract, study_type, keywords, mesh_terms, substances, pubmed_url, journal_url, drive_url";

interface UseExportPapersArgs {
  userId: string | undefined;
  serverFilterParams: ServerFilterParams;
  tags: Tag[];
  projects: Project[];
  tagsLoading: boolean;
  projectsLoading: boolean;
}

export function useExportPapers({
  userId,
  serverFilterParams,
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
    async (format: "csv" | "ris" | "bibtex") => {
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
        const rawPapers = await fetchAllPages<Paper>(
          () => buildPapersQuery(userId, serverFilterParams, EXPORT_SELECT),
        );

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

        // 4. Format and download
        switch (format) {
          case "csv":
            exportToCSV(hydratedPapers);
            break;
          case "ris":
            exportToRIS(hydratedPapers);
            break;
          case "bibtex":
            exportToBibTeX(hydratedPapers);
            break;
        }

        toast({
          title: "Export started",
          description: `Downloading ${hydratedPapers.length} paper${hydratedPapers.length !== 1 ? "s" : ""} as ${format.toUpperCase()}.`,
        });
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
    [userId, serverFilterParams, tags, projects, toast],
  );

  return { exportPapers, isExporting, isExportReady };
}
