import { useState, useMemo, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { exportToCSV, exportToRIS } from "@/lib/exportUtils";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { usePapers } from "@/hooks/usePapers";
import { useKeywordPool } from "@/hooks/useKeywordPool";
import { useSynonymPool } from "@/hooks/useSynonymPool";
import { useExclusionPools } from "@/hooks/useExclusionPools";
import { useColumnVisibility } from "@/hooks/useColumnVisibility";
import { useColumnWidths } from "@/hooks/useColumnWidths";
import { useStudyTypePool } from "@/hooks/useStudyTypePool";
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
import { StudyTypePoolEntry } from "@/lib/evaluateStudyType";
import { AnalyticsPanel } from "@/components/papers/AnalyticsPanel";

export function Dashboard() {
  const { user, loading: authLoading } = useAuth();
  const { toast } = useToast();
  const navigate = useNavigate();

  // Initialize pools FIRST so normalization config is available for usePapers
  const {
    poolKeywords,
    addKeyword: addPoolKeyword,
    addMultipleKeywords: addMultiplePoolKeywords,
    deleteKeyword: deletePoolKeyword,
    deleteAllKeywords: deleteAllPoolKeywords,
    findMatchingKeywords,
  } = useKeywordPool(user?.id);

  const {
    synonymGroups,
    addSynonymGroup,
    updateSynonymGroup,
    deleteSynonymGroup,
    normalizeKeyword,
    synonymLookup,
  } = useSynonymPool(user?.id);

  const {
    poolStudyTypes,
    addStudyType: addPoolStudyType,
    addMultipleStudyTypes: addMultiplePoolStudyTypes,
    updateStudyType: updatePoolStudyType,
    deleteStudyType: deletePoolStudyType,
    deleteAllStudyTypes: deleteAllPoolStudyTypes,
    renameGroup: renamePoolGroup,
    deleteGroup: deletePoolGroup,
  } = useStudyTypePool(user?.id);

  const {
    excludedKeywords,
    excludedStudyTypes,
    addExcludedKeyword,
    deleteExcludedKeyword,
    clearExcludedKeywords,
    addExcludedStudyType,
    deleteExcludedStudyType,
    clearExcludedStudyTypes,
    getExcludedKeywordSet,
    getExcludedStudyTypeSet,
  } = useExclusionPools(user?.id);

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

  // Track study type pool version to trigger re-evaluation on changes
  const [studyTypePoolVersion, setStudyTypePoolVersion] = useState(0);

  // Re-evaluate study types when pool changes (triggered by modal close)
  useEffect(() => {
    if (studyTypePoolVersion > 0) {
      const pool: StudyTypePoolEntry[] = poolStudyTypes.map(st => ({
        study_type: st.study_type,
        specificity_weight: st.specificity_weight,
        hierarchy_rank: st.hierarchy_rank,
      }));
      reevaluateStudyTypes(pool);
    }
  }, [studyTypePoolVersion]); // intentionally only depend on version counter

  const handleStudyTypePoolModalClose = useCallback(() => {
    setStudyTypePoolVersion(v => v + 1);
  }, []);

  // usePapers now receives the normalization config
  const {
    papers,
    projects,
    tags,
    loading,
    allKeywords,
    createProject,
    updateProject,
    deleteProject,
    createTag,
    updateTag,
    deleteTag,
    addPapers,
    addPaperManually,
    bulkImportPapers,
    updatePaper,
    deletePaper,
    bulkDeletePapers,
    bulkSetProjects,
    bulkSetTags,
    reevaluateStudyTypes,
  } = usePapers(user?.id, normalizationConfig);

  // Wrap delete to immediately re-evaluate with a fresh pool (avoids stale state)
  const handleDeletePoolStudyType = useCallback(async (id: string) => {
    await deletePoolStudyType(id);
    const freshPool: StudyTypePoolEntry[] = poolStudyTypes
      .filter(st => st.id !== id)
      .map(st => ({
        study_type: st.study_type,
        specificity_weight: st.specificity_weight,
        hierarchy_rank: st.hierarchy_rank,
      }));
    reevaluateStudyTypes(freshPool);
  }, [deletePoolStudyType, poolStudyTypes, reevaluateStudyTypes]);

  const handleDeleteAllPoolStudyTypes = useCallback(async () => {
    await deleteAllPoolStudyTypes();
    reevaluateStudyTypes([]);
  }, [deleteAllPoolStudyTypes, reevaluateStudyTypes]);

  const {
    visibleColumns,
    toggleColumn,
    availableColumns,
  } = useColumnVisibility();

  const {
    columnWidths,
    setColumnWidth,
  } = useColumnWidths();

  // Filter available keywords: derive from papers only, apply synonym mapping, exclude, deduplicate
  const filteredKeywords = useMemo(() => {
    // Step A: Flatten keywords + substances from ALL papers
    const allTerms = papers.flatMap(paper => [
      ...(paper.keywords || []),
      ...((paper.substances as string[]) || []),
      ...((paper.mesh_terms as string[]) || []),
    ]);

    // Step B: Map synonyms - child -> canonical (fixes self-canceling bug)
    const synonymChildMap = new Map<string, string>();
    synonymGroups.forEach(group => {
      group.synonyms.forEach(syn => synonymChildMap.set(syn.toLowerCase(), group.canonical_term));
    });

    const mappedTerms = allTerms.map(term => {
      const canonical = synonymChildMap.get(term.toLowerCase());
      return canonical || term;
    });

    // Step C: Filter exclusions
    const excludedSet = new Set(excludedKeywords.map(ek => ek.keyword.toLowerCase()));

    // Step D: Deduplicate & sort
    return Array.from(new Set(mappedTerms))
      .filter(kw => !excludedSet.has(kw.toLowerCase()))
      .sort();
  }, [papers, excludedKeywords, synonymGroups]);

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

  // Build dynamic study type filter options: only unique group_names
  const studyTypeFilterOptions = useMemo(() => {
    const groupSet = new Set<string>();
    poolStudyTypes.forEach(st => {
      if (st.group_name) groupSet.add(st.group_name);
    });
    return Array.from(groupSet).sort();
  }, [poolStudyTypes]);

  // Selection state
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedTagId, setSelectedTagId] = useState<string | null>(null);

  // Bulk selection state
  const [selectedPaperIds, setSelectedPaperIds] = useState<Set<string>>(new Set());

  const handleToggleSelect = useCallback((paperId: string) => {
    setSelectedPaperIds(prev => {
      const next = new Set(prev);
      if (next.has(paperId)) next.delete(paperId);
      else next.add(paperId);
      return next;
    });
  }, []);

  // Dialog state
  const [addPaperOpen, setAddPaperOpen] = useState(false);
  const [editingPaper, setEditingPaper] = useState<PaperWithTags | null>(null);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [editingTag, setEditingTag] = useState<Tag | null>(null);

  // Filter state
  const [searchQuery, setSearchQuery] = useState("");
  const [yearFrom, setYearFrom] = useState("");
  const [yearTo, setYearTo] = useState("");
  const [studyType, setStudyType] = useState("all");
  const [selectedKeywords, setSelectedKeywords] = useState<string[]>([]);

  useEffect(() => {
    if (!authLoading && !user) {
      navigate("/auth", { replace: true });
    }
  }, [user, authLoading, navigate]);

  // Filter papers (exclusions are now display-only, handled in PaperList)
  const filteredPapers = useMemo(() => {
    return papers.filter((paper) => {

      // Project filter
      if (selectedProjectId && !paper.projects.some((p) => p.id === selectedProjectId)) {
        return false;
      }

      // Tag filter
      if (selectedTagId && !paper.tags.some((t) => t.id === selectedTagId)) {
        return false;
      }

      // Search query
      if (searchQuery) {
        const query = searchQuery.toLowerCase();
        const matchesSearch =
          paper.title.toLowerCase().includes(query) ||
          paper.authors.some((a) => a.toLowerCase().includes(query)) ||
          (paper.journal && paper.journal.toLowerCase().includes(query)) ||
          (paper.abstract && paper.abstract.toLowerCase().includes(query));
        if (!matchesSearch) return false;
      }

      // Year range
      if (yearFrom && paper.year && paper.year < parseInt(yearFrom)) {
        return false;
      }
      if (yearTo && paper.year && paper.year > parseInt(yearTo)) {
        return false;
      }

      // Study type filter: match any subtype belonging to the selected group
      if (studyType !== "all") {
        const paperType = (paper.study_type || "").toLowerCase();
        const subtypesInGroup = poolStudyTypes
          .filter(st => st.group_name?.toLowerCase() === studyType.toLowerCase())
          .map(st => st.study_type.toLowerCase());
        if (!subtypesInGroup.includes(paperType)) return false;
      }

      // Keywords: combine all term sources and normalize through synonym pool
      if (selectedKeywords.length > 0) {
        const allTerms = [
          ...(paper.keywords || []),
          ...((paper.substances as string[]) || []),
          ...((paper.mesh_terms as string[]) || []),
        ];
        const synonymChildMap = new Map<string, string>();
        synonymGroups.forEach(group => {
          group.synonyms.forEach(syn => synonymChildMap.set(syn.toLowerCase(), group.canonical_term));
        });
        const normalizedTerms = allTerms.map(term => {
          const canonical = synonymChildMap.get(term.toLowerCase());
          return (canonical || term).toLowerCase();
        });
        const hasAllKeywords = selectedKeywords.every(kw =>
          normalizedTerms.includes(kw.toLowerCase())
        );
        if (!hasAllKeywords) return false;
      }

      return true;
    });
  }, [
    papers,
    selectedProjectId,
    selectedTagId,
    searchQuery,
    yearFrom,
    yearTo,
    studyType,
    studyTypeFilterOptions,
    selectedKeywords,
    synonymGroups,
  ]);

  // Bulk action handlers (must be after filteredPapers)
  const handleToggleSelectAll = useCallback(() => {
    setSelectedPaperIds(prev => {
      const allFilteredIds = filteredPapers.map(p => p.id);
      const allSelected = allFilteredIds.every(id => prev.has(id));
      if (allSelected) return new Set<string>();
      return new Set(allFilteredIds);
    });
  }, [filteredPapers]);

  const handleClearSelection = useCallback(() => {
    setSelectedPaperIds(new Set());
  }, []);

  const handleBulkDelete = useCallback(async () => {
    await bulkDeletePapers(Array.from(selectedPaperIds));
    setSelectedPaperIds(new Set());
  }, [selectedPaperIds, bulkDeletePapers]);

  const handleBulkSetProjects = useCallback(async (projectIds: string[]) => {
    await bulkSetProjects(Array.from(selectedPaperIds), projectIds);
    setSelectedPaperIds(new Set());
  }, [selectedPaperIds, bulkSetProjects]);

  const handleBulkSetTags = useCallback(async (tagIds: string[]) => {
    await bulkSetTags(Array.from(selectedPaperIds), tagIds);
    setSelectedPaperIds(new Set());
  }, [selectedPaperIds, bulkSetTags]);

  const hasActiveFilters =
    searchQuery !== "" ||
    yearFrom !== "" ||
    yearTo !== "" ||
    studyType !== "all" ||
    selectedKeywords.length > 0;

  const clearFilters = () => {
    setSearchQuery("");
    setYearFrom("");
    setYearTo("");
    setStudyType("all");
    setSelectedKeywords([]);
  };

  const handleExportCSV = () => {
    exportToCSV(filteredPapers);
    toast({ title: "Export started", description: `Downloading ${filteredPapers.length} papers as CSV.` });
  };

  const handleExportRIS = () => {
    exportToRIS(filteredPapers);
    toast({ title: "Export started", description: `Downloading ${filteredPapers.length} citations as RIS.` });
  };

  const handleKeywordToggle = (keyword: string) => {
    setSelectedKeywords((prev) =>
      prev.includes(keyword)
        ? prev.filter((k) => k !== keyword)
        : [...prev, keyword]
    );
  };

  const handleSavePaper = async (
    updates: Partial<PaperWithTags> & { tagIds: string[] }
  ) => {
    if (editingPaper) {
      // Apply synonym mapping to manually entered keywords before saving
      if (updates.keywords && Array.isArray(updates.keywords)) {
        const mapped = updates.keywords.map(kw => {
          const canonical = synonymLookup[kw.toLowerCase()];
          return canonical || kw;
        });
        // Deduplicate case-insensitively
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

  if (authLoading || loading) {
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
    <div className="flex min-h-screen flex-col bg-background">
      <Header />
      <div className="flex flex-1">
        <Sidebar
          projects={projects}
          tags={tags}
          selectedProjectId={selectedProjectId}
          selectedTagId={selectedTagId}
          onSelectProject={setSelectedProjectId}
          onSelectTag={setSelectedTagId}
          onCreateProject={createProject}
          onCreateTag={createTag}
          onEditProject={(p) => setEditingProject(p)}
          onDeleteProject={deleteProject}
          onEditTag={(t) => setEditingTag(t)}
          onDeleteTag={deleteTag}
          poolKeywords={poolKeywords}
          availableKeywords={allKeywords}
          onAddPoolKeyword={addPoolKeyword}
          onAddMultiplePoolKeywords={addMultiplePoolKeywords}
          onDeletePoolKeyword={deletePoolKeyword}
          onDeleteAllPoolKeywords={deleteAllPoolKeywords}
          synonymGroups={synonymGroups}
          onAddSynonymGroup={addSynonymGroup}
          onUpdateSynonymGroup={updateSynonymGroup}
          onDeleteSynonymGroup={deleteSynonymGroup}
          excludedKeywords={excludedKeywords}
          excludedStudyTypes={excludedStudyTypes}
          onAddExcludedKeyword={addExcludedKeyword}
          onDeleteExcludedKeyword={deleteExcludedKeyword}
          onClearExcludedKeywords={clearExcludedKeywords}
          onAddExcludedStudyType={addExcludedStudyType}
          onDeleteExcludedStudyType={deleteExcludedStudyType}
          onClearExcludedStudyTypes={clearExcludedStudyTypes}
          poolStudyTypes={poolStudyTypes}
          availableStudyTypes={allStudyTypes}
          onAddPoolStudyType={addPoolStudyType}
          onAddMultiplePoolStudyTypes={addMultiplePoolStudyTypes}
          onUpdatePoolStudyType={updatePoolStudyType}
          onDeletePoolStudyType={handleDeletePoolStudyType}
          onDeleteAllPoolStudyTypes={handleDeleteAllPoolStudyTypes}
          onRenamePoolGroup={renamePoolGroup}
          onDeletePoolGroup={deletePoolGroup}
          onStudyTypePoolModalClose={handleStudyTypePoolModalClose}
        />
        <main className="flex-1 p-6 overflow-auto">
          <div className="mb-6 flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold">
                {selectedProjectId
                  ? projects.find((p) => p.id === selectedProjectId)?.name
                  : selectedTagId
                  ? tags.find((t) => t.id === selectedTagId)?.name
                  : "All Papers"}
              </h1>
              <p className="text-muted-foreground">
                {filteredPapers.length} paper{filteredPapers.length !== 1 ? "s" : ""}
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
            />
          </div>

          <AnalyticsPanel papers={filteredPapers} />

          <PaperList
            papers={filteredPapers}
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
