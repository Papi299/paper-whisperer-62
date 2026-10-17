/**
 * Rows of the eight evidence tables, mapped onto the domain models
 * (EVIDENCE-RECORDS-001B).
 *
 * Each mapper takes the GENERATED row type, so a renamed or retyped column
 * breaks the typecheck here instead of drifting silently. Each also re-checks
 * at runtime what the schema guarantees — closed vocabularies, the value shape
 * of the field, "reported if and only if a value is present", the source-
 * reference matrix — and fails closed: a row that does not satisfy them is
 * reported with its problems, never coerced into plausible evidence. Rows the
 * deployed schema wrote always pass; a failure means a response that cannot be
 * trusted (a schema this code does not know, or a malformed reply).
 *
 * Problem strings name a column and never echo its content.
 */

import type { Database } from "@/integrations/supabase/types";
import { EVIDENCE_FIELDS, isArmRole, isDesignProfile, isFieldKey, type FieldDefinition } from "./fieldDictionary";
import {
  toAnchorId,
  toArmId,
  toEventId,
  toLinkId,
  toOutcomeId,
  toPaperId,
  toRequestId,
  toSnapshotId,
  toStudyId,
  toStudyVersion,
  toValueId,
  toValueVersion,
  type ValueId,
} from "./ids";
import { codePointLength, type CodePointOffset } from "./normalization";
import {
  isEventType,
  isLinkBasis,
  isLinkStatus,
  isLocatorKind,
  isReferencePurpose,
  isReferenceSourceKind,
  isRequestOp,
  isReviewReason,
  isReviewStatus,
  isStateReason,
  isValueState,
  type Arm,
  type FieldContent,
  type FullTextLocator,
  type HistoryEvent,
  type Outcome,
  type RecordedValue,
  type SourceSnapshot,
  type StoredReference,
  type StudyHeader,
  type StudyReportLink,
  type ValueTarget,
} from "./types";

type Row<T extends keyof Database["public"]["Tables"]> = Database["public"]["Tables"][T]["Row"];

export type MapResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly problems: readonly string[] };

function done<T>(problems: string[], build: () => T): MapResult<T> {
  return problems.length > 0
    ? { ok: false, problems: Object.freeze(problems) }
    : { ok: true, value: Object.freeze(build()) };
}

