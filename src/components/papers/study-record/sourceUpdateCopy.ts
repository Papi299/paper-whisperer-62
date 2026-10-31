/**
 * Wording for "Use current abstract" (EVIDENCE-RECORDS-001C2C-B): the choice
 * in the comparison, its confirmation, and what the server answered.
 *
 * Everything said about the outcome comes from the server's answer — the copy
 * it saved, the quotes it found again or not, the reviews it changed — never
 * from a forecast. Before the write, only what the record already says is
 * stated: the copies kept, the quotes that will be checked, and each field
 * whose review the change affects (`describeSourceUpdate`). Finding a quote
 * again is a match of characters; nothing here says two texts, or a value and
 * its source, mean the same thing.
 */

import type { EvidenceError } from "@/lib/evidence/errors";
import type { RebaseSourceResult } from "@/lib/evidence/lifecycleClient";
import { SOURCE_TOO_LONG_MESSAGE } from "@/lib/evidence/sources";
import type { SourceUpdateHold, SourceUpdateNotSent } from "@/hooks/useStudyRecordEditor";

const plural = (count: number, one: string, many: string) => `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;

export const SOURCE_UPDATE_COPY = {
  // The choice, in the comparison
  heading: "Keep the saved copy, or use the library abstract",
  keep: (seq: number) => `Your record keeps saved copy ${seq} unless you choose to use the abstract in your library instead.`,
  keepTypography: (seq: number) =>
    `Keeping saved copy ${seq} is the default: the two differ only in characters quote matching treats as the same. Use the library abstract only if you want its exact characters saved.`,
  firstCapture: "This record has no saved copy of this paper's abstract. Using the library abstract saves it as the record's first copy, so it can be quoted.",
  action: "Use current abstract",
  checking: "Waiting for the abstract in your library to be read…",
  unread: "Read the abstract in your library first: check again.",
  copyLimit: "This paper already has 20 saved copies of its abstract, the most a study record keeps, so another can't be saved.",
  tooLong: SOURCE_TOO_LONG_MESSAGE,
  noDigest:
    "This browser can't compute the check PaperLume uses to make sure a saved copy is exactly the text you saw, so a copy can't be saved here. Try an up-to-date browser.",
  saving: "Saving the library abstract as a new copy…",

  // The confirmation
  dialogTitle: "Use the current abstract?",
  paper: (title: string) => `Paper: “${title}”`,
  untitledPaper: "Paper: a linked paper whose title couldn't be read",
  currentCopy: (seq: number, total: number, date: string) => `The record's saved copy now: copy ${seq} of ${total}, saved ${date}.`,
  noCopy: "The record has no saved copy of this paper's abstract yet.",
  whatHappens: "What happens",
  newCopy: (next: number, chars: number) =>
    `PaperLume saves the library abstract you compared — ${plural(chars, "character", "characters")} — as copy ${next}, the record's current copy. A saved copy is never changed afterwards.`,
  firstCopy: (chars: number) =>
    `PaperLume saves the library abstract you compared — ${plural(chars, "character", "characters")} — as the record's first copy. A saved copy is never changed afterwards.`,
  earlierKept: (seq: number) =>
    seq === 1 ? "Copy 1 stays with the record, and you can still open it." : `Copies 1 to ${seq} stay with the record, and you can still open them.`,
  quotesChecked:
    "PaperLume will check existing quotations against the new abstract. Quotations that cannot be matched uniquely will remain linked to their earlier saved copies.",
  quotesToCheck: (count: number, seq: number) => `${plural(count, "quote", "quotes")} on copy ${seq} will be checked.`,
  quotesEarlier: (count: number) => `${plural(count, "quote stays", "quotes stay")} on an earlier copy, as now: only quotes on the current copy are checked.`,
  noQuotes: (seq: number) => `No quote is on copy ${seq}, so no quote will be checked.`,
  firstNoQuotes: "With no earlier copy, there are no quotes to check.",
  matchMeaning: "A quote found again means only that the same characters are in the new copy, not that they mean the same thing.",
  reviewsHeading: "Reviews",
  reviewIntro:
    "Every field that cites this paper's abstract — a quote from any of its copies, a copy you examined, or a note that it couldn't be checked — is affected, even when its quotes are found again:",
  needsRereview: (count: number) => `${plural(count, "field will need", "fields will need")} re-review — the review or flag no longer applies:`,
  staysNeedsRereview: (count: number) => `${plural(count, "field already needs", "fields already need")} re-review, and stay${count === 1 ? "s" : ""} that way:`,
  staysUnreviewed: (count: number) => `${plural(count, "field isn't", "fields aren't")} reviewed, and stay${count === 1 ? "s" : ""} Not reviewed:`,
  noReviews: "No recorded field cites this paper's abstract, so no review changes.",
  notesKept: "Review notes are kept: a field's flag note stays with it, shown as your earlier review note.",
  unavailable: (count: number) =>
    `${plural(count, "field says", "fields say")} this paper had no abstract to check. Once a copy is saved, ${count === 1 ? "it" : "they"} can't be confirmed until you edit ${count === 1 ? "it" : "them"} to record what the abstract says.`,
  typography: "The two differ only in characters quote matching treats as the same. Keeping the saved copy is the default; nothing changes unless you save.",
  reviewedFrom: (label: string) => `${label} — now Reviewed by you`,
  flaggedFrom: (label: string) => `${label} — now Flagged`,
  cancel: "Cancel",
  confirm: (next: number) => `Save as copy ${next}`,
  confirmFirst: "Save as the first copy",
  changedWhileOpen:
    "The abstract in your library, or this record, changed while this was open, so nothing can be saved from it. Close this, then look at the abstract again.",
  notWritable: "Your account can't save changes to study records now, so nothing can be saved from this.",
  checkingWhileOpen: "Checking the abstract in your library again…",

  // What the server answered
  saved: (seq: number) => `Saved copy ${seq} of this paper's abstract as the record's current copy.`,
  savedFirst: "Saved copy 1 of this paper's abstract — the record's first copy.",
  earlierStay: (previous: number) => (previous === 1 ? "Copy 1 is kept, and you can still open it." : `Copies 1 to ${previous} are kept, and you can still open them.`),
  replayed: "Your earlier attempt had already saved it: nothing was saved twice.",
  noQuotesChecked: (previous: number) => `No quote was on copy ${previous}, so no quote was checked.`,
  firstNoQuotesChecked: "There was no earlier copy, so no quote was checked.",
  quotesResult: (checked: number, seq: number, rematched: number, notFound: number, ambiguous: number) =>
    `${plural(checked, "quote was", "quotes were")} checked against copy ${seq}: ${rematched.toLocaleString("en-US")} found exactly once and moved to it` +
    `${notFound > 0 ? `, ${notFound.toLocaleString("en-US")} not found` : ""}${ambiguous > 0 ? `, ${ambiguous.toLocaleString("en-US")} found more than once` : ""}.`,
  quotesKept: (previous: number) => `Quotes not found exactly once stay on copy ${previous}.`,
  reviewsChanged: (count: number) => `${plural(count, "field now needs", "fields now need")} re-review.`,
  reviewsUnchanged: "No field's review status changed.",
  unchanged: (seq: number) => `Nothing was saved: saved copy ${seq} is already the abstract in your library, character for character.`,
  reloadFailed: (seq: number) => `Copy ${seq} was saved, but the record couldn't be read back to show it. Reload to see it.`,
  notSent: {
    stale:
      "Nothing was sent: the abstract in your library or this record changed after you chose to use it. Look at the abstract again, then choose again.",
    ineligible: "Nothing was sent: this abstract can't be saved as a copy.",
    digest_unavailable:
      "Nothing was sent: this browser can't compute the check PaperLume uses to make sure a saved copy is exactly the text you saw.",
    digest_failed: "Nothing was sent: the check PaperLume uses to make sure a saved copy is exactly the text you saw couldn't be computed. Try again.",
    invalid_request: "Nothing was sent: the request couldn't be prepared. Reload the record and try again.",
  } satisfies Readonly<Record<SourceUpdateNotSent, string>>,
  sourceChanged:
    "Nothing was saved: the abstract in your library changed after you compared it. It's being read again — look at it, then choose again if you still want it.",
  refusedInvalid: "Nothing was saved: PaperLume couldn't save this abstract as a copy. Reload the record, then look at the abstract again.",
  reloadToTryAgain: "Reload the record before trying again.",
  uncertain: "We couldn't tell whether the new copy was saved. Try again — it won't be saved twice.",
  notSavedTryAgain: (reason: string) => `${reason} Try again — it won't be saved twice.`,
  conflict: "This study record was changed in another tab or window, so no copy was saved. Reload to see the latest version.",
  tryAgain: "Try again",
  reload: "Reload latest version",
  dismiss: "Dismiss",
} as const;

