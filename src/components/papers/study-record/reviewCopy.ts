/**
 * Review mode's wording (EVIDENCE-RECORDS-001C2A; Requirements-001A §I, the
 * C2 audit §E12).
 *
 * Domain wording — review status labels, Confirm-block and Flag-note messages,
 * state labels, error messages — comes from `src/lib/evidence/` so the same
 * thing is never said two ways. These are the screen-level sentences around it.
 *
 * "Reviewed by you" means the user pressed Confirm on this exact version of
 * one value while its value and its source were shown together. It is never
 * "verified", "accurate" or "correct", and nothing here describes a whole
 * record as reviewed or complete.
 */

import type { EvidenceError } from "@/lib/evidence/errors";
import { EVIDENCE_FIELDS } from "@/lib/evidence/fieldDictionary";
import { CONFIRM_BLOCK_MESSAGES } from "@/lib/evidence/review";
import type { ReviewHold, ReviewItem } from "@/lib/studyRecord/reviewModel";
import { STUDY_RECORD_COPY } from "./studyRecordCopy";

/** A date as the Study Record dialog shows it: "Oct 20, 2026". */
export function formatRecordDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

export const REVIEW_COPY = {
  // Modes
  modeLabel: "Study record mode",
  editMode: "Edit",
  reviewMode: "Review",
  // Summary
  summaryHeading: "Review summary",
  summaryRecorded: (count: number) => (count === 1 ? "1 recorded field" : `${count} recorded fields`),
  summaryCannotConfirm: (count: number) => `${count} can't be confirmed yet`,
  standing:
    "Confirm records that you checked this saved value against the source shown. Saving is never a review, and PaperLume doesn't check your interpretation.",
  // Filter
  filterLabel: "Show",
  filterNeedsReview: "Needs your review",
  filterAll: "All recorded",
  emptyNothingRecorded: "No fields are recorded yet. Record values in Edit and save them, then review them here.",
  emptyAllReviewed: "Nothing needs your review. Every recorded field is reviewed by you.",
  // Card
  statusLabel: "Review status",
  reviewedOn: (date: string) => `Reviewed by you on ${date}`,
  needsRereview: "Needs re-review — a new copy of the abstract was saved",
  flagNote: "Your note",
  earlierReviewNote: "Your earlier review note",
  valueNote: "Note",
  asReported: "As reported",
  confirmedNumber: "Confirmed number",
  sourcesHeading: "Sources",
  fromAbstractOnly: "From the abstract only — abstracts can leave out or simplify what the full text reports.",
  noSourceGiven: "No source given.",
  readOnly: "You can see these fields and their reviews, but your account can't confirm or flag them.",
  confirm: "Confirm against this source",
  confirmFlagged: "Confirming replaces your flag and its note.",
  flag: "Flag…",
  edit: "Edit",
  editLabel: (field: string) => `Edit ${field}`,
  working: "Recording your review…",
  // Sources
  quoteFrom: (paper: string) => `Quote from the saved abstract of ${paper}`,
  copyLabel: (seq: number, total: number, date: string) => `copy ${seq} of ${total}, saved ${date}`,
  occurrence: (occurrence: number, count: number) => `occurrence ${occurrence} of ${count}`,
  earlierCopyQuote: "This quote is in an earlier copy of the abstract. Show that copy to see it in place.",
  quoteNotLocated: "Couldn't show this quote in its saved copy.",
  fullTextOf: (paper: string) => `Full text of ${paper}`,
  examinedAbstract: (paper: string) => `Examined: the saved abstract of ${paper}`,
  examinedFullText: (paper: string) => `Examined: the full text of ${paper}`,
  unavailableAbstract: (paper: string) => `Couldn't check: the abstract of ${paper} — it had no abstract in your library`,
  unavailableFullText: (paper: string) => `Couldn't check: the full text of ${paper}`,
  unavailableNowHasCopy: "This paper has a saved copy of its abstract now.",
  yourReference: "your reference — check it in your copy; PaperLume doesn't",
  yourStatement: "your statement",
  thisPaper: "this paper",
  earlierCopyNotShown: "an earlier copy",
  // Inline source on a phone
  showSavedCopy: "Show the saved abstract",
  hideSavedCopy: "Hide the saved abstract",
  // Source pane in Review
  sourceFor: (field: string) => `Source for: ${field}`,
  sourcePickPrompt: "Select a field to see its source here.",
  sourceHighlighted: (count: number) =>
    count === 1 ? "The highlighted passage is the quote this field cites." : `The highlighted passages are the ${count} quotes this field cites.`,
  sourceExamined: "You recorded that you examined this saved copy.",
  sourceUnavailable: "You recorded that this paper had no abstract to check.",
  sourceEarlierCopy: (seq: number, date: string) =>
    `This field's sources include an earlier copy of the abstract (copy ${seq}, saved ${date}). Nothing is highlighted for it in the current copy; show copy ${seq} to see it.`,
  sourceNotAbstract: "This field cites no part of this paper's saved abstract.",
  sourceCopy: (seq: number, total: number, date: string) => `Saved copy ${seq} of ${total}, saved ${date}.`,
  // Flag form
  flagLabel: "What's wrong with this value?",
  flagHelp: "At least 3 characters. Your note is saved with the flag; flagging doesn't change the value.",
  flagCount: (count: number) => `${count.toLocaleString("en-US")} of 2,000 characters`,
  flagSubmit: "Flag",
  flagUpdate: "Update flag",
  flagUnchanged: "Change the note to update the flag.",
  cancel: "Cancel",
  // Outcomes
  announceConfirmed: (field: string, next: string | null) =>
    next ? `Confirmed ${field}. Next: ${next}.` : `Confirmed ${field}. Nothing else needs your review.`,
  announceAlreadyConfirmed: (field: string) => `${field} is already confirmed.`,
  announceFlagged: (field: string) => `Flagged ${field}.`,
  announceFlagUnchanged: (field: string) => `${field} already has this flag.`,
  uncertain: "We couldn't tell whether your review was recorded. Try again — it won't be recorded twice.",
  notRecordedTryAgain: (reason: string) => `${reason} Try again — it won't be recorded twice.`,
  tryAgain: "Try again",
  reload: "Reload latest version",
  dismiss: "Dismiss",
  staleVersion: CONFIRM_BLOCK_MESSAGES.stale_version,
  notRecorded: "This field is no longer recorded. Reload to see the latest version.",
  blockedUnknown: "This value can't be confirmed yet. Reload to see what it still needs.",
  targetMissing: "This review couldn't be matched to the saved field. Reload and try again.",
  noteRefused: "This note couldn't be saved with the flag. Check it and try again.",
  conflict: "This study record was changed in another tab or window. Reload to review the latest version.",
} as const;

