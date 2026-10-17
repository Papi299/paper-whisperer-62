/**
 * Advisory validation of study-record input (EVIDENCE-RECORDS-001B).
 *
 * Pure checks for the PR-A1 schema and for preparing what the future PR-A3
 * save RPC will receive. The browser's answer is advisory; the server's RPCs
 * remain the authority. Each check names its source:
 *
 *   * the PR-A1 single-row CHECKs — value shapes and bounds, "reported if and
 *     only if a value is present", the state-reason and note rules, and the
 *     source-reference matrix (purpose x source kind);
 *   * PR-A2 — "blank" means empty after normalization v1, the rule its RPCs
 *     apply to labels and notes (accepted decision 9). This module applies it
 *     to every free text: whether the PR-A3 RPCs adopt it for values is theirs
 *     to decide, and until then the browser is the stricter side;
 *   * FK-PROOF-001 §J — which reference purposes each value state takes;
 *   * Requirements-001 §H4/§H6 and 001A §D1 — design family, comparator-only,
 *     list hygiene, and that a new quote targets its link's current copy.
 *
 * Nothing here rewrites what the user wrote: no trimming, no normalization of
 * values, no coercion of a malformed value into a plausible one. A problem is
 * reported with a stable `code` and a `path`, and the caller decides.
 * `trimListEntries` exists for an explicit, visible fix of list entries, never
 * as a silent one.
 */

import {
  COUNT_MAX,
  COUNT_MIN,
  EVIDENCE_FIELDS,
  isArmRole,
  isDesignProfile,
  isFieldAllowedForArmRole,
  isFieldAllowedForDesign,
  isFieldKey,
  type ArmFieldKey,
  type ArmRole,
  type DesignProfile,
  type FieldDefinition,
  type FieldKey,
} from "./fieldDictionary";
import { isCanonicalUuid, type AnchorId, type PaperId, type SnapshotId } from "./ids";
import { locateQuote, QUOTE_MAX_LENGTH } from "./matcher";
import { codePointLength, findPostgresTextProblem, isNormalizationEmpty, WHITE_SPACE_CODE_POINTS } from "./normalization";
import { checkCountInQuote } from "./numbers";
import { VALUE_STATE_RULES } from "./states";
import {
  isLocatorKind,
  isReferencePurpose,
  isReferenceSourceKind,
  isStateReason,
  isValueState,
  type FieldContent,
  type FullTextLocator,
  type ReferencePurpose,
  type ReferenceSourceKind,
  type StateReason,
  type ValueState,
} from "./types";

// ── Bounds (PR-A1 CHECKs; PR-A2 argument checks) ─────────────────────────────

export const STUDY_LABEL_MAX_LENGTH = 120;
export const STUDY_NOTES_MAX_LENGTH = 10_000;
export const VALUE_NOTE_MAX_LENGTH = 2000;
export const UNCLEAR_NOTE_MIN_LENGTH = 10;
export const NOT_APPLICABLE_NOTE_MIN_LENGTH = 3;
export const MAX_SUPPORTING_REFERENCES = 3;
export const LOCATOR_TEXT_MAX_LENGTH = 200;

// ── Issues ───────────────────────────────────────────────────────────────────

