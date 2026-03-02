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
import { Search, X, Download, FileText, FileSpreadsheet } from "lucide-react";
import { KeywordFilterDropdown } from "./KeywordFilterDropdown";
import { Project, Tag } from "@/types/database";

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
  selectedKeywords: string[];
  availableKeywords: string[];
  onKeywordToggle: (keyword: string) => void;
  onClearFilters: () => void;
  onExportCSV: () => void;
  onExportRIS: () => void;
  hasActiveFilters: boolean;
  projects: Project[];
  tags: Tag[];
  selectedProjectId: string | null;
  selectedTagId: string | null;
  onProjectChange: (projectId: string | null) => void;
  onTagChange: (tagId: string | null) => void;
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
  selectedKeywords,
  availableKeywords,
  onKeywordToggle,
  onClearFilters,
  onExportCSV,
  onExportRIS,
  hasActiveFilters,
  projects,
  tags,
  selectedProjectId,
  selectedTagId,
  onProjectChange,
  onTagChange,
}: SearchFiltersProps) {

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-4 items-center">
        {/* Search */}
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search titles, authors, journals..."
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

        {/* Project Filter */}
        <Select
          value={selectedProjectId ?? "all"}
          onValueChange={(v) => onProjectChange(v === "all" ? null : v)}
        >
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="Project" />
          </SelectTrigger>
          <SelectContent className="bg-popover">
            <SelectItem value="all">All Projects</SelectItem>
            {projects.map((project) => (
              <SelectItem key={project.id} value={project.id}>
                <div className="flex items-center gap-2">
                  <div
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ backgroundColor: project.color }}
                  />
                  {project.name}
                </div>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Tag Filter */}
        <Select
          value={selectedTagId ?? "all"}
          onValueChange={(v) => onTagChange(v === "all" ? null : v)}
        >
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="Tag" />
          </SelectTrigger>
          <SelectContent className="bg-popover">
            <SelectItem value="all">All Tags</SelectItem>
            {tags.map((tag) => (
              <SelectItem key={tag.id} value={tag.id}>
                <div className="flex items-center gap-2">
                  <div
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ backgroundColor: tag.color }}
                  />
                  {tag.name}
                </div>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Keywords Dropdown */}
        <KeywordFilterDropdown
          selectedKeywords={selectedKeywords}
          availableKeywords={availableKeywords}
          onKeywordToggle={onKeywordToggle}
        />

        {/* Actions */}
        <div className="flex gap-2">
          {hasActiveFilters && (
            <Button variant="outline" size="sm" onClick={onClearFilters}>
              <X className="mr-1 h-4 w-4" />
              Clear
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                <Download className="mr-1 h-4 w-4" />
                Export
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="bg-popover">
              <DropdownMenuItem onClick={onExportCSV}>
                <FileSpreadsheet className="mr-2 h-4 w-4" />
                Export as CSV
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onExportRIS}>
                <FileText className="mr-2 h-4 w-4" />
                Export as RIS
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  );
}