/** A card's name: the field, with the SAVED name of its group or outcome ("Placebo: Comparator type"). */
export function reviewItemLabel(item: Pick<ReviewItem, "fieldKey" | "target">): string {
  const field = EVIDENCE_FIELDS[item.fieldKey].label;
  const { target } = item;
  if (target.scope === "study") return field;
  const name = target.name || (target.scope === "arm" ? STUDY_RECORD_COPY.groupRole[target.role] : "Outcome");
  return `${name}: ${field}`;
}

/** Why a card's actions wait (the model's holds), each with what the user can do. */
export const REVIEW_HOLD_MESSAGES: Readonly<Record<ReviewHold, string>> = Object.freeze({
  busy: "Wait for the current action to finish.",
  unresolved: "Resolve the earlier action first: try it again, or reload.",
  changed_elsewhere: "This record changed elsewhere. Reload to review it.",
  group_removal_pending: "This group will be removed when you save. Undo the removal to review its values.",
  outcome_removal_pending: "This outcome will be removed when you save. Undo the removal to review its values.",
  unsaved_edit: "This field has unsaved changes. Save or undo them to review it.",
});

/**
 * What a review the server did not record says on screen: kept to the review,
 * never built from the server's text. Kinds whose request is kept (the outcome
 * is unknown, or it may be resent as is) get the retry wording.
 */
export function reviewErrorText(error: EvidenceError): string {
  if (error.retry === "same_request") {
    if (error.applied === "unknown") return REVIEW_COPY.uncertain;
    if (error.kind === "auth_required") return error.userMessage;
    const reason =
      error.kind === "database_busy"
        ? "The database was busy, so your review wasn't recorded."
        : error.kind === "service_unavailable"
          ? "PaperLume couldn't reach the database, so your review wasn't recorded."
          : "Something went wrong, so your review wasn't recorded.";
    return REVIEW_COPY.notRecordedTryAgain(reason);
  }
  switch (error.kind) {
    case "version_conflict":
      return error.detail?.parameter === "expectedValueVersion" ? REVIEW_COPY.staleVersion : REVIEW_COPY.conflict;
    case "confirm_blocked":
      return REVIEW_COPY.blockedUnknown;
    case "invalid_input":
      return error.detail?.parameter === "note" ? REVIEW_COPY.noteRefused : error.userMessage;
    case "target_not_found":
    case "request_id_reused":
      return REVIEW_COPY.targetMissing;
    default:
      return error.userMessage;
  }
}