/** Default English messages. The code is the contract; the message is presentation. */
export const VALIDATION_MESSAGES = Object.freeze({
  "study.label_required": "Give the study a short name.",
  "study.label_too_long": "Study names can be up to 120 characters.",
  "study.design_profile_required": "Choose the kind of study.",
  "study.notes_blank": "Remove the empty notes, or write some.",
  "study.notes_too_long": "Study notes can be up to 10,000 characters.",
  "study.link_status_required": "Say whether this paper reports an original study.",
  "request.request_id_invalid": "This action has no valid request id.",
  "request.paper_id_invalid": "This paper id isn't valid.",
  "request.study_id_invalid": "This study record id isn't valid.",
  "request.expected_version_invalid": "This study record's version isn't valid. Reload it.",
  "request.link_action_invalid": "Choose confirm, mark as provisional or remove.",
  "request.notes_missing": "Say whether the study has notes: null means none.",
  "field.unknown": "This field doesn't exist in study records.",
  "field.wrong_scope": "This field belongs to a different part of the study record.",
  "field.not_allowed_for_design": "This field isn't part of the form for this kind of study.",
  "field.not_allowed_for_arm_role": "Comparator type applies to comparator groups only.",
  "context.invalid": "The study record's context is incomplete.",
  "state.unknown": "Choose a state for this field.",
  "value.required": "Enter the value, or choose another state.",
  "value.not_allowed": "Only a Reported field holds a value.",
  "value.wrong_shape": "This value doesn't have the form this field needs.",
  "value.no_source_given": "No source given",
  "text.not_text": "Enter the value as text.",
  "text.malformed": "This text contains characters that can't be saved.",
  "text.blank": "Enter some text, not only spaces.",
  "text.too_long": "This text is too long.",
  "code.not_in_list": "Choose one of the listed options.",
  "count.reported_text_required": "Enter the number as the source reports it.",
  "count.value_required": "Confirm the number this text reports.",
  "count.not_integer": "The confirmed number must be a whole number.",
  "count.out_of_range": "The confirmed number must be between 0 and 10,000,000.",
  "count.digits_absent_from_quote": "The number doesn't appear in your quote. Check the value or the quote.",
  "list.not_list": "Enter the entries as a list.",
  "list.empty": "Add at least one entry.",
  "list.too_many": "This list has too many entries.",
  "list.entry_not_text": "Each entry must be text.",
  "list.entry_malformed": "This entry contains characters that can't be saved.",
  "list.entry_blank": "Remove the empty entry.",
  "list.entry_untrimmed": "Remove the spaces at the start or end of this entry.",
  "list.entry_contains_whitespace": "Registration numbers can't contain spaces.",
  "list.entry_forbidden_character": "This entry contains a character that can't be saved.",
  "list.entry_too_short": "This entry is too short.",
  "list.entry_too_long": "This entry is too long.",
  "list.entry_duplicate": "This entry is listed twice.",
  "state_reason.required": "Say why this is unclear: ambiguous, conflicting or incomplete.",
  "state_reason.not_allowed": "Only an Unclear field has a reason.",
  "state_reason.unknown": "Choose ambiguous, conflicting or incomplete.",
  "note.not_text": "Enter the note as text.",
  "note.malformed": "This note contains characters that can't be saved.",
  "note.blank": "Remove the empty note, or write one.",
  "note.too_long": "Notes can be up to 2,000 characters.",
  "note.required_for_unclear": "Say what is unclear — for example ‘abstract gives 120 and 118 randomized’.",
  "note.required_for_not_applicable": "Say why this doesn't apply to this study.",
  "references.not_list": "Sources must be a list.",
  "references.too_many_supporting": "A value can have up to 3 supporting sources.",
  "references.supporting_not_allowed": "Only a Reported or Unclear field can have a supporting source.",
  "references.examined_required": "Say which source you examined.",
  "references.examined_not_allowed": "This state doesn't take an examined source.",
  "references.unavailable_required": "Say which source you couldn't check.",
  "references.unavailable_not_allowed": "This state doesn't take an unavailable source.",
  "references.basis_required": "Quote the unclear text, or say which source you examined.",
  "references.not_allowed": "A Not applicable field has no sources.",
  "references.duplicate_assessment": "This source is already marked as examined or unavailable for this field.",
  "reference.not_object": "This source is incomplete.",
  "reference.purpose_unknown": "This source has no valid purpose.",
  "reference.source_kind_unknown": "Sources can be the abstract or the full text.",
  "reference.other_source_deferred": "Sources outside your library can't be recorded yet.",
  "reference.paper_invalid": "This source names no valid paper.",
  "reference.paper_not_linked": "This paper isn't linked to this study record.",
  "reference.server_fields_not_allowed": "Match results are computed by the server, never sent by the browser.",
  "reference.snapshot_required": "Choose the saved copy of the abstract.",
  "reference.snapshot_not_allowed": "Only an abstract quote or an examined abstract names a saved copy.",
  "reference.snapshot_not_of_link": "This saved copy belongs to a different paper.",
  "reference.snapshot_not_current": "Use the current saved copy of the abstract.",
  "reference.unavailable_abstract_has_copy": "This paper has a saved copy of its abstract, so it isn't unavailable.",
  "reference.quote_required": "Enter the quote from the abstract.",
  "reference.quote_not_allowed": "A full-text reference names a location only; quotes from the full text can't be stored.",
  "reference.quote_invalid": "Quote at least 3 characters, including a letter or number.",
  "reference.quote_too_long": "Quotes from the abstract can be up to 1,000 characters.",
  "reference.quote_not_found":
    "This text wasn't found in the saved abstract. Select it directly in the abstract, or add it as a full-text reference if it comes from elsewhere.",
  "reference.quote_ambiguous": "This text appears several times in the abstract. Select the one you mean, or add a few words.",
  "reference.occurrence_out_of_range": "Choose one of the places this text appears.",
  "reference.occurrence_not_allowed": "Only an abstract quote has an occurrence.",
  "reference.locator_required": "Give the page, section, table, figure or paragraph.",
  "reference.locator_not_allowed": "Only a full-text reference names a location.",
  "reference.locator_kind_unknown": "Choose page, section, table, figure, paragraph or other.",
  "reference.locator_text_invalid": "Give the location in up to 200 characters.",
} as const);

