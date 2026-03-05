import { useState, useMemo, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { exportToCSV, exportToRIS } from "@/lib/exportUtils";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { usePapers } from "@/hooks/usePapers";
import { useColumnVisibility } from "@/hooks/useColumnVisibility";
import { useColumnWidths } from "@/hooks/useColumnWidths";
import { useStudyTypeReevaluation } from "@/hooks/useStudyTypeReevaluation";
import { useFilteredAndSortedPapers } from "@/hooks/useFilteredAndSortedPapers";
import { useBulkSelection } from "@/hooks/useBulkSelection";
import { Header } from "@/components/layout/Header";
import { Sidebar } from "@/components/layout/Sidebar";
import { PaperList } from "@/components/papers/PaperList";
import { BulkActionsToolbar } from "@/components/papers/BulkActionsToolbar";
import { AddPaperDialog } from "@/components/papers/AddPaperDialog";
import { EditPaperDialog } from "@/components/papers/EditPaperDialog";
import { EditProjectDialog } from "@/components/projects/EditProjectDialog";
import { EditTagDialog } from "@/components/tags/EditTagDialog";
import { SearchFilters } from "@/components/papers/SearchFilters";
import { ColumnVisibilityDropdown } from "@/components/papers/ColumnVisibilityDropdown";
import { Button } from "@/components/ui/button";
import { PaperWithTags, Project, Tag } from "@/types/database";
import { Plus, Loader2 } from "lucide-react";
import { NormalizationConfig } from "@/lib/normalizePaperData";
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

  // Core paper data
  const {
    papers,
    projects,
    tags,
    loading,
    allKeywords,
    totalCount,
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
    updatePaper,
    deletePaper,
    bulkDeletePapers,
    bulkSetProjects,
    bulkSetTags,
    reevaluateStudyTypes,
  } = usePapers(user?.id, normalizationConfig);

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

  // Column visibility & widths
  const { visibleColumns, toggleColumn, availableColumns } = useColumnVisibility();
  const { columnWidths, setColumnWidth } = useColumnWidths();

  // Filter available keywords: derive from papers, apply synonym mapping, exclude, deduplicate
  const filteredKeywords = useMemo(() => {
    const allTerms = [
      ...papers.flatMap(paper => [
        ...(paper.keywords || []),
        ...((paper.substances as string[]) || []),
        ...((paper.mesh_terms as string[]) || []),
      ]),
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
  }, [papers, excludedKeywords, synonymLookup, poolKeywords]);

  // Extract unique study types from papers for import functionality
  const allStudyTypes = useMemo(() => {
    const studyTypeSet = new Set<string>();
    papers.forEach((paper) => {
      if (paper.study_type) {
        paper.study_type
          .split(/[,;]+/)
          .map((t) => t.trim())
          .filter(Boolean)
          .forEach((t) => studyTypeSet.add(t));
      }
    });
    return Array.from(studyTypeSet).sort();
  }, [papers]);

  // Filtering & sorting
  const {
    searchQuery,
    setSearchQuery,
    yearFrom,
    setYearFrom,
    yearTo,
    setYearTo,
    studyType,
    setStudyType,
    selectedKeywords,
    selectedProjectId,
    setSelectedProjectId,
    selectedTagId,
    setSelectedTagId,
    studyTypeFilterOptions,
    sortKey,
    sortDirection,
    handleSort,
    filteredPapers,
    sortedPapers,
    handleKeywordToggle,
    clearFilters,
    hasActiveFilters,
  } = useFilteredAndSortedPapers({
    papers,
    poolStudyTypes,
    synonymLookup,
    findMatchingKeywords,
    userId: user?.id,
  });

  // Bulk selection
  const {
    selectedPaperIds,
    handleToggleSelect,
    handleToggleSelectAll,
    handleClearSelection,
    handleBulkDelete,
    handleBulkSetProjects,
    handleBulkSetTags,
  } = useBulkSelection({
    sortedPapers,
    bulkDeletePapers,
    bulkSetProjects,
    bulkSetTags,
  });

  // Dialog state
  const [addPaperOpen, setAddPaperOpen] = useState(false);
  const [editingPaper, setEditingPaper] = useState<PaperWithTags | null>(null);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [editingTag, setEditingTag] = useState<Tag | null>(null);

  const handleExportCSV = () => {
    exportToCSV(filteredPapers);
    toast({ title: "Export started", description: `Downloading ${filteredPapers.length} papers as CSV.` });
  };

  const handleExportRIS = () => {
    exportToRIS(filteredPapers);
    toast({ title: "Export started", description: `Downloading ${filteredPapers.length} citations as RIS.` });
  };

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

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <Header />
      <div className="flex flex-1">
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
        />
        <main className="flex-1 p-6 overflow-auto">
          <div className="mb-6 flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold">Papers</h1>
              <p className="text-muted-foreground">
                {filteredPapers.length} paper{filteredPapers.length !== 1 ? "s" : ""}
                {totalCount > papers.length && ` (${papers.length} of ${totalCount} loaded)`}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <ColumnVisibilityDropdown
                availableColumns={availableColumns}
                visibleColumns={visibleColumns}
                onToggleColumn={toggleColumn}
              />
              <Button onClick={() => setAddPaperOpen(true)}>
                <Plus className="mr-2 h-4 w-4" />
                Add Papers
              </Button>
            </div>
          </div>

          <div className="mb-6">
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
              selectedKeywords={selectedKeywords}
              availableKeywords={filteredKeywords}
              onKeywordToggle={handleKeywordToggle}
              onClearFilters={clearFilters}
              onExportCSV={handleExportCSV}
              onExportRIS={handleExportRIS}
              hasActiveFilters={hasActiveFilters}
              projects={projects}
              tags={tags}
              selectedProjectId={selectedProjectId}
              selectedTagId={selectedTagId}
              onProjectChange={setSelectedProjectId}
              onTagChange={setSelectedTagId}
            />
          </div>

          <AnalyticsPanel papers={filteredPapers} />

          <PaperList
            papers={sortedPapers}
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
            sortKey={sortKey}
            sortDirection={sortDirection}
            onSort={handleSort}
            hasNextPage={hasNextPage}
            isFetchingNextPage={isFetchingNextPage}
            onLoadMore={fetchNextPage}
          />

          <BulkActionsToolbar
            selectedCount={selectedPaperIds.size}
            onClearSelection={handleClearSelection}
            onBulkDelete={handleBulkDelete}
            onBulkSetProjects={handleBulkSetProjects}
            onBulkSetTags={handleBulkSetTags}
            projects={projects}
            tags={tags}
          />
        </main>
      </div>

      <AddPaperDialog
        open={addPaperOpen}
        onOpenChange={setAddPaperOpen}
        onSubmitManual={addPaperManually}
        onBulkImport={bulkImportPapers}
      />

      <EditPaperDialog
        paper={editingPaper}
        projects={projects}
        tags={tags}
        open={!!editingPaper}
        onOpenChange={(open) => !open && setEditingPaper(null)}
        onSave={handleSavePaper}
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
    </div>
  );
}

export default Dashboard;
