/**
 * History mode's wording (EVIDENCE-RECORDS-001C2B).
 *
 * Domain wording — field labels, state labels, review status labels, the
 * design families, code labels — comes from `src/lib/evidence/`, so the same
 * thing is never said two ways. These are the History sentences around it,
 * built from `historyModel.ts`'s descriptions and nothing else.
 *
 * What History may say, and may not:
 *   * it describes committed operations, in the words of what they recorded.
 *     It never says a value was verified, approved or validated, that a source
 *     was validated, or that a record is complete: "Reviewed by you" is one
 *     Confirm of one saved value at one version;
 *   * where History kept only a fingerprint, it says that text changed — never
 *     what it said — and says that the text isn't stored. A fingerprint, an id
 *     or a request's internals never reach the screen;
 *   * a name History did not record — a group's in a value event, a paper's
 *     title — is today's, and is always called that ("now named", "now
 *     titled"), or the thing is said to be gone.
 */

import { CODE_LABELS, DESIGN_PROFILE_LABELS, EVIDENCE_FIELDS, type ArmRole, type FieldKey } from "@/lib/evidence/fieldDictionary";
import { REVIEW_STATUS_LABELS } from "@/lib/evidence/review";
import { VALUE_STATE_CHOICE_LABELS } from "@/lib/evidence/states";
import type { EventType, LinkStatus, RequestOp, StateReason, ValueState } from "@/lib/evidence/types";
import type {
  ClearedReview,
  HistoryChange,
  HistoryField,
  HistoryName,
  HistoryPaper,
  NoteChange,
  SnapshotContent,
  SourceCounts,
} from "@/lib/studyRecord/historyModel";
import { STUDY_RECORD_COPY } from "./studyRecordCopy";

export const HISTORY_COPY = {
  mode: "History",
  heading: "History",
  intro: "Every change saved to this study record, newest first: what was saved, reviewed or changed, and when. History is read-only.",
  textNotKept:
    "History keeps the study name and the names of groups and outcomes as they were. For other text — values, notes, quotes — it records only that the text changed, never the text itself.",
  loading: "Loading history…",
  loadFailed: "Couldn't load this study record's history.",
  integrity: "This history couldn't be shown because the data received did not pass a consistency check. Nothing from it is displayed.",
  gone: "This study record no longer exists, so its history can't be shown.",
  empty: "No history is recorded for this study record.",
  tryAgain: "Try again",
  refresh: "Refresh",
  refreshLabel: "Refresh history",
  refreshing: "Refreshing…",
  refreshFailed: "Couldn't refresh the history. What's shown was read earlier.",
  loadOlder: "Load older entries",
  loadingOlder: "Loading older entries…",
  olderFailed: "Couldn't load older entries.",
  beginning: "This is the beginning of this study record's history.",
  entriesLabel: "Study record history",
  showDetails: "Show details",
  hideDetails: "Hide details",
  detailsLabel: (title: string, version: number) => `Details of “${title}”, record version ${version}`,
  detailsLoading: "Loading details…",
  detailsFailed: "Couldn't load the details of this entry.",
  detailsIntegrity: "These details couldn't be shown because the data received did not pass a consistency check.",
  detailsGone: "This study record no longer exists.",
  moreChanges: "Show more changes",
  loadingMoreChanges: "Loading more changes…",
  moreChangesFailed: "Couldn't load more changes.",
  changesShown: (count: number) => (count === 1 ? "1 change shown" : `${count.toLocaleString("en-US")} changes shown`),
  version: (version: number) => `Record version ${version.toLocaleString("en-US")}`,
  announceOlder: (count: number) => (count === 1 ? "Loaded 1 older entry." : `Loaded ${count} older entries.`),
  announceRefreshed: "History refreshed.",
  unreadableDetail: "The details of this change can't be shown.",
} as const;

/** One title per committed operation — every request op an installed RPC records. */
export const HISTORY_OPERATION_TITLES: Readonly<Record<RequestOp, string>> = Object.freeze({
  create_study: "Study record created",
  update_study: "Study details updated",
  save_changes: "Changes saved",
  review_fields: "Review recorded",
  set_link: "Linked paper changed",
  rebase_source: "Saved abstract copy updated",
});

/**
 * What an event's own type says, and nothing more: the line for an event whose
 * details can't be read (and for `review_reset`, which no installed RPC writes).
 */