export type ValidationCode = keyof typeof VALIDATION_MESSAGES;
export type IssuePath = readonly (string | number)[];

export interface ValidationIssue {
  readonly code: ValidationCode;
  readonly path: IssuePath;
  readonly severity: "error" | "warning";
  readonly message: string;
}

/** `ok` is false exactly when an issue has severity "error"; warnings never block. */
export interface ValidationResult {
  readonly ok: boolean;
  readonly issues: readonly ValidationIssue[];
}

class Issues {
  readonly list: ValidationIssue[] = [];
  error(code: ValidationCode, path: IssuePath, message: string = VALIDATION_MESSAGES[code]) {
    this.list.push(Object.freeze({ code, path: Object.freeze([...path]), severity: "error", message }));
  }
  warning(code: ValidationCode, path: IssuePath, message: string = VALIDATION_MESSAGES[code]) {
    this.list.push(Object.freeze({ code, path: Object.freeze([...path]), severity: "warning", message }));
  }
  result(): ValidationResult {
    return Object.freeze({ ok: this.list.every((i) => i.severity !== "error"), issues: Object.freeze(this.list) });
  }
}

// ── Text helpers ─────────────────────────────────────────────────────────────

const WHITE_SPACE = new Set(WHITE_SPACE_CODE_POINTS);
const UNIT_SEPARATOR = 0x1f;
const isAbsent = (value: unknown) => value === undefined || value === null;

/** 10000 -> "10,000", without locale data. */
function withThousands(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** PostgreSQL's one-argument btrim: strips U+0020 only, which is what the PR-A1 CHECKs measure. */
export function btrimSpaces(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && text.charCodeAt(start) === 0x20) start += 1;
  while (end > start && text.charCodeAt(end - 1) === 0x20) end -= 1;
  return text.slice(start, end);
}

/** Strip the 25 White_Space code points of normalization v1 from both ends. */
function trimWhiteSpace(text: string): string {
  const chars = Array.from(text);
  let start = 0;
  let end = chars.length;
  while (start < end && WHITE_SPACE.has(chars[start].codePointAt(0) as number)) start += 1;
  while (end > start && WHITE_SPACE.has(chars[end - 1].codePointAt(0) as number)) end -= 1;
  return chars.slice(start, end).join("");
}

function checkFreeText(
  issues: Issues,
  value: unknown,
  path: IssuePath,
  maxLength: number,
  codes: { notText: ValidationCode; malformed: ValidationCode; blank: ValidationCode; tooLong: ValidationCode },
): value is string {
  if (typeof value !== "string") {
    issues.error(codes.notText, path);
    return false;
  }
  if (findPostgresTextProblem(value)) {
    issues.error(codes.malformed, path);
    return false;
  }
  if (isNormalizationEmpty(value)) issues.error(codes.blank, path);
  if (codePointLength(value) > maxLength) issues.error(codes.tooLong, path, `${VALIDATION_MESSAGES[codes.tooLong]} The limit is ${withThousands(maxLength)} characters.`);
  return true;
}

const TEXT_CODES = { notText: "text.not_text", malformed: "text.malformed", blank: "text.blank", tooLong: "text.too_long" } as const;
const NOTE_CODES = { notText: "note.not_text", malformed: "note.malformed", blank: "note.blank", tooLong: "note.too_long" } as const;

/**
 * Trim each list entry of white space, for an explicit fix the user sees.
 * Returns the trimmed entries and the indices that changed.
 */
export function trimListEntries(entries: readonly string[]): { readonly entries: readonly string[]; readonly changed: readonly number[] } {
  const trimmed = entries.map(trimWhiteSpace);
  const changed = trimmed.flatMap((entry, index) => (entry === entries[index] ? [] : [index]));
  return Object.freeze({ entries: Object.freeze(trimmed), changed: Object.freeze(changed) });
}

