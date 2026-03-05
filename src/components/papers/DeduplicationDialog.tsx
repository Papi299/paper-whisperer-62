import { useState, useEffect, useMemo } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Loader2, CheckCircle2, AlertTriangle } from "lucide-react";
import { useDeduplication, suggestKeepPaper } from "@/hooks/useDeduplication";
import { DuplicateGroup, DuplicatePaperInfo } from "@/types/database";

interface DeduplicationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId: string;
}

/** Count non-null/non-empty fields for a paper — shown as a completeness indicator. */
function fieldCount(paper: DuplicatePaperInfo): number {
  let count = 0;
  if (paper.title) count++;
  if (paper.authors?.length > 0) count++;
  if (paper.year) count++;
  if (paper.journal) count++;
  if (paper.pmid) count++;
  if (paper.doi) count++;
  if (paper.abstract) count++;
  if (paper.study_type) count++;
  if (paper.keywords?.length > 0) count++;
  return count;
}

function formatDate(dateStr: string): string {
  try {
    return new Date(dateStr).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return dateStr;
  }
}

function truncate(text: string | null, maxLen: number): string {
  if (!text) return "-";
  return text.length > maxLen ? text.slice(0, maxLen) + "..." : text;
}

function MatchBadge({ group }: { group: DuplicateGroup }) {
  const label =
    group.match_type === "pmid"
      ? `PMID: ${group.match_value}`
      : group.match_type === "doi"
        ? `DOI: ${group.match_value}`
        : `PMID + DOI: ${group.match_value}`;

  return (
    <Badge
      variant="outline"
      className="font-mono text-xs"
    >
      {label}
    </Badge>
  );
}

function DuplicateGroupCard({
  group,
  groupIndex,
  selectedKeepId,
  onSelectKeep,
}: {
  group: DuplicateGroup;
  groupIndex: number;
  selectedKeepId: string;
  onSelectKeep: (groupIdx: number, paperId: string) => void;
}) {
  return (
    <div className="rounded-lg border p-4 space-y-3">
      <div className="flex items-center justify-between">
        <MatchBadge group={group} />
        <span className="text-xs text-muted-foreground">
          {group.papers.length} copies
        </span>
      </div>

      <RadioGroup
        value={selectedKeepId}
        onValueChange={(val) => onSelectKeep(groupIndex, val)}
        className="space-y-2"
      >
        {group.papers.map((paper) => {
          const isSelected = paper.id === selectedKeepId;
          const fields = fieldCount(paper);
          const maxFields = 9;

          return (
            <label
              key={paper.id}
              className={`flex items-start gap-3 rounded-md border p-3 cursor-pointer transition-colors ${
                isSelected
                  ? "border-primary bg-primary/5"
                  : "border-border hover:bg-muted/50"
              }`}
            >
              <RadioGroupItem value={paper.id} className="mt-0.5" />
              <div className="flex-1 min-w-0 space-y-1">
                <p className="text-sm font-medium leading-tight">
                  {truncate(paper.title, 120)}
                </p>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span>
                    {paper.authors?.length > 0
                      ? truncate(paper.authors.join(", "), 60)
                      : "No authors"}
                  </span>
                  <span>{paper.year || "No year"}</span>
                  <span>{truncate(paper.journal, 30)}</span>
                </div>
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  <span
                    className={`${fields >= 7 ? "text-green-600" : fields >= 4 ? "text-yellow-600" : "text-red-500"}`}
                  >
                    {fields}/{maxFields} fields
                  </span>
                  <span>Added {formatDate(paper.created_at)}</span>
                  {paper.pmid && (
                    <span className="font-mono">PMID: {paper.pmid}</span>
                  )}
                  {paper.doi && (
                    <span className="font-mono">
                      DOI: {truncate(paper.doi, 25)}
                    </span>
                  )}
                </div>
              </div>
              {isSelected && (
                <Badge variant="default" className="shrink-0 text-xs">
                  Keep
                </Badge>
              )}
            </label>
          );
        })}
      </RadioGroup>
    </div>
  );
}

