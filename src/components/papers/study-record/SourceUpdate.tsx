import { forwardRef, useId, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { codePointLength } from "@/lib/evidence/normalization";
import type { StudyRecordLink } from "@/lib/studyRecord/read";
import type { ReviewItem } from "@/lib/studyRecord/reviewModel";
import {
  canDigestAbstract,
  checkSourceUpdateCandidate,
  describeSourceUpdate,
  sourceUpdateEligibility,
  type SourceUpdateCandidate,
  type SourceUpdateImpact,
} from "@/lib/studyRecord/sourceUpdate";
import { useEditor } from "./editorContext";
import { formatRecordDate, reviewItemLabel } from "./reviewCopy";
import type { LibraryStatus } from "./sourceCompareModel";
import { SOURCE_UPDATE_COPY, SOURCE_UPDATE_HOLD_MESSAGES, sourceUpdateErrorText, sourceUpdateResultLines } from "./sourceUpdateCopy";

/**
 * "Use current abstract" in the comparison (EVIDENCE-RECORDS-001C2C-B): the
 * choice between keeping the saved copy — always the default — and saving the
 * library abstract shown as the link's new copy, or its first.
 *
 * Offered only to a user who may write, for a library abstract that could be
 * a copy, read and shown just now, and only while the editor says nothing
 * holds it; otherwise the button says why it waits, beside it and linked to
 * it. Pressing it freezes the exact text shown and opens a confirmation that
 * lists what the change does — from the record as loaded, never a forecast of
 * which quotes will be found again. Cancel sends nothing. Confirm hands that
 * one frozen candidate to the editor hook, which checks it again, computes its
 * SHA-256 and sends the one request; this component sends nothing itself.
 */
export function SourceUpdatePanel({
  link,
  status,
  readAt,
}: {
  readonly link: StudyRecordLink;
  readonly status: LibraryStatus;
  /** When the library read `status` comes from finished. */
  readonly readAt: number;
}) {
  const { sourceUpdate } = useEditor();
  const ids = useId();
  const [candidate, setCandidate] = useState<SourceUpdateCandidate | null>(null);
  const confirmed = useRef(false);
  const progressRef = useRef<HTMLParagraphElement>(null);
  // Whether the write is still running when the confirmation finishes closing: only then does its progress take focus.
  const runningRef = useRef(false);

  const { state } = sourceUpdate;
  const working = state.status !== "idle" && state.paperId === link.link.paperId && (state.status === "preparing" || state.status === "working");
  runningRef.current = working;
  const sourceState = status.kind === "ready" ? status.state : null;
  // Nothing to choose: the library abstract is the copy, gone, or neither has one. An open confirmation stays, and says what changed.
  const nothingToChoose =
    !sourceUpdate.writable || (sourceState !== null && (sourceState.kind === "current" || sourceState.kind === "abstract_removed" || sourceState.kind === "no_copy_no_abstract"));
  const dialog = (
    <SourceUpdateDialog
      candidate={candidate}
      link={link}
      status={status}
      onCancel={() => setCandidate(null)}
      onConfirm={(frozen) => {
        confirmed.current = true;
        setCandidate(null);
        void sourceUpdate.start(frozen);
      }}
      onCloseAutoFocus={(event) => {
        // After Confirm, focus follows the write — its progress here while it runs, then what it answered — never back to the
        // button, and never away from an answer that arrived before the dialog finished closing.
        if (!confirmed.current) return;
        confirmed.current = false;
        event.preventDefault();
        if (runningRef.current) progressRef.current?.focus();
      }}
    />
  );
  if (nothingToChoose) return dialog;

  const libraryText = status.kind === "ready" ? status.abstract : null;
  const eligibility = libraryText !== null ? sourceUpdateEligibility(link, libraryText) : null;
  const seq = link.currentCopy ? (link.snapshots.find((snapshot) => snapshot.id === link.currentCopy?.id)?.seq ?? link.currentCopy.seq) : null;
  const reason = working
    ? null
    : status.kind === "checking"
      ? SOURCE_UPDATE_COPY.checking
      : status.kind !== "ready" || !eligibility
        ? SOURCE_UPDATE_COPY.unread
        : eligibility.kind === "ineligible"
          ? eligibility.reason === "copy_limit"
            ? SOURCE_UPDATE_COPY.copyLimit
            : SOURCE_UPDATE_COPY.tooLong
          : !canDigestAbstract()
            ? SOURCE_UPDATE_COPY.noDigest
            : sourceUpdate.hold
              ? SOURCE_UPDATE_HOLD_MESSAGES[sourceUpdate.hold]
              : null;
  const offered = !working && reason === null && eligibility?.kind === "eligible" && libraryText !== null;
  const typography = sourceState?.kind === "typography_only_change";
  const intro = seq === null ? SOURCE_UPDATE_COPY.firstCapture : typography ? SOURCE_UPDATE_COPY.keepTypography(seq) : SOURCE_UPDATE_COPY.keep(seq);

  const open = () => {
    if (!offered || libraryText === null) return;
    // The exact text shown, frozen now: the confirmation and the request are about this text and nothing read later.
    setCandidate(
      Object.freeze({
        paperId: link.link.paperId,
        text: libraryText,
        studyVersion: sourceUpdate.knownVersion,
        currentCopyId: link.currentCopy?.id ?? null,
        readAt,
      }),
    );
  };

  return (
    <section className="space-y-2 rounded-md border p-3" aria-labelledby={`${ids}-heading`} data-testid="source-update">
      <h4 id={`${ids}-heading`} className="text-sm font-medium">
        {SOURCE_UPDATE_COPY.heading}
      </h4>
      <p className="text-xs">{intro}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant={typography ? "outline" : "default"}
          className="coarse:min-h-10 aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
          aria-disabled={!offered || undefined}
          aria-describedby={reason ? `${ids}-reason` : undefined}
          aria-busy={working || undefined}
          onClick={open}
          data-testid="source-update-open"
        >
          {working && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
          {SOURCE_UPDATE_COPY.action}
        </Button>
      </div>
      {reason && (
        <p id={`${ids}-reason`} className="text-xs" data-testid="source-update-reason">
          {reason}
        </p>
      )}
      <p ref={progressRef} tabIndex={-1} role="status" className="text-xs focus:outline-none" data-testid="source-update-progress">
        {working ? SOURCE_UPDATE_COPY.saving : ""}
      </p>
      {dialog}
    </section>
  );
}

/**
 * The confirmation: the paper, its current copy, what saving does to the
 * copies and the quotes, and each field whose review changes — or stays —
 * named. Re-checked on every render: if the library abstract shown, the
 * record, its version or its copy is no longer the one the text was frozen
 * against, or something now holds the action, Confirm sends nothing and says
 * why.
 */
function SourceUpdateDialog({
  candidate,
  link,
  status,
  onCancel,
  onConfirm,
  onCloseAutoFocus,
}: {
  readonly candidate: SourceUpdateCandidate | null;
  readonly link: StudyRecordLink;
  readonly status: LibraryStatus;
  readonly onCancel: () => void;
  readonly onConfirm: (candidate: SourceUpdateCandidate) => void;
  readonly onCloseAutoFocus: (event: Event) => void;
}) {
  const { base, sourceUpdate } = useEditor();
  // While the closing animation plays, keep showing what was open.
  const [shown, setShown] = useState(candidate);
  if (candidate !== null && candidate !== shown) setShown(candidate);
  const current = candidate ?? shown;
  const impact = useMemo(
    () => (current ? describeSourceUpdate(base, sourceUpdate.reviewItems, current.paperId) : null),
    [base, current, sourceUpdate.reviewItems],
  );

  return (
    <AlertDialog open={candidate !== null} onOpenChange={(open) => !open && onCancel()}>
      {current && impact && (
        <SourceUpdateConfirmation candidate={current} impact={impact} link={link} status={status} onConfirm={onConfirm} onCloseAutoFocus={onCloseAutoFocus} />
      )}
    </AlertDialog>
  );
}

function SourceUpdateConfirmation({
  candidate,
  impact,
  link,
  status,
  onConfirm,
  onCloseAutoFocus,
}: {
  readonly candidate: SourceUpdateCandidate;
  readonly impact: SourceUpdateImpact;
  readonly link: StudyRecordLink;
  readonly status: LibraryStatus;
  readonly onConfirm: (candidate: SourceUpdateCandidate) => void;
  readonly onCloseAutoFocus: (event: Event) => void;
}) {
  const { base, sourceUpdate } = useEditor();
  const ids = useId();
  const check = checkSourceUpdateCandidate(base, sourceUpdate.knownVersion, candidate);
  const checking = status.kind === "checking";
  const sameText = status.kind === "ready" && status.abstract === candidate.text;
  const problem = !sourceUpdate.writable
    ? SOURCE_UPDATE_COPY.notWritable
    : check.kind !== "ready" || link.link.paperId !== candidate.paperId || (!checking && !sameText)
      ? SOURCE_UPDATE_COPY.changedWhileOpen
      : checking
        ? SOURCE_UPDATE_COPY.checkingWhileOpen
        : !canDigestAbstract()
          ? SOURCE_UPDATE_COPY.noDigest
          : sourceUpdate.hold
            ? SOURCE_UPDATE_HOLD_MESSAGES[sourceUpdate.hold]
            : null;
  const ready = problem === null;
  const first = impact.currentCopy === null;
  const next = impact.copies + 1;
  const chars = codePointLength(candidate.text);
  const typography = check.kind === "ready" && check.state === "typography_only_change";
  const affected = impact.needsRereview.length + impact.staysNeedsRereview.length + impact.staysUnreviewed.length;

  return (
    <>
      <AlertDialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col" data-testid="source-update-dialog" onCloseAutoFocus={onCloseAutoFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle>{SOURCE_UPDATE_COPY.dialogTitle}</AlertDialogTitle>
        </AlertDialogHeader>
        <AlertDialogDescription asChild>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain text-sm text-muted-foreground" data-testid="source-update-impact">
            <p className="break-words font-medium text-foreground [overflow-wrap:anywhere]">
              {impact.paperTitle === null ? SOURCE_UPDATE_COPY.untitledPaper : SOURCE_UPDATE_COPY.paper(impact.paperTitle)}
            </p>
            <p>{impact.currentCopy ? SOURCE_UPDATE_COPY.currentCopy(impact.currentCopy.seq, impact.copies, formatRecordDate(impact.currentCopy.capturedAt)) : SOURCE_UPDATE_COPY.noCopy}</p>
            {typography && <p>{SOURCE_UPDATE_COPY.typography}</p>}

            <section aria-labelledby={`${ids}-what`} className="space-y-1">
              <h3 id={`${ids}-what`} className="font-medium text-foreground">
                {SOURCE_UPDATE_COPY.whatHappens}
              </h3>
              <ul className="list-disc space-y-1 pl-5" data-testid="source-update-what">
                <li>{first ? SOURCE_UPDATE_COPY.firstCopy(chars) : SOURCE_UPDATE_COPY.newCopy(next, chars)}</li>
                {impact.currentCopy && <li>{SOURCE_UPDATE_COPY.earlierKept(impact.currentCopy.seq)}</li>}
                {impact.currentCopy ? (
                  impact.quotesToRecheck > 0 ? (
                    <>
                      <li>{SOURCE_UPDATE_COPY.quotesChecked}</li>
                      <li>{SOURCE_UPDATE_COPY.quotesToCheck(impact.quotesToRecheck, impact.currentCopy.seq)}</li>
                      <li>{SOURCE_UPDATE_COPY.matchMeaning}</li>
                    </>
                  ) : (
                    <li>{SOURCE_UPDATE_COPY.noQuotes(impact.currentCopy.seq)}</li>
                  )
                ) : (
                  <li>{SOURCE_UPDATE_COPY.firstNoQuotes}</li>
                )}
                {impact.quotesOnEarlierCopies > 0 && <li>{SOURCE_UPDATE_COPY.quotesEarlier(impact.quotesOnEarlierCopies)}</li>}
              </ul>
            </section>

            <section aria-labelledby={`${ids}-reviews`} className="space-y-2" data-testid="source-update-reviews">
              <h3 id={`${ids}-reviews`} className="font-medium text-foreground">
                {SOURCE_UPDATE_COPY.reviewsHeading}
              </h3>
              {affected === 0 ? (
                <p>{SOURCE_UPDATE_COPY.noReviews}</p>
              ) : (
                <>
                  <p>{SOURCE_UPDATE_COPY.reviewIntro}</p>
                  <ImpactList
                    testId="source-update-needs-rereview"
                    heading={SOURCE_UPDATE_COPY.needsRereview(impact.needsRereview.length)}
                    items={impact.needsRereview}
                    describe={(item) =>
                      item.value.review.status === "disputed" ? SOURCE_UPDATE_COPY.flaggedFrom(reviewItemLabel(item)) : SOURCE_UPDATE_COPY.reviewedFrom(reviewItemLabel(item))
                    }
                  />
                  <ImpactList
                    testId="source-update-stays-rereview"
                    heading={SOURCE_UPDATE_COPY.staysNeedsRereview(impact.staysNeedsRereview.length)}
                    items={impact.staysNeedsRereview}
                    describe={reviewItemLabel}
                  />
                  <ImpactList
                    testId="source-update-stays-unreviewed"
                    heading={SOURCE_UPDATE_COPY.staysUnreviewed(impact.staysUnreviewed.length)}
                    items={impact.staysUnreviewed}
                    describe={reviewItemLabel}
                  />
                  {impact.withReviewNote > 0 && <p>{SOURCE_UPDATE_COPY.notesKept}</p>}
                  {first && impact.unavailableAbstract.length > 0 && <p data-testid="source-update-unavailable">{SOURCE_UPDATE_COPY.unavailable(impact.unavailableAbstract.length)}</p>}
                </>
              )}
            </section>
          </div>
        </AlertDialogDescription>
        {problem && (
          <p role={checking ? "status" : "alert"} className="rounded-md border border-amber-500/50 bg-amber-50 p-2 text-sm dark:bg-amber-950/30" data-testid="source-update-problem">
            {problem}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel className="coarse:min-h-10">{SOURCE_UPDATE_COPY.cancel}</AlertDialogCancel>
          <Button
            type="button"
            className="coarse:min-h-10 aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
            aria-disabled={!ready || undefined}
            onClick={() => {
              if (ready) onConfirm(candidate);
            }}
            data-testid="source-update-confirm"
          >
            {first ? SOURCE_UPDATE_COPY.confirmFirst : SOURCE_UPDATE_COPY.confirm(next)}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </>
  );
}

function ImpactList({
  testId,
  heading,
  items,
  describe,
}: {
  readonly testId: string;
  readonly heading: string;
  readonly items: readonly ReviewItem[];
  readonly describe: (item: ReviewItem) => string;
}) {
  if (items.length === 0) return null;
  return (
    <div className="space-y-1" data-testid={testId}>
      <p>{heading}</p>
      <ul className="list-disc space-y-0.5 pl-5">
        {items.map((item) => (
          <li key={item.key} className="break-words [overflow-wrap:anywhere]">
            {describe(item)}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * What "Use current abstract" last answered for this link, from the server's
 * own answer: the copy it saved, the quotes it found again or kept, and the
 * reviews it changed — or why nothing was saved, with what to do next. A
 * rebase in doubt, a conflict and a lost pilot role are the editor's own
 * alerts, so they are not repeated here.
 */
export const SourceUpdateOutcome = forwardRef<HTMLDivElement, { readonly link: StudyRecordLink }>(function SourceUpdateOutcome({ link }, ref) {
  const { sourceUpdate } = useEditor();
  const { state } = sourceUpdate;
  if (state.status === "idle" || state.paperId !== link.link.paperId) return null;
  const box = "space-y-2 rounded-md border p-3 text-sm focus:outline-none";
  switch (state.status) {
    case "done":
      return (
        <div ref={ref} tabIndex={-1} role="status" className={`${box} border-emerald-600/40 bg-emerald-50 dark:bg-emerald-950/30`} data-testid="source-update-outcome" data-outcome={state.result.status}>
          {sourceUpdateResultLines(state.result).map((line, index) => (
            <p key={index} className={index === 0 ? "font-medium" : undefined}>
              {line}
            </p>
          ))}
          <Button type="button" size="sm" variant="ghost" className="coarse:min-h-10" onClick={sourceUpdate.dismiss}>
            {SOURCE_UPDATE_COPY.dismiss}
          </Button>
        </div>
      );
    case "reload_failed":
      return (
        <div ref={ref} tabIndex={-1} role="alert" className={`${box} border-amber-500/50 bg-amber-50 dark:bg-amber-950/30`} data-testid="source-update-outcome" data-outcome="reload_failed">
          <p>{SOURCE_UPDATE_COPY.reloadFailed(state.result.seq)}</p>
          <Button type="button" size="sm" variant="outline" className="coarse:min-h-10" onClick={sourceUpdate.reload}>
            {SOURCE_UPDATE_COPY.reload}
          </Button>
        </div>
      );
    case "not_sent":
    case "source_changed":
      return (
        <div ref={ref} tabIndex={-1} role="alert" className={`${box} border-amber-500/50 bg-amber-50 dark:bg-amber-950/30`} data-testid="source-update-outcome" data-outcome={state.status === "not_sent" ? `not_sent:${state.reason}` : "source_changed"}>
          <p>{state.status === "not_sent" ? SOURCE_UPDATE_COPY.notSent[state.reason] : SOURCE_UPDATE_COPY.sourceChanged}</p>
          <Button type="button" size="sm" variant="ghost" className="coarse:min-h-10" onClick={sourceUpdate.dismiss}>
            {SOURCE_UPDATE_COPY.dismiss}
          </Button>
        </div>
      );
    case "failed":
      return (
        <div ref={ref} tabIndex={-1} role="alert" className={`${box} border-destructive/40 bg-destructive/5`} data-testid="source-update-outcome" data-outcome={`failed:${state.error.kind}`}>
          <p>{sourceUpdateErrorText(state.error)}</p>
          <p className="text-xs">{SOURCE_UPDATE_COPY.reloadToTryAgain}</p>
          <Button type="button" size="sm" variant="outline" className="coarse:min-h-10" onClick={sourceUpdate.reload}>
            {SOURCE_UPDATE_COPY.reload}
          </Button>
        </div>
      );
    default:
      return null;
  }
});
