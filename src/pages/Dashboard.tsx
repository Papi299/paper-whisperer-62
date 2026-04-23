import { useState, useMemo, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { usePapers } from "@/hooks/usePapers";
import { useColumnVisibility } from "@/hooks/useColumnVisibility";
import { useColumnWidths } from "@/hooks/useColumnWidths";
import { useStudyTypeReevaluation } from "@/hooks/useStudyTypeReevaluation";
import { useKeywordReevaluation } from "@/hooks/useKeywordReevaluation";
import { useFilterState } from "@/hooks/useFilterState";
import {
  useFilterPresets,
  applyPreset,
  buildPresetPayload,
  type FilterPreset,
  type PresetPayload,
} from "@/hooks/useFilterPresets";
import { useExportPapers } from "@/hooks/useExportPapers";
import { useAnalyticsData } from "@/hooks/useAnalyticsData";
import { useBulkSelection } from "@/hooks/useBulkSelection";
import { Sidebar } from "@/components/layout/Sidebar";
import { PaperList } from "@/components/papers/PaperList";
import { BulkActionsToolbar } from "@/components/papers/BulkActionsToolbar";
import { AddPaperDialog } from "@/components/papers/AddPaperDialog";
import { EditPaperDialog } from "@/components/papers/EditPaperDialog";
import { EditProjectDialog } from "@/components/projects/EditProjectDialog";
import { EditTagDialog } from "@/components/tags/EditTagDialog";
import { SearchFilters } from "@/components/papers/SearchFilters";
import { ColumnVisibilityDropdown } from "@/components/papers/ColumnVisibilityDropdown";
import { DeduplicationDialog } from "@/components/papers/DeduplicationDialog";
import { Button } from "@/components/ui/button";
import { PaperWithTags, PaperAttachment, Project, Tag } from "@/types/database";
import { Plus, Loader2, Layers, Sparkles } from "lucide-react";
import { NormalizationConfig } from "@/lib/normalizePaperData";
import { supabase } from "@/integrations/supabase/client";
import { fetchAbstract, fetchAbstractsBatch } from "@/hooks/useAbstract";
import { AnalyticsPanel } from "@/components/papers/AnalyticsPanel";
import { PoolsProvider, usePools } from "@/contexts/PoolsContext";

/**
 * Outer Dashboard shell: handles auth redirect and provides PoolsProvider.
 */
export function Dashboard() {
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!authLoading && !user) {
      navigate("/auth", { replace: true });
    }
  }, [user, authLoading, navigate]);

  if (authLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!user) {
    return null;
  }

  return (
    <PoolsProvider userId={user.id}>
      <DashboardContent />
    </PoolsProvider>
  );
}

/**
 * Inner Dashboard content: consumes pool data from PoolsContext.
 */
