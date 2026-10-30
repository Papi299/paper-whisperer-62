import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useStudyRecordHistory } from "@/hooks/useStudyRecordHistory";
import { historyContextOf } from "@/lib/studyRecord/historyModel";
import type { StudyRecordData } from "@/lib/studyRecord/read";
import { HistoryEntry } from "./HistoryEntry";
import { HISTORY_COPY } from "./historyCopy";

interface HistoryPaneProps {
  readonly userId: string;
  readonly studyId: string;
  /** The record as loaded now: History names a group, an outcome or a paper from it only as it is now. */
  readonly base: StudyRecordData;
}

/**
 * History mode (EVIDENCE-RECORDS-001C2B): the study record's committed
 * operations, newest first, ten at a time, each with the changes it recorded
 * when it is opened. Read from `evidence_events` alone, through the owner-scoped
 * read (`useStudyRecordHistory`) — never inferred from the record's current
 * state — and read-only for everyone who can open the record, the pilot owner
 * and a former owner alike: nothing here can save, confirm, flag or change a
 * source.
 *
 * Mounted only while History is the chosen mode, so every opening reads
 * afresh; a failed read is said to be one, never shown as an empty history.
 */
export function HistoryPane({ userId, studyId, base }: HistoryPaneProps) {
  const history = useStudyRecordHistory(userId, studyId, true);
  const context = useMemo(() => historyContextOf(base), [base]);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());
  const [announcement, setAnnouncement] = useState("");
  const headingRef = useRef<HTMLHeadingElement>(null);
  const entryHeadings = useRef(new Map<number, HTMLHeadingElement>());
  // Where focus goes once a read the user asked for has finished.
  const [focusEntry, setFocusEntry] = useState<number | null>(null);
  const [focusHeading, setFocusHeading] = useState(false);
  const { operations, status } = history;

  useEffect(() => {
    if (focusEntry === null || operations.length <= focusEntry) return;
    // The first entry Load older added: reading continues where the list grew.
    entryHeadings.current.get(operations[focusEntry].studyVersion)?.focus();
    setAnnouncement(HISTORY_COPY.announceOlder(operations.length - focusEntry));
    setFocusEntry(null);
  }, [focusEntry, operations]);
  useEffect(() => {
    if (!focusHeading || status === "loading") return;
    headingRef.current?.focus();
    setFocusHeading(false);
  }, [focusHeading, status]);

  const toggle = useCallback((version: number) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(version)) next.delete(version);
      else next.add(version);
      return next;
    });
  }, []);

  const busy = history.refreshing || history.loadingOlder;
  const loadOlder = async () => {
    if (busy) return;
    const from = operations.length;
    setAnnouncement("");
    if (await history.loadOlder()) setFocusEntry(from);
  };
  const refresh = async () => {
    if (busy) return;
    setAnnouncement("");
    await history.refresh();
    setAnnouncement(HISTORY_COPY.announceRefreshed);
  };
  const retry = async () => {
    setFocusHeading(true);
    await history.refresh();
  };

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6" data-testid="study-record-history-pane" data-history-status={status}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          <h3 ref={headingRef} tabIndex={-1} className="rounded-sm text-sm font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {HISTORY_COPY.heading}
          </h3>
          <p className="text-xs text-muted-foreground">{HISTORY_COPY.intro}</p>
          <p className="text-xs text-muted-foreground">{HISTORY_COPY.textNotKept}</p>
        </div>
        {status === "ready" && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="shrink-0 coarse:min-h-10"
            aria-label={HISTORY_COPY.refreshLabel}
            aria-disabled={busy || undefined}
            aria-busy={history.refreshing || undefined}
            onClick={() => void refresh()}
            data-testid="history-refresh"
          >
            <RefreshCw className={`mr-2 h-4 w-4${history.refreshing ? " animate-spin" : ""}`} aria-hidden="true" />
            {history.refreshing ? HISTORY_COPY.refreshing : HISTORY_COPY.refresh}
          </Button>
        )}
      </div>

      {status === "loading" && (
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          {HISTORY_COPY.loading}
        </p>
      )}
      {status === "error" && (
        <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm" data-testid="history-error">
          <p>{history.error?.kind === "integrity" ? HISTORY_COPY.integrity : HISTORY_COPY.loadFailed}</p>
          <Button type="button" size="sm" variant="outline" className="mt-2 coarse:min-h-10" onClick={() => void retry()}>
            {HISTORY_COPY.tryAgain}
          </Button>
        </div>
      )}
      {status === "gone" && (
        <p role="alert" className="rounded-md border p-3 text-sm" data-testid="history-gone">
          {HISTORY_COPY.gone}
        </p>
      )}
      {status === "ready" && history.refreshFailed && (
        <p role="alert" className="rounded-md border border-amber-500/50 bg-amber-50 p-3 text-sm dark:bg-amber-950/30">
          {HISTORY_COPY.refreshFailed}
        </p>
      )}
      {status === "ready" && operations.length === 0 && <p className="text-sm">{HISTORY_COPY.empty}</p>}

      {status === "ready" && operations.length > 0 && (
        <>
          <ol className="space-y-3" aria-label={HISTORY_COPY.entriesLabel} data-testid="history-entries">
            {operations.map((operation) => (
              <HistoryEntry
                key={operation.studyVersion}
                userId={userId}
                studyId={studyId}
                operation={operation}
                context={context}
                expanded={expanded.has(operation.studyVersion)}
                onToggle={() => toggle(operation.studyVersion)}
                onGone={history.markGone}
                headingRef={(element) => {
                  if (element) entryHeadings.current.set(operation.studyVersion, element);
                  else entryHeadings.current.delete(operation.studyVersion);
                }}
              />
            ))}
          </ol>
          <div className="space-y-2" data-testid="history-footer">
            {history.olderFailed && (
              <p role="alert" className="text-sm">
                {HISTORY_COPY.olderFailed}
              </p>
            )}
            {history.hasOlder ? (
              <Button
                type="button"
                variant="outline"
                className="w-full coarse:min-h-10 sm:w-auto"
                aria-disabled={busy || undefined}
                aria-busy={history.loadingOlder || undefined}
                onClick={() => void loadOlder()}
                data-testid="history-load-older"
              >
                {history.loadingOlder && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
                {history.loadingOlder ? HISTORY_COPY.loadingOlder : history.olderFailed ? HISTORY_COPY.tryAgain : HISTORY_COPY.loadOlder}
              </Button>
            ) : (
              <p className="text-xs text-muted-foreground" data-testid="history-beginning">
                {HISTORY_COPY.beginning}
              </p>
            )}
          </div>
        </>
      )}

      <p role="status" aria-live="polite" className="sr-only" data-testid="history-announcement">
        {announcement}
      </p>
    </div>
  );
}
