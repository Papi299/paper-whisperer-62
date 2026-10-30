import { useId, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSavedCopy } from "@/hooks/useStudyRecords";
import type { SnapshotId } from "@/lib/evidence/ids";
import { normalizeEvidenceV1WithMap } from "@/lib/evidence/normalization";
import type { RecordedValue } from "@/lib/evidence/types";
import { StudyRecordReadError, type SnapshotInfo, type StudyRecordLink } from "@/lib/studyRecord/read";
import { useEditor } from "./editorContext";
import { formatRecordDate } from "./reviewCopy";
import { SavedCopyText } from "./SavedCopyText";
import { SOURCE_COMPARE_COPY } from "./sourceCompareCopy";
import { savedQuoteRanges } from "./sourcePaneModel";

/**
 * Every saved copy of one link's abstract (EVIDENCE-RECORDS-001C2C-A), newest
 * first, from the record's own metadata: no text is read until one is opened.
 * Shown only when the link has more than one copy.
 */
export function SavedCopiesList({ link, onShowCopy }: { readonly link: StudyRecordLink; readonly onShowCopy: (snapshotId: SnapshotId) => void }) {
  const ids = useId();
  const [open, setOpen] = useState(false);
  const total = link.snapshots.length;
  if (total < 2) return null;
  const currentId = link.currentCopy?.id ?? null;
  return (
    <div className="space-y-2" data-testid="saved-copies">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs font-medium">{SOURCE_COMPARE_COPY.copiesHeading(total)}</p>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 px-2 text-xs coarse:min-h-10"
          aria-expanded={open}
          aria-controls={open ? `${ids}-copies` : undefined}
          onClick={() => setOpen((current) => !current)}
        >
          {open ? SOURCE_COMPARE_COPY.hideCopies : SOURCE_COMPARE_COPY.showCopies}
        </Button>
      </div>
      {open && (
        <ol id={`${ids}-copies`} className="space-y-1">
          {[...link.snapshots].reverse().map((snapshot) => (
            <li
              key={snapshot.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2 text-xs"
              data-testid="saved-copy-item"
              data-copy-seq={snapshot.seq}
            >
              <span className="min-w-0 break-words [overflow-wrap:anywhere]">
                {SOURCE_COMPARE_COPY.copyLine(snapshot.seq, total, formatRecordDate(snapshot.capturedAt), snapshot.charCount)}
              </span>
              {snapshot.id === currentId ? (
                <span className="text-muted-foreground">{SOURCE_COMPARE_COPY.currentCopy}</span>
              ) : (
                <Button type="button" variant="outline" size="sm" className="coarse:min-h-10" onClick={() => onShowCopy(snapshot.id)}>
                  {SOURCE_COMPARE_COPY.showCopy(snapshot.seq)}
                </Button>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** How many of `values`' saved supporting quotes are on the copy `copyId`. */
function quotesOn(values: readonly Pick<RecordedValue, "references">[], copyId: string): number {
  let count = 0;
  for (const value of values) {
    for (const reference of value.references) {
      if (reference.purpose === "supports" && reference.sourceKind === "abstract" && reference.snapshotId === copyId) count++;
    }
  }
  return count;
}

/**
 * One saved copy of a link's abstract, read-only (EVIDENCE-RECORDS-001C2C-A):
 * its number, date and length from the record, and its exact text read when
 * it is opened — this copy only, for this user, study and paper. The saved
 * quotes of `values` that name this copy are marked by their own stored
 * offsets, mapped through this copy's own text: a quote on another copy is
 * never placed here. There is no "Use as quote": new quotes come from the
 * current copy only.
 */
export function EarlierCopy({
  link,
  info,
  values,
  reviewing,
  onBack,
  backLabel,
}: {
  readonly link: StudyRecordLink;
  readonly info: SnapshotInfo;
  /** The saved values whose quotes on this copy are marked: the record's in Edit, the card's in Review. */
  readonly values: readonly RecordedValue[];
  readonly reviewing: boolean;
  readonly onBack: () => void;
  readonly backLabel: string;
}) {
  const editor = useEditor();
  const ids = useId();
  const read = useSavedCopy(editor.userId, editor.base.header.id, info);
  const copy = read.data ?? null;
  const map = useMemo(() => (copy ? normalizeEvidenceV1WithMap(copy.exactText) : null), [copy]);
  const ranges = useMemo(() => (copy && map ? values.flatMap((value) => savedQuoteRanges(value, copy.id, map)) : []), [copy, map, values]);
  const quotes = quotesOn(values, info.id);
  const total = link.snapshots.length;
  const currentSeq = link.snapshots[total - 1]?.seq ?? info.seq;
  const integrity = read.error instanceof StudyRecordReadError && read.error.kind === "integrity";

  return (
    <section className="space-y-2" aria-labelledby={`${ids}-heading`} data-testid="earlier-copy" data-copy-seq={info.seq}>
      <h3 id={`${ids}-heading`} tabIndex={-1} className="break-words text-sm font-semibold focus:outline-none [overflow-wrap:anywhere]" data-source-view-heading>
        {SOURCE_COMPARE_COPY.earlierHeading(info.seq, total)}
      </h3>
      <p className="text-xs text-muted-foreground">{SOURCE_COMPARE_COPY.earlierMeta(formatRecordDate(info.capturedAt), info.charCount)}</p>
      <p className="text-xs">{SOURCE_COMPARE_COPY.earlierNote(currentSeq)}</p>
      {read.isPending ? (
        <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
          {SOURCE_COMPARE_COPY.loadingCopy(info.seq)}
        </p>
      ) : read.isError ? (
        <div className="space-y-2">
          <p role="alert" className="text-xs">
            {integrity ? SOURCE_COMPARE_COPY.copyIntegrity(info.seq) : SOURCE_COMPARE_COPY.copyFailed(info.seq)}
          </p>
          {!integrity && (
            <Button type="button" variant="outline" size="sm" className="coarse:min-h-10" onClick={() => void read.refetch()}>
              {SOURCE_COMPARE_COPY.tryAgain}
            </Button>
          )}
        </div>
      ) : copy === null ? (
        <p className="text-xs">{SOURCE_COMPARE_COPY.copyGone(info.seq)}</p>
      ) : (
        <>
          <p className="text-xs">{reviewing ? SOURCE_COMPARE_COPY.earlierReviewQuotes(quotes) : SOURCE_COMPARE_COPY.earlierQuotes(quotes)}</p>
          <SavedCopyText text={copy.exactText} ranges={ranges} data-testid="earlier-copy-text" />
        </>
      )}
      <Button type="button" variant="outline" size="sm" className="coarse:min-h-10" onClick={onBack} data-testid="earlier-copy-back">
        {backLabel}
      </Button>
    </section>
  );
}
