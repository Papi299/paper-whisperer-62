import { Fragment, useCallback, useId, useMemo, useRef, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SOURCE_STATE_MESSAGES, SOURCE_TOO_LONG_MESSAGE } from "@/lib/evidence/sources";
import type { SourceSnapshot } from "@/lib/evidence/types";
import type { StudyRecordLink } from "@/lib/studyRecord/read";
import { diffSourceText, type DiffSegment } from "@/lib/studyRecord/sourceDiff";
import { formatRecordDate } from "./reviewCopy";
import { SavedCopyText } from "./SavedCopyText";
import { SOURCE_COMPARE_COPY } from "./sourceCompareCopy";
import { looksAlike, markHiddenCharacters, type LibraryStatus } from "./sourceCompareModel";

type Reading = "changes" | "saved" | "library";

/** The library abstract's text, when the last read found one that isn't empty after v1. */
function libraryTextOf(status: LibraryStatus): string | null {
  if (status.kind !== "ready" || status.abstract === null) return null;
  return status.state.kind === "abstract_removed" || status.state.kind === "no_copy_no_abstract" ? null : status.abstract;
}

function seqOf(link: StudyRecordLink, copy: SourceSnapshot | null): number | null {
  return copy ? (link.snapshots.find((snapshot) => snapshot.id === copy.id)?.seq ?? copy.seq) : null;
}

/** What the last library read says, when it isn't an answer: on its way, failed, or the paper unreadable. */
function ReadProblem({ status, onCheckAgain }: { readonly status: Exclude<LibraryStatus, { kind: "ready" }>; readonly onCheckAgain: () => void }) {
  if (status.kind === "checking") {
    return (
      <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="source-read-problem" data-source-status="checking">
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
        {SOURCE_COMPARE_COPY.checking}
      </p>
    );
  }
  return (
    <div className="space-y-2" data-testid="source-read-problem" data-source-status={status.kind}>
      <p role="status" className="text-xs" data-failure={status.kind === "failed" ? status.reason : undefined}>
        {status.kind === "unavailable"
          ? SOURCE_COMPARE_COPY.unavailable
          : status.reason === "integrity"
            ? SOURCE_COMPARE_COPY.failedIntegrity
            : status.reason === "transient"
              ? SOURCE_COMPARE_COPY.failedTransient
              : SOURCE_COMPARE_COPY.failed}
      </p>
      <CheckAgain onCheckAgain={onCheckAgain} />
    </div>
  );
}

function CheckAgain({ onCheckAgain, busy = false }: { readonly onCheckAgain: () => void; readonly busy?: boolean }) {
  return (
    <Button type="button" variant="ghost" size="sm" className="h-8 px-2 text-xs coarse:min-h-10" aria-label={SOURCE_COMPARE_COPY.checkAgainLabel} disabled={busy} onClick={onCheckAgain}>
      <RefreshCw className="mr-1 h-3 w-3" aria-hidden="true" />
      {SOURCE_COMPARE_COPY.checkAgain}
    </Button>
  );
}

/**
 * How the saved copy relates to the abstract in the library now
 * (EVIDENCE-RECORDS-001C2C-A): the source states of `deriveSourceState`, in
 * words, from the last read only. Offers Compare (`onCompare`, Edit only) and
 * Check again; nothing here writes, and every state keeps the saved copy.
 */