const isString = (value: unknown): value is string => typeof value === "string";
const isNat = (value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;

export function mapStudyRow(row: Row<"evidence_studies">): MapResult<StudyHeader> {
  const problems: string[] = [];
  const id = toStudyId(row.id);
  const version = toStudyVersion(row.row_version);
  if (!id) problems.push("id");
  if (!isString(row.label)) problems.push("label");
  if (!isDesignProfile(row.design_profile)) problems.push("design_profile");
  if (row.notes !== null && !isString(row.notes)) problems.push("notes");
  if (!version) problems.push("row_version");
  if (!isString(row.created_at)) problems.push("created_at");
  if (!isString(row.updated_at)) problems.push("updated_at");
  return done(problems, () => ({
    id: id!,
    label: row.label,
    designProfile: row.design_profile as StudyHeader["designProfile"],
    notes: row.notes,
    version: version!,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export function mapStudyReportRow(row: Row<"evidence_study_reports">): MapResult<StudyReportLink> {
  const problems: string[] = [];
  const id = toLinkId(row.id);
  const studyId = toStudyId(row.study_id);
  const paperId = toPaperId(row.paper_id);
  if (!id) problems.push("id");
  if (!studyId) problems.push("study_id");
  if (!paperId) problems.push("paper_id");
  if (!isLinkStatus(row.link_status)) problems.push("link_status");
  if (!isLinkBasis(row.link_basis)) problems.push("link_basis");
  return done(problems, () => ({
    id: id!,
    studyId: studyId!,
    paperId: paperId!,
    status: row.link_status as StudyReportLink["status"],
    basis: row.link_basis as StudyReportLink["basis"],
  }));
}

export function mapSourceSnapshotRow(row: Row<"evidence_source_snapshots">): MapResult<SourceSnapshot> {
  const problems: string[] = [];
  const id = toSnapshotId(row.id);
  const studyId = toStudyId(row.study_id);
  const paperId = toPaperId(row.paper_id);
  if (!id) problems.push("id");
  if (!studyId) problems.push("study_id");
  if (!paperId) problems.push("paper_id");
  if (!isNat(row.seq, 1)) problems.push("seq");
  if (row.source_kind !== "library_abstract") problems.push("source_kind");
  if (!isString(row.exact_text) || row.exact_text.length === 0) problems.push("exact_text");
  else if (row.char_count !== codePointLength(row.exact_text)) problems.push("char_count");
  if (row.normalization_version !== "v1") problems.push("normalization_version");
  if (!isString(row.captured_at)) problems.push("captured_at");
  return done(problems, () => ({
    id: id!,
    studyId: studyId!,
    paperId: paperId!,
    seq: row.seq,
    sourceKind: "library_abstract" as const,
    exactText: row.exact_text,
    charCount: row.char_count,
    normalizationVersion: "v1" as const,
    capturedAt: row.captured_at,
  }));
}

export function mapArmRow(row: Row<"evidence_arms">): MapResult<Arm> {
  const problems: string[] = [];
  const id = toArmId(row.id);
  const studyId = toStudyId(row.study_id);
  if (!id) problems.push("id");
  if (!studyId) problems.push("study_id");
  if (!isArmRole(row.arm_role)) problems.push("arm_role");
  if (!isString(row.display_label)) problems.push("display_label");
  if (!isNat(row.position, 0, 99)) problems.push("position");
  return done(problems, () => ({
    id: id!,
    studyId: studyId!,
    role: row.arm_role as Arm["role"],
    displayLabel: row.display_label,
    position: row.position,
  }));
}

export function mapOutcomeRow(row: Row<"evidence_outcomes">): MapResult<Outcome> {
  const problems: string[] = [];
  const id = toOutcomeId(row.id);
  const studyId = toStudyId(row.study_id);
  if (!id) problems.push("id");
  if (!studyId) problems.push("study_id");
  if (!isString(row.display_label)) problems.push("display_label");
  if (!isNat(row.position, 0, 99)) problems.push("position");
  return done(problems, () => ({ id: id!, studyId: studyId!, displayLabel: row.display_label, position: row.position }));
}

const MATCH_COLUMNS = ["quote_text", "match_start", "match_end", "match_occurrence", "match_count", "normalization_version", "matched_at"] as const;

/** One source reference, and the value it belongs to. */
export function mapFieldAnchorRow(
  row: Row<"evidence_field_anchors">,
): MapResult<{ readonly valueId: ValueId; readonly reference: StoredReference }> {
  const problems: string[] = [];
  const id = toAnchorId(row.id);
  const valueId = toValueId(row.value_id);
  const paperId = toPaperId(row.paper_id);
  if (!id) problems.push("id");
  if (!valueId) problems.push("value_id");
  if (!paperId) problems.push("paper_id");
  const purposeOk = isReferencePurpose(row.purpose);
  const kindOk = isReferenceSourceKind(row.source_kind);
  if (!purposeOk) problems.push("purpose");
  if (!kindOk) problems.push("source_kind");
  if (!purposeOk || !kindOk) return { ok: false, problems: Object.freeze(problems) };

  const supports = row.purpose === "supports";
  const quote = supports && row.source_kind === "abstract";
  const snapshotId = toSnapshotId(row.snapshot_id);
  const takesSnapshot = row.source_kind === "abstract" && row.purpose !== "unavailable";
  if (takesSnapshot ? !snapshotId : row.snapshot_id !== null) problems.push("snapshot_id");
  if (supports ? !isNat(row.position, 0, 2) : row.position !== null) problems.push("position");

  const matchValues = MATCH_COLUMNS.map((column) => row[column]);
  if (quote) {
    const valid =
      isString(row.quote_text) &&
      codePointLength(row.quote_text) >= 3 &&
      codePointLength(row.quote_text) <= 1000 &&
      isNat(row.match_start, 0) &&
      isNat(row.match_end, row.match_start + 1) &&
      isNat(row.match_occurrence, 1) &&
      isNat(row.match_count, row.match_occurrence) &&
      row.normalization_version === "v1" &&
      isString(row.matched_at);
    if (!valid) problems.push("match");
  } else if (matchValues.some((v) => v !== null)) {
    problems.push("match");
  }

  const hasLocator = row.locator_kind !== null || row.locator_text !== null;
  const locatorValid = isLocatorKind(row.locator_kind) && isString(row.locator_text);
  const locatorRule =
    supports && row.source_kind === "full_text" ? "required" : row.purpose === "examined" && row.source_kind === "full_text" ? "optional" : "none";
  if (locatorRule === "required" && !locatorValid) problems.push("locator");
  if (locatorRule === "optional" && hasLocator && !locatorValid) problems.push("locator");
  if (locatorRule === "none" && hasLocator) problems.push("locator");

  return done(problems, () => {
    const locator: FullTextLocator | null = locatorValid
      ? Object.freeze({ kind: row.locator_kind as FullTextLocator["kind"], text: row.locator_text as string })
      : null;
    const base = { id: id!, paperId: paperId! };
    let reference: StoredReference;
    if (row.purpose === "supports" && row.source_kind === "abstract") {
      reference = {
        ...base,
        purpose: "supports",
        sourceKind: "abstract",
        snapshotId: snapshotId!,
        position: row.position as number,
        quoteText: row.quote_text as string,
        match: Object.freeze({
          attestation: "server" as const,
          normalizedStart: row.match_start as CodePointOffset,
          normalizedEnd: row.match_end as CodePointOffset,
          occurrence: row.match_occurrence as number,
          count: row.match_count as number,
          normalizationVersion: "v1" as const,
          matchedAt: row.matched_at as string,
        }),
      };
    } else if (row.purpose === "supports") {
      reference = { ...base, purpose: "supports", sourceKind: "full_text", position: row.position as number, locator: locator! };
    } else if (row.purpose === "examined" && row.source_kind === "abstract") {
      reference = { ...base, purpose: "examined", sourceKind: "abstract", snapshotId: snapshotId! };
    } else if (row.purpose === "examined") {
      reference = { ...base, purpose: "examined", sourceKind: "full_text", locator };
    } else {
      reference = { ...base, purpose: "unavailable", sourceKind: row.source_kind as StoredReference["sourceKind"] };
    }
    return { valueId: valueId!, reference: Object.freeze(reference) };
  });
}

function contentOf(definition: FieldDefinition, row: Row<"evidence_field_values">, problems: string[]): FieldContent | null {
  const present = {
    text: row.value_text !== null,
    code: row.value_code !== null,
    int: row.value_int !== null,
    list: row.value_list !== null,
  };
  const only = (...keys: (keyof typeof present)[]) =>
    (Object.keys(present) as (keyof typeof present)[]).every((k) => present[k] === keys.includes(k));
  switch (definition.shape) {
    case "text":
      if (!only("text") || !isString(row.value_text)) break;
      return { shape: "text", text: row.value_text };
    case "code":
      if (!only("code") || !isString(row.value_code) || !definition.codes.includes(row.value_code)) break;
      return { shape: "code", code: row.value_code };
    case "integer_with_reported_text":
      if (!only("text", "int") || !isString(row.value_text) || !isNat(row.value_int, definition.integer.min, definition.integer.max)) break;
      return { shape: "integer_with_reported_text", reportedText: row.value_text, value: row.value_int };
    case "text_list":
      if (!only("list") || !Array.isArray(row.value_list) || !row.value_list.every(isString)) break;
      return { shape: "text_list", entries: Object.freeze([...row.value_list]) };
  }
  problems.push("value");
  return null;
}

/** One recorded value, with the references already mapped for it. */
export function mapFieldValueRow(row: Row<"evidence_field_values">, references: readonly StoredReference[]): MapResult<RecordedValue> {
  const problems: string[] = [];
  const id = toValueId(row.id);
  const studyId = toStudyId(row.study_id);
  const valueVersion = toValueVersion(row.value_version);
  if (!id) problems.push("id");
  if (!studyId) problems.push("study_id");
  if (!valueVersion) problems.push("value_version");

  let target: ValueTarget | null = null;
  const armId = row.arm_id === null ? null : toArmId(row.arm_id);
  const outcomeId = row.outcome_id === null ? null : toOutcomeId(row.outcome_id);
  if ((row.arm_id !== null && !armId) || (row.outcome_id !== null && !outcomeId) || (armId && outcomeId)) problems.push("target");
  else target = armId ? { scope: "arm", armId } : outcomeId ? { scope: "outcome", outcomeId } : { scope: "study" };

  const keyOk = isFieldKey(row.field_key);
  if (!keyOk) problems.push("field_key");
  else if (target && EVIDENCE_FIELDS[row.field_key as keyof typeof EVIDENCE_FIELDS].scope !== target.scope) problems.push("field_key");
  const stateOk = isValueState(row.value_state);
  if (!stateOk) problems.push("value_state");

  let content: FieldContent | null = null;
  if (stateOk && row.value_state === "reported") {
    if (keyOk) content = contentOf(EVIDENCE_FIELDS[row.field_key as keyof typeof EVIDENCE_FIELDS], row, problems);
  } else if ([row.value_text, row.value_code, row.value_int, row.value_list].some((v) => v !== null)) {
    problems.push("value");
  }

  const unclear = row.value_state === "unclear";
  if (unclear ? !isStateReason(row.state_reason) : row.state_reason !== null) problems.push("state_reason");
  if (row.note !== null && !isString(row.note)) problems.push("note");
  if (row.extraction_method !== "manual") problems.push("extraction_method");

  const statusOk = isReviewStatus(row.review_status);
  if (!statusOk) problems.push("review_status");
  const reviewed = row.review_status === "user_reviewed";
  const reviewedVersion = row.reviewed_version === null ? null : toValueVersion(row.reviewed_version);
  if (reviewed ? !isString(row.reviewed_at) || reviewedVersion === null || reviewedVersion !== row.value_version : row.reviewed_at !== null || row.reviewed_version !== null) {
    problems.push("reviewed");
  }
  if (row.review_status === "needs_rereview" ? !isReviewReason(row.review_reason) : row.review_reason !== null) problems.push("review_reason");
  if (row.review_note !== null && !isString(row.review_note)) problems.push("review_note");

  return done(problems, () => ({
    id: id!,
    studyId: studyId!,
    target: target!,
    fieldKey: row.field_key as RecordedValue["fieldKey"],
    state: row.value_state as RecordedValue["state"],
    stateReason: row.state_reason as RecordedValue["stateReason"],
    content: content === null ? null : Object.freeze(content),
    note: row.note,
    extractionMethod: "manual" as const,
    review: Object.freeze({
      status: row.review_status as RecordedValue["review"]["status"],
      reason: row.review_reason as RecordedValue["review"]["reason"],
      note: row.review_note,
      reviewedAt: row.reviewed_at,
      reviewedVersion,
    }),
    valueVersion: valueVersion!,
    references: Object.freeze([...references]),
  }));
}

export function mapEventRow(row: Row<"evidence_events">): MapResult<HistoryEvent> {
  const problems: string[] = [];
  const id = toEventId(row.id);
  const studyId = toStudyId(row.study_id);
  const studyVersion = toStudyVersion(row.study_version);
  const requestId = toRequestId(row.request_id);
  if (!id) problems.push("id");
  if (!studyId) problems.push("study_id");
  if (!studyVersion) problems.push("study_version");
  if (!requestId) problems.push("request_id");
  if (!isNat(row.ordinal, 0)) problems.push("ordinal");
  if (!isEventType(row.event_type) || (row.ordinal === 0) !== (row.event_type === "request")) problems.push("event_type");
  if (row.ordinal === 0 ? !isRequestOp(row.op) : row.op !== null) problems.push("op");
  if (!isString(row.occurred_at)) problems.push("occurred_at");
  return done(problems, () => ({
    id: id!,
    studyId: studyId!,
    studyVersion: studyVersion!,
    ordinal: row.ordinal,
    type: row.event_type as HistoryEvent["type"],
    requestId: requestId!,
    op: row.op as HistoryEvent["op"],
    targetId: row.target_id,
    fieldKey: row.field_key,
    before: row.before,
    after: row.after,
    occurredAt: row.occurred_at,
  }));
}
