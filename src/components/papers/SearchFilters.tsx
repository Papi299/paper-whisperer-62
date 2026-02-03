import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Search, X, Download } from "lucide-react";
import { KeywordFilterDropdown } from "./KeywordFilterDropdown";

interface SearchFiltersProps {
  searchQuery: string;
  onSearchChange: (query: string) => void;
  yearFrom: string;
  yearTo: string;
  onYearFromChange: (year: string) => void;
  onYearToChange: (year: string) => void;
  studyType: string;
  onStudyTypeChange: (type: string) => void;
  selectedKeywords: string[];
  availableKeywords: string[];
  onKeywordToggle: (keyword: string) => void;
  onClearFilters: () => void;
  onExport: () => void;
  hasActiveFilters: boolean;
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
  selectedKeywords,
  availableKeywords,
  onKeywordToggle,
  onClearFilters,
  onExport,
  hasActiveFilters,
}: SearchFiltersProps) {
  const studyTypes = [
    "RCT",
    "Meta-analysis",
    "Systematic Review",
    "Cohort Study",
    "Case-Control",
    "Cross-sectional",
    "Case Report",
    "Review",
  ];

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
            {studyTypes.map((type) => (
              <SelectItem key={type} value={type}>
                {type}
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
          <Button variant="outline" size="sm" onClick={onExport}>
            <Download className="mr-1 h-4 w-4" />
            Export
          </Button>
        </div>
      </div>
    </div>
  );
}