// ── Study header (the PR-A2 RPC arguments) ───────────────────────────────────

/** `p_label`: 1-120 characters and not empty after v1 (PR-A2; PR-A1 `evidence_studies_label_check`). */
export function validateStudyLabel(label: unknown): ValidationResult {
  const issues = new Issues();
  if (typeof label !== "string" || findPostgresTextProblem(label) || isNormalizationEmpty(label)) {
    issues.error("study.label_required", ["label"]);
  } else if (codePointLength(label) > STUDY_LABEL_MAX_LENGTH) {
    issues.error("study.label_too_long", ["label"]);
  }
  return issues.result();
}

/** `p_notes`: null means no notes; otherwise up to 10,000 characters, not empty after v1. Never "". */
export function validateStudyNotes(notes: unknown): ValidationResult {
  const issues = new Issues();
  if (notes === null) return issues.result();
  if (typeof notes !== "string" || findPostgresTextProblem(notes) || isNormalizationEmpty(notes)) {
    issues.error("study.notes_blank", ["notes"]);
  } else if (codePointLength(notes) > STUDY_NOTES_MAX_LENGTH) {
    issues.error("study.notes_too_long", ["notes"]);
  }
  return issues.result();
}

// ── Field values ─────────────────────────────────────────────────────────────

/** A full-text locator as drafted; validated, never trusted. */
export interface LocatorDraft {
  readonly kind: string;
  readonly text: string;
}

/**
 * One source reference as drafted in the browser — a domain shape, not a wire
 * format (the PR-A3 payload is defined by PR-A3). It carries no match columns:
 * the server computes `match_start`, `match_end`, `match_occurrence`,
 * `match_count` and `matched_at`. `anchorId` marks an existing, unchanged
 * reference carried over; anything without one is new. `occurrence` is the
 * 1-based occurrence the user chose when a quote appears several times.
 */
export type ReferenceDraft =
  | {
      readonly purpose: "supports";
      readonly sourceKind: "abstract";
      readonly paperId: PaperId;
      readonly snapshotId: SnapshotId;
      readonly quoteText: string;
      readonly occurrence?: number | null;
      readonly anchorId?: AnchorId | null;
    }
  | {
      readonly purpose: "supports";
      readonly sourceKind: "full_text";
      readonly paperId: PaperId;
      readonly locator: LocatorDraft;
      readonly anchorId?: AnchorId | null;
    }
  | {
      readonly purpose: "examined";
      readonly sourceKind: "abstract";
      readonly paperId: PaperId;
      readonly snapshotId: SnapshotId;
      readonly anchorId?: AnchorId | null;
    }
  | {
      readonly purpose: "examined";
      readonly sourceKind: "full_text";
      readonly paperId: PaperId;
      readonly locator?: LocatorDraft | null;
      readonly anchorId?: AnchorId | null;
    }
  | {
      readonly purpose: "unavailable";
      readonly sourceKind: ReferenceSourceKind;
      readonly paperId: PaperId;
      readonly anchorId?: AnchorId | null;
    };

/** A value as drafted: a state, and for Reported its typed content. */
export interface ValueDraft {
  readonly fieldKey: FieldKey;
  readonly state: ValueState;
  readonly stateReason?: StateReason | null;
  readonly content?: FieldContent | null;
  readonly note?: string | null;
  readonly references?: readonly ReferenceDraft[];
}

/** One of the study's links, with its saved copies. */
export interface LinkSources {
  readonly paperId: PaperId;
  /** The link's highest-`seq` copy, or null when it has none. */
  readonly currentSnapshotId: SnapshotId | null;
  /** Every copy of the link, current and superseded. */
  readonly snapshotIds: readonly SnapshotId[];
}

export type ValueTargetContext =
  | { readonly scope: "study" }
  | { readonly scope: "arm"; readonly armRole: ArmRole }
  | { readonly scope: "outcome" };

export interface ValueContext {
  readonly designProfile: DesignProfile;
  readonly target: ValueTargetContext;
  readonly links: readonly LinkSources[];
  /** Saved-copy texts by snapshot id. When given, abstract quotes are matched in the browser too. */
  readonly copyTexts?: ReadonlyMap<string, string>;
}

const SERVER_ATTESTED_KEYS = ["matchStart", "matchEnd", "matchOccurrence", "matchCount", "matchedAt", "normalizationVersion"];

