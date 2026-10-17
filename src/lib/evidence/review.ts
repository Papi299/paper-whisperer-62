/**
 * Human review of recorded values (EVIDENCE-RECORDS-001B).
 *
 * Requirements-001 §J2 as amended by 001A §E5-E6 and §I, and FK-PROOF-001 §J:
 *
 *   * "Reviewed by you" exists only because the user pressed Confirm on ONE
 *     value at ONE exact `value_version`. There is no bulk confirmation, no
 *     automatic confirmation, no confirmation because validation passed, and no
 *     record-level reviewed, complete or verified state (001A PD-7, §I6).
 *   * Confirm needs current support: a Reported value needs an abstract quote on
 *     its link's CURRENT copy or a full-text locator (quotes on superseded
 *     copies do not count), and a number needs its confirmed integer. Every
 *     examined abstract must be the current copy; an unavailable abstract must
 *     still have no copy.
 *   * Flag needs a note of at least 3 characters, in any state.
 *   * Any change to a value — its state, reason, content, note or sources —
 *     returns it to Not reviewed.
 *   * When a link's saved abstract is replaced, or first saved, every value that
 *     depends on that link's abstract and was reviewed or flagged needs
 *     re-review — EVEN IF EVERY QUOTE IS FOUND AGAIN. A deterministic re-match
 *     changes where a quote points; it never moves review status upward
 *     (001A §E5, PD-6).
 *
 * These are browser-side preconditions: they decide what the UI offers and
 * explain why. The PR-A3 review RPC re-checks all of them, binds the review to
 * the version, and its answer stands.
 */

import { EVIDENCE_FIELDS } from "./fieldDictionary";
import type { PaperId, ValueId, ValueVersion } from "./ids";
import { codePointLength, findPostgresTextProblem, isNormalizationEmpty } from "./normalization";
import type { FieldContent, RecordedValue, ReviewState, ReviewStatus, StoredReference } from "./types";
import {
  btrimSpaces,
  NOT_APPLICABLE_NOTE_MIN_LENGTH,
  UNCLEAR_NOTE_MIN_LENGTH,
  VALUE_NOTE_MAX_LENGTH,
  type LinkSources,
  type ReferenceDraft,
  type ValueDraft,
} from "./validation";

export const REVIEW_STATUS_LABELS: Readonly<Record<ReviewStatus, string>> = Object.freeze({
  unreviewed: "Not reviewed",
  user_reviewed: "Reviewed by you",
  disputed: "Flagged",
  needs_rereview: "Needs re-review",
});

/** Requirements-001 §E7: the label of a field whose review an edit cleared. */
export const CHANGED_AFTER_REVIEW_LABEL = "Not reviewed (changed after review)";

/** Requirements-001A §I7. */
export const REVIEWED_BY_YOU_MEANING =
  "Reviewed by you — you confirmed this value against the source shown. PaperLume hasn't checked your interpretation.";

export const FLAG_NOTE_MIN_LENGTH = 3;

export type ConfirmBlock =
  | "not_recorded"
  | "stale_version"
  | "no_current_support"
  | "count_not_confirmed"
  | "examined_abstract_not_current"
  | "unavailable_abstract_has_copy"
  | "note_missing"
  | "state_reason_missing";

/** Shown beside the Confirm button, not in a tooltip (Requirements-001 §E6). */
export const CONFIRM_BLOCK_MESSAGES: Readonly<Record<ConfirmBlock, string>> = Object.freeze({
  not_recorded: "Record this field before confirming it.",
  stale_version: "This field changed since you opened it.",
  no_current_support: "Add a quote or a full-text reference before confirming.",
  count_not_confirmed: "Confirm the number before confirming this value.",
  examined_abstract_not_current: "Check the current saved copy of the abstract, then save, before confirming.",
  unavailable_abstract_has_copy: "This paper now has a saved copy of its abstract. Record what it says before confirming.",
  note_missing: "Add the required note before confirming.",
  state_reason_missing: "Say why this is unclear before confirming.",
});

export type ConfirmCheck =
  | { readonly kind: "allowed"; readonly item: { readonly valueId: ValueId; readonly valueVersion: ValueVersion } }
  /** This exact version is already reviewed: Confirm would change nothing (001A §I5). */
  | { readonly kind: "already_reviewed" }
  | { readonly kind: "blocked"; readonly reasons: readonly ConfirmBlock[] };

const currentCopyOf = (links: readonly LinkSources[], paperId: PaperId) =>
  links.find((link) => link.paperId === paperId)?.currentSnapshotId ?? null;

function isCurrentSupport(reference: StoredReference, links: readonly LinkSources[]): boolean {
  if (reference.purpose !== "supports") return false;
  if (reference.sourceKind === "full_text") return true;
  const current = currentCopyOf(links, reference.paperId);
  return current !== null && reference.snapshotId === current;
}

/**
 * Whether the user may confirm `value` as they loaded it. `loadedVersion` is
 * the `value_version` on screen when the user pressed Confirm; it is what the
 * review is bound to. On success, `item` is the one binding the PR-A3 review
 * RPC needs (001A L2: a value id and its version).
 */