export function SourceStatusBanner({
  link,
  copy,
  status,
  onCompare,
  onCheckAgain,
}: {
  readonly link: StudyRecordLink;
  readonly copy: SourceSnapshot | null;
  readonly status: LibraryStatus;
  /** Null where comparing isn't offered (Review). */
  readonly onCompare: (() => void) | null;
  readonly onCheckAgain: () => void;
}) {
  if (status.kind !== "ready") return <ReadProblem status={status} onCheckAgain={onCheckAgain} />;
  const { state } = status;
  const seq = seqOf(link, copy);
  if (state.kind === "current") {
    return (
      <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground" data-testid="source-status" data-source-state="current">
        <p role="status">{SOURCE_COMPARE_COPY.current}</p>
        <CheckAgain onCheckAgain={onCheckAgain} />
      </div>
    );
  }
  const capture = "capture" in state ? state.capture : null;
  const changed = state.kind === "content_change";
  const showable = state.kind === "content_change" || state.kind === "typography_only_change" || state.kind === "abstract_now_available";
  return (
    <div
      className={`space-y-2 rounded-md border p-3 text-sm ${changed ? "border-amber-500/60 bg-amber-50 dark:bg-amber-950/30" : "bg-muted/40"}`}
      data-testid="source-status"
      data-source-state={state.kind}
      data-source-capture={capture ?? undefined}
    >
      <p role="status">{SOURCE_STATE_MESSAGES[state.kind]}</p>
      {capture === "refused_too_long" && <p className="text-xs">{SOURCE_TOO_LONG_MESSAGE}</p>}
      {showable && <p className="text-xs text-muted-foreground">{seq === null ? SOURCE_COMPARE_COPY.informationalNoCopy : SOURCE_COMPARE_COPY.informational(seq)}</p>}
      <div className="flex flex-wrap items-center gap-2">
        {showable && onCompare && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="coarse:min-h-10"
            aria-label={state.kind === "abstract_now_available" ? undefined : SOURCE_COMPARE_COPY.compareLabel}
            onClick={onCompare}
            data-testid="source-compare-open"
          >
            {state.kind === "abstract_now_available" ? SOURCE_COMPARE_COPY.showLibrary : SOURCE_COMPARE_COPY.compare}
          </Button>
        )}
        <CheckAgain onCheckAgain={onCheckAgain} />
      </div>
    </div>
  );
}

/**
 * The comparison (EVIDENCE-RECORDS-001C2C-A): the saved copy and the library
 * abstract, as their changes or either in full, always named for what they
 * are. Read-only: opening, switching, moving between changes and closing send
 * nothing, and the record keeps its copy. The changes are a bounded word-level
 * comparison (`diffSourceText`); past its budget, the two texts are offered in
 * full instead.
 */
