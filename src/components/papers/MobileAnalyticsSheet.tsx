import { Paper } from "@/types/database";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { AnalyticsContent } from "./AnalyticsContent";

interface MobileAnalyticsSheetProps {
  papers: Paper[];
  isLoading: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Analytics on a phone.
 *
 * Desktop keeps the inline Collapsible, which pushes the table down when
 * expanded. Doing that on mobile would undo the entire point of the compact
 * layout, so here the same `AnalyticsContent` opens in a bottom sheet
 * *over* the dashboard: the table's vertical geometry is untouched, and
 * closing returns the user to exactly the view they left.
 *
 * The sheet owns the vertical scrolling and is capped below full height so it
 * always reads as an overlay rather than a new page.
 */
export function MobileAnalyticsSheet({
  papers,
  isLoading,
  open,
  onOpenChange,
}: MobileAnalyticsSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="flex h-[88vh] flex-col gap-0 p-0"
      >
        <SheetHeader className="space-y-1 border-b px-4 py-4 text-left">
          <SheetTitle>Analytics &amp; Insights</SheetTitle>
          <SheetDescription>
            Distributions across the papers currently matching your filters.
          </SheetDescription>
        </SheetHeader>
        {/* `overflow-x-hidden` keeps a wide chart inside the sheet instead of
            letting it push the document sideways. */}
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-4">
          <AnalyticsContent papers={papers} isLoading={isLoading} compact />
        </div>
      </SheetContent>
    </Sheet>
  );
}
