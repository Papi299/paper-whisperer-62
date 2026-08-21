import { Paper } from "@/types/database";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { BarChart3, ChevronDown, ChevronUp } from "lucide-react";
import { AnalyticsContent } from "./AnalyticsContent";
import type { AnalyticsTargets } from "@/hooks/useAnalyticsTargets";
import type { AuthorIdentityDataset, AuthorIdentityPaper } from "@/lib/authorIdentity";
import type { AuthorIdentityReadState } from "@/hooks/useAuthorIdentities";
import type { useAuthorIdentities } from "@/hooks/useAuthorIdentities";

interface AnalyticsPanelProps {
  papers: Paper[];
  isLoading: boolean;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * The user's author-identity decisions, or `null` when the identity subsystem
   * is not installed in this environment. Passed through untouched — this shell
   * makes no author decisions of its own.
   */
  identityDataset?: AuthorIdentityDataset | null;
  /** User-wide linked-paper evidence, forwarded untouched. See `AnalyticsContent`. */
  identityEvidencePapers?: readonly AuthorIdentityPaper[];
  /** Why the identity dataset looks the way it does. See `AnalyticsContent`. */
  identityReadState?: AuthorIdentityReadState;
  /** The identity read/write API, forwarded so the manager can be opened here. */
  identities?: ReturnType<typeof useAuthorIdentities>;
  /** Owned by the Dashboard and shared with `MobileAnalyticsSheet`. */
  targets: AnalyticsTargets;
}

/**
 * Desktop analytics shell: an inline Collapsible in the Dashboard header.
 *
 * Expanding it pushes the paper table down, which is acceptable on a laptop and
 * is exactly what it has always done. On a phone it is not — the table would be
 * driven off screen, defeating the whole point of the compact mobile layout — so
 * narrow viewports render `AnalyticsContent` in an overlay instead
 * (`MobileAnalyticsSheet`). Both shells share this one body, one
 * `isAnalyticsOpen` state and one `AnalyticsTargets` selection state, so the
 * two presentations cannot disagree about whether analytics is open, what it
 * shows, or which targets the user picked — including across a resize, which
 * swaps which of the two shells is mounted.
 */
export function AnalyticsPanel({
  papers,
  isLoading,
  isOpen,
  onOpenChange,
  targets,
  identityDataset = null,
  identityEvidencePapers,
  identityReadState,
  identities,
}: AnalyticsPanelProps) {
  return (
    <Collapsible open={isOpen} onOpenChange={onOpenChange}>
      <CollapsibleTrigger asChild>
        <Button variant="outline" size="sm" className="mb-4 gap-2">
          <BarChart3 className="h-4 w-4" aria-hidden="true" />
          Analytics & Insights
          {isOpen ? (
            <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
          )}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <Card className="mb-4">
          <CardContent className="pt-4 pb-4">
            <AnalyticsContent
              papers={papers}
              isLoading={isLoading}
              targets={targets}
              identityDataset={identityDataset}
              identityEvidencePapers={identityEvidencePapers}
              identityReadState={identityReadState}
              identities={identities}
            />
          </CardContent>
        </Card>
      </CollapsibleContent>
    </Collapsible>
  );
}
