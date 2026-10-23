import { useState, useEffect, useMemo, useRef } from "react";
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
import { Loader2, CheckCircle2, AlertTriangle, BookOpenCheck } from "lucide-react";
import { useDeduplication, suggestKeepPaper } from "@/hooks/useDeduplication";
import { usePaperLinkCheck } from "@/hooks/useStudyRecords";
import { mergeBlock, STUDY_RECORD_MERGE_COPY, type MergeBlock } from "@/lib/studyRecord/paperGuards";
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
    /*
     * A DOI is a single token with no break opportunity, so its min-content
     * width is its full length — which the whole card was being sized to.
     * `break-all` gives it break points; `min-w-0` lets the row act on them.
     */
    <Badge variant="outline" className="font-mono text-xs min-w-0 break-all">
      {label}
    </Badge>
  );
}

function DuplicateGroupCard({
  group,
  groupIndex,
  selectedKeepId,
  onSelectKeep,
  held,
  block,
}: {
  group: DuplicateGroup;
  groupIndex: number;
  selectedKeepId: string;
  onSelectKeep: (groupIdx: number, paperId: string) => void;
  /** Papers of this group a study record links to (EVIDENCE-RECORDS-001C1). */
  held: ReadonlySet<string>;
  /** Why this group can't be merged as chosen; null when it can. */
  block: MergeBlock | null;
}) {
  const titleOf = (id: string) => group.papers.find((paper) => paper.id === id)?.title ?? "This paper";
  return (
    <div className="rounded-lg border p-4 space-y-3" data-testid="duplicate-group">
      <div className="flex items-center justify-between gap-2">
        <MatchBadge group={group} />
        <span className="shrink-0 text-xs text-muted-foreground">
          {group.papers.length} copies
        </span>
      </div>

      {block && (
        <p role="note" className="rounded-md border border-amber-500/50 bg-amber-50 p-2 text-xs dark:bg-amber-950/30" data-testid="duplicate-group-block">
          {block.kind === "several_held"
            ? STUDY_RECORD_MERGE_COPY.severalHeld(block.paperIds.length)
            : STUDY_RECORD_MERGE_COPY.discardHeld(titleOf(block.paperIds[0]))}
        </p>
      )}

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
              className={`flex min-w-0 items-start gap-3 rounded-md border p-3 cursor-pointer transition-colors ${
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
                    <span className="font-mono break-all">PMID: {paper.pmid}</span>
                  )}
                  {paper.doi && (
                    <span className="font-mono break-all">
                      DOI: {truncate(paper.doi, 25)}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1">
                {isSelected && (
                  <Badge variant="default" className="shrink-0 text-xs">
                    Keep
                  </Badge>
                )}
                {held.has(paper.id.toLowerCase()) && (
                  <Badge variant="outline" className="shrink-0 gap-1 text-xs font-normal">
                    <BookOpenCheck className="h-3 w-3" aria-hidden="true" />
                    Study record
                  </Badge>
                )}
              </div>
            </label>
          );
        })}
      </RadioGroup>
    </div>
  );
}

/**
 * Caps the duplicate list and makes it scroll — on the RADIX VIEWPORT, not on
 * the ScrollArea root. Load-bearing; do not "simplify" it back to a plain
 * `max-h-*` on the root.
 *
 * `ui/scroll-area` renders `<Root class="relative overflow-hidden {className}">
 * <Viewport class="h-full w-full">`. A cap written on the root leaves the root
 * with a computed `height: auto` (it is a `flex-1` item of an auto-height
 * column, so its used height comes from its content and is then clamped by
 * `max-height`). A clamped auto height is not a DEFINITE height, so the
 * viewport's `h-full` resolves to `auto` and the viewport grows to its content
 * instead of becoming the scrolling box. Measured at 390x844 with three
 * duplicate groups: root 464px (`max-height: 464.2px`, `overflow: hidden`),
 * viewport 2602px, `scrollHeight === clientHeight` — so the viewport had no
 * scroll range, Radix mounted no scrollbar, the root silently clipped 7 of the
 * 9 paper rows and the wheel moved nothing.
 *
 * Capping the viewport instead gives ONE element both the bounded height and
 * the scrolling: `overflow-y: scroll` (set inline by Radix) now has a real
 * range, so wheel, touch and keyboard all reach the last row. Short lists are
 * unaffected — `max-height` only binds once the content exceeds it, so a single
 * small group still sizes to its content and shows no scrollbar.
 *
 * Covered by e2e/scrollarea-reachability.spec.ts (real Chromium, with a
 * negative control that restores the root-only cap).
 */
const RESULTS_SCROLL_CAP =
  "[&_[data-radix-scroll-area-viewport]]:max-h-[55vh]";

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

  // EVIDENCE-RECORDS-001C1. Which of these papers a study record links to,
  // checked fresh once the scan has groups. A merge that would discard such a
  // paper is refused by the database; this check explains it first and keeps
  // it out of "Merge All". Advisory: a link made after it is still refused.
  const groupPaperIds = useMemo(
    () => duplicateGroups.flatMap((group) => group.papers.map((paper) => paper.id)),
    [duplicateGroups],
  );
  const { check: linkCheck, retry: retryLinkCheck } = usePaperLinkCheck(
    userId,
    groupPaperIds,
    open && !scanning && duplicateGroups.length > 0,
  );
  const linkCheckSettled = linkCheck.status === "clear" || linkCheck.status === "held";
  const held = useMemo(
    () => new Set(linkCheck.status === "held" ? linkCheck.held.map((paper) => paper.paperId.toLowerCase()) : []),
    [linkCheck],
  );
  const heldKey = [...held].sort().join(",");

  // Groups whose keeper the user chose, so a later suggestion never overrides it.
  const chosenByUser = useRef<Set<number>>(new Set());

  // Auto-populate suggested keeps when groups arrive
  useEffect(() => {
    if (duplicateGroups.length > 0) {
      chosenByUser.current = new Set();
      const defaults = new Map<number, string>();
      duplicateGroups.forEach((group, idx) => {
        defaults.set(idx, suggestKeepPaper(group));
      });
      setSelections(defaults);
    }
  }, [duplicateGroups]);

  // Once the study records are known, suggest keeping the paper that has one
  // in every group the user hasn't decided themselves.
  useEffect(() => {
    if (!heldKey || duplicateGroups.length === 0) return;
    const linked = new Set(heldKey.split(","));
    setSelections((previous) => {
      const next = new Map(previous);
      duplicateGroups.forEach((group, idx) => {
        if (!chosenByUser.current.has(idx)) next.set(idx, suggestKeepPaper(group, linked));
      });
      return next;
    });
  }, [duplicateGroups, heldKey]);

  const handleSelectKeep = (groupIdx: number, paperId: string) => {
    chosenByUser.current.add(groupIdx);
    setSelections((prev) => {
      const next = new Map(prev);
      next.set(groupIdx, paperId);
      return next;
    });
  };

  const blocks = useMemo(
    () =>
      duplicateGroups.map((group, idx) =>
        mergeBlock(group, selections.get(idx) || group.papers[0].id, held),
      ),
    [duplicateGroups, selections, held],
  );
  const mergeableCount = blocks.filter((block) => block === null).length;

  const handleMergeAll = async () => {
    if (!linkCheckSettled) return;
    const mergeable = new Map([...selections].filter(([idx]) => blocks[idx] === null));
    await mergeAllGroups(mergeable, { skippedForStudyRecords: selections.size - mergeable.size });
    onOpenChange(false);
  };

  const totalDuplicatePapers = useMemo(
    () => duplicateGroups.reduce((sum, g) => sum + g.papers.length, 0),
    [duplicateGroups],
  );

  const papersToRemove = useMemo(
    () =>
      duplicateGroups.reduce((sum, g, idx) => sum + (blocks[idx] === null ? g.papers.length - 1 : 0), 0),
    [duplicateGroups, blocks],
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
            <ScrollArea className={`flex-1 pr-4 ${RESULTS_SCROLL_CAP}`}>
              <div className="space-y-4">
                {held.size > 0 && (
                  <p className="text-xs text-muted-foreground" data-testid="duplicate-study-record-notice">
                    {STUDY_RECORD_MERGE_COPY.notice}
                  </p>
                )}
                {duplicateGroups.map((group, idx) => (
                  <DuplicateGroupCard
                    key={`${group.match_type}-${group.match_value}`}
                    group={group}
                    groupIndex={idx}
                    selectedKeepId={selections.get(idx) || group.papers[0].id}
                    onSelectKeep={handleSelectKeep}
                    held={held}
                    block={linkCheckSettled ? blocks[idx] : null}
                  />
                ))}
              </div>
            </ScrollArea>

            <Separator />

            <DialogFooter className="flex items-center justify-between sm:justify-between">
              <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
                {linkCheck.status === "checking" ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    <span>{STUDY_RECORD_MERGE_COPY.checking}</span>
                  </>
                ) : linkCheck.status === "error" ? (
                  <>
                    <AlertTriangle className="h-4 w-4 text-yellow-500" aria-hidden="true" />
                    <span>{STUDY_RECORD_MERGE_COPY.checkFailed}</span>
                    <Button variant="outline" size="sm" onClick={retryLinkCheck}>
                      Try again
                    </Button>
                  </>
                ) : (
                  <>
                    <AlertTriangle className="h-4 w-4 text-yellow-500" />
                    <span>
                      {papersToRemove} paper{papersToRemove !== 1 ? "s" : ""} will
                      be removed
                    </span>
                  </>
                )}
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={() => onOpenChange(false)}
                  disabled={merging}
                >
                  Cancel
                </Button>
                {/* Until the study records are known, Merge does nothing — said by the
                    status beside it. `aria-disabled` rather than `disabled`, so the
                    control keeps its place and pointer target while the check runs. */}
                <Button
                  onClick={handleMergeAll}
                  disabled={merging || selections.size === 0 || mergeableCount === 0}
                  aria-disabled={!linkCheckSettled || undefined}
                >
                  {merging ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Merging...
                    </>
                  ) : (
                    `Merge All (${mergeableCount} group${mergeableCount !== 1 ? "s" : ""})`
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