export const HISTORY_UNREADABLE_TITLES: Readonly<Record<Exclude<EventType, "request">, string>> = Object.freeze({
  study_created: "The study record was created",
  study_updated: "The study details were changed",
  link_created: "A paper was linked",
  link_status_changed: "A paper link was changed",
  link_removed: "A paper link was removed",
  source_captured: "A copy of an abstract was saved",
  source_rebased: "Quotes were rechecked against a new copy of an abstract",
  anchor_rematched: "A quote was moved to a new copy of an abstract",
  anchor_not_rematched: "A quote stayed on an earlier copy of an abstract",
  arm_added: "A group was added",
  arm_updated: "A group was changed",
  arm_removed: "A group was removed",
  outcome_added: "An outcome was added",
  outcome_updated: "An outcome was changed",
  outcome_removed: "An outcome was removed",
  value_saved: "A field was saved",
  value_cleared: "A field was cleared",
  review_confirmed: "A field was reviewed by you",
  review_flagged: "A field was flagged",
  review_reset: "A review was reset",
  review_needs_rereview: "A field was marked as needing re-review",
});

const LINK_STATUS_WORDS: Readonly<Record<LinkStatus, string>> = Object.freeze({
  provisional: "provisional",
  user_confirmed: "confirmed by you",
});

const GROUP_ROLE_WORDS: Readonly<Record<ArmRole, string>> = Object.freeze({
  intervention: "intervention group",
  comparator: "comparator group",
});

const CLEARED_REVIEW_LINES: Readonly<Record<ClearedReview, string>> = Object.freeze({
  user_reviewed: "Previously reviewed by you — saving this change reset the review.",
  disputed: "Previously flagged — saving this change cleared the flag and its note.",
  needs_rereview: "Previously needed re-review — saving this change reset it to Not reviewed.",
});

const EARLIER_TEXT_NOT_KEPT = "Earlier text isn't stored in History.";
const TEXT_NOT_KEPT = "The text itself isn't stored in History.";
const NOTE_TEXT_NOT_KEPT = "History doesn't keep the text of notes.";

/** A date and time as History shows it: "Oct 25, 2026, 2:03 PM UTC" — with its time zone, so it is never ambiguous. */
export function formatHistoryTime(iso: string, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    ...(timeZone ? { timeZone } : {}),
  }).format(new Date(iso));
}

const count = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const quoted = (text: string) => `“${text}”`;

/** A field's label, with its group or outcome only as History can name it. */
export function historyFieldName(field: HistoryField): string {
  const label = field.fieldKey ? EVIDENCE_FIELDS[field.fieldKey].label : "A field this version of PaperLume doesn't recognize";
  const { target } = field;
  switch (target.scope) {
    case "study":
      return label;
    case "arm":
      return target.current ? `${label} (group now named ${quoted(target.current.name)})` : `${label} (a group since removed)`;
    case "outcome":
      return target.current ? `${label} (outcome now named ${quoted(target.current.name)})` : `${label} (an outcome since removed)`;
    case "unknown":
      return `${label} (no longer recorded)`;
  }
}

function paperName(paper: HistoryPaper): string {
  if (!paper.current) return "a paper no longer linked to this record";
  return paper.current.title === null ? "a linked paper whose title couldn't be read" : `the paper now titled ${quoted(paper.current.title)}`;
}

function stateName(state: ValueState, reason: StateReason | null): string {
  const label = VALUE_STATE_CHOICE_LABELS[state];
  return reason ? `${label} (${STUDY_RECORD_COPY.reasons[reason].toLowerCase()})` : label;
}

function contentName(fieldKey: FieldKey | null, content: SnapshotContent): string {
  switch (content.shape) {
    case "code":
      return (fieldKey && CODE_LABELS[fieldKey]?.[content.code]) || content.code;
    case "number":
      return content.value.toLocaleString("en-US");
    case "text":
      return `a text of ${count(content.chars, "character", "characters")}`;
    case "list":
      return count(content.entries, "entry", "entries");
  }
}

/** What changed in a value's content, between two readable contents of one field. */
function contentChangeName(fieldKey: FieldKey | null, from: SnapshotContent | null, to: SnapshotContent | null): string {
  if (from && to && from.shape === to.shape) {
    if (from.shape === "text") return "text changed";
    if (from.shape === "list" && to.shape === "list") return from.entries === to.entries ? "entries changed" : `${count(from.entries, "entry", "entries")} → ${count(to.entries, "entry", "entries")}`;
    if (from.shape === "number" && to.shape === "number" && from.value === to.value) return "reported text changed";
    return `${contentName(fieldKey, from)} → ${contentName(fieldKey, to)}`;
  }
  return to ? `now ${contentName(fieldKey, to)}` : "value removed";
}

export function sourcesSummary(sources: SourceCounts): string {
  const parts = [
    sources.quotes > 0 && count(sources.quotes, "quote from a saved abstract", "quotes from a saved abstract"),
    sources.fullText > 0 && count(sources.fullText, "full-text reference", "full-text references"),
    sources.examined > 0 && count(sources.examined, "examined source", "examined sources"),
    sources.unavailable > 0 && count(sources.unavailable, "source that couldn't be checked", "sources that couldn't be checked"),
  ].filter((part): part is string => typeof part === "string");
  return parts.length > 0 ? `Sources: ${parts.join(", ")}.` : "No source given.";
}