function validateLocator(issues: Issues, locator: unknown, path: IssuePath): void {
  if (!locator || typeof locator !== "object") {
    issues.error("reference.locator_required", path);
    return;
  }
  const { kind, text } = locator as Partial<FullTextLocator>;
  if (!isLocatorKind(kind)) issues.error("reference.locator_kind_unknown", [...path, "kind"]);
  if (
    typeof text !== "string" ||
    findPostgresTextProblem(text) ||
    isNormalizationEmpty(text) ||
    codePointLength(text) > LOCATOR_TEXT_MAX_LENGTH
  ) {
    issues.error("reference.locator_text_invalid", [...path, "text"]);
  }
}

function validateContent(issues: Issues, definition: FieldDefinition, content: unknown): void {
  const path = ["content"];
  if (!content || typeof content !== "object" || (content as { shape?: unknown }).shape !== definition.shape) {
    issues.error("value.wrong_shape", path);
    return;
  }
  switch (definition.shape) {
    case "text": {
      checkFreeText(issues, (content as { text?: unknown }).text, [...path, "text"], definition.text.maxLength, TEXT_CODES);
      return;
    }
    case "code": {
      const { code } = content as { code?: unknown };
      if (typeof code !== "string" || !definition.codes.includes(code)) issues.error("code.not_in_list", [...path, "code"]);
      return;
    }
    case "integer_with_reported_text": {
      const { reportedText, value } = content as { reportedText?: unknown; value?: unknown };
      if (isAbsent(reportedText)) issues.error("count.reported_text_required", [...path, "reportedText"]);
      else checkFreeText(issues, reportedText, [...path, "reportedText"], definition.reportedText.maxLength, TEXT_CODES);
      if (isAbsent(value)) issues.error("count.value_required", [...path, "value"]);
      else if (typeof value !== "number" || !Number.isInteger(value)) issues.error("count.not_integer", [...path, "value"]);
      else if (value < COUNT_MIN || value > COUNT_MAX) issues.error("count.out_of_range", [...path, "value"]);
      return;
    }
    case "text_list": {
      const { entries } = content as { entries?: unknown };
      if (!Array.isArray(entries)) {
        issues.error("list.not_list", [...path, "entries"]);
        return;
      }
      const { minEntries, maxEntries, entry: rule } = definition.list;
      if (entries.length < minEntries) issues.error("list.empty", [...path, "entries"]);
      if (entries.length > maxEntries) {
        issues.error("list.too_many", [...path, "entries"], `${VALIDATION_MESSAGES["list.too_many"]} The limit is ${maxEntries}.`);
      }
      const seen = new Map<string, number>();
      entries.forEach((entry: unknown, index: number) => {
        const at = [...path, "entries", index];
        if (typeof entry !== "string") return issues.error("list.entry_not_text", at);
        if (findPostgresTextProblem(entry)) return issues.error("list.entry_malformed", at);
        const trimmed = trimWhiteSpace(entry);
        if (trimmed === "" || isNormalizationEmpty(entry)) return issues.error("list.entry_blank", at);
        if (Array.from(entry).some((ch) => ch.codePointAt(0) === UNIT_SEPARATOR)) issues.error("list.entry_forbidden_character", at);
        if (rule.whitespace === "none" && Array.from(entry).some((ch) => WHITE_SPACE.has(ch.codePointAt(0) as number))) {
          issues.error("list.entry_contains_whitespace", at);
        } else if (trimmed !== entry) {
          issues.error("list.entry_untrimmed", at);
        }
        const length = codePointLength(trimmed);
        if (length < rule.minLength) issues.error("list.entry_too_short", at, `${VALIDATION_MESSAGES["list.entry_too_short"]} Use at least ${rule.minLength} characters.`);
        if (length > rule.maxLength) issues.error("list.entry_too_long", at, `${VALIDATION_MESSAGES["list.entry_too_long"]} The limit is ${rule.maxLength} characters.`);
        const first = seen.get(trimmed);
        if (first !== undefined) issues.error("list.entry_duplicate", at);
        else seen.set(trimmed, index);
      });
      return;
    }
  }
}

interface CheckedReference {
  readonly purpose: ReferencePurpose;
  readonly sourceKind: ReferenceSourceKind;
  readonly paperId: string;
  readonly quoteText: string | null;
}

