import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import type { FieldKey } from "@/lib/evidence/fieldDictionary";
import { locateQuote, type QuoteOccurrence } from "@/lib/evidence/matcher";
import { normalizeEvidenceV1WithMap } from "@/lib/evidence/normalization";
import { parseValueKey, setValueEdit, viewValue } from "@/lib/studyRecord/draft";
import { addQuoteToEdit, quoteChoiceFromSelection } from "@/lib/studyRecord/quotes";
import { reviewCopyFocus, type ReviewItem } from "@/lib/studyRecord/reviewModel";
import { useEditor } from "./editorContext";
import { formatRecordDate, REVIEW_COPY, reviewItemLabel } from "./reviewCopy";
import { SavedCopyText } from "./SavedCopyText";
import { quoteFieldGroups, savedQuoteRanges, storedQuoteRange, type TextRange } from "./sourcePaneModel";
import { STUDY_RECORD_COPY } from "./studyRecordCopy";

type Range = TextRange;

const SELECT_CLASS =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

/**
 * What the Source pane shows (EVIDENCE-RECORDS-001C2A). In Edit, the draft's
 * quotes — saved and unsaved — and "Use as quote". In Review, only the SAVED
 * quotes of the card being reviewed, and no way to add one: a quote added,
 * changed or removed in the draft is never shown as what a Confirm is made
 * against.
 */
export type SourceDisplay = { readonly mode: "edit" } | { readonly mode: "review"; readonly item: ReviewItem | null };

/**
 * The Source pane (Requirements-001 §E3–§E4): the study's IMMUTABLE saved copy
 * of the abstract — never the live library abstract — as plain text nodes,
 * `white-space: pre-wrap`, so superscripts, punctuation, line breaks and every
 * space survive and nothing is interpreted as HTML. Quotes already used on
 * this copy are highlighted (an underline as well as a colour).
 *
 * In Edit, selecting text offers "Use as quote for…" a chosen field. The
 * selection's occurrence comes from the selection itself; when the selection
 * cannot tell which of several identical passages it is, the user is asked.
 * The browser's match is advisory; the server matches again when the record
 * is saved. In Review (`display`), the pane shows the saved quotes of one
 * value and says what it cannot show — an earlier copy is never stood in for
 * by the current one.
 */