export function SourceCompare({
  link,
  copy,
  status,
  onCheckAgain,
  onBack,
}: {
  readonly link: StudyRecordLink;
  readonly copy: SourceSnapshot | null;
  readonly status: LibraryStatus;
  readonly onCheckAgain: () => void;
  readonly onBack: () => void;
}) {
  const ids = useId();
  const seq = seqOf(link, copy);
  const [reading, setReading] = useState<Reading>(copy ? "changes" : "library");
  const libraryText = libraryTextOf(status);
  const diff = useMemo(() => (copy && libraryText !== null ? diffSourceText(copy.exactText, libraryText) : null), [copy, libraryText]);
  const capture = status.kind === "ready" && "capture" in status.state ? status.state.capture : null;

  /** In place of a text that needs the library: why it isn't there. */
  const libraryProblem = () => {
    if (status.kind !== "ready") return <ReadProblem status={status} onCheckAgain={onCheckAgain} />;
    return <p className="text-xs" data-testid="source-read-problem" data-source-status="removed">{SOURCE_COMPARE_COPY.libraryRemoved}</p>;
  };

  return (
    <section className="space-y-3" aria-labelledby={`${ids}-heading`} data-testid="source-compare">
      <h3 id={`${ids}-heading`} tabIndex={-1} className="text-sm font-semibold focus:outline-none" data-source-view-heading>
        {copy ? SOURCE_COMPARE_COPY.compareHeading : SOURCE_COMPARE_COPY.libraryHeading}
      </h3>
      <p className="text-xs text-muted-foreground">{seq === null ? SOURCE_COMPARE_COPY.informationalNoCopy : SOURCE_COMPARE_COPY.informational(seq)}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" className="coarse:min-h-10" onClick={onBack} data-testid="source-compare-back">
          {SOURCE_COMPARE_COPY.backToSaved}
        </Button>
        <CheckAgain onCheckAgain={onCheckAgain} busy={status.kind === "checking"} />
      </div>

      <Tabs value={reading} onValueChange={(value) => setReading(value as Reading)} className="space-y-3">
        <TabsList aria-label={SOURCE_COMPARE_COPY.readingsLabel} className={`grid h-auto w-full ${copy ? "grid-cols-3" : "grid-cols-1"}`}>
          {copy && (
            <TabsTrigger value="changes" className="h-auto min-h-9 whitespace-normal px-2 text-xs coarse:min-h-10">
              {SOURCE_COMPARE_COPY.readingChanges}
            </TabsTrigger>
          )}
          {copy && seq !== null && (
            <TabsTrigger value="saved" className="h-auto min-h-9 whitespace-normal px-2 text-xs coarse:min-h-10">
              {SOURCE_COMPARE_COPY.readingSaved(seq)}
            </TabsTrigger>
          )}
          <TabsTrigger value="library" className="h-auto min-h-9 whitespace-normal px-2 text-xs coarse:min-h-10">
            {SOURCE_COMPARE_COPY.readingLibrary}
          </TabsTrigger>
        </TabsList>

        {copy && seq !== null && (
          <TabsContent value="changes" className="mt-0 space-y-2 focus-visible:ring-inset" data-testid="source-compare-reading" data-reading="changes">
            {libraryText === null || diff === null ? (
              libraryProblem()
            ) : diff.kind === "identical" ? (
              <p className="text-xs">{SOURCE_COMPARE_COPY.current}</p>
            ) : diff.kind === "too_different" ? (
              <p className="text-xs" data-testid="source-compare-too-different">
                {SOURCE_COMPARE_COPY.tooDifferent(seq)}
              </p>
            ) : (
              <ChangesReading
                seq={seq}
                segments={diff.segments}
                changeCount={diff.changeCount}
                removedWords={diff.removedWords}
                addedWords={diff.addedWords}
                typographyOnly={status.kind === "ready" && status.state.kind === "typography_only_change"}
              />
            )}
          </TabsContent>
        )}
        {copy && seq !== null && (
          <TabsContent value="saved" className="mt-0 space-y-2 focus-visible:ring-inset" data-testid="source-compare-reading" data-reading="saved">
            <p className="text-xs font-medium">{SOURCE_COMPARE_COPY.savedLabel(seq)}</p>
            <p className="text-xs text-muted-foreground">{SOURCE_COMPARE_COPY.savedNote(formatRecordDate(copy.capturedAt))}</p>
            <SavedCopyText text={copy.exactText} ranges={[]} data-testid="source-compare-saved-text" />
          </TabsContent>
        )}
        <TabsContent value="library" className="mt-0 space-y-2 focus-visible:ring-inset" data-testid="source-compare-reading" data-reading="library">
          <p className="text-xs font-medium">{SOURCE_COMPARE_COPY.libraryLabel}</p>
          {libraryText === null ? (
            libraryProblem()
          ) : (
            <>
              <p className="text-xs text-muted-foreground">{SOURCE_COMPARE_COPY.libraryNote}</p>
              {capture === "refused_too_long" && <p className="text-xs">{SOURCE_TOO_LONG_MESSAGE}</p>}
              <SavedCopyText text={libraryText} ranges={[]} data-testid="source-compare-library-text" />
            </>
          )}
        </TabsContent>
      </Tabs>
    </section>
  );
}

