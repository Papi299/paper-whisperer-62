import { useEffect, useId, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Circle, Flag, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ReviewActionState } from "@/hooks/useStudyRecordEditor";
import { CODE_LABELS } from "@/lib/evidence/fieldDictionary";
import { normalizeEvidenceV1WithMap } from "@/lib/evidence/normalization";
import { confirmBlockMessage, REVIEW_STATUS_LABELS, reviewedByYouMeaning } from "@/lib/evidence/review";
import { describeValueState } from "@/lib/evidence/states";
import type { RecordedValue } from "@/lib/evidence/types";
import type { LinkSources } from "@/lib/evidence/validation";
import type { StudyRecordLink } from "@/lib/studyRecord/read";
import { reviewCopyFocus, type ReviewItem, type ReviewSource } from "@/lib/studyRecord/reviewModel";
import { EarlierCopy } from "./EarlierCopy";
import { FlagForm } from "./FlagForm";
import { formatRecordDate, REVIEW_COPY, REVIEW_HOLD_MESSAGES, reviewErrorText, reviewItemLabel } from "./reviewCopy";
import { SavedCopyText } from "./SavedCopyText";
import { SOURCE_COMPARE_COPY } from "./sourceCompareCopy";
import { savedQuoteRanges } from "./sourcePaneModel";
import { STUDY_RECORD_COPY } from "./studyRecordCopy";

export interface ReviewCardProps {
  readonly item: ReviewItem;
  /** The heading level: 4 for a study field, 5 inside a group or outcome. */
  readonly level: 4 | 5;
  readonly isMobile: boolean;
  readonly links: readonly StudyRecordLink[];
  /** The same links as `checkConfirm` takes them: each paper's current copy and every copy. */
  readonly linkSources: readonly LinkSources[];
  /** The editor's review action, to show this card's own progress or refusal. */
  readonly action: ReviewActionState;
  readonly registerHeading: (key: string, element: HTMLElement | null) => void;
  readonly registerStatus: (key: string, element: HTMLElement | null) => void;
  readonly onFocusItem: (item: ReviewItem) => void;
  readonly onConfirm: (item: ReviewItem) => void;
  /** Resolves to true once the flag is recorded. */
  readonly onFlag: (item: ReviewItem, note: string) => Promise<boolean>;
  readonly onEdit: (item: ReviewItem) => void;
  readonly onReload: () => void;
  readonly onDismiss: () => void;
}

/** Refusals shown for the whole record rather than on a card (the editor's own messages). */
const RECORD_LEVEL_REFUSALS = new Set(["version_conflict", "records_not_enabled", "study_not_found"]);

/**
 * One saved value under review (Requirements-001A §I3): its label, the value
 * and state as SAVED, its note, its sources — each scoped to the paper and the
 * copy it names — and its review status, in words beside an icon. The only
 * actions are "Confirm against this source", "Flag…" and "Edit"; when Confirm
 * can't be used, why is written next to it and linked to it.
 */
