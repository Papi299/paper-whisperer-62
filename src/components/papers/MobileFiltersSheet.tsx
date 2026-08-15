import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { X } from "lucide-react";
import { FilterControls, type FilterControlsProps } from "./FilterControls";
import { FilterPresetsMenu, type FilterPresetsMenuProps } from "./FilterPresetsMenu";

interface MobileFiltersSheetProps extends Omit<FilterControlsProps, "variant"> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * The dashboard's existing clear action. It clears the search query too, so
   * the button below says so rather than implying it only resets what is
   * visible inside this sheet.
   */
  onClearFilters: () => void;
  hasActiveFilters: boolean;
  filterPresets: FilterPresetsMenuProps;
}

/**
 * The mobile filter surface.
 *
 * Every non-search filter moves in here so the permanent toolbar can shrink to
 * three compact rows. Deliberately NOT an Apply/draft-state form: the controls
 * write straight through to the dashboard's existing filter state, exactly as
 * the desktop toolbar does, so results update live behind the overlay and
 * reopening always shows the current selection. There is no second copy of the
 * filter state to keep in sync.
 *
 * Search is not here on purpose — it stays permanently visible above the table.
 */
export function MobileFiltersSheet({
  open,
  onOpenChange,
  onClearFilters,
  hasActiveFilters,
  filterPresets,
  ...filterControls
}: MobileFiltersSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex w-[92vw] max-w-[26rem] flex-col gap-0 p-0 sm:max-w-[26rem]"
      >
        <SheetHeader className="space-y-1 border-b px-4 py-4 text-left">
          <SheetTitle>Filters</SheetTitle>
          <SheetDescription>Refine the papers shown in your library.</SheetDescription>
        </SheetHeader>

        {/* The filters scroll; the actions below stay reachable without
            scrolling to the bottom of a long list. */}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <FilterControls {...filterControls} variant="stacked" />
        </div>

        <div className="flex items-center gap-2 border-t px-4 py-3">
          <FilterPresetsMenu {...filterPresets} />
          {hasActiveFilters && (
            <Button variant="outline" size="sm" onClick={onClearFilters}>
              <X className="mr-1 h-4 w-4" aria-hidden="true" />
              {/* Truthful label: the shared handler also clears the search
                  field, which lives outside this sheet. */}
              Clear all filters
            </Button>
          )}
          <Button size="sm" className="ml-auto" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