function validateReference(issues: Issues, raw: unknown, index: number, context: ValueContext): CheckedReference | null {
  const path = ["references", index];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    issues.error("reference.not_object", path);
    return null;
  }
  const draft = raw as Record<string, unknown>;
  if (draft.sourceKind === "other_source") {
    issues.error("reference.other_source_deferred", [...path, "sourceKind"]);
    return null;
  }
  const purposeOk = isReferencePurpose(draft.purpose);
  const kindOk = isReferenceSourceKind(draft.sourceKind);
  if (!purposeOk) issues.error("reference.purpose_unknown", [...path, "purpose"]);
  if (!kindOk) issues.error("reference.source_kind_unknown", [...path, "sourceKind"]);
  if (!purposeOk || !kindOk) return null;
  const purpose = draft.purpose as ReferencePurpose;
  const sourceKind = draft.sourceKind as ReferenceSourceKind;

  if (SERVER_ATTESTED_KEYS.some((key) => !isAbsent(draft[key]))) issues.error("reference.server_fields_not_allowed", path);

  let link: LinkSources | undefined;
  if (!isCanonicalUuid(draft.paperId)) {
    issues.error("reference.paper_invalid", [...path, "paperId"]);
  } else {
    link = context.links.find((l) => l.paperId === (draft.paperId as string).toLowerCase());
    if (!link) issues.error("reference.paper_not_linked", [...path, "paperId"]);
  }

  const isNew = isAbsent(draft.anchorId);
  const takesSnapshot = sourceKind === "abstract" && purpose !== "unavailable";
  const takesQuote = purpose === "supports" && sourceKind === "abstract";
  const takesLocator = sourceKind === "full_text" && purpose !== "unavailable";

  // snapshot_id: required for an abstract quote and an examined abstract; nothing else names one.
  if (takesSnapshot) {
    if (!isCanonicalUuid(draft.snapshotId)) issues.error("reference.snapshot_required", [...path, "snapshotId"]);
    else if (link) {
      const snapshotId = (draft.snapshotId as string).toLowerCase();
      if (!link.snapshotIds.includes(snapshotId as SnapshotId)) issues.error("reference.snapshot_not_of_link", [...path, "snapshotId"]);
      else if (isNew && snapshotId !== link.currentSnapshotId) issues.error("reference.snapshot_not_current", [...path, "snapshotId"]);
    }
  } else if (!isAbsent(draft.snapshotId)) {
    issues.error("reference.snapshot_not_allowed", [...path, "snapshotId"]);
  }

  // An unavailable abstract names a link that has no saved copy (FK-PROOF-001 §J).
  if (purpose === "unavailable" && sourceKind === "abstract" && link && link.currentSnapshotId !== null) {
    issues.error("reference.unavailable_abstract_has_copy", path);
  }

  // Quote: abstract quotes only. Full-text references are locator-only (001A PD-3).
  let quoteText: string | null = null;
  if (takesQuote) {
    if (typeof draft.quoteText !== "string") issues.error("reference.quote_required", [...path, "quoteText"]);
    else quoteText = validateQuote(issues, draft, path, context);
  } else if (!isAbsent(draft.quoteText)) {
    issues.error("reference.quote_not_allowed", [...path, "quoteText"]);
  }
  if (!takesQuote && !isAbsent(draft.occurrence)) issues.error("reference.occurrence_not_allowed", [...path, "occurrence"]);

  // Locator: required for a supporting full-text reference, optional (both parts or none) when examined.
  if (takesLocator) {
    if (purpose === "supports" || !isAbsent(draft.locator)) validateLocator(issues, draft.locator, [...path, "locator"]);
  } else if (!isAbsent(draft.locator)) {
    issues.error("reference.locator_not_allowed", [...path, "locator"]);
  }

  return { purpose, sourceKind, paperId: String(draft.paperId).toLowerCase(), quoteText };
}

