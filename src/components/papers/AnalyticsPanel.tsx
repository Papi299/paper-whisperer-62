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

interface AnalyticsPanelProps {
  papers: Paper[];
  isLoading: boolean;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Desktop analytics shell: an inline Collapsible in the Dashboard header.
 *
 * Expanding it pushes the paper table down, which is acceptable on a laptop and
 * is exactly what it has always done. On a phone it is not — the table would be
 * driven off screen, defeating the whole point of the compact mobile layout — so
 * narrow viewports render `AnalyticsContent` in an overlay instead
 * (`MobileAnalyticsSheet`). Both shells share this one body and one
 * `isAnalyticsOpen` state, so the two presentations cannot disagree about
 * whether analytics is open or what it shows.
 */
export function AnalyticsPanel({ papers, isLoading, isOpen, onOpenChange }: AnalyticsPanelProps) {
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
            <AnalyticsContent papers={papers} isLoading={isLoading} />
          </CardContent>
        </Card>
      </CollapsibleContent>
    </Collapsible>
  );
}
