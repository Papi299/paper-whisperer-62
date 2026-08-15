import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { KeywordFilterDropdown } from "./KeywordFilterDropdown";
import { SearchableEntityMultiFilter } from "./SearchableEntityMultiFilter";
import { Project, Tag } from "@/types/database";
import type { EntityMatchMode } from "@/lib/filterSets";
import type { NotesPresence } from "@/hooks/papers/types";
import { cn } from "@/lib/utils";

export interface FilterControlsProps {
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
  projects: Project[];
  tags: Tag[];
  selectedProjectIds: string[];
  selectedTagIds: string[];
  onProjectToggle: (projectId: string) => void;
  onTagToggle: (tagId: string) => void;
  onClearProjects: () => void;
  onClearTags: () => void;
  projectMatchMode: EntityMatchMode;
  tagMatchMode: EntityMatchMode;
  onProjectMatchModeChange: (mode: EntityMatchMode) => void;
  onTagMatchModeChange: (mode: EntityMatchMode) => void;
  /**
   * `inline` — the desktop toolbar: one wrapping row of compact controls.
   * `stacked` — the mobile Filters sheet: full-width controls in labelled
   * sections, sized for a thumb rather than a cursor.
   *
   * Only the presentation differs. Both variants are driven by the same
   * handlers and the same state, so a filter can never mean one thing on a
   * phone and another on a laptop.
   */
  variant?: "inline" | "stacked";
}

/** Section wrapper used by the stacked (mobile) variant only. */
function FilterSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium text-foreground">{title}</h3>
      {children}
    </div>
  );
}

/**
 * Every non-search filter control on the Papers dashboard.
 *
 * Search is intentionally NOT here: on mobile it stays permanently visible
 * outside the Filters sheet, so keeping it in this component would either
 * duplicate the field or drag it into the overlay.
 */
export function FilterControls({
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
  projects,
  tags,
  selectedProjectIds,
  selectedTagIds,
  onProjectToggle,
  onTagToggle,
  onClearProjects,
  onClearTags,
  projectMatchMode,
  tagMatchMode,
  onProjectMatchModeChange,
  onTagMatchModeChange,
  variant = "inline",
}: FilterControlsProps) {
  const stacked = variant === "stacked";

  const yearRange = (
    <div className="flex items-center gap-2">
      <Label htmlFor="year-from" className="sr-only">
        Published from year
      </Label>
      <Input
        id="year-from"
        type="number"
        placeholder="From"
        value={yearFrom}
        onChange={(e) => onYearFromChange(e.target.value)}
        className={cn(stacked ? "flex-1" : "w-24")}
      />
      <span className="text-muted-foreground" aria-hidden="true">
        -
      </span>
      <Label htmlFor="year-to" className="sr-only">
        Published to year
      </Label>
      <Input
        id="year-to"
        type="number"
        placeholder="To"
        value={yearTo}
        onChange={(e) => onYearToChange(e.target.value)}
        className={cn(stacked ? "flex-1" : "w-24")}
      />
    </div>
  );

  {
    /* A Radix select trigger takes its name from the selected value ("All
       Types"), which says nothing about what it filters — hence aria-label. */
  }
  const studyTypeSelect = (
    <Select value={studyType} onValueChange={onStudyTypeChange}>
      <SelectTrigger
        className={cn(stacked ? "w-full" : "w-[180px]")}
        aria-label="Filter by study type"
      >
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
  );

  const notesSelect = (
    <Select
      value={notesPresence}
      onValueChange={(v) => onNotesPresenceChange(v as NotesPresence)}
    >
      <SelectTrigger
        className={cn(stacked ? "w-full" : "w-[160px]")}
        aria-label="Filter by notes presence"
      >
        <SelectValue placeholder="Notes" />
      </SelectTrigger>
      <SelectContent className="bg-popover">
        <SelectItem value="all">All Papers</SelectItem>
        <SelectItem value="has">Has notes</SelectItem>
        <SelectItem value="none">No notes</SelectItem>
      </SelectContent>
    </Select>
  );

  const projectFilter = (
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
      matchMode={projectMatchMode}
      onMatchModeChange={onProjectMatchModeChange}
      matchModeGroupLabel="Match projects"
      matchAnyDescription="Match papers in at least one selected project"
      matchAllDescription="Match papers in every selected project"
      variant={stacked ? "stacked" : "inline"}
    />
  );

  const tagFilter = (
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
      matchMode={tagMatchMode}
      onMatchModeChange={onTagMatchModeChange}
      matchModeGroupLabel="Match tags"
      matchAnyDescription="Match papers with at least one selected tag"
      matchAllDescription="Match papers with every selected tag"
      variant={stacked ? "stacked" : "inline"}
    />
  );

  const keywordFilter = (
    <KeywordFilterDropdown
      selectedKeywords={selectedKeywords}
      availableKeywords={availableKeywords}
      onKeywordToggle={onKeywordToggle}
      variant={stacked ? "stacked" : "inline"}
    />
  );

  if (stacked) {
    return (
      <div className="space-y-5">
        <FilterSection title="Publication year">{yearRange}</FilterSection>
        <FilterSection title="Study type">{studyTypeSelect}</FilterSection>
        <FilterSection title="Notes">{notesSelect}</FilterSection>
        <FilterSection title="Projects">{projectFilter}</FilterSection>
        <FilterSection title="Tags">{tagFilter}</FilterSection>
        {availableKeywords.length > 0 && (
          <FilterSection title="Keywords">{keywordFilter}</FilterSection>
        )}
      </div>
    );
  }

  return (
    <>
      {yearRange}
      {studyTypeSelect}
      {notesSelect}
      {projectFilter}
      {tagFilter}
      {keywordFilter}
    </>
  );
}