function validateQuote(issues: Issues, draft: Record<string, unknown>, path: IssuePath, context: ValueContext): string | null {
  const quoteText = draft.quoteText as string;
  const at = [...path, "quoteText"];
  if (findPostgresTextProblem(quoteText)) {
    issues.error("reference.quote_invalid", at);
    return null;
  }
  const occurrence = draft.occurrence;
  const occurrenceOk = isAbsent(occurrence) || (Number.isInteger(occurrence) && (occurrence as number) >= 1);
  if (!occurrenceOk) issues.error("reference.occurrence_out_of_range", [...path, "occurrence"]);
  const snapshotText =
    isCanonicalUuid(draft.snapshotId) ? context.copyTexts?.get((draft.snapshotId as string).toLowerCase()) : undefined;
  // Without the copy's text only the quote's own rules can be checked; the matcher needs some copy.
  const match = locateQuote(quoteText, snapshotText ?? "");
  if (match.kind === "invalid") {
    const tooLong = match.problems.includes("quote_too_long") || match.problems.includes("normalized_too_long");
    issues.error(tooLong ? "reference.quote_too_long" : "reference.quote_invalid", at);
    return null;
  }
  if (snapshotText === undefined) return quoteText;

  if (match.kind === "not_found") issues.error("reference.quote_not_found", at);
  else if (occurrenceOk && !isAbsent(occurrence) && (occurrence as number) > match.count) {
    issues.error("reference.occurrence_out_of_range", [...path, "occurrence"]);
  } else if (match.kind === "multiple" && isAbsent(occurrence)) {
    issues.error(
      "reference.quote_ambiguous",
      at,
      `This text appears ${match.count} times in the abstract. Select the one you mean, or add a few words.`,
    );
  }
  return quoteText;
}

/** A value's references, counted by purpose. */
export interface ReferencePurposeCounts {
  readonly supports: number;
  readonly examined: number;
  readonly unavailable: number;
}

export function countReferencePurposes(references: readonly { readonly purpose: ReferencePurpose }[]): ReferencePurposeCounts {
  const counts = { supports: 0, examined: 0, unavailable: 0 };
  for (const { purpose } of references) if (isReferencePurpose(purpose)) counts[purpose] += 1;
  return Object.freeze(counts);
}

/** A reference-count rule of a value's state, by the code `validateValueDraft` reports for it. */
export type StateReferenceCode =
  | "references.too_many_supporting"
  | "references.supporting_not_allowed"
  | "references.examined_required"
  | "references.examined_not_allowed"
  | "references.unavailable_required"
  | "references.unavailable_not_allowed"
  | "references.basis_required"
  | "references.not_allowed";

// No state requires a supporting source (VALUE_STATE_RULES), so it has no "required" code.
const PURPOSE_RULE_CODES = [
  { purpose: "supports", required: null, forbidden: "references.supporting_not_allowed" },
  { purpose: "examined", required: "references.examined_required", forbidden: "references.examined_not_allowed" },
  { purpose: "unavailable", required: "references.unavailable_required", forbidden: "references.unavailable_not_allowed" },
] as const;

/**
 * The reference-count rules of `state` that `counts` break: PR-A1's cap of
 * three supporting references (positions 0-2), then FK-PROOF-001 §J as
 * `VALUE_STATE_RULES` holds it — a purpose the state forbids, a purpose it
 * requires, and Unclear's "at least one supporting or examined source". A
 * state that takes no source at all says so once. This is the one statement
 * of these rules for both `validateValueDraft` and `checkConfirm`, so a value
 * whose sources break its state is refused by both. Codes come in a fixed
 * order: the cap, supporting, examined, unavailable, then the Unclear minimum.
 */
export function checkStateReferences(state: ValueState, counts: ReferencePurposeCounts): readonly StateReferenceCode[] {
  const rule = VALUE_STATE_RULES[state];
  const codes: StateReferenceCode[] = [];
  if (counts.supports > MAX_SUPPORTING_REFERENCES) codes.push("references.too_many_supporting");
  if (PURPOSE_RULE_CODES.every(({ purpose }) => rule[purpose].max === 0)) {
    if (counts.supports + counts.examined + counts.unavailable > 0) codes.push("references.not_allowed");
  } else {
    for (const { purpose, required, forbidden } of PURPOSE_RULE_CODES) {
      if (rule[purpose].max === 0 && counts[purpose] > 0) codes.push(forbidden);
      else if (required !== null && counts[purpose] < rule[purpose].min) codes.push(required);
    }
    if (counts.supports + counts.examined < rule.supportsOrExaminedMin) codes.push("references.basis_required");
  }
  return Object.freeze(codes);
}

function validateReferencesForState(issues: Issues, state: ValueState, references: readonly CheckedReference[]): void {
  for (const code of checkStateReferences(state, countReferencePurposes(references))) issues.error(code, ["references"]);

  // One assessment (examined or unavailable) per report and source kind.
  const assessed = new Set<string>();
  references.forEach((reference, index) => {
    if (reference.purpose === "supports") return;
    const key = `${reference.paperId}|${reference.sourceKind}`;
    if (assessed.has(key)) issues.error("references.duplicate_assessment", ["references", index]);
    assessed.add(key);
  });
}