export function checkConfirm(value: RecordedValue | null, loadedVersion: number, links: readonly LinkSources[]): ConfirmCheck {
  if (!value) return { kind: "blocked", reasons: ["not_recorded"] };
  if (loadedVersion !== value.valueVersion) return { kind: "blocked", reasons: ["stale_version"] };
  if (value.review.status === "user_reviewed" && value.review.reviewedVersion === value.valueVersion) {
    return { kind: "already_reviewed" };
  }

  const reasons: ConfirmBlock[] = [];
  const examinedAbstractsCurrent = value.references.every(
    (r) => !(r.purpose === "examined" && r.sourceKind === "abstract") || r.snapshotId === currentCopyOf(links, r.paperId),
  );
  const noteLength = value.note === null ? 0 : codePointLength(btrimSpaces(value.note));

  switch (value.state) {
    case "reported": {
      if (!value.references.some((r) => isCurrentSupport(r, links))) reasons.push("no_current_support");
      if (EVIDENCE_FIELDS[value.fieldKey].shape === "integer_with_reported_text" && !hasConfirmedCount(value.content)) {
        reasons.push("count_not_confirmed");
      }
      break;
    }
    case "not_reported":
      if (!examinedAbstractsCurrent) reasons.push("examined_abstract_not_current");
      break;
    case "source_unavailable": {
      const stale = value.references.some(
        (r) => r.purpose === "unavailable" && r.sourceKind === "abstract" && currentCopyOf(links, r.paperId) !== null,
      );
      if (stale) reasons.push("unavailable_abstract_has_copy");
      break;
    }
    case "unclear":
      if (value.stateReason === null) reasons.push("state_reason_missing");
      if (noteLength < UNCLEAR_NOTE_MIN_LENGTH) reasons.push("note_missing");
      if (!examinedAbstractsCurrent) reasons.push("examined_abstract_not_current");
      break;
    case "not_applicable":
      if (noteLength < NOT_APPLICABLE_NOTE_MIN_LENGTH) reasons.push("note_missing");
      break;
  }

  if (reasons.length > 0) return { kind: "blocked", reasons: Object.freeze(reasons) };
  return { kind: "allowed", item: Object.freeze({ valueId: value.id, valueVersion: value.valueVersion }) };
}

function hasConfirmedCount(content: FieldContent | null): boolean {
  return content?.shape === "integer_with_reported_text" && Number.isInteger(content.value);
}

export type FlagBlock = "not_recorded" | "stale_version" | "note_too_short" | "note_too_long" | "note_malformed";

export const FLAG_BLOCK_MESSAGES: Readonly<Record<FlagBlock, string>> = Object.freeze({
  not_recorded: "Record this field before flagging it.",
  stale_version: "This field changed since you opened it.",
  note_too_short: "Say what's wrong, in at least 3 characters.",
  note_too_long: "Flag notes can be up to 2,000 characters.",
  note_malformed: "This note contains characters that can't be saved.",
});

/** Whether the user may flag `value` with `note` (PR-A1 `evidence_field_values_review_note_check`). */
export function checkFlag(
  value: RecordedValue | null,
  loadedVersion: number,
  note: string,
): { readonly kind: "allowed" } | { readonly kind: "blocked"; readonly reasons: readonly FlagBlock[] } {
  if (!value) return { kind: "blocked", reasons: ["not_recorded"] };
  if (loadedVersion !== value.valueVersion) return { kind: "blocked", reasons: ["stale_version"] };
  if (typeof note !== "string" || findPostgresTextProblem(note)) return { kind: "blocked", reasons: ["note_malformed"] };
  const reasons: FlagBlock[] = [];
  if (codePointLength(btrimSpaces(note)) < FLAG_NOTE_MIN_LENGTH || isNormalizationEmpty(note)) reasons.push("note_too_short");
  if (codePointLength(note) > VALUE_NOTE_MAX_LENGTH) reasons.push("note_too_long");
  return reasons.length > 0 ? { kind: "blocked", reasons: Object.freeze(reasons) } : { kind: "allowed" };
}

// ── Edits ────────────────────────────────────────────────────────────────────

/** The draft that reproduces a stored value exactly — the starting point of an edit. */
export function draftFromRecordedValue(value: RecordedValue): ValueDraft {
  const references = value.references.map((reference): ReferenceDraft => {
    switch (reference.purpose) {
      case "supports":
        return reference.sourceKind === "abstract"
          ? {
              purpose: "supports",
              sourceKind: "abstract",
              paperId: reference.paperId,
              snapshotId: reference.snapshotId,
              quoteText: reference.quoteText,
              occurrence: reference.match.occurrence,
              anchorId: reference.id,
            }
          : {
              purpose: "supports",
              sourceKind: "full_text",
              paperId: reference.paperId,
              locator: { kind: reference.locator.kind, text: reference.locator.text },
              anchorId: reference.id,
            };
      case "examined":
        return reference.sourceKind === "abstract"
          ? { purpose: "examined", sourceKind: "abstract", paperId: reference.paperId, snapshotId: reference.snapshotId, anchorId: reference.id }
          : {
              purpose: "examined",
              sourceKind: "full_text",
              paperId: reference.paperId,
              locator: reference.locator ? { kind: reference.locator.kind, text: reference.locator.text } : null,
              anchorId: reference.id,
            };
      case "unavailable":
        return { purpose: "unavailable", sourceKind: reference.sourceKind, paperId: reference.paperId, anchorId: reference.id };
    }
  });
  return Object.freeze({
    fieldKey: value.fieldKey,
    state: value.state,
    stateReason: value.stateReason,
    content: value.content,
    note: value.note,
    references: Object.freeze(references),
  });
}