const NOTE_WORDS: Readonly<Record<Exclude<NoteChange, "unchanged" | "none">, string>> = Object.freeze({
  added: "note added",
  changed: "note changed",
  removed: "note removed",
});

function groupName(name: HistoryName, kind: "Group" | "Outcome"): string {
  if (!name) return kind === "Group" ? "A group since removed" : "An outcome since removed";
  return name.source === "event" ? `${kind} ${quoted(name.name)}` : `The ${kind.toLowerCase()} now named ${quoted(name.name)}`;
}

/** One change event, in words: a line, and the lines that qualify it. */
export interface HistoryChangeText {
  readonly text: string;
  readonly details: readonly string[];
}

export function describeChangeText(change: HistoryChange): HistoryChangeText {
  switch (change.kind) {
    case "study_created":
      return { text: `Study record created as ${quoted(change.label)}`, details: [`Kind of study: ${DESIGN_PROFILE_LABELS[change.designProfile]}`] };
    case "study_updated": {
      const lines = [
        change.label && `Name changed from ${quoted(change.label.from)} to ${quoted(change.label.to)}`,
        change.designProfile && `Kind of study changed from ${DESIGN_PROFILE_LABELS[change.designProfile.from]} to ${DESIGN_PROFILE_LABELS[change.designProfile.to]}`,
        change.notes && `Study notes ${change.notes}. ${change.notes === "added" ? TEXT_NOT_KEPT : EARLIER_TEXT_NOT_KEPT}`,
      ].filter((line): line is string => typeof line === "string");
      return { text: lines[0], details: lines.slice(1) };
    }
    case "link_created":
      return { text: `Linked to ${paperName(change.paper)}, as ${LINK_STATUS_WORDS[change.status]}`, details: [] };
    case "link_status_changed":
      return {
        text: `Link to ${paperName(change.paper)} changed from ${LINK_STATUS_WORDS[change.status.from]} to ${LINK_STATUS_WORDS[change.status.to]}`,
        details: [],
      };
    case "link_removed":
      return {
        text: `Link to ${paperName(change.paper)} removed`,
        details: change.copies > 0 ? [`Its ${count(change.copies, "saved copy", "saved copies")} of the abstract went with it.`] : [],
      };
    case "source_captured":
      return change.first
        ? {
            text: `Saved a copy of the abstract of ${paperName(change.paper)}`,
            details: [`Copy ${change.seq}, ${count(change.chars, "character", "characters")}. History doesn't keep the copy's text.`],
          }
        : {
            text: `Saved a new copy of the abstract of ${paperName(change.paper)}`,
            details: [`Copy ${change.seq}, ${count(change.chars, "character", "characters")}. Earlier copies are kept; History doesn't show their text.`],
          };
    case "source_rebased":
      return {
        text: `Quotes rechecked against the new copy of the abstract of ${paperName(change.paper)}`,
        details: [
          `${count(change.rechecked, "quote", "quotes")} rechecked: ${change.rematched} found again, ${change.notFound} not found, ${change.ambiguous} found more than once.`,
          ...(change.needRereview > 0 ? [`${count(change.needRereview, "field needs", "fields need")} re-review.`] : []),
        ],
      };
    case "anchor_rematched":
      return { text: `${historyFieldName(change.field)}: a quote was found again in copy ${change.seq.to}`, details: [`It pointed to copy ${change.seq.from} before.`] };
    case "anchor_not_rematched":
      return {
        text: `${historyFieldName(change.field)}: a quote ${
          change.outcome === "ambiguous" ? "was found more than once in" : change.outcome === "not_found" ? "wasn't found in" : "couldn't be checked against"
        } the new copy`,
        details: [`It stays on copy ${change.keptSeq}.`],
      };
    case "group_added":
      return { text: `Added ${GROUP_ROLE_WORDS[change.role]} ${quoted(change.name)}`, details: [] };
    case "group_updated": {
      const name = groupName(change.name, "Group");
      const lines = [
        change.renamed && `Group ${quoted(change.renamed.from)} renamed to ${quoted(change.renamed.to)}`,
        change.role && `${name} changed from ${GROUP_ROLE_WORDS[change.role.from]} to ${GROUP_ROLE_WORDS[change.role.to]}`,
        change.moved && `${name} moved`,
      ].filter((line): line is string => typeof line === "string");
      return { text: lines[0], details: lines.slice(1) };
    }
    case "group_removed":
      return {
        text: `Removed ${GROUP_ROLE_WORDS[change.role]} ${quoted(change.name)}`,
        details: change.values > 0 ? [`Its ${count(change.values, "recorded value", "recorded values")} and their sources went with it.`] : [],
      };
    case "outcome_added":
      return { text: `Added outcome ${quoted(change.name)}`, details: [] };
    case "outcome_updated": {
      const name = groupName(change.name, "Outcome");
      const lines = [change.renamed && `Outcome ${quoted(change.renamed.from)} renamed to ${quoted(change.renamed.to)}`, change.moved && `${name} moved`].filter(
        (line): line is string => typeof line === "string",
      );
      return { text: lines[0], details: lines.slice(1) };
    }
    case "outcome_removed":
      return {
        text: `Removed outcome ${quoted(change.name)}`,
        details: change.values > 0 ? [`Its ${count(change.values, "recorded value", "recorded values")} and their sources went with it.`] : [],
      };
    case "value_saved":
      return describeValueSavedText(change.field, change.saved);
    case "value_cleared":
      return {
        text: `${historyFieldName(change.field)}: cleared (it was ${stateName(change.state, change.stateReason)})`,
        details: change.reviewCleared ? [`Its review (${REVIEW_STATUS_LABELS[change.reviewCleared]}) went with it.`] : [],
      };
    case "review":
      return describeReviewText(change);
    case "unreadable":
      return {
        text: change.field ? `${HISTORY_UNREADABLE_TITLES[change.type]}: ${historyFieldName(change.field)}` : HISTORY_UNREADABLE_TITLES[change.type],
        details: [HISTORY_COPY.unreadableDetail],
      };
  }
}