function validateNote(issues: Issues, state: ValueState, note: unknown): void {
  if (!isAbsent(note)) checkFreeText(issues, note, ["note"], VALUE_NOTE_MAX_LENGTH, NOTE_CODES);
  // The CHECK measures char_length(btrim(note)) — spaces only — so this does too.
  const measured = typeof note === "string" ? codePointLength(btrimSpaces(note)) : 0;
  if (state === "unclear" && measured < UNCLEAR_NOTE_MIN_LENGTH) issues.error("note.required_for_unclear", ["note"]);
  if (state === "not_applicable" && measured < NOT_APPLICABLE_NOTE_MIN_LENGTH) {
    issues.error("note.required_for_not_applicable", ["note"]);
  }
}

function validateTarget(issues: Issues, key: FieldKey, context: ValueContext): void {
  const definition: FieldDefinition = EVIDENCE_FIELDS[key];
  if (definition.scope !== context.target.scope) {
    issues.error("field.wrong_scope", ["fieldKey"]);
    return;
  }
  if (!isFieldAllowedForDesign(key, context.designProfile)) issues.error("field.not_allowed_for_design", ["fieldKey"]);
  if (context.target.scope === "arm" && !isFieldAllowedForArmRole(key as ArmFieldKey, context.target.armRole)) {
    issues.error("field.not_allowed_for_arm_role", ["fieldKey"]);
  }
}

function contextIsUsable(context: ValueContext): boolean {
  if (!context || typeof context !== "object" || !isDesignProfile(context.designProfile) || !Array.isArray(context.links)) return false;
  const { target } = context;
  if (!target || (target.scope !== "study" && target.scope !== "outcome" && target.scope !== "arm")) return false;
  return target.scope !== "arm" || isArmRole(target.armRole);
}

/**
 * Validate one drafted value in its context. Deterministic: issues come in a
 * fixed order — field, state, value, reason, note, references, then warnings.
 */
export function validateValueDraft(draft: ValueDraft, context: ValueContext): ValidationResult {
  const issues = new Issues();
  if (!contextIsUsable(context)) {
    issues.error("context.invalid", []);
    return issues.result();
  }

  const key = draft?.fieldKey;
  const knownKey = isFieldKey(key);
  if (!knownKey) issues.error("field.unknown", ["fieldKey"]);
  else validateTarget(issues, key, context);

  const state = draft?.state;
  if (!isValueState(state)) {
    issues.error("state.unknown", ["state"]);
    return issues.result();
  }

  // "Reported" if and only if a value is present (PR-A1 value_presence_check).
  const content = draft.content;
  if (state === "reported") {
    if (isAbsent(content)) issues.error("value.required", ["content"]);
    else if (knownKey) validateContent(issues, EVIDENCE_FIELDS[key], content);
  } else if (!isAbsent(content)) {
    issues.error("value.not_allowed", ["content"]);
  }

  // A reason exactly when the state is Unclear (state_reason_check).
  const reason = draft.stateReason;
  if (state === "unclear") {
    if (isAbsent(reason)) issues.error("state_reason.required", ["stateReason"]);
    else if (!isStateReason(reason)) issues.error("state_reason.unknown", ["stateReason"]);
  } else if (!isAbsent(reason)) {
    issues.error("state_reason.not_allowed", ["stateReason"]);
  }

  validateNote(issues, state, draft.note);

  const rawReferences: unknown = draft.references ?? [];
  if (!Array.isArray(rawReferences)) {
    issues.error("references.not_list", ["references"]);
    return issues.result();
  }
  const checked = rawReferences.flatMap((raw: unknown, index: number) => {
    const reference = validateReference(issues, raw, index, context);
    return reference ? [reference] : [];
  });
  validateReferencesForState(issues, state, checked);

  // Derived warnings — never blocking.
  if (state === "reported" && !checked.some((r) => r.purpose === "supports")) issues.warning("value.no_source_given", ["references"]);
  if (state === "reported" && knownKey && EVIDENCE_FIELDS[key].shape === "integer_with_reported_text") {
    const value = (content as { value?: unknown } | null)?.value;
    const quotes = checked.flatMap((r) => (r.quoteText !== null ? [r.quoteText] : []));
    if (typeof value === "number" && Number.isInteger(value) && quotes.length > 0) {
      const check = checkCountInQuote(value, quotes);
      if (check.kind === "warning") issues.warning("count.digits_absent_from_quote", ["content", "value"], check.message);
    }
  }
  return issues.result();
}