/** The changes, in text order, with a way to move from one to the next that stays in reach while the text scrolls. */
function ChangesReading({
  seq,
  segments,
  changeCount,
  removedWords,
  addedWords,
  typographyOnly,
}: {
  readonly seq: number;
  readonly segments: readonly DiffSegment[];
  readonly changeCount: number;
  readonly removedWords: number;
  readonly addedWords: number;
  readonly typographyOnly: boolean;
}) {
  const [at, setAt] = useState(-1);
  const regions = useRef(new Map<number, HTMLElement>());
  const register = useCallback((index: number, element: HTMLElement | null) => {
    if (element) regions.current.set(index, element);
    else regions.current.delete(index);
  }, []);
  const go = (index: number) => {
    setAt(index);
    const element = regions.current.get(index);
    element?.focus({ preventScroll: true });
    element?.scrollIntoView({ block: "center" });
  };
  return (
    <>
      <p className="text-xs font-medium" data-testid="source-compare-summary">
        {SOURCE_COMPARE_COPY.summary(changeCount, removedWords, addedWords)}
      </p>
      <p className="text-xs text-muted-foreground">{SOURCE_COMPARE_COPY.legend(seq)}</p>
      {typographyOnly && <p className="text-xs text-muted-foreground">{SOURCE_COMPARE_COPY.typographyNote}</p>}
      <div className="whitespace-pre-wrap break-words rounded-md border bg-muted/30 p-3 text-sm leading-relaxed [overflow-wrap:anywhere]" data-testid="source-compare-changes">
        {segments.map((segment, index) =>
          segment.kind === "same" ? <Fragment key={index}>{segment.text}</Fragment> : <ChangeMark key={index} change={segment} current={segment.index === at} register={register} />,
        )}
      </div>
      <div className="sticky bottom-0 flex flex-wrap items-center gap-2 border-t bg-background py-2" role="group" aria-label={SOURCE_COMPARE_COPY.changesNavigation}>
        <p aria-live="polite" className="mr-auto text-xs" data-testid="source-compare-position">
          {at < 0 ? SOURCE_COMPARE_COPY.changeCount(changeCount) : SOURCE_COMPARE_COPY.changePosition(at + 1, changeCount)}
        </p>
        <Button type="button" variant="outline" size="sm" className="coarse:min-h-10" disabled={at <= 0} onClick={() => go(at - 1)}>
          {SOURCE_COMPARE_COPY.previousChange}
        </Button>
        <Button type="button" variant="outline" size="sm" className="coarse:min-h-10" disabled={at >= changeCount - 1} onClick={() => go(at + 1)}>
          {SOURCE_COMPARE_COPY.nextChange}
        </Button>
      </div>
    </>
  );
}

/** One side of a change, with the characters that can't be seen named. */
function Marked({ text }: { readonly text: string }) {
  return (
    <>
      {markHiddenCharacters(text).map((piece, index) =>
        piece.kind === "text" ? (
          <Fragment key={index}>{piece.text}</Fragment>
        ) : (
          <span key={index} className="mx-px rounded border border-current px-1 text-[0.7rem]" data-testid="source-compare-hidden-character">
            {piece.label}
          </span>
        ),
      )}
    </>
  );
}

/**
 * One changed passage: what only the saved copy has, struck through, and what
 * only the library abstract has, underlined — each also said in words for a
 * screen reader, so neither colour nor decoration is the only signal.
 */
function ChangeMark({
  change,
  current,
  register,
}: {
  readonly change: Extract<DiffSegment, { kind: "change" }>;
  readonly current: boolean;
  readonly register: (index: number, element: HTMLElement | null) => void;
}) {
  const alike = looksAlike(change.removed, change.added);
  return (
    <span
      ref={(element) => register(change.index, element)}
      tabIndex={-1}
      className={`scroll-my-16 rounded-sm focus:outline-none focus:ring-2 focus:ring-ring${current ? " ring-2 ring-ring" : ""}`}
      data-testid="source-compare-change"
      data-change-index={change.index}
    >
      {change.removed !== "" && (
        <del className="bg-red-100 text-red-900 line-through decoration-2 dark:bg-red-950/50 dark:text-red-200">
          <span className="sr-only">{SOURCE_COMPARE_COPY.onlyInSaved}</span>
          <Marked text={change.removed} />
        </del>
      )}
      {change.added !== "" && (
        <ins className="bg-emerald-100 text-emerald-900 underline decoration-2 underline-offset-2 dark:bg-emerald-950/50 dark:text-emerald-200">
          <span className="sr-only">{SOURCE_COMPARE_COPY.onlyInLibrary}</span>
          <Marked text={change.added} />
        </ins>
      )}
      {alike && <span className="ml-1 text-xs text-muted-foreground no-underline">({SOURCE_COMPARE_COPY.storedDifferently})</span>}
    </span>
  );
}