function describeValueSavedText(field: HistoryField, saved: Extract<HistoryChange, { kind: "value_saved" }>["saved"]): HistoryChangeText {
  const name = historyFieldName(field);
  const details: string[] = [];
  const { state, stateReason, content } = saved;
  if (saved.created) {
    const recorded = content.to ? ` — ${contentName(field.fieldKey, content.to)}` : "";
    if (saved.note === "added") details.push("With a note.");
    details.push(sourcesSummary(saved.sources.to));
    // A text, a list, a number's reported text and a note are kept only as fingerprints.
    if ((content.to && content.to.shape !== "code") || saved.note !== "none") details.push(TEXT_NOT_KEPT);
    return { text: `${name}: recorded as ${stateName(state.to, stateReason.to)}${recorded}`, details };
  }
  const stateChanged = state.from !== state.to || stateReason.from !== stateReason.to;
  const parts = [
    stateChanged && `${stateName(state.from ?? state.to, stateReason.from)} → ${stateName(state.to, stateReason.to)}`,
    // Leaving Reported takes the value with it: the new state already says so.
    content.changed && !(state.from !== state.to && content.to === null) && contentChangeName(field.fieldKey, content.from, content.to),
    saved.note !== "unchanged" && saved.note !== "none" && NOTE_WORDS[saved.note],
    saved.sources.changed && "sources changed",
  ].filter((part): part is string => typeof part === "string");
  if (saved.sources.changed) details.push(sourcesSummary(saved.sources.to));
  if (saved.reviewCleared) details.push(CLEARED_REVIEW_LINES[saved.reviewCleared]);
  const earlierText = (content.changed && !!content.from && content.from.shape !== "code") || saved.note === "changed" || saved.note === "removed";
  if (earlierText) details.push(EARLIER_TEXT_NOT_KEPT);
  return { text: `${name}: ${parts.length > 0 ? parts.join("; ") : "saved"}`, details };
}

function describeReviewText(change: Extract<HistoryChange, { kind: "review" }>): HistoryChangeText {
  const name = historyFieldName(change.field);
  const details: string[] = [];
  if (change.change === "needs_rereview") {
    details.push(`It was ${REVIEW_STATUS_LABELS[change.from]} before.`);
    return { text: `${name}: needs re-review — the saved abstract copy changed`, details };
  }
  if (change.change === "confirmed") {
    if (change.from === "disputed") details.push("This replaced your flag.");
    if (change.from === "needs_rereview") details.push("It needed re-review before.");
    if (change.from === "user_reviewed") details.push("It was already reviewed by you; the review note changed.");
    else if (change.note === "added" || change.note === "changed") details.push("With a review note.");
    if (change.note !== "none") details.push(NOTE_TEXT_NOT_KEPT);
    return { text: `${name}: ${REVIEW_STATUS_LABELS.user_reviewed.toLowerCase()}`, details };
  }
  if (change.from === "disputed") details.push("The flag's note changed.");
  if (change.from === "user_reviewed") details.push("This replaced your review.");
  details.push(NOTE_TEXT_NOT_KEPT);
  return { text: `${name}: ${REVIEW_STATUS_LABELS.disputed.toLowerCase()}`, details };
}
