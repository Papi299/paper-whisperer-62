import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { X, Download, Loader2 } from "lucide-react";
import { FilterControls, type FilterControlsProps } from "./FilterControls";
import { PaperSearchField } from "./PaperSearchField";
import { FilterPresetsMenu, type FilterPresetsMenuProps } from "./FilterPresetsMenu";
import { EXPORT_FORMAT_OPTIONS } from "@/lib/exportFormats";
import type { ExportFormat } from "@/hooks/useExportPapers";

interface SearchFiltersProps extends Omit<FilterControlsProps, "variant"> {
  searchQuery: string;
  onSearchChange: (query: string) => void;
  onClearFilters: () => void;
  onExport: (format: ExportFormat) => void;
  hasActiveFilters: boolean;
  isExportReady?: boolean;
  isExporting?: boolean;
  /**
   * Saved Searches / Filter Presets bundle. Pure pass-through into
   * `<FilterPresetsMenu />` — see `FilterPresetsMenuProps` for the
   * authoritative per-field documentation.
   */
  filterPresets: FilterPresetsMenuProps;
}

/**
 * The desktop search + filter toolbar: one wrapping row of inline controls.
 *
 * This is now a thin composition of `PaperSearchField`, `FilterControls` and
 * the actions, rather than owning that markup itself — the mobile Filters sheet
 * renders the same `FilterControls` in its stacked variant, so the two
 * presentations cannot drift apart in which filters they offer or what those
 * filters mean. The rendered desktop result is unchanged.
 */
export function SearchFilters({
  searchQuery,
  onSearchChange,
  onClearFilters,
  onExport,
  hasActiveFilters,
  isExportReady,
  isExporting = false,
  filterPresets,
  ...filterControls
}: SearchFiltersProps) {
  // Export gating: based on isExportReady (from useExportPapers)
  const exportDisabled = !isExportReady || isExporting;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-4 items-center">
        <PaperSearchField
          value={searchQuery}
          onChange={onSearchChange}
          className="flex-1 min-w-[200px]"
        />

        <FilterControls {...filterControls} variant="inline" />

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
              {EXPORT_FORMAT_OPTIONS.map(({ format, label, Icon }) => (
                <DropdownMenuItem key={format} onClick={() => onExport(format)}>
                  <Icon className="mr-2 h-4 w-4" />
                  {label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  );
}