function DashboardContent() {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Pool data from context
  const {
    poolKeywords,
    findMatchingKeywords,
    synonymGroups,
    normalizeKeyword,
    synonymLookup,
    poolStudyTypes,
    deleteStudyType: deletePoolStudyType,
    deleteAllStudyTypes: deleteAllPoolStudyTypes,
    excludedKeywords,
    addExcludedKeyword,
    addExcludedStudyType,
    getExcludedKeywordSet,
    getExcludedStudyTypeSet,
  } = usePools();

  // Build normalization config from pool data
  const normalizationConfig = useMemo<NormalizationConfig>(() => ({
    synonymLookup: synonymLookup || {},
    poolStudyTypes: poolStudyTypes.map(st => ({
      study_type: st.study_type,
      specificity_weight: st.specificity_weight,
      hierarchy_rank: st.hierarchy_rank,
    })),
    poolKeywords: poolKeywords.map(pk => pk.keyword),
    synonymGroups: synonymGroups.map(sg => ({
      canonical_term: sg.canonical_term,
      synonyms: sg.synonyms,
    })),
  }), [synonymLookup, poolStudyTypes, poolKeywords, synonymGroups]);

  // ── Step 1: Filter state (no papers dependency) ──
  const {
    serverFilterParams,
    serverSortParams,
    searchQuery,
    setSearchQuery,
    yearFrom,
    setYearFrom,
    yearTo,
    setYearTo,
    studyType,
    setStudyType,
    notesPresence,
    setNotesPresence,
    selectedKeywords,
    setSelectedKeywords,
    selectedProjectId,
    setSelectedProjectId,
    selectedTagId,
    setSelectedTagId,
    studyTypeFilterOptions,
    sortKey,
    sortDirection,
    handleSort,
    handleKeywordToggle,
    clearFilters,
    hasActiveFilters,
    searchMatchFlags,
  } = useFilterState({ poolStudyTypes, userId: user?.id });

  // ── Step 2: Papers (receives server params — already sorted by server) ──
  const {
    papers,
    projects,
    tags,
    loading,
    tagsLoading,
    projectsLoading,
    allKeywords,
    allStudyTypes,
    totalCount,
    filteredCount,
    allFilteredIds,
    serverKeywordOptions,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    createProject,
    updateProject,
    deleteProject,
    createTag,
    updateTag,
    deleteTag,
    addPaperManually,
    bulkImportPapers,
    bulkImportFromParsedData,
    updatePaper,
    deletePaper,
    bulkDeletePapers,
    bulkSetProjects,
    bulkSetTags,
    reevaluateStudyTypes,
    reevaluateKeywords,
    updatePapersCache,
  } = usePapers(user?.id, serverFilterParams, serverSortParams, normalizationConfig);

  // ── Step 3: Dedicated export fetch (bypasses paginated display query) ──
  const { exportPapers, isExporting, isExportReady } = useExportPapers({
    userId: user?.id,
    serverFilterParams,
    serverSortParams,
    tags,
    projects,
    tagsLoading,
    projectsLoading,
  });

  // ── Saved Searches / Filter Presets (list + create + delete) ──
  const {
    presets,
    isLoading: presetsLoading,
    isSaving: presetsSaving,
    savePreset,
    deletePreset,
  } = useFilterPresets({ userId: user?.id });

  /** Build the payload to persist from the current filter state. */
  const getCurrentPresetPayload = useCallback((): PresetPayload => {
    return buildPresetPayload({
      searchQuery,
      yearFrom,
      yearTo,
      studyType,
      notesPresence,
      selectedKeywords,
      selectedProjectId,
      selectedTagId,
    });
  }, [
    searchQuery,
    yearFrom,
    yearTo,
    studyType,
    notesPresence,
    selectedKeywords,
    selectedProjectId,
    selectedTagId,
  ]);

  /**
   * Full-replacement preset load. Runs the stale-ID guard in `applyPreset`
   * and surfaces a toast if the saved project or tag no longer exists.
   * Sort state is intentionally left untouched — it is a view concern.
   */
  const handleLoadPreset = useCallback(
    (preset: FilterPreset) => {
      const result = applyPreset(
        preset.payload,
        {
          setSearchQuery,
          setYearFrom,
          setYearTo,
          setStudyType,
          setNotesPresence,
          setSelectedKeywords,
          setSelectedProjectId,
          setSelectedTagId,
        },
        projects,
        tags,
      );

      if (result.droppedProjectId || result.droppedTagId) {
        const parts: string[] = [];
        if (result.droppedProjectId) parts.push("project");
        if (result.droppedTagId) parts.push("tag");
        toast({
          title: "Preset loaded with missing references",
          description: `The ${parts.join(" and ")} saved in "${preset.name}" no longer exists — skipped.`,
        });
      } else {
        toast({
          title: "Preset loaded",
          description: `"${preset.name}" is now active.`,
        });
      }
    },
    [
      projects,
      tags,
      setSearchQuery,
      setYearFrom,
      setYearTo,
      setStudyType,
      setNotesPresence,
      setSelectedKeywords,
      setSelectedProjectId,
      setSelectedTagId,
      toast,
    ],
  );

  // ── Step 4: Dedicated analytics fetch (bypasses paginated display query) ──
  const [isAnalyticsOpen, setIsAnalyticsOpen] = useState(false);
  const { papers: analyticsPapers, isLoading: isAnalyticsLoading } = useAnalyticsData({
    userId: user?.id,
    serverFilterParams,
    serverSortParams,
    enabled: isAnalyticsOpen,
  });

  // Study type re-evaluation on pool changes
  const {
    handleStudyTypePoolModalClose,
    handleDeletePoolStudyType,
    handleDeleteAllPoolStudyTypes,
  } = useStudyTypeReevaluation({
    poolStudyTypes,
    reevaluateStudyTypes,
    deleteStudyType: deletePoolStudyType,
    deleteAllStudyTypes: deleteAllPoolStudyTypes,
  });

  // Keyword re-evaluation on keyword/synonym pool changes (dirty-flag gated)
  const {
    markDirty: markKeywordPoolDirty,
    handlePoolModalClose: handleKeywordPoolModalClose,
  } = useKeywordReevaluation({
    normalizationConfig,
    reevaluateKeywords,
  });

  // Column visibility & widths
  const { visibleColumns, toggleColumn, availableColumns } = useColumnVisibility();
  const { columnWidths, setColumnWidth } = useColumnWidths();

  // Filter available keywords: server-side keyword options + pool keywords, apply synonym mapping, exclude, deduplicate
  const filteredKeywords = useMemo(() => {
    const allTerms = [
      ...(serverKeywordOptions ?? []),
      ...poolKeywords.map(pk => pk.keyword),
    ];

    const mappedTerms = allTerms.map(term => {
      const canonical = synonymLookup[term.toLowerCase()];
      return canonical || term;
    });

    const excludedSet = new Set(excludedKeywords.map(ek => ek.keyword.toLowerCase()));

    return Array.from(new Set(mappedTerms))
      .filter(kw => !excludedSet.has(kw.toLowerCase()))
      .sort();
  }, [serverKeywordOptions, excludedKeywords, synonymLookup, poolKeywords]);

  // Bulk selection (server-sorted + server-filtered)
  const {
    selectedPaperIds,
    isSelectAllReady,
    handleToggleSelect,
    handleToggleSelectAll,
    handleClearSelection,
    handleBulkDelete,
    handleBulkSetProjects,
    handleBulkSetTags,
  } = useBulkSelection({
    papers: papers,
    allFilteredIds,
    bulkDeletePapers,
    bulkSetProjects,
    bulkSetTags,
  });

  // Dialog state
  const [addPaperOpen, setAddPaperOpen] = useState(false);
  const [dedupOpen, setDedupOpen] = useState(false);
  const [editingPaper, setEditingPaper] = useState<PaperWithTags | null>(null);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [editingTag, setEditingTag] = useState<Tag | null>(null);
  const [analyzingPaperId, setAnalyzingPaperId] = useState<string | null>(null);
  const [bulkAnalyzing, setBulkAnalyzing] = useState(false);
  const [bulkAnalyzeProgress, setBulkAnalyzeProgress] = useState({ current: 0, total: 0 });

  const handleExportCSV = () => exportPapers("csv");
  const handleExportRIS = () => exportPapers("ris");
  const handleExportBibTeX = () => exportPapers("bibtex");

  const handleAttachmentsChange = useCallback((paperId: string, atts: PaperAttachment[]) => {
    updatePapersCache((all) =>
      all.map((p) => (p.id === paperId ? { ...p, paper_attachments: atts } : p))
    );
  }, [updatePapersCache]);

  /** Smart merge: preserve existing study_type if it's specific (not generic/empty). */
  const isGenericStudyType = (type: string | null | undefined) =>
    !type || type.trim() === "" || type.trim().toLowerCase() === "journal article";

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

      // Smart merge: keep existing study_type if it's specific
      const finalStudyType = isGenericStudyType(paper.study_type)
        ? (aiData.studyType ?? paper.study_type)
        : paper.study_type;

      const updates: Record<string, unknown> = {
        tldr: aiData.tldr || paper.tldr,
        study_type: finalStudyType,
        statistical_methods: aiData.statisticalMethods || paper.statistical_methods,
      };

      await updatePaper(paper.id, updates);

      const keptStudyType = !isGenericStudyType(paper.study_type) && aiData.studyType && aiData.studyType !== paper.study_type;
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
        const finalStudyType = isGenericStudyType(paper.study_type)
          ? (aiData.studyType ?? paper.study_type)
          : paper.study_type;

        await updatePaper(paper.id, {
          tldr: aiData.tldr || paper.tldr,
          study_type: finalStudyType,
          statistical_methods: aiData.statisticalMethods || paper.statistical_methods,
        });
        successCount++;
      } catch (err: unknown) {
        failCount++;
        toast({
          title: `Failed: ${paper.title?.slice(0, 50)}...`,
          description: err instanceof Error ? err.message : "Unknown error",
          variant: "destructive",
        });
      }

      // 3-second cooldown to avoid Gemini rate limits
      await new Promise(resolve => setTimeout(resolve, 3000));
    }

    setBulkAnalyzing(false);
    setBulkAnalyzeProgress({ current: 0, total: 0 });
    toast({
      title: "Bulk analysis complete",
      description: `${successCount} succeeded, ${failCount} failed out of ${papersToAnalyze.length} papers.`,
    });
  }, [papers, selectedPaperIds, updatePaper, toast]);

  const handleSavePaper = async (
    updates: Partial<PaperWithTags> & { tagIds: string[] }
  ) => {
    if (editingPaper) {
      if (updates.keywords && Array.isArray(updates.keywords)) {
        const mapped = updates.keywords.map(kw => {
          const canonical = synonymLookup[kw.toLowerCase()];
          return canonical || kw;
        });
        const seen = new Set<string>();
        updates.keywords = mapped.filter(kw => {
          const lower = kw.toLowerCase();
          if (seen.has(lower)) return false;
          seen.add(lower);
          return true;
        });
      }
      await updatePaper(editingPaper.id, updates);
    }
  };

  if (loading && papers.length === 0) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="flex h-screen w-full bg-background overflow-hidden">
      <Sidebar
        projects={projects}
        tags={tags}
        onCreateProject={createProject}
        onCreateTag={createTag}
        onEditProject={(p) => setEditingProject(p)}
        onDeleteProject={deleteProject}
        onEditTag={(t) => setEditingTag(t)}
        onDeleteTag={deleteTag}
        availableKeywords={allKeywords}
        availableStudyTypes={allStudyTypes}
        onDeletePoolStudyType={handleDeletePoolStudyType}
        onDeleteAllPoolStudyTypes={handleDeleteAllPoolStudyTypes}
        onStudyTypePoolModalClose={handleStudyTypePoolModalClose}
        onKeywordPoolChange={markKeywordPoolDirty}
        onKeywordPoolModalClose={handleKeywordPoolModalClose}
      />
      <main className="flex-1 flex flex-col overflow-hidden relative">
        <div className="flex flex-col gap-4 bg-background border-b px-6 py-4 shadow-sm shrink-0 z-10">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold">Papers</h1>
              <p className="text-muted-foreground">
                {hasActiveFilters
                  ? `${filteredCount} of ${totalCount} papers`
                  : `${totalCount} paper${totalCount !== 1 ? "s" : ""}`}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <ColumnVisibilityDropdown
                availableColumns={availableColumns}
                visibleColumns={visibleColumns}
                onToggleColumn={toggleColumn}
              />
              <Button variant="outline" onClick={() => setDedupOpen(true)}>
                <Layers className="mr-2 h-4 w-4" />
                Find Duplicates
              </Button>
              <Button onClick={() => setAddPaperOpen(true)}>
                <Plus className="mr-2 h-4 w-4" />
                Add Papers
              </Button>
            </div>
          </div>
          <SearchFilters
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            yearFrom={yearFrom}
            yearTo={yearTo}
            onYearFromChange={setYearFrom}
            onYearToChange={setYearTo}
            studyType={studyType}
            onStudyTypeChange={setStudyType}
            studyTypeFilterOptions={studyTypeFilterOptions}
            notesPresence={notesPresence}
            onNotesPresenceChange={setNotesPresence}
            selectedKeywords={selectedKeywords}
            availableKeywords={filteredKeywords}
            onKeywordToggle={handleKeywordToggle}
            onClearFilters={clearFilters}
            onExportCSV={handleExportCSV}
            onExportRIS={handleExportRIS}
            onExportBibTeX={handleExportBibTeX}
            hasActiveFilters={hasActiveFilters}
            projects={projects}
            tags={tags}
            selectedProjectId={selectedProjectId}
            selectedTagId={selectedTagId}
            onProjectChange={setSelectedProjectId}
            onTagChange={setSelectedTagId}
            isExportReady={isExportReady}
            isExporting={isExporting}
            presets={presets}
            presetsLoading={presetsLoading}
            presetsSaving={presetsSaving}
            getCurrentPresetPayload={getCurrentPresetPayload}
            onSavePreset={savePreset}
            onLoadPreset={handleLoadPreset}
            onDeletePreset={deletePreset}
          />
          <AnalyticsPanel
            papers={analyticsPapers}
            isLoading={isAnalyticsLoading}
            isOpen={isAnalyticsOpen}
            onOpenChange={setIsAnalyticsOpen}
          />
        </div>

        <div className="flex-1 flex flex-col p-6 min-h-0 overflow-hidden">
          <PaperList
            papers={papers}
            onEdit={setEditingPaper}
            onDelete={deletePaper}
            findMatchingKeywords={findMatchingKeywords}
            visibleColumns={visibleColumns}
            columnWidths={columnWidths}
            onColumnResize={setColumnWidth}
            normalizeKeyword={normalizeKeyword}
            excludedKeywords={getExcludedKeywordSet()}
            excludedStudyTypes={getExcludedStudyTypeSet()}
            onExcludeStudyType={addExcludedStudyType}
            onExcludeKeyword={addExcludedKeyword}
            onUpdateDriveUrl={async (paperId, driveUrl) => {
              await updatePaper(paperId, { drive_url: driveUrl });
            }}
            selectedPaperIds={selectedPaperIds}
            onToggleSelect={handleToggleSelect}
            onToggleSelectAll={handleToggleSelectAll}
            isSelectAllReady={isSelectAllReady}
            sortKey={sortKey}
            sortDirection={sortDirection}
            onSort={handleSort}
            poolKeywordStrings={poolKeywords.map(pk => pk.keyword)}
            onAnalyzePaper={handleAnalyzePaper}
            analyzingPaperId={analyzingPaperId}
            hasNextPage={hasNextPage}
            isFetchingNextPage={isFetchingNextPage}
            onLoadMore={fetchNextPage}
            searchMatchFlags={searchMatchFlags}
          />

          <BulkActionsToolbar
            selectedCount={selectedPaperIds.size}
            onClearSelection={handleClearSelection}
            onBulkDelete={handleBulkDelete}
            onBulkSetProjects={handleBulkSetProjects}
            onBulkSetTags={handleBulkSetTags}
            onBulkAnalyze={handleBulkAnalyze}
            bulkAnalyzing={bulkAnalyzing}
            bulkAnalyzeProgress={bulkAnalyzeProgress}
            projects={projects}
            tags={tags}
          />
        </div>
      </main>

      <AddPaperDialog
        open={addPaperOpen}
        onOpenChange={setAddPaperOpen}
        onSubmitManual={addPaperManually}
        onBulkImport={bulkImportPapers}
        onFileImport={bulkImportFromParsedData}
        projects={projects}
        tags={tags}
      />

      <EditPaperDialog
        paper={editingPaper}
        projects={projects}
        tags={tags}
        open={!!editingPaper}
        onOpenChange={(open) => !open && setEditingPaper(null)}
        onSave={handleSavePaper}
        userId={user?.id}
        onAttachmentsChange={handleAttachmentsChange}
      />

      <EditProjectDialog
        project={editingProject}
        open={!!editingProject}
        onOpenChange={(open) => !open && setEditingProject(null)}
        onSave={updateProject}
      />

      <EditTagDialog
        tag={editingTag}
        open={!!editingTag}
        onOpenChange={(open) => !open && setEditingTag(null)}
        onSave={updateTag}
      />

      {dedupOpen && (
        <DeduplicationDialog
          open={dedupOpen}
          onOpenChange={setDedupOpen}
          userId={user!.id}
        />
      )}
    </div>
  );
}

export default Dashboard;
