import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Search, X, Download, FileText, FileSpreadsheet, BookOpen, Loader2 } from "lucide-react";
import { KeywordFilterDropdown } from "./KeywordFilterDropdown";
import { SearchableEntityMultiFilter } from "./SearchableEntityMultiFilter";
import { FilterPresetsMenu, type FilterPresetsMenuProps } from "./FilterPresetsMenu";
import { Project, Tag } from "@/types/database";
import type { NotesPresence } from "@/hooks/papers/types";
import type { ExportFormat } from "@/hooks/useExportPapers";

interface SearchFiltersProps {
  searchQuery: string;
  onSearchChange: (query: string) => void;
  yearFrom: string;
  yearTo: string;
  onYearFromChange: (year: string) => void;
  onYearToChange: (year: string) => void;
  studyType: string;
  onStudyTypeChange: (type: string) => void;
  studyTypeFilterOptions: string[];
  notesPresence: NotesPresence;
  onNotesPresenceChange: (v: NotesPresence) => void;
  selectedKeywords: string[];
  availableKeywords: string[];
  onKeywordToggle: (keyword: string) => void;
  onClearFilters: () => void;
  onExport: (format: ExportFormat) => void;
  hasActiveFilters: boolean;
  projects: Project[];
  tags: Tag[];
  selectedProjectIds: string[];
  selectedTagIds: string[];
  onProjectToggle: (projectId: string) => void;
  onTagToggle: (tagId: string) => void;
  onClearProjects: () => void;
  onClearTags: () => void;
  isExportReady?: boolean;
  isExporting?: boolean;
  /**
   * Saved Searches / Filter Presets bundle. Pure pass-through into
   * `<FilterPresetsMenu />` — see `FilterPresetsMenuProps` for the
   * authoritative per-field documentation.
   */
  filterPresets: FilterPresetsMenuProps;
}

export function SearchFilters({
  searchQuery,
  onSearchChange,
  yearFrom,
  yearTo,
  onYearFromChange,
  onYearToChange,
  studyType,
  onStudyTypeChange,
  studyTypeFilterOptions,
  notesPresence,
  onNotesPresenceChange,
  selectedKeywords,
  availableKeywords,
  onKeywordToggle,
  onClearFilters,
  onExport,
  hasActiveFilters,
  projects,
  tags,
  selectedProjectIds,
  selectedTagIds,
  onProjectToggle,
  onTagToggle,
  onClearProjects,
  onClearTags,
  isExportReady,
  isExporting = false,
  filterPresets,
}: SearchFiltersProps) {

  // Export gating: based on isExportReady (from useExportPapers)
  const exportDisabled = !isExportReady || isExporting;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-4 items-center">
        {/* Search */}
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder={'Search titles, authors, notes, keywords... Use "..." for exact phrase'}
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            className="pl-9"
          />
        </div>

        {/* Year range */}
        <div className="flex items-center gap-2">
          <Input
            type="number"
            placeholder="From"
            value={yearFrom}
            onChange={(e) => onYearFromChange(e.target.value)}
            className="w-24"
          />
          <span className="text-muted-foreground">-</span>
          <Input
            type="number"
            placeholder="To"
            value={yearTo}
            onChange={(e) => onYearToChange(e.target.value)}
            className="w-24"
          />
        </div>

        {/* Study Type */}
        <Select value={studyType} onValueChange={onStudyTypeChange}>
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="Study Type" />
          </SelectTrigger>
          <SelectContent className="bg-popover">
            <SelectItem value="all">All Types</SelectItem>
            {studyTypeFilterOptions.map((type) => (
              <SelectItem key={type} value={type}>
                {type}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Notes presence */}
        <Select value={notesPresence} onValueChange={(v) => onNotesPresenceChange(v as NotesPresence)}>
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="Notes" />
          </SelectTrigger>
          <SelectContent className="bg-popover">
            <SelectItem value="all">All Papers</SelectItem>
            <SelectItem value="has">Has notes</SelectItem>
            <SelectItem value="none">No notes</SelectItem>
          </SelectContent>
        </Select>

        {/* Project Filter (searchable multi-select) */}
        <SearchableEntityMultiFilter
          items={projects}
          selectedIds={selectedProjectIds}
          onToggle={onProjectToggle}
          onClear={onClearProjects}
          allLabel="All Projects"
          nounSingular="Project"
          nounPlural="Projects"
          searchPlaceholder="Search projects..."
          emptyMessage="No projects found."
          ariaLabel="Filter by project"
        />

        {/* Tag Filter (searchable multi-select) */}
        <SearchableEntityMultiFilter
          items={tags}
          selectedIds={selectedTagIds}
          onToggle={onTagToggle}
          onClear={onClearTags}
          allLabel="All Tags"
          nounSingular="Tag"
          nounPlural="Tags"
          searchPlaceholder="Search tags..."
          emptyMessage="No tags found."
          ariaLabel="Filter by tag"
        />

        {/* Keywords Dropdown */}
        <KeywordFilterDropdown
          selectedKeywords={selectedKeywords}
          availableKeywords={availableKeywords}
          onKeywordToggle={onKeywordToggle}
        />

        {/* Actions */}
        <div className="flex gap-2">
          <FilterPresetsMenu {...filterPresets} />
          {hasActiveFilters && (
            <Button variant="outline" size="sm" onClick={onClearFilters}>
              <X className="mr-1 h-4 w-4" />
              Clear
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" disabled={exportDisabled} title={exportDisabled ? (isExporting ? "Exporting…" : "Loading…") : undefined}>
                {isExporting ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Download className="mr-1 h-4 w-4" />}
                {isExporting ? "Exporting…" : "Export"}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="bg-popover">
              <DropdownMenuItem onClick={() => onExport("csv")}>
                <FileSpreadsheet className="mr-2 h-4 w-4" />
                Export as CSV
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onExport("ris")}>
                <FileText className="mr-2 h-4 w-4" />
                Export as RIS
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onExport("bibtex")}>
                <BookOpen className="mr-2 h-4 w-4" />
                Export as BibTeX
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  );
}