export function DeduplicationDialog({
  open,
  onOpenChange,
  userId,
}: DeduplicationDialogProps) {
  const {
    scanning,
    duplicateGroups,
    merging,
    scanForDuplicates,
    mergeAllGroups,
  } = useDeduplication(userId);

  // Track which paper to keep in each group (groupIndex -> paperId)
  const [selections, setSelections] = useState<Map<number, string>>(new Map());

  // Auto-scan when dialog opens
  useEffect(() => {
    if (open) {
      scanForDuplicates();
      setSelections(new Map());
    }
  }, [open, scanForDuplicates]);

  // Auto-populate suggested keeps when groups arrive
  useEffect(() => {
    if (duplicateGroups.length > 0) {
      const defaults = new Map<number, string>();
      duplicateGroups.forEach((group, idx) => {
        defaults.set(idx, suggestKeepPaper(group));
      });
      setSelections(defaults);
    }
  }, [duplicateGroups]);

  const handleSelectKeep = (groupIdx: number, paperId: string) => {
    setSelections((prev) => {
      const next = new Map(prev);
      next.set(groupIdx, paperId);
      return next;
    });
  };

  const handleMergeAll = async () => {
    await mergeAllGroups(selections);
    onOpenChange(false);
  };

  const totalDuplicatePapers = useMemo(
    () => duplicateGroups.reduce((sum, g) => sum + g.papers.length, 0),
    [duplicateGroups],
  );

  const papersToRemove = useMemo(
    () =>
      duplicateGroups.reduce((sum, g) => sum + (g.papers.length - 1), 0),
    [duplicateGroups],
  );

  // Determine dialog state for rendering
  const hasScanned = !scanning && duplicateGroups.length === 0;
  const hasDuplicates = !scanning && duplicateGroups.length > 0;

  return (
    <Dialog open={open} onOpenChange={merging ? undefined : onOpenChange}>
      <DialogContent className="sm:max-w-[700px] max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Find Duplicates</DialogTitle>
          <DialogDescription>
            {scanning
              ? "Scanning your entire library for exact PMID and DOI matches..."
              : hasDuplicates
                ? `Found ${duplicateGroups.length} duplicate group${duplicateGroups.length !== 1 ? "s" : ""} (${totalDuplicatePapers} total papers). Select which paper to keep in each group.`
                : hasScanned
                  ? "No duplicates found in your library."
                  : "Scan for duplicate papers based on exact PMID and DOI matches."}
          </DialogDescription>
        </DialogHeader>

        {scanning && (
          <div className="flex flex-col items-center justify-center py-12 gap-3">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">
              Scanning entire database...
            </p>
          </div>
        )}

        {hasScanned && !scanning && (
          <div className="flex flex-col items-center justify-center py-12 gap-3">
            <CheckCircle2 className="h-12 w-12 text-green-500" />
            <p className="text-sm font-medium">No duplicates found</p>
            <p className="text-xs text-muted-foreground">
              All papers have unique PMIDs and DOIs.
            </p>
          </div>
        )}

        {hasDuplicates && (
          <>
            <ScrollArea className="flex-1 max-h-[55vh] pr-4">
              <div className="space-y-4">
                {duplicateGroups.map((group, idx) => (
                  <DuplicateGroupCard
                    key={`${group.match_type}-${group.match_value}`}
                    group={group}
                    groupIndex={idx}
                    selectedKeepId={selections.get(idx) || group.papers[0].id}
                    onSelectKeep={handleSelectKeep}
                  />
                ))}
              </div>
            </ScrollArea>

            <Separator />

            <DialogFooter className="flex items-center justify-between sm:justify-between">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <AlertTriangle className="h-4 w-4 text-yellow-500" />
                <span>
                  {papersToRemove} paper{papersToRemove !== 1 ? "s" : ""} will
                  be removed
                </span>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={() => onOpenChange(false)}
                  disabled={merging}
                >
                  Cancel
                </Button>
                <Button
                  onClick={handleMergeAll}
                  disabled={merging || selections.size === 0}
                >
                  {merging ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Merging...
                    </>
                  ) : (
                    `Merge All (${duplicateGroups.length} group${duplicateGroups.length !== 1 ? "s" : ""})`
                  )}
                </Button>
              </div>
            </DialogFooter>
          </>
        )}

        {hasScanned && (
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
