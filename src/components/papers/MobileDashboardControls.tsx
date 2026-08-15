import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Menu, Plus, SlidersHorizontal, MoreHorizontal } from "lucide-react";
import { AiQuotaIndicator } from "./AiQuotaIndicator";
import { PaperSearchField } from "./PaperSearchField";
import { MobileFiltersSheet } from "./MobileFiltersSheet";
import { MobileLibraryActionsSheet } from "./MobileLibraryActionsSheet";
import {
  countActiveFilterCategories,
  describeFiltersTrigger,
  type FilterCategoryState,
} from "@/lib/activeFilterCategories";
import type { FilterControlsProps } from "./FilterControls";
import type { FilterPresetsMenuProps } from "./FilterPresetsMenu";
import type { AiQuotaStatus } from "@/hooks/useAiQuota";
import type { ExportFormat } from "@/hooks/useExportPapers";
import { ColumnId, ColumnConfig } from "@/hooks/useColumnVisibility";

interface MobileDashboardControlsProps extends Omit<FilterControlsProps, "variant"> {
  /** Header identity. */
  countLabel: string;
  onOpenNav: () => void;
  navOpen: boolean;
  onAddPapers: () => void;

  /** Permanent search. */
  searchQuery: string;
  onSearchChange: (query: string) => void;

  /** Utility row. */
  aiQuotaStatus: AiQuotaStatus | null;
  aiQuotaLoading: boolean;
  aiQuotaError: boolean;

  /** Filters sheet. */
  onClearFilters: () => void;
  hasActiveFilters: boolean;
  filterPresets: FilterPresetsMenuProps;

  /** More sheet. */
  availableColumns: ColumnConfig[];
  visibleColumns: ColumnId[];
  onToggleColumn: (columnId: ColumnId) => void;
  onFindDuplicates: () => void;
  onOpenAnalytics: () => void;
  onExport: (format: ExportFormat) => void;
  isExportReady?: boolean;
  isExporting?: boolean;
}

/**
 * The permanent smartphone control region: three compact levels, and nothing
 * else.
 *
 * PFA-C09 stopped the toolbar overflowing sideways by letting it wrap, which
 * turned fifteen controls into a wall of chrome roughly 74% of a 390x844
 * viewport tall — the paper table was reduced to a sliver at the bottom. The
 * fix is progressive disclosure, not deletion: everything low-frequency moved
 * behind `Filters` and `More`, and what stays is what a phone user reaches for
 * constantly.
 *
 *   Level 1  [Menu]  Papers / N papers            [+ Add]
 *   Level 2  [ Search papers                            ]
 *   Level 3  [Filters 3] [More]                    [✨ ∞]
 */
export function MobileDashboardControls({
  countLabel,
  onOpenNav,
  navOpen,
  onAddPapers,
  searchQuery,
  onSearchChange,
  aiQuotaStatus,
  aiQuotaLoading,
  aiQuotaError,
  onClearFilters,
  hasActiveFilters,
  filterPresets,
  availableColumns,
  visibleColumns,
  onToggleColumn,
  onFindDuplicates,
  onOpenAnalytics,
  onExport,
  isExportReady,
  isExporting,
  ...filterControls
}: MobileDashboardControlsProps) {
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);

  // Derived from the same filter state the sheet edits — never from the DOM.
  const categoryState: FilterCategoryState = {
    yearFrom: filterControls.yearFrom,
    yearTo: filterControls.yearTo,
    studyType: filterControls.studyType,
    notesPresence: filterControls.notesPresence,
    selectedKeywords: filterControls.selectedKeywords,
    selectedProjectIds: filterControls.selectedProjectIds,
    selectedTagIds: filterControls.selectedTagIds,
  };
  const activeCount = countActiveFilterCategories(categoryState);

  return (
    <>
      <div className="flex flex-col gap-2">
        {/* ── Level 1 — library identity, navigation and the primary action ── */}
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="icon"
            className="shrink-0"
            aria-label="Open navigation menu"
            aria-haspopup="dialog"
            aria-expanded={navOpen}
            onClick={onOpenNav}
          >
            <Menu className="h-4 w-4" aria-hidden="true" />
          </Button>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-lg font-bold leading-tight">Papers</h1>
            <p className="truncate text-xs text-muted-foreground">{countLabel}</p>
          </div>
          {/* Visible label is shortened to fit the row; the accessible name is
              not, so it still matches the desktop control. */}
          <Button className="shrink-0" aria-label="Add papers" onClick={onAddPapers}>
            <Plus className="mr-1 h-4 w-4" aria-hidden="true" />
            Add
          </Button>
        </div>

        {/* ── Level 2 — search stays permanently visible ── */}
        <PaperSearchField value={searchQuery} onChange={onSearchChange} />

        {/* ── Level 3 — progressive disclosure plus compact status ── */}
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            className="shrink-0"
            aria-label={describeFiltersTrigger(activeCount)}
            aria-haspopup="dialog"
            aria-expanded={filtersOpen}
            onClick={() => setFiltersOpen(true)}
          >
            <SlidersHorizontal className="mr-2 h-4 w-4" aria-hidden="true" />
            Filters
            {activeCount > 0 && (
              <Badge variant="secondary" className="ml-2 h-5 px-1.5 tabular-nums">
                {activeCount}
              </Badge>
            )}
          </Button>
          <Button
            variant="outline"
            className="shrink-0"
            aria-label="More library actions"
            aria-haspopup="dialog"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen(true)}
          >
            <MoreHorizontal className="mr-2 h-4 w-4" aria-hidden="true" />
            More
          </Button>
          <div className="ml-auto min-w-0">
            <AiQuotaIndicator
              status={aiQuotaStatus}
              isLoading={aiQuotaLoading}
              isError={aiQuotaError}
              variant="compact"
            />
          </div>
        </div>
      </div>

      <MobileFiltersSheet
        open={filtersOpen}
        onOpenChange={setFiltersOpen}
        onClearFilters={onClearFilters}
        hasActiveFilters={hasActiveFilters}
        filterPresets={filterPresets}
        {...filterControls}
      />

      <MobileLibraryActionsSheet
        open={moreOpen}
        onOpenChange={setMoreOpen}
        availableColumns={availableColumns}
        visibleColumns={visibleColumns}
        onToggleColumn={onToggleColumn}
        onFindDuplicates={onFindDuplicates}
        onOpenAnalytics={onOpenAnalytics}
        onExport={onExport}
        isExportReady={isExportReady}
        isExporting={isExporting}
      />
    </>
  );
}