export function SourcePane({ onQuoteAdded, display = { mode: "edit" } }: { readonly onQuoteAdded: (key: string) => void; readonly display?: SourceDisplay }) {
  const editor = useEditor();
  const ids = useId();
  const link = editor.sourceLink;
  const copy = link?.currentCopy ?? null;
  const reviewing = display.mode === "review";
  const quoting = editor.canEdit && !reviewing;
  const textRef = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<Range | null>(null);
  const [pickedKey, setPickedKey] = useState<string | null>(null);
  const [pending, setPending] = useState<{ readonly quoteText: string; readonly occurrences: readonly QuoteOccurrence[] } | null>(null);
  const [chosen, setChosen] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");

  const groups = useMemo(() => quoteFieldGroups(editor.draft), [editor.draft]);
  const allKeys = useMemo(() => new Set(groups.flatMap((group) => group.options.map((option) => option.key))), [groups]);
  const targetKey =
    (pickedKey && allKeys.has(pickedKey) && pickedKey) ||
    (editor.lastFocusedKey && allKeys.has(editor.lastFocusedKey) && editor.lastFocusedKey) ||
    groups[0]?.options[0]?.key ||
    null;

  const map = useMemo(() => (copy ? normalizeEvidenceV1WithMap(copy.exactText) : null), [copy]);
  const reviewItem = display.mode === "review" ? display.item : null;
  const highlights = useMemo(() => {
    if (!copy || !map) return [];
    // Review: the saved quotes of the card under review, and nothing else.
    if (reviewing) return reviewItem ? savedQuoteRanges(reviewItem.value, copy.id, map) : [];
    const ranges: Range[] = [];
    const keys = new Set([...editor.baseValues.keys(), ...editor.draft.values.keys()]);
    for (const key of keys) {
      const { edit } = viewValue(editor.baseValues, editor.draft, key);
      if (edit.cleared) continue;
      for (const reference of edit.references) {
        const r = reference.reference;
        if (r.purpose !== "supports" || r.sourceKind !== "abstract" || r.snapshotId !== copy.id) continue;
        if (reference.kind === "kept" && reference.reference.purpose === "supports" && reference.reference.sourceKind === "abstract") {
          const range = storedQuoteRange(map, reference.reference.match);
          if (range) ranges.push(range);
        } else if (reference.kind === "new" && reference.reference.purpose === "supports" && reference.reference.sourceKind === "abstract") {
          const match = locateQuote(reference.reference.quoteText, copy.exactText);
          const occurrence =
            match.kind === "unique" ? match.occurrences[0] : match.kind === "multiple" && reference.reference.occurrence ? match.occurrences[reference.reference.occurrence - 1] : null;
          if (occurrence) ranges.push({ start: occurrence.exactUtf16.start, end: occurrence.exactUtf16.end });
        }
      }
    }
    return ranges;
  }, [copy, map, reviewing, reviewItem, editor.baseValues, editor.draft]);

  /** The selection, as UTF-16 indices of the copy, when it lies inside the copy's text. Ignored in Review. */
  const captureSelection = useCallback(() => {
    if (reviewing) return;
    const container = textRef.current;
    const current = window.getSelection();
    if (!container || !current || current.rangeCount === 0 || current.isCollapsed) return;
    const range = current.getRangeAt(0);
    if (!container.contains(range.startContainer) || !container.contains(range.endContainer)) return;
    const before = range.cloneRange();
    before.selectNodeContents(container);
    before.setEnd(range.startContainer, range.startOffset);
    const start = before.toString().length;
    const end = start + range.toString().length;
    if (end > start) {
      setSelection({ start, end });
      setPending(null);
      setChosen(null);
      setMessage(null);
    }
  }, [reviewing]);

  useEffect(() => {
    const onChange = () => captureSelection();
    document.addEventListener("selectionchange", onChange);
    return () => document.removeEventListener("selectionchange", onChange);
  }, [captureSelection]);

  const applySelectionAsQuote = () => {
    if (!quoting || !copy || !selection || !targetKey) return;
    const choice = pending
      ? chosen !== null
        ? { kind: "ready" as const, quoteText: pending.quoteText, occurrence: chosen, count: pending.occurrences.length }
        : null
      : quoteChoiceFromSelection(copy.exactText, selection);
    if (!choice) return;
    if (choice.kind === "invalid") {
      setMessage(choice.message);
      return;
    }
    if (choice.kind === "choose") {
      setPending({ quoteText: choice.quoteText, occurrences: choice.occurrences });
      return;
    }
    const several = choice.count !== null && choice.count > 1;
    const { fieldKey } = parseValueKey(targetKey);
    const current = viewValue(editor.baseValues, editor.draft, targetKey).edit;
    const result = addQuoteToEdit(
      current,
      fieldKey as FieldKey,
      {
        purpose: "supports",
        sourceKind: "abstract",
        paperId: copy.paperId,
        snapshotId: copy.id,
        quoteText: choice.quoteText,
        occurrence: several ? choice.occurrence : null,
        expectedMatchCount: several ? choice.count : null,
      },
      editor.newLocalId(),
      choice.quoteText,
    );
    if (!result.ok) {
      setMessage(result.reason === "limit" ? STUDY_RECORD_COPY.quoteLimit : STUDY_RECORD_COPY.quoteNeedsState);
      return;
    }
    editor.update((draft) => setValueEdit(editor.baseValues, draft, targetKey, result.edit));
    setAnnouncement(STUDY_RECORD_COPY.quoteAdded(editor.describeField(targetKey)));
    setSelection(null);
    setPending(null);
    setChosen(null);
    setMessage(null);
    window.getSelection()?.removeAllRanges();
    onQuoteAdded(targetKey);
  };

  const selectedText = copy && selection ? copy.exactText.slice(selection.start, selection.end) : "";
  const preview = Array.from(selectedText).length > 160 ? `${Array.from(selectedText).slice(0, 160).join("")}…` : selectedText;
  const copyInfo = copy && link ? link.snapshots.find((snapshot) => snapshot.id === copy.id) ?? null : null;

  return (
    <div className="flex min-h-full flex-col" data-testid="study-record-source-pane" data-source-mode={display.mode}>
      <div className="flex-1 space-y-3 px-4 py-4 sm:px-6">
        {reviewing && <ReviewSourceFocus item={reviewItem} paperId={link?.link.paperId ?? null} />}
        {editor.links.length > 1 && (
          <div className="space-y-1">
            <Label htmlFor={`${ids}-paper`} className="text-xs">
              {STUDY_RECORD_COPY.sourcePaperLabel}
            </Label>
            <select id={`${ids}-paper`} className={SELECT_CLASS} value={link?.link.paperId ?? ""} onChange={(event) => editor.setSourcePaperId(event.target.value)}>
              {editor.links.map((candidate) => (
                <option key={candidate.link.id} value={candidate.link.paperId}>
                  {candidate.paperTitle ?? STUDY_RECORD_COPY.thisPaper}
                </option>
              ))}
            </select>
          </div>
        )}
        <h3 className="text-sm font-semibold">{STUDY_RECORD_COPY.savedCopyHeading}</h3>
        {copy ? (
          <>
            <p className="text-xs text-muted-foreground">
              {reviewing && copyInfo && link
                ? REVIEW_COPY.sourceCopy(copyInfo.seq, link.snapshots.length, formatRecordDate(copy.capturedAt))
                : STUDY_RECORD_COPY.savedCopyDate(formatRecordDate(copy.capturedAt))}
            </p>
            <SavedCopyText
              ref={textRef}
              data-testid="study-record-saved-abstract"
              text={copy.exactText}
              ranges={highlights}
              onMouseUp={captureSelection}
              onKeyUp={captureSelection}
              onTouchEnd={captureSelection}
            />
            {quoting && !selection && <p className="text-xs text-muted-foreground">{STUDY_RECORD_COPY.selectionPrompt}</p>}
          </>
        ) : (
          <p className="text-sm">{STUDY_RECORD_COPY.noSavedCopy}</p>
        )}
        <p className="text-xs text-muted-foreground">{STUDY_RECORD_COPY.fullTextNotice}</p>
        <p role="status" className="sr-only">
          {announcement}
        </p>
      </div>

      {quoting && copy && selection && (
        <div className="sticky bottom-0 space-y-2 border-t bg-background px-4 py-3 sm:px-6" role="region" aria-label={STUDY_RECORD_COPY.useAsQuote} data-testid="use-as-quote-bar">
          <p className="text-xs">
            <span className="font-medium">{STUDY_RECORD_COPY.selectedText}: </span>
            <span className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">“{preview}”</span>
          </p>
          <div className="space-y-1">
            <Label htmlFor={`${ids}-field`} className="text-xs">
              {STUDY_RECORD_COPY.useAsQuoteFor}
            </Label>
            <select id={`${ids}-field`} className={SELECT_CLASS} value={targetKey ?? ""} onChange={(event) => setPickedKey(event.target.value)}>
              {groups.map((group) => (
                <optgroup key={group.label} label={group.label}>
                  {group.options.map((option) => (
                    <option key={option.key} value={option.key}>
                      {option.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
          {pending && (
            <fieldset className="space-y-1">
              <legend className="text-xs font-medium">{STUDY_RECORD_COPY.selectionOccurrence(pending.occurrences.length)}</legend>
              <RadioGroup value={chosen === null ? "" : String(chosen)} onValueChange={(value) => setChosen(Number(value))} className="gap-1">
                {pending.occurrences.map((occurrence) => (
                  <label key={occurrence.occurrence} className="flex cursor-pointer items-start gap-2 rounded p-1 text-xs coarse:min-h-10">
                    <RadioGroupItem value={String(occurrence.occurrence)} className="mt-0.5" aria-label={STUDY_RECORD_COPY.occurrenceOption(occurrence.occurrence)} />
                    <span className="min-w-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                      {occurrence.context.truncatedBefore && "…"}
                      {occurrence.context.before}
                      <mark className="bg-amber-100 underline decoration-dotted dark:bg-amber-900/50">{occurrence.context.match}</mark>
                      {occurrence.context.after}
                      {occurrence.context.truncatedAfter && "…"}
                    </span>
                  </label>
                ))}
              </RadioGroup>
            </fieldset>
          )}
          {message && (
            <p role="alert" className="text-xs text-destructive">
              {message}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" className="coarse:min-h-10" onClick={applySelectionAsQuote} disabled={!targetKey || (pending !== null && chosen === null)}>
              {STUDY_RECORD_COPY.useAsQuote}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="coarse:min-h-10"
              onClick={() => {
                setSelection(null);
                setPending(null);
                setMessage(null);
              }}
            >
              {STUDY_RECORD_COPY.cancel}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Review: which field's source this is, and what of it the copy shown can and cannot show. */
function ReviewSourceFocus({ item, paperId }: { readonly item: ReviewItem | null; readonly paperId: string | null }) {
  if (!item) {
    return (
      <p className="rounded-md border p-3 text-sm" data-testid="review-source-focus">
        {REVIEW_COPY.sourcePickPrompt}
      </p>
    );
  }
  const focus = paperId ? reviewCopyFocus(item, paperId) : null;
  return (
    <div className="space-y-1 rounded-md border p-3 text-sm" data-testid="review-source-focus" aria-live="polite">
      <p className="break-words font-medium [overflow-wrap:anywhere]">{REVIEW_COPY.sourceFor(reviewItemLabel(item))}</p>
      {focus && !focus.refersToAbstract && <p className="text-xs text-muted-foreground">{REVIEW_COPY.sourceNotAbstract}</p>}
      {focus && focus.currentQuotes > 0 && <p className="text-xs">{REVIEW_COPY.sourceHighlighted(focus.currentQuotes)}</p>}
      {focus?.examinedCurrent && <p className="text-xs">{REVIEW_COPY.sourceExamined}</p>}
      {focus?.unavailable && <p className="text-xs">{REVIEW_COPY.sourceUnavailable}</p>}
      {focus?.earlierCopies.map((snapshot) => (
        <p key={snapshot.id} className="text-xs" data-testid="review-source-earlier-copy">
          {REVIEW_COPY.sourceEarlierCopy(snapshot.seq, formatRecordDate(snapshot.capturedAt))}
        </p>
      ))}
    </div>
  );
}
