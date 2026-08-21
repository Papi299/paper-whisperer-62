import { Paper } from "@/types/database";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { AnalyticsContent } from "./AnalyticsContent";
import type { AnalyticsTargets } from "@/hooks/useAnalyticsTargets";
import type { AuthorIdentityDataset, AuthorIdentityPaper } from "@/lib/authorIdentity";
import type { AuthorIdentityReadState } from "@/hooks/useAuthorIdentities";
import type { useAuthorIdentities } from "@/hooks/useAuthorIdentities";

interface MobileAnalyticsSheetProps {
  papers: Paper[];
  isLoading: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * The user's author-identity decisions, or `null` when the identity subsystem
   * is not installed in this environment. Shared with `AnalyticsPanel` so both
   * shells group authors identically across the breakpoint.
   */
  identityDataset?: AuthorIdentityDataset | null;
  /** User-wide linked-paper evidence, forwarded untouched. See `AnalyticsContent`. */
  identityEvidencePapers?: readonly AuthorIdentityPaper[];
  /** Why the identity dataset looks the way it does. See `AnalyticsContent`. */
  identityReadState?: AuthorIdentityReadState;
  /** The identity read/write API, forwarded so the manager can be opened here. */
  identities?: ReturnType<typeof useAuthorIdentities>;
  /** Owned by the Dashboard and shared with `AnalyticsPanel`. */
  targets: AnalyticsTargets;
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
 *
 * It renders only below 768px, so it and the desktop `AnalyticsPanel` are never
 * mounted together — no duplicate analytics controls in the accessibility tree.
 * The selection state they show is therefore held by the Dashboard, above the
 * point where the two swap.
 */
export function MobileAnalyticsSheet({
  papers,
  isLoading,
  open,
  onOpenChange,
  targets,
  identityDataset = null,
  identityEvidencePapers,
  identityReadState,
  identities,
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
          <AnalyticsContent
            papers={papers}
            isLoading={isLoading}
            targets={targets}
            identityDataset={identityDataset}
            identityEvidencePapers={identityEvidencePapers}
            identityReadState={identityReadState}
            identities={identities}
            compact
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}