function canonicalReference(reference: ReferenceDraft): string {
  const r = reference as Record<string, unknown>;
  const locator = r.locator as { kind?: unknown; text?: unknown } | null | undefined;
  return JSON.stringify([
    r.purpose,
    r.sourceKind,
    r.paperId,
    r.snapshotId ?? null,
    r.quoteText ?? null,
    r.occurrence ?? null,
    locator ? [locator.kind, locator.text] : null,
  ]);
}

function canonicalContent(content: FieldContent | null | undefined): unknown {
  if (!content) return null;
  switch (content.shape) {
    case "text":
      return ["text", content.text];
    case "code":
      return ["code", content.code];
    case "integer_with_reported_text":
      return ["count", content.reportedText, content.value];
    case "text_list":
      return ["list", [...content.entries]];
    default:
      // A stored value always has a valid shape, so a malformed draft never compares equal to one.
      return ["malformed"];
  }
}

function canonicalDraft(draft: ValueDraft): string {
  const references = draft.references ?? [];
  // Supporting sources keep their order (it is their position); assessments are a set.
  const supports = references.filter((r) => r.purpose === "supports").map(canonicalReference);
  const assessments = references.filter((r) => r.purpose !== "supports").map(canonicalReference).sort();
  return JSON.stringify([
    draft.fieldKey,
    draft.state,
    draft.stateReason ?? null,
    canonicalContent(draft.content),
    draft.note ?? null,
    supports,
    assessments,
  ]);
}

/** Whether saving `draft` would change the stored value at all. */
export function draftChangesValue(value: RecordedValue, draft: ValueDraft): boolean {
  return canonicalDraft(draftFromRecordedValue(value)) !== canonicalDraft(draft);
}

/**
 * The review a value will have after saving `draft`: unchanged when nothing
 * changes, otherwise Not reviewed. The review note's fate on an edit is the
 * PR-A3 RPC's to decide, so it is not predicted here.
 */
export function predictReviewAfterSave(value: RecordedValue, draft: ValueDraft): Omit<ReviewState, "note"> {
  if (!draftChangesValue(value, draft)) {
    const { note: _note, ...review } = value.review;
    return Object.freeze(review);
  }
  return Object.freeze({ status: "unreviewed", reason: null, reviewedAt: null, reviewedVersion: null });
}

/** Whether saving `draft` would clear a review the user gave (a reviewed or flagged value changing). */
export function saveClearsReview(value: RecordedValue, draft: ValueDraft): boolean {
  return value.review.status !== "unreviewed" && draftChangesValue(value, draft);
}

// ── Source changes ───────────────────────────────────────────────────────────

/**
 * Whether `value` depends on the abstract of the link to `paperId`: it has any
 * abstract reference there — a quote, an examined copy or an unavailable
 * abstract (FK-PROOF-001 §J, replacing 001A's "basis includes abstract").
 */
export function isAbstractDependent(value: Pick<RecordedValue, "references">, paperId: PaperId): boolean {
  return value.references.some((r) => r.sourceKind === "abstract" && r.paperId === paperId);
}

export interface ReviewTransition {
  readonly valueId: ValueId;
  readonly from: ReviewStatus;
  readonly to: ReviewStatus;
  readonly reason: "source_changed" | null;
  readonly changed: boolean;
}

/**
 * The review transitions a saved-copy change on the link to `paperId` causes:
 * `rebase` (a new copy replaced the current one) or `first_capture` (a link
 * without a copy got its first). Reviewed, flagged and needs-re-review values
 * that depend on that abstract need re-review with reason `source_changed`;
 * not-reviewed ones stay not reviewed; nothing else changes. No quote-match
 * result is an input: a re-matched quote does not keep a review.
 */
export function deriveSourceChangeTransitions(
  values: readonly RecordedValue[],
  change: { readonly paperId: PaperId; readonly kind: "rebase" | "first_capture" },
): readonly ReviewTransition[] {
  return Object.freeze(
    values
      .filter((value) => isAbstractDependent(value, change.paperId))
      .map((value): ReviewTransition => {
        const from = value.review.status;
        const to: ReviewStatus = from === "unreviewed" ? "unreviewed" : "needs_rereview";
        return Object.freeze({
          valueId: value.id,
          from,
          to,
          reason: to === "needs_rereview" ? "source_changed" : null,
          changed: from !== to,
        });
      }),
  );
}