/** Why "Use current abstract" waits, each with what the user can do. */
export const SOURCE_UPDATE_HOLD_MESSAGES: Readonly<Record<SourceUpdateHold, string>> = Object.freeze({
  busy: "Wait for the current action to finish.",
  unresolved: "Resolve the earlier action first: try it again, or reload.",
  changed_elsewhere: "This record changed elsewhere. Reload it first.",
  unsaved_changes: "Save or undo your unsaved changes first: a new copy is saved only from a record with none.",
  flag_open: "Send or cancel the Flag note you started in Review first.",
  refused: "Reload the record before trying again.",
});

/** The lines that report what the server did: its copy, its quote counts and its review count — nothing more. */
export function sourceUpdateResultLines(result: RebaseSourceResult): readonly string[] {
  if (result.status === "unchanged") return [SOURCE_UPDATE_COPY.unchanged(result.seq)];
  const lines: string[] = [];
  const first = result.previousSnapshotId === null;
  const previous = result.seq - 1;
  if (first) {
    lines.push(SOURCE_UPDATE_COPY.savedFirst, SOURCE_UPDATE_COPY.firstNoQuotesChecked);
  } else {
    lines.push(SOURCE_UPDATE_COPY.saved(result.seq), SOURCE_UPDATE_COPY.earlierStay(previous));
    const checked = result.rematched + result.notFound + result.ambiguous;
    if (checked === 0) lines.push(SOURCE_UPDATE_COPY.noQuotesChecked(previous));
    else {
      lines.push(SOURCE_UPDATE_COPY.quotesResult(checked, result.seq, result.rematched, result.notFound, result.ambiguous));
      if (result.notFound + result.ambiguous > 0) lines.push(SOURCE_UPDATE_COPY.quotesKept(previous));
    }
  }
  lines.push(result.needsRereview > 0 ? SOURCE_UPDATE_COPY.reviewsChanged(result.needsRereview) : SOURCE_UPDATE_COPY.reviewsUnchanged);
  if (result.status === "replayed") lines.push(SOURCE_UPDATE_COPY.replayed);
  return lines;
}

/**
 * What a rebase the server did not apply — or may have — says on screen:
 * fixed copy, never the server's text. Kinds whose request is kept (the
 * outcome is unknown, or it may be resent as is) get the retry wording.
 */
export function sourceUpdateErrorText(error: EvidenceError): string {
  if (error.retry === "same_request") {
    if (error.applied === "unknown") return SOURCE_UPDATE_COPY.uncertain;
    if (error.kind === "auth_required") return error.userMessage;
    const reason =
      error.kind === "database_busy"
        ? "The database was busy, so the copy wasn't saved."
        : error.kind === "service_unavailable"
          ? "PaperLume couldn't reach the database, so the copy wasn't saved."
          : "Something went wrong, so the copy wasn't saved.";
    return SOURCE_UPDATE_COPY.notSavedTryAgain(reason);
  }
  switch (error.kind) {
    case "source_changed_again":
      return SOURCE_UPDATE_COPY.sourceChanged;
    case "version_conflict":
      return SOURCE_UPDATE_COPY.conflict;
    case "invalid_input":
    case "invalid_request":
    case "request_id_reused":
      return SOURCE_UPDATE_COPY.refusedInvalid;
    default:
      return error.userMessage;
  }
}
