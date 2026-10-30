import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useStudyRecordHistoryChanges } from "@/hooks/useStudyRecordHistory";
import { describeHistoryChange, type HistoryContext } from "@/lib/studyRecord/historyModel";
import type { HistoryOperation } from "@/lib/studyRecord/historyRead";
import { describeChangeText, formatHistoryTime, HISTORY_COPY, HISTORY_OPERATION_TITLES } from "./historyCopy";

interface HistoryEntryProps {
  readonly userId: string;
  readonly studyId: string;
  readonly operation: HistoryOperation;
  readonly context: HistoryContext;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  /** A read of this entry's details found the study gone. */
  readonly onGone: () => void;
  /** The entry's heading, for moving focus to it after older entries load. */
  readonly headingRef: (element: HTMLHeadingElement | null) => void;
}

/**
 * One committed operation (EVIDENCE-RECORDS-001C2B): what it was, when, and
 * the record version it produced; its changes are read only while its details
 * are open. Read-only: nothing here sends a write.
 */
export function HistoryEntry({ userId, studyId, operation, context, expanded, onToggle, onGone, headingRef }: HistoryEntryProps) {
  const ids = useId();
  const title = HISTORY_OPERATION_TITLES[operation.op];
  const version = HISTORY_COPY.version(operation.studyVersion);
  return (
    <li>
      <article aria-labelledby={`${ids}-title`} className="rounded-md border p-3" data-testid="history-entry" data-history-version={operation.studyVersion}>
        <h4
          id={`${ids}-title`}
          ref={headingRef}
          tabIndex={-1}
          className="break-words rounded-sm text-sm font-medium [overflow-wrap:anywhere] focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {title}
        </h4>
        <p className="mt-1 text-xs text-muted-foreground">
          <time dateTime={operation.occurredAt}>{formatHistoryTime(operation.occurredAt)}</time>
          <span aria-hidden="true"> · </span>
          <span className="sr-only">, </span>
          {version}
        </p>
        {/* Named after its entry, so a list of them is told apart; the name starts with the visible words. */}
        <Button
          type="button"
          variant="link"
          className="mt-1 h-auto p-0 text-xs coarse:min-h-10"
          aria-expanded={expanded}
          aria-controls={`${ids}-details`}
          aria-label={`${expanded ? HISTORY_COPY.hideDetails : HISTORY_COPY.showDetails}: ${title}, ${version}`}
          onClick={onToggle}
          data-testid="history-entry-toggle"
        >
          {expanded ? HISTORY_COPY.hideDetails : HISTORY_COPY.showDetails}
        </Button>
        {/* Always present, so aria-controls names an element; its contents exist only while open. */}
        <div id={`${ids}-details`} hidden={!expanded} role="region" aria-label={HISTORY_COPY.detailsLabel(title, operation.studyVersion)}>
          {expanded && <HistoryDetails userId={userId} studyId={studyId} operation={operation} context={context} onGone={onGone} />}
        </div>
      </article>
    </li>
  );
}

interface HistoryDetailsProps {
  readonly userId: string;
  readonly studyId: string;
  readonly operation: HistoryOperation;
  readonly context: HistoryContext;
  readonly onGone: () => void;
}

/** The changes of one operation, in the order they were recorded, in pages. */
function HistoryDetails({ userId, studyId, operation, context, onGone }: HistoryDetailsProps) {
  const changes = useStudyRecordHistoryChanges(userId, studyId, operation, true);
  const described = useMemo(
    () => changes.changes.map((event) => ({ id: event.id, type: event.type, text: describeChangeText(describeHistoryChange(event, context)) })),
    [changes.changes, context],
  );
  // After "Show more changes", focus goes to the first change it added. Every change can take focus
  // (tabIndex -1, outside the tab order), so it keeps it when the list renders again.
  const [focusFrom, setFocusFrom] = useState<number | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (focusFrom !== null && described.length > focusFrom) {
      (listRef.current?.children[focusFrom] as HTMLElement | undefined)?.focus();
      setFocusFrom(null);
    }
  }, [described.length, focusFrom]);

  useEffect(() => {
    if (changes.status === "gone") onGone();
  }, [changes.status, onGone]);

  if (changes.status === "loading") {
    return (
      <p role="status" className="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        {HISTORY_COPY.detailsLoading}
      </p>
    );
  }
  if (changes.status === "gone") return <p className="mt-2 text-sm">{HISTORY_COPY.detailsGone}</p>;
  if (changes.status === "error") {
    return (
      <div role="alert" className="mt-2 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm">
        <p>{changes.error?.kind === "integrity" ? HISTORY_COPY.detailsIntegrity : HISTORY_COPY.detailsFailed}</p>
        <Button type="button" size="sm" variant="outline" className="mt-2 coarse:min-h-10" onClick={() => void changes.retry()}>
          {HISTORY_COPY.tryAgain}
        </Button>
      </div>
    );
  }

  const loadMore = async () => {
    if (changes.loadingMore) return;
    const from = described.length;
    if (await changes.loadMore()) setFocusFrom(from);
  };

  return (
    <div className="mt-2 space-y-2">
      <ul ref={listRef} className="space-y-2" data-testid="history-changes">
        {described.map((change) => (
          <li
            key={change.id}
            tabIndex={-1}
            className="rounded-sm border-l-2 pl-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-testid="history-change"
            data-history-change={change.type}
          >
            <p className="break-words [overflow-wrap:anywhere]">{change.text.text}</p>
            {change.text.details.map((detail, line) => (
              <p key={line} className="break-words text-xs text-muted-foreground [overflow-wrap:anywhere]">
                {detail}
              </p>
            ))}
          </li>
        ))}
      </ul>
      {(changes.hasMore || changes.moreFailed) && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">{HISTORY_COPY.changesShown(described.length)}</p>
          {changes.moreFailed && (
            <p role="alert" className="text-sm">
              {HISTORY_COPY.moreChangesFailed}
            </p>
          )}
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="coarse:min-h-10"
            aria-disabled={changes.loadingMore || undefined}
            aria-busy={changes.loadingMore || undefined}
            onClick={() => void loadMore()}
          >
            {changes.loadingMore && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
            {changes.loadingMore ? HISTORY_COPY.loadingMoreChanges : changes.moreFailed ? HISTORY_COPY.tryAgain : HISTORY_COPY.moreChanges}
          </Button>
        </div>
      )}
    </div>
  );
}
