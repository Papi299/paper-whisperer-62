import { useState, useMemo, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { usePapers } from "@/hooks/usePapers";
import { useKeywordPool } from "@/hooks/useKeywordPool";
import { useSynonymPool } from "@/hooks/useSynonymPool";
import { useExclusionPools } from "@/hooks/useExclusionPools";
import { useColumnVisibility } from "@/hooks/useColumnVisibility";
import { useColumnWidths } from "@/hooks/useColumnWidths";
import { Header } from "@/components/layout/Header";
import { Sidebar } from "@/components/layout/Sidebar";
import { PaperList } from "@/components/papers/PaperList";
import { AddPaperDialog } from "@/components/papers/AddPaperDialog";
import { EditPaperDialog } from "@/components/papers/EditPaperDialog";
import { SearchFilters } from "@/components/papers/SearchFilters";
import { ColumnVisibilityDropdown } from "@/components/papers/ColumnVisibilityDropdown";
import { Button } from "@/components/ui/button";
import { PaperWithTags, Project, Tag } from "@/types/database";
import { Plus, Loader2 } from "lucide-react";

export function Dashboard() {
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();

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
    updatePaper,
    deletePaper,
  } = usePapers(user?.id);

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
  } = useSynonymPool(user?.id);

  const {
    excludedKeywords,
    excludedStudyTypes,
    addExcludedKeyword,
    deleteExcludedKeyword,
    clearExcludedKeywords,
    addExcludedStudyType,
    deleteExcludedStudyType,
    clearExcludedStudyTypes,
    shouldExcludePaper,
    getExcludedKeywordSet,
  } = useExclusionPools(user?.id);

  const {
    visibleColumns,
    toggleColumn,
    availableColumns,
  } = useColumnVisibility();

  const {
    columnWidths,
    setColumnWidth,
  } = useColumnWidths();

  // Selection state
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedTagId, setSelectedTagId] = useState<string | null>(null);

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

  // Filter papers
  const filteredPapers = useMemo(() => {
    return papers.filter((paper) => {
      // Check study type exclusion (keywords are filtered at display level)
      if (shouldExcludePaper(paper.study_type)) {
        return false;
      }

      // Project filter
      if (selectedProjectId && paper.project_id !== selectedProjectId) {
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

      // Study type
      if (studyType !== "all" && paper.study_type !== studyType) {
        return false;
      }

      // Keywords
      if (selectedKeywords.length > 0) {
        const hasAllKeywords = selectedKeywords.every((kw) =>
          paper.keywords.includes(kw)
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
    selectedKeywords,
    shouldExcludePaper,
  ]);

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

  const handleExport = () => {
    const headers = [
      "Title",
      "Authors",
      "Year",
      "Journal",
      "PMID",
      "DOI",
      "Study Type",
      "Statistical Methods",
      "Keywords",
      "Tags",
      "Project",
    ];

    const rows = filteredPapers.map((paper) => [
      paper.title,
      paper.authors.join("; "),
      paper.year?.toString() || "",
      paper.journal || "",
      paper.pmid || "",
      paper.doi || "",
      paper.study_type || "",
      paper.statistical_methods || "",
      paper.keywords.join("; "),
      paper.tags.map((t) => t.name).join("; "),
      paper.project?.name || "",
    ]);

    const csvContent = [
      headers.join(","),
      ...rows.map((row) =>
        row.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(",")
      ),
    ].join("\n");

    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `paper-index-${new Date().toISOString().split("T")[0]}.csv`;
    link.click();
    URL.revokeObjectURL(url);
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
              selectedKeywords={selectedKeywords}
              availableKeywords={allKeywords}
              onKeywordToggle={handleKeywordToggle}
              onClearFilters={clearFilters}
              onExport={handleExport}
              hasActiveFilters={hasActiveFilters}
            />
          </div>

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
          />
        </main>
      </div>

      <AddPaperDialog
        open={addPaperOpen}
        onOpenChange={setAddPaperOpen}
        onSubmit={addPapers}
        onSubmitManual={addPaperManually}
      />

      <EditPaperDialog
        paper={editingPaper}
        projects={projects}
        tags={tags}
        open={!!editingPaper}
        onOpenChange={(open) => !open && setEditingPaper(null)}
        onSave={handleSavePaper}
      />
    </div>
  );
}

export default Dashboard;