export function ReviewCard({
  item,
  level,
  isMobile,
  links,
  linkSources,
  action,
  registerHeading,
  registerStatus,
  onFocusItem,
  onConfirm,
  onFlag,
  onEdit,
  onReload,
  onDismiss,
}: ReviewCardProps) {
  const ids = useId();
  const label = reviewItemLabel(item);
  const { value, confirm, flag } = item;
  const [flagOpen, setFlagOpen] = useState(false);
  const flagButtonRef = useRef<HTMLButtonElement>(null);
  const alertRef = useRef<HTMLDivElement>(null);

  const mine = action.status !== "idle" && action.valueId === value.id;
  const working = mine && action.status === "working";
  const failure = mine && action.status === "failed" ? action.failure : null;
  const cardFailure = failure && !(failure.kind === "refused" && RECORD_LEVEL_REFUSALS.has(failure.error.kind)) ? failure : null;

  useEffect(() => {
    if (cardFailure) alertRef.current?.focus();
  }, [cardFailure]);

  const writable = confirm.kind !== "none";
  const confirmShown = confirm.kind === "offered" || confirm.kind === "held" || confirm.kind === "blocked";
  const confirmReasons =
    confirm.kind === "held" ? [REVIEW_HOLD_MESSAGES[confirm.hold]] : confirm.kind === "blocked" ? confirm.reasons.map((block) => confirmBlockMessage(block, value, linkSources)) : [];
  const replacesFlag = confirmShown && value.review.status === "disputed";
  const confirmDescribedBy = [confirmReasons.length > 0 ? `${ids}-reasons` : null, replacesFlag ? `${ids}-replaces` : null].filter(Boolean).join(" ") || undefined;
  const flagHeld = flag.kind === "held" ? REVIEW_HOLD_MESSAGES[flag.hold] : null;
  // Both actions wait for the same hold: when Confirm is shown, its reasons already say why.
  const flagHeldId = flagHeld ? (confirm.kind === "held" ? `${ids}-reasons` : `${ids}-flag-held`) : undefined;
  const Heading = level === 4 ? "h4" : "h5";

  return (
    <article
      aria-labelledby={`${ids}-heading`}
      data-review-target={`value:${item.key}`}
      data-testid={`review-card-${item.key}`}
      className="space-y-3 rounded-md border p-3"
      onFocusCapture={() => onFocusItem(item)}
      onPointerDown={() => onFocusItem(item)}
    >
      <Heading
        id={`${ids}-heading`}
        ref={(element: HTMLHeadingElement | null) => registerHeading(item.key, element)}
        tabIndex={-1}
        className="break-words rounded-sm text-sm font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-ring [overflow-wrap:anywhere]"
      >
        {label}
      </Heading>

      <StatusLine value={value} id={`${ids}-status`} register={(element) => registerStatus(item.key, element)} />
      <ValueView item={item} />
      <SourceList item={item} />
      {item.fromAbstractOnly && <p className="text-xs text-muted-foreground">{REVIEW_COPY.fromAbstractOnly}</p>}
      {isMobile && item.abstractPaperIds.length > 0 && <InlineSavedCopy item={item} links={links} />}

      {cardFailure && (
        <div ref={alertRef} tabIndex={-1} role="alert" className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm focus:outline-none" data-testid="review-card-alert">
          <CardFailure failure={cardFailure} value={value} linkSources={linkSources} />
          <div className="flex flex-wrap gap-2">
            {(cardFailure.kind !== "refused" || ["confirm_blocked", "target_not_found", "request_id_reused"].includes(cardFailure.error.kind)) && (
              <Button type="button" size="sm" variant="outline" className="coarse:min-h-10" onClick={onReload}>
                {REVIEW_COPY.reload}
              </Button>
            )}
            <Button type="button" size="sm" variant="ghost" className="coarse:min-h-10" onClick={onDismiss}>
              {REVIEW_COPY.dismiss}
            </Button>
          </div>
        </div>
      )}

      {writable && (
        <div className="space-y-2">
          {confirmReasons.length > 0 && (
            <ul id={`${ids}-reasons`} className="space-y-1 text-xs" data-testid="review-confirm-reasons">
              {confirmReasons.map((reason) => (
                <li key={reason} className="flex items-start gap-1">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span>{reason}</span>
                </li>
              ))}
            </ul>
          )}
          {replacesFlag && (
            <p id={`${ids}-replaces`} className="text-xs">
              {REVIEW_COPY.confirmFlagged}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {confirmShown && (
              <Button
                type="button"
                size="sm"
                className="coarse:min-h-10 aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
                aria-disabled={confirm.kind !== "offered" || working || undefined}
                aria-describedby={confirmDescribedBy}
                aria-busy={(working && action.status === "working" && action.action === "confirm") || undefined}
                data-testid="review-confirm"
                onClick={() => {
                  if (confirm.kind !== "offered" || working) return;
                  onConfirm(item);
                }}
              >
                {working && action.status === "working" && action.action === "confirm" && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
                {REVIEW_COPY.confirm}
              </Button>
            )}
            <Button
              ref={flagButtonRef}
              type="button"
              size="sm"
              variant="outline"
              className="coarse:min-h-10 aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
              aria-expanded={flagOpen}
              aria-controls={flagOpen ? `${ids}-flag` : undefined}
              aria-disabled={(flag.kind !== "offered" && !flagOpen) || undefined}
              aria-describedby={!flagOpen ? flagHeldId : undefined}
              data-testid="review-flag"
              onClick={() => {
                if (flagOpen) setFlagOpen(false);
                else if (flag.kind === "offered") setFlagOpen(true);
              }}
            >
              {REVIEW_COPY.flag}
            </Button>
            <Button type="button" variant="link" className="h-auto p-0 coarse:min-h-10" aria-label={REVIEW_COPY.editLabel(label)} onClick={() => onEdit(item)}>
              {REVIEW_COPY.edit}
            </Button>
          </div>
          {flagHeld && confirm.kind !== "held" && (
            <p id={`${ids}-flag-held`} className="text-xs">
              {flagHeld}
            </p>
          )}
          {flagOpen && (
            <FlagForm
              id={`${ids}-flag`}
              value={value}
              working={working && action.status === "working" && action.action === "flag"}
              heldReason={flagHeld}
              onCancel={() => {
                setFlagOpen(false);
                requestAnimationFrame(() => flagButtonRef.current?.focus());
              }}
              onSubmit={(note) => {
                void onFlag(item, note).then((flagged) => {
                  if (flagged) setFlagOpen(false);
                });
              }}
            />
          )}
        </div>
      )}
    </article>
  );
}

/** The review status as an icon AND words; the date of a review is the server's `reviewed_at`. */
function StatusLine({ value, id, register }: { readonly value: RecordedValue; readonly id: string; readonly register: (element: HTMLElement | null) => void }) {
  const { review } = value;
  const date = review.reviewedAt ? formatRecordDate(review.reviewedAt) : null;
  const Icon = review.status === "user_reviewed" ? CheckCircle2 : review.status === "disputed" ? Flag : review.status === "needs_rereview" ? RefreshCw : Circle;
  const text =
    review.status === "user_reviewed" && date
      ? REVIEW_COPY.reviewedOn(date)
      : review.status === "needs_rereview"
        ? REVIEW_COPY.needsRereview
        : REVIEW_STATUS_LABELS[review.status];
  const noteLabel = review.status === "needs_rereview" ? REVIEW_COPY.earlierReviewNote : REVIEW_COPY.flagNote;
  return (
    <div className="space-y-1">
      <p ref={register} id={id} tabIndex={-1} className="flex items-center gap-1.5 rounded-sm text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-ring" data-testid="review-status">
        <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span>
          <span className="sr-only">{REVIEW_COPY.statusLabel}: </span>
          {text}
        </span>
      </p>
      {review.status === "user_reviewed" && date && <p className="text-xs text-muted-foreground">{reviewedByYouMeaning(date)}</p>}
      {review.note && (
        <p className="whitespace-pre-wrap break-words text-xs [overflow-wrap:anywhere]" data-testid="review-note">
          <span className="font-medium">{noteLabel}: </span>
          {review.note}
        </p>
      )}
    </div>
  );
}

/** The value exactly as saved: its state, its content, its reason and its note. */
function ValueView({ item }: { readonly item: ReviewItem }) {
  const { value } = item;
  const { content } = value;
  return (
    <div className="space-y-1 text-sm" data-testid="review-value">
      <p className="font-medium">
        {describeValueState(value).label}
        {value.state === "unclear" && value.stateReason ? ` — ${STUDY_RECORD_COPY.reasons[value.stateReason]}` : ""}
      </p>
      {content?.shape === "text" && <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{content.text}</p>}
      {content?.shape === "code" && <p>{CODE_LABELS[value.fieldKey]?.[content.code] ?? content.code}</p>}
      {content?.shape === "integer_with_reported_text" && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-2">
          <dt className="text-muted-foreground">{REVIEW_COPY.asReported}</dt>
          <dd className="min-w-0 break-words [overflow-wrap:anywhere]">{content.reportedText}</dd>
          <dt className="text-muted-foreground">{REVIEW_COPY.confirmedNumber}</dt>
          <dd>{content.value.toLocaleString("en-US")}</dd>
        </dl>
      )}
      {content?.shape === "text_list" && (
        <ul className="list-disc space-y-0.5 pl-5">
          {content.entries.map((entry, index) => (
            <li key={index} className="break-words [overflow-wrap:anywhere]">
              {entry}
            </li>
          ))}
        </ul>
      )}
      {value.note && (
        <p className="whitespace-pre-wrap break-words text-xs [overflow-wrap:anywhere]">
          <span className="font-medium">{REVIEW_COPY.valueNote}: </span>
          {value.note}
        </p>
      )}
    </div>
  );
}

const paperName = (source: ReviewSource) => source.paper.title ?? REVIEW_COPY.thisPaper;
const copyName = (copy: Extract<ReviewSource, { kind: "quote" }>["copy"]) =>
  copy ? (copy.current ? REVIEW_COPY.copyLabel(copy.snapshot.seq, copy.total, formatRecordDate(copy.snapshot.capturedAt)) : `${REVIEW_COPY.earlierCopyNotShown} — ${REVIEW_COPY.copyLabel(copy.snapshot.seq, copy.total, formatRecordDate(copy.snapshot.capturedAt))}`) : REVIEW_COPY.earlierCopyNotShown;

/** The persisted references, each with the paper and copy it names (FK-PROOF-001 §J). */
function SourceList({ item }: { readonly item: ReviewItem }) {
  const supported = item.sources.some((source) => source.kind === "quote" || (source.kind === "full_text" && source.purpose === "supports"));
  return (
    <div className="space-y-2" data-testid="review-sources">
      <p className="text-xs font-medium">{REVIEW_COPY.sourcesHeading}</p>
      {item.value.state === "reported" && !supported && <p className="text-xs">{REVIEW_COPY.noSourceGiven}</p>}
      {item.sources.length > 0 && (
        <ul className="space-y-2">
          {item.sources.map((source) => (
            <li key={source.id} className="space-y-1 rounded-md bg-muted/40 p-2 text-xs" data-testid="review-source">
              <SourceView source={source} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SourceView({ source }: { readonly source: ReviewSource }) {
  switch (source.kind) {
    case "quote":
      return (
        <>
          <p className="break-words [overflow-wrap:anywhere]">
            <span className="font-medium">{REVIEW_COPY.quoteFrom(paperName(source))}</span> ({copyName(source.copy)}
            {source.count > 1 ? `, ${REVIEW_COPY.occurrence(source.occurrence, source.count)}` : ""})
          </p>
          {source.context ? (
            <blockquote className="whitespace-pre-wrap break-words border-l-2 pl-2 [overflow-wrap:anywhere]" data-testid="review-quote">
              {source.context.truncatedBefore && "…"}
              {source.context.before}
              <mark className="bg-amber-100 underline decoration-dotted underline-offset-2 dark:bg-amber-900/50">{source.context.match}</mark>
              {source.context.after}
              {source.context.truncatedAfter && "…"}
            </blockquote>
          ) : (
            <>
              <blockquote className="whitespace-pre-wrap break-words border-l-2 pl-2 [overflow-wrap:anywhere]" data-testid="review-quote">
                {source.quoteText}
              </blockquote>
              <p className="text-amber-700 dark:text-amber-400">{source.copy?.current ? REVIEW_COPY.quoteNotLocated : REVIEW_COPY.earlierCopyQuote}</p>
            </>
          )}
        </>
      );
    case "full_text":
      if (source.purpose === "supports") {
        return (
          <p className="break-words [overflow-wrap:anywhere]">
            <span className="font-medium">{REVIEW_COPY.fullTextOf(paperName(source))}</span>
            {source.locator ? `, ${STUDY_RECORD_COPY.locatorKinds[source.locator.kind]} ${source.locator.text}` : ""} — {REVIEW_COPY.yourReference}
          </p>
        );
      }
      return (
        <p className="break-words [overflow-wrap:anywhere]">
          <span className="font-medium">{REVIEW_COPY.examinedFullText(paperName(source))}</span>
          {source.locator ? `, ${STUDY_RECORD_COPY.locatorKinds[source.locator.kind]} ${source.locator.text}` : ""} ({REVIEW_COPY.yourStatement})
        </p>
      );
    case "examined_abstract":
      return (
        <p className="break-words [overflow-wrap:anywhere]">
          <span className="font-medium">{REVIEW_COPY.examinedAbstract(paperName(source))}</span> ({copyName(source.copy)})
        </p>
      );
    case "unavailable":
      return (
        <>
          <p className="break-words font-medium [overflow-wrap:anywhere]">
            {source.sourceKind === "abstract" ? REVIEW_COPY.unavailableAbstract(paperName(source)) : REVIEW_COPY.unavailableFullText(paperName(source))}
          </p>
          {source.copyNow && <p>{REVIEW_COPY.unavailableNowHasCopy}</p>}
        </>
      );
  }
}

/**
 * On a phone the Source pane is not beside the card, so the card shows the
 * saved copy itself on request (001A §I3: an absence can't be quoted, so a Not
 * reported or Couldn't check claim needs the copy beside it): each linked
 * paper's current copy, with this value's SAVED quotes marked.
 */
function InlineSavedCopy({ item, links }: { readonly item: ReviewItem; readonly links: readonly StudyRecordLink[] }) {
  const ids = useId();
  const [open, setOpen] = useState(false);
  const shown = item.abstractPaperIds.map((paperId) => links.find((link) => link.link.paperId === paperId)).filter((link): link is StudyRecordLink => !!link);
  return (
    <div className="space-y-2">
      <Button type="button" variant="outline" size="sm" className="coarse:min-h-10" aria-expanded={open} aria-controls={open ? `${ids}-copy` : undefined} onClick={() => setOpen((current) => !current)}>
        {open ? REVIEW_COPY.hideSavedCopy : REVIEW_COPY.showSavedCopy}
      </Button>
      {open && (
        <div id={`${ids}-copy`} className="space-y-3" data-testid="review-inline-copy">
          {shown.map((link) => (
            <InlineCopy key={link.link.id} item={item} link={link} />
          ))}
        </div>
      )}
    </div>
  );
}

function InlineCopy({ item, link }: { readonly item: ReviewItem; readonly link: StudyRecordLink }) {
  const copy = link.currentCopy;
  // One earlier copy at a time, in the card (C2C-A): on a phone the Source pane isn't beside it.
  const [openCopy, setOpenCopy] = useState<string | null>(null);
  const map = useMemo(() => (copy ? normalizeEvidenceV1WithMap(copy.exactText) : null), [copy]);
  const ranges = useMemo(() => (copy && map ? savedQuoteRanges(item.value, copy.id, map) : []), [copy, map, item.value]);
  const focus = reviewCopyFocus(item, link.link.paperId);
  const info = copy ? link.snapshots.find((snapshot) => snapshot.id === copy.id) : undefined;
  return (
    <div className="space-y-1">
      <p className="break-words text-xs font-medium [overflow-wrap:anywhere]">{link.paperTitle ?? REVIEW_COPY.thisPaper}</p>
      {focus.unavailable && <p className="text-xs">{REVIEW_COPY.sourceUnavailable}</p>}
      {focus.examinedCurrent && <p className="text-xs">{REVIEW_COPY.sourceExamined}</p>}
      {focus.currentQuotes > 0 && <p className="text-xs">{REVIEW_COPY.sourceHighlighted(focus.currentQuotes)}</p>}
      {focus.earlierCopies.map((snapshot) => (
        <div key={snapshot.id} className="space-y-1">
          <p className="text-xs">{REVIEW_COPY.sourceEarlierCopy(snapshot.seq, formatRecordDate(snapshot.capturedAt))}</p>
          {openCopy === snapshot.id ? (
            <EarlierCopy link={link} info={snapshot} values={[item.value]} reviewing onBack={() => setOpenCopy(null)} backLabel={SOURCE_COMPARE_COPY.hideCopy(snapshot.seq)} />
          ) : (
            <Button type="button" variant="outline" size="sm" className="coarse:min-h-10" onClick={() => setOpenCopy(snapshot.id)} data-testid="review-show-earlier-copy">
              {SOURCE_COMPARE_COPY.showCopy(snapshot.seq)}
            </Button>
          )}
        </div>
      ))}
      {copy ? (
        <>
          {info && <p className="text-xs text-muted-foreground">{REVIEW_COPY.sourceCopy(info.seq, link.snapshots.length, formatRecordDate(copy.capturedAt))}</p>}
          <SavedCopyText text={copy.exactText} ranges={ranges} data-testid="review-inline-saved-abstract" />
        </>
      ) : (
        <p className="text-xs">{STUDY_RECORD_COPY.noSavedCopy}</p>
      )}
    </div>
  );
}

/** Why this card's last review was not recorded, and what to do. */
function CardFailure({
  failure,
  value,
  linkSources,
}: {
  readonly failure: Extract<ReviewActionState, { status: "failed" }>["failure"];
  readonly value: RecordedValue;
  readonly linkSources: readonly LinkSources[];
}) {
  if (failure.kind === "stale_version") return <p>{REVIEW_COPY.staleVersion}</p>;
  if (failure.kind === "not_recorded") return <p>{REVIEW_COPY.notRecorded}</p>;
  const { error } = failure;
  if (error.kind === "confirm_blocked" && error.blocks && error.blocks.length > 0) {
    // The server's answer stands: its blocks replace the browser's advice.
    return (
      <ul className="space-y-1">
        {error.blocks.map((block) => (
          <li key={block}>{confirmBlockMessage(block, value, linkSources)}</li>
        ))}
      </ul>
    );
  }
  return <p>{reviewErrorText(error)}</p>;
}
