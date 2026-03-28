import { useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Paper, PaperWithTags, Project, Tag } from "@/types/database";
import { ServerFilterParams, areServerFiltersReady } from "./papers/types";
import { buildPapersQuery } from "@/lib/buildPapersQuery";
import { applyClientFilters, ClientFilterParams } from "@/lib/applyClientFilters";
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
  clientFilterParams: ClientFilterParams;
}

export function useExportPapers({
  userId,
  serverFilterParams,
  tags,
  projects,
  tagsLoading,
  projectsLoading,
  clientFilterParams,
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
        // 1. Fetch all matching papers (no pagination)
        const query = buildPapersQuery(userId, serverFilterParams, EXPORT_SELECT);
        const { data: papersData, error: papersError } = await query;

        if (papersError) throw papersError;

        const rawPapers = (papersData as Paper[]) || [];

        if (rawPapers.length === 0) {
          toast({ title: "No papers to export", description: "No papers match current filters." });
          return;
        }

        const paperIds = rawPapers.map((p) => p.id);

        // 2. Fetch junction tables for hydration
        const [paperTagsResult, paperProjectsResult] = await Promise.all([
          supabase.from("paper_tags").select("paper_id, tag_id").in("paper_id", paperIds),
          supabase.from("paper_projects").select("paper_id, project_id").in("paper_id", paperIds),
        ]);

        if (paperTagsResult.error) throw paperTagsResult.error;
        if (paperProjectsResult.error) throw paperProjectsResult.error;

        // 3. Hydrate into PaperWithTags
        const tagsMap = new Map(tags.map((t) => [t.id, t]));
        const projectsMap = new Map(projects.map((p) => [p.id, p]));

        const hydratedPapers: PaperWithTags[] = rawPapers.map((paper) => {
          const paperTagIds = (paperTagsResult.data || [])
            .filter((pt: { paper_id: string; tag_id: string }) => pt.paper_id === paper.id)
            .map((pt: { tag_id: string }) => pt.tag_id);

          const paperProjectIds = (paperProjectsResult.data || [])
            .filter((pp: { paper_id: string; project_id: string }) => pp.paper_id === paper.id)
            .map((pp: { project_id: string }) => pp.project_id);

          return {
            ...paper,
            tags: paperTagIds.map((id: string) => tagsMap.get(id)).filter((t): t is Tag => !!t),
            projects: paperProjectIds.map((id: string) => projectsMap.get(id)).filter((p): p is Project => !!p),
          };
        });

        // 4. Apply client-only filters (keywords, short-search)
        const filteredPapers = applyClientFilters(hydratedPapers, clientFilterParams);

        if (filteredPapers.length === 0) {
          toast({ title: "No papers to export", description: "No papers match current filters." });
          return;
        }

        // 5. Format and download
        switch (format) {
          case "csv":
            exportToCSV(filteredPapers);
            break;
          case "ris":
            exportToRIS(filteredPapers);
            break;
          case "bibtex":
            exportToBibTeX(filteredPapers);
            break;
        }

        toast({
          title: "Export started",
          description: `Downloading ${filteredPapers.length} paper${filteredPapers.length !== 1 ? "s" : ""} as ${format.toUpperCase()}.`,
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
    [userId, serverFilterParams, tags, projects, clientFilterParams, toast],
  );

  return { exportPapers, isExporting, isExportReady };
}
