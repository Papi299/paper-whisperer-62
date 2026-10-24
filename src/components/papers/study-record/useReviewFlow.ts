import { useCallback, useEffect, useRef, useState } from "react";
import type { ReviewOutcome, useStudyRecordEditor } from "@/hooks/useStudyRecordEditor";
import type { ReviewAction } from "@/lib/evidence/fieldRequests";
import { nextNeedingReview, type ReviewItem } from "@/lib/studyRecord/reviewModel";
import { REVIEW_COPY, reviewItemLabel } from "./reviewCopy";

type Editor = ReturnType<typeof useStudyRecordEditor>;

type PendingFocus = { readonly kind: "heading" | "status"; readonly key: string } | { readonly kind: "summary" };

/** Whether `element` is on screen: not inside a collapsed part or an inactive tab panel. */
const isShown = (element: HTMLElement) => !element.closest("[hidden], [data-state='inactive']");

/**
 * What a review does on screen besides the write (EVIDENCE-RECORDS-001C2A,
 * the C2 audit §E11): a polite announcement, and where focus goes —
 * after Confirm, the next value that needs review (Confirm & next), or the
 * summary when none is left; after Flag, the card's status. A press from a
 * card and "Try again" from the editor's alert take the same path. Refusals
 * move focus to their own alert (the card's or the editor's), not here.
 */
export function useReviewFlow(editor: Editor, fallbackRef: React.RefObject<HTMLElement>) {
  const [announcement, setAnnouncement] = useState("");
  const [pendingFocus, setPendingFocus] = useState<PendingFocus | null>(null);
  const headings = useRef(new Map<string, HTMLElement>());
  const statuses = useRef(new Map<string, HTMLElement>());
  const summaryRef = useRef<HTMLHeadingElement>(null);

  const registerHeading = useCallback((key: string, element: HTMLElement | null) => {
    if (element) headings.current.set(key, element);
    else headings.current.delete(key);
  }, []);
  const registerStatus = useCallback((key: string, element: HTMLElement | null) => {
    if (element) statuses.current.set(key, element);
    else statuses.current.delete(key);
  }, []);

  // Once the element is rendered: focus it, or — when Review isn't on screen — the dialog's title.
  useEffect(() => {
    if (!pendingFocus) return;
    const element =
      pendingFocus.kind === "summary" ? summaryRef.current : (pendingFocus.kind === "heading" ? headings.current : statuses.current).get(pendingFocus.key);
    if (!element) return;
    const target = isShown(element) ? element : fallbackRef.current;
    target?.focus();
    if (target === element) element.scrollIntoView?.({ block: "nearest" });
    setPendingFocus(null);
  }, [pendingFocus, editor.reviewItems, fallbackRef]);

  const settle = useCallback((item: ReviewItem, action: ReviewAction, outcome: ReviewOutcome, next: ReviewItem | null) => {
    if (outcome.kind !== "done") return;
    const label = reviewItemLabel(item);
    if (action === "confirm") {
      setAnnouncement(outcome.status === "unchanged" ? REVIEW_COPY.announceAlreadyConfirmed(label) : REVIEW_COPY.announceConfirmed(label, next ? reviewItemLabel(next) : null));
      setPendingFocus(next ? { kind: "heading", key: next.key } : { kind: "summary" });
    } else {
      setAnnouncement(outcome.status === "unchanged" ? REVIEW_COPY.announceFlagUnchanged(label) : REVIEW_COPY.announceFlagged(label));
      setPendingFocus({ kind: "status", key: item.key });
    }
  }, []);

  /** Confirm one value, as its card shows it. The next value is chosen from the list as it stands: this Confirm changes no other value. */
  const confirm = async (item: ReviewItem) => {
    const next = nextNeedingReview(editor.reviewItems, item.key);
    settle(item, "confirm", await editor.review({ valueId: item.value.id, shownVersion: item.value.valueVersion }, "confirm", null), next);
  };

  /** Flag one value; resolves to true once the flag is recorded. */
  const flag = async (item: ReviewItem, note: string): Promise<boolean> => {
    const outcome = await editor.review({ valueId: item.value.id, shownVersion: item.value.valueVersion }, "flag", note);
    settle(item, "flag", outcome, null);
    return outcome.kind === "done";
  };

  /** Try again: the SAME request (the editor keeps it); its result is shown as the first press's would have been. */
  const retry = async () => {
    const { reviewAction, reviewItems } = editor;
    if (reviewAction.status !== "uncertain") return;
    const item = reviewItems.find((candidate) => candidate.value.id === reviewAction.valueId);
    const next = item ? nextNeedingReview(reviewItems, item.key) : null;
    const outcome = await editor.retryReview();
    if (item) settle(item, reviewAction.action, outcome, next);
  };

  return { announcement, summaryRef, registerHeading, registerStatus, confirm, flag, retry };
}

export type ReviewFlow = ReturnType<typeof useReviewFlow>;
