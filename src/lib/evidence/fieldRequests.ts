/**
 * Requests for the three PR-A3 RPCs, prepared and validated
 * (EVIDENCE-RECORDS-001A3; `20261017155445`; docs/evidence-records-field-operations.md).
 *
 * The contract of `lifecycleRequests.ts` holds here too: a prepared request is
 * a frozen object holding the RPC's exact arguments — the parameter names of
 * the generated Supabase function types — including the caller's request id
 * and the versions it was prepared against. Resending the SAME object is how a
 * retry of the same user action is made; a different action, including the
 * same edit after a version conflict, needs a new request id.
 *
 *   * `evidence_save_changes` — one atomic batch of group, outcome and value
 *     changes. `prepareSaveChanges` turns typed changes into the server's wire
 *     format (snake_case keys, every key present, JSON null where the server
 *     allows it) and refuses what can be refused without the study: shapes,
 *     ids, batch refs, the closed vocabularies, labels and positions. The
 *     value rules that need the study — design family, group role, links,
 *     current copies, quote matching, list hygiene — are `validateValueDraft`'s
 *     to advise and the server's to decide.
 *   * `evidence_review_fields` — Confirm or Flag ONE value at ONE version.
 *     There is no array: no request can confirm two values.
 *   * `evidence_rebase_source` — save a new copy of a linked paper's abstract.
 *     The caller sends the SHA-256 of the abstract it displayed; computing it
 *     needs a crypto API, which this library does not use.
 *
 * Nothing here can name a match offset, the server's match count, a matched or
 * reviewed time, a fingerprint, a history row or a user: the wire format has no
 * key for any of them, and the server refuses one as forged. The
 * `expectedMatchCount` of a quote is what the user SAW; the server compares it
 * with its own count and refuses the quote as ambiguous when they differ.
 */

import type { Database, Json } from "@/integrations/supabase/types";
import { EVIDENCE_FIELDS, isArmRole, isFieldKey, type ArmRole, type FieldKey } from "./fieldDictionary";
import {
  MAX_POSTGRES_INTEGER,
  toAnchorId,
  toArmId,
  toOutcomeId,
  toPaperId,
  toRequestId,
  toSnapshotId,
  toStudyId,
  toStudyVersion,
  toValueId,
  toValueVersion,
  type PaperId,
  type RequestId,
  type StudyId,
  type ValueId,
} from "./ids";
import type { Prepared } from "./lifecycleRequests";
import { codePointLength, findPostgresTextProblem, isNormalizationEmpty } from "./normalization";
import { FLAG_NOTE_MIN_LENGTH } from "./review";
import {
  isLocatorKind,
  isReferencePurpose,
  isReferenceSourceKind,
  isStateReason,
  isValueState,
  type FieldContent,
  type FullTextLocator,
  type ReferenceSourceKind,
  type StateReason,
  type ValueState,
} from "./types";
import { btrimSpaces, VALIDATION_MESSAGES, VALUE_NOTE_MAX_LENGTH, type IssuePath, type ValidationCode, type ValidationIssue } from "./validation";

/** The three PR-A3 client RPCs, in the order the migration creates them. */
export const EVIDENCE_FIELD_RPCS = ["evidence_save_changes", "evidence_review_fields", "evidence_rebase_source"] as const;
export type EvidenceFieldRpc = (typeof EVIDENCE_FIELD_RPCS)[number];

/**
 * The draft PR-A3 limits (Requirements-001 Q11), as the server enforces them.
 * Mirrored for early refusal and for messages; the server's answer stands.
 */
export const EVIDENCE_FIELD_LIMITS = Object.freeze({
  changesPerSave: 200,
  /** Measured by the server as the jsonb text of `p_changes`, in bytes. */
  saveBytes: 65_536,
  armsPerStudy: 20,
  outcomesPerStudy: 50,
  valuesPerStudy: 400,
  copiesPerLink: 20,
  /** Examined and unavailable references per value. */
  assessmentsPerValue: 10,
  supportingPerValue: 3,
  occurrencesPerQuote: 100,
  /** Kept from PR-A1/PR-A2. */
  eventsPerStudy: 5_000,
});

export const ARM_LABEL_MAX_LENGTH = 120;
export const OUTCOME_LABEL_MAX_LENGTH = 200;
export const POSITION_MAX = 99;
const BATCH_REF = /^[A-Za-z0-9_-]{1,64}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

type Functions = Database["public"]["Functions"];

export type SaveChangesArgs = Functions["evidence_save_changes"]["Args"];
/**
 * The generated type lists `p_note` as a non-null string; Confirm takes NULL
 * for "no note". As in `lifecycleRequests.ts`, only that parameter is widened.
 */
export type ReviewFieldsArgs = Omit<Functions["evidence_review_fields"]["Args"], "p_note"> & { p_note: string | null };
export type RebaseSourceArgs = Functions["evidence_rebase_source"]["Args"];

// ── Typed changes ────────────────────────────────────────────────────────────

/** What a value change describes. A `*Ref` names a group or outcome added in the same batch. */
export type ChangeTarget =
  | { readonly scope: "study" }
  | { readonly scope: "arm"; readonly armId: string }
  | { readonly scope: "arm"; readonly armRef: string }
  | { readonly scope: "outcome"; readonly outcomeId: string }
  | { readonly scope: "outcome"; readonly outcomeRef: string };

/**
 * One reference of a value's COMPLETE new set. `{ anchorId }` keeps an existing
 * reference exactly as stored; anything else is new. A new abstract quote with
 * several occurrences names the 1-based `occurrence` the user chose AND the
 * `expectedMatchCount` they saw; with one occurrence both may be null.
 */
export type ReferenceChange =
  | { readonly anchorId: string }
  | {
      readonly purpose: "supports";
      readonly sourceKind: "abstract";
      readonly paperId: string;
      readonly snapshotId: string;
      readonly quoteText: string;
      readonly occurrence: number | null;
      readonly expectedMatchCount: number | null;
    }
  | { readonly purpose: "supports"; readonly sourceKind: "full_text"; readonly paperId: string; readonly locator: FullTextLocator }
  | { readonly purpose: "examined"; readonly sourceKind: "abstract"; readonly paperId: string; readonly snapshotId: string }
  | { readonly purpose: "examined"; readonly sourceKind: "full_text"; readonly paperId: string; readonly locator: FullTextLocator | null }
  | { readonly purpose: "unavailable"; readonly sourceKind: ReferenceSourceKind; readonly paperId: string };

export type SaveChange =
  | { readonly op: "add_arm"; readonly ref: string; readonly armRole: ArmRole; readonly displayLabel: string; readonly position: number }
  | { readonly op: "update_arm"; readonly armId: string; readonly armRole: ArmRole; readonly displayLabel: string; readonly position: number }
  | { readonly op: "remove_arm"; readonly armId: string }
  | { readonly op: "add_outcome"; readonly ref: string; readonly displayLabel: string; readonly position: number }
  | { readonly op: "update_outcome"; readonly outcomeId: string; readonly displayLabel: string; readonly position: number }
  | { readonly op: "remove_outcome"; readonly outcomeId: string }
  | {
      readonly op: "set_value";
      readonly target: ChangeTarget;
      readonly fieldKey: FieldKey;
      /** The `value_version` on screen; null for a field not yet recorded. */
      readonly expectedValueVersion: number | null;
      readonly state: ValueState;
      readonly stateReason: StateReason | null;
      readonly content: FieldContent | null;
      readonly note: string | null;
      readonly references: readonly ReferenceChange[];
    }
  | { readonly op: "clear_value"; readonly target: ChangeTarget; readonly fieldKey: FieldKey; readonly expectedValueVersion: number };

// ── Requests ─────────────────────────────────────────────────────────────────

interface RequestBase<Op extends string, Rpc extends EvidenceFieldRpc, Args> {
  readonly op: Op;
  readonly functionName: Rpc;
  readonly requestId: RequestId;
  readonly studyId: StudyId;
  readonly expectedVersion: number;
  readonly args: Readonly<Args>;
}

export type SaveChangesRequest = RequestBase<"save_changes", "evidence_save_changes", SaveChangesArgs> & {
  /** The batch refs of the groups and of the outcomes this request adds, in order. */
  readonly armRefs: readonly string[];
  readonly outcomeRefs: readonly string[];
};
export type ReviewAction = "confirm" | "flag";
export type ReviewFieldRequest = RequestBase<"review_fields", "evidence_review_fields", ReviewFieldsArgs> & {
  readonly valueId: ValueId;
  readonly expectedValueVersion: number;
  readonly action: ReviewAction;
};
export type RebaseSourceRequest = RequestBase<"rebase_source", "evidence_rebase_source", RebaseSourceArgs> & {
  readonly paperId: PaperId;
};
export type FieldRequest = SaveChangesRequest | ReviewFieldRequest | RebaseSourceRequest;

class Issues {
  readonly list: ValidationIssue[] = [];
  add(code: ValidationCode, path: IssuePath) {
    this.list.push(Object.freeze({ code, path: Object.freeze([...path]), severity: "error", message: VALIDATION_MESSAGES[code] }));
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function finish<R>(issues: Issues, build: () => R): Prepared<R> {
  if (issues.list.length > 0) return { ok: false, issues: Object.freeze(issues.list) };
  return { ok: true, request: deepFreeze(build()) };
}

function envelope(issues: Issues, input: { readonly studyId: unknown; readonly expectedVersion: unknown; readonly requestId: unknown }) {
  const studyId = toStudyId(input.studyId);
  const version = toStudyVersion(input.expectedVersion);
  if (!studyId) issues.add("request.study_id_invalid", ["studyId"]);
  if (!version) issues.add("request.expected_version_invalid", ["expectedVersion"]);
  const requestId = toRequestId(input.requestId);
  if (!requestId) issues.add("request.request_id_invalid", ["requestId"]);
  return { studyId, version, requestId };
}

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]) => {
  const present = Object.keys(value).sort();
  return present.length === keys.length && [...keys].sort().every((key, i) => key === present[i]);
};
const isPosition = (value: unknown) => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= POSITION_MAX;
const isPositiveInteger = (value: unknown) => Number.isInteger(value) && (value as number) >= 1 && (value as number) <= MAX_POSTGRES_INTEGER;
/** Well formed, not blank after v1, at most `max` characters. */
const isUsableText = (value: unknown, max: number) =>
  typeof value === "string" && !findPostgresTextProblem(value) && !isNormalizationEmpty(value) && codePointLength(value) <= max;

const CHANGE_KEYS: Readonly<Record<SaveChange["op"], readonly string[]>> = Object.freeze({
  add_arm: ["op", "ref", "armRole", "displayLabel", "position"],
  update_arm: ["op", "armId", "armRole", "displayLabel", "position"],
  remove_arm: ["op", "armId"],
  add_outcome: ["op", "ref", "displayLabel", "position"],
  update_outcome: ["op", "outcomeId", "displayLabel", "position"],
  remove_outcome: ["op", "outcomeId"],
  set_value: ["op", "target", "fieldKey", "expectedValueVersion", "state", "stateReason", "content", "note", "references"],
  clear_value: ["op", "target", "fieldKey", "expectedValueVersion"],
});

type Wire = { [key: string]: Json };

interface BatchState {
  readonly armRefs: string[];
  readonly outcomeRefs: string[];
  readonly armIds: Set<string>;
  readonly outcomeIds: Set<string>;
  readonly removedArms: Set<string>;
  readonly removedOutcomes: Set<string>;
  readonly targets: Set<string>;
}

function wireTarget(issues: Issues, raw: unknown, path: IssuePath): { wire: Wire; key: string; scope: string } | null {
  if (!isObject(raw)) {
    issues.add("request.change_invalid", [...path, "target"]);
    return null;
  }
  const at = [...path, "target"];
  if (raw.scope === "study" && hasExactKeys(raw, ["scope"])) return { wire: { scope: "study" }, key: "study", scope: "study" };
  if (raw.scope === "arm" && hasExactKeys(raw, ["scope", "armId"])) {
    const id = toArmId(raw.armId);
    if (id) return { wire: { scope: "arm", arm_id: id }, key: `arm:${id}`, scope: "arm" };
  }
  if (raw.scope === "arm" && hasExactKeys(raw, ["scope", "armRef"]) && typeof raw.armRef === "string" && BATCH_REF.test(raw.armRef)) {
    return { wire: { scope: "arm", arm_ref: raw.armRef }, key: `arm_ref:${raw.armRef}`, scope: "arm" };
  }
  if (raw.scope === "outcome" && hasExactKeys(raw, ["scope", "outcomeId"])) {
    const id = toOutcomeId(raw.outcomeId);
    if (id) return { wire: { scope: "outcome", outcome_id: id }, key: `outcome:${id}`, scope: "outcome" };
  }
  if (raw.scope === "outcome" && hasExactKeys(raw, ["scope", "outcomeRef"]) && typeof raw.outcomeRef === "string" && BATCH_REF.test(raw.outcomeRef)) {
    return { wire: { scope: "outcome", outcome_ref: raw.outcomeRef }, key: `outcome_ref:${raw.outcomeRef}`, scope: "outcome" };
  }
  issues.add("request.change_invalid", at);
  return null;
}

function wireContent(issues: Issues, fieldKey: FieldKey, raw: unknown, path: IssuePath): Json {
  const shape = EVIDENCE_FIELDS[fieldKey].shape;
  const at = [...path, "content"];
  if (!isObject(raw) || raw.shape !== shape) {
    issues.add("value.wrong_shape", at);
    return null;
  }
  switch (shape) {
    case "text":
      if (!hasExactKeys(raw, ["shape", "text"]) || typeof raw.text !== "string") break;
      return { shape, text: raw.text };
    case "code":
      if (!hasExactKeys(raw, ["shape", "code"]) || typeof raw.code !== "string") break;
      return { shape, code: raw.code };
    case "integer_with_reported_text":
      if (!hasExactKeys(raw, ["shape", "reportedText", "value"]) || typeof raw.reportedText !== "string" || !Number.isInteger(raw.value)) break;
      return { shape, reported_text: raw.reportedText, value: raw.value as number };
    case "text_list":
      if (!hasExactKeys(raw, ["shape", "entries"]) || !Array.isArray(raw.entries) || !raw.entries.every((e) => typeof e === "string")) break;
      return { shape, entries: [...(raw.entries as string[])] };
  }
  issues.add("value.wrong_shape", at);
  return null;
}

function wireReference(issues: Issues, raw: unknown, path: IssuePath): Json {
  if (!isObject(raw)) {
    issues.add("reference.not_object", path);
    return null;
  }
  if ("anchorId" in raw) {
    const anchorId = toAnchorId(raw.anchorId);
    if (!hasExactKeys(raw, ["anchorId"]) || !anchorId) {
      issues.add("request.change_invalid", path);
      return null;
    }
    return { anchor_id: anchorId };
  }
  if (!isReferencePurpose(raw.purpose)) {
    issues.add("reference.purpose_unknown", [...path, "purpose"]);
    return null;
  }
  if (!isReferenceSourceKind(raw.sourceKind)) {
    issues.add("reference.source_kind_unknown", [...path, "sourceKind"]);
    return null;
  }
  const { purpose, sourceKind } = raw;
  const paperId = toPaperId(raw.paperId);
  if (!paperId) issues.add("reference.paper_invalid", [...path, "paperId"]);
  const snapshotId = () => {
    const id = toSnapshotId(raw.snapshotId);
    if (!id) issues.add("reference.snapshot_required", [...path, "snapshotId"]);
    return id;
  };
  const locator = (optional: boolean): { locator_kind: string | null; locator_text: string | null } => {
    const value = raw.locator;
    if (optional && value === null) return { locator_kind: null, locator_text: null };
    if (!isObject(value) || !hasExactKeys(value, ["kind", "text"])) {
      issues.add("reference.locator_required", [...path, "locator"]);
      return { locator_kind: null, locator_text: null };
    }
    if (!isLocatorKind(value.kind)) issues.add("reference.locator_kind_unknown", [...path, "locator", "kind"]);
    if (!isUsableText(value.text, 200)) issues.add("reference.locator_text_invalid", [...path, "locator", "text"]);
    return { locator_kind: String(value.kind), locator_text: String(value.text) };
  };

  if (purpose === "supports" && sourceKind === "abstract") {
    if (!hasExactKeys(raw, ["purpose", "sourceKind", "paperId", "snapshotId", "quoteText", "occurrence", "expectedMatchCount"])) {
      issues.add("request.change_invalid", path);
      return null;
    }
    const snapshot = snapshotId();
    if (typeof raw.quoteText !== "string") issues.add("reference.quote_required", [...path, "quoteText"]);
    const { occurrence, expectedMatchCount } = raw;
    const bothNull = occurrence === null && expectedMatchCount === null;
    const chosen = isPositiveInteger(occurrence) && isPositiveInteger(expectedMatchCount) && (occurrence as number) <= (expectedMatchCount as number);
    if (!bothNull && !chosen) issues.add("reference.occurrence_out_of_range", [...path, "occurrence"]);
    return {
      purpose,
      source_kind: sourceKind,
      paper_id: paperId,
      snapshot_id: snapshot,
      quote_text: typeof raw.quoteText === "string" ? raw.quoteText : null,
      occurrence: chosen ? (occurrence as number) : null,
      expected_match_count: chosen ? (expectedMatchCount as number) : null,
    };
  }
  if ((purpose === "supports" || purpose === "examined") && sourceKind === "full_text") {
    if (!hasExactKeys(raw, ["purpose", "sourceKind", "paperId", "locator"])) {
      issues.add("request.change_invalid", path);
      return null;
    }
    return { purpose, source_kind: sourceKind, paper_id: paperId, ...locator(purpose === "examined") };
  }
  if (purpose === "examined" && sourceKind === "abstract") {
    if (!hasExactKeys(raw, ["purpose", "sourceKind", "paperId", "snapshotId"])) {
      issues.add("request.change_invalid", path);
      return null;
    }
    return { purpose, source_kind: sourceKind, paper_id: paperId, snapshot_id: snapshotId() };
  }
  if (!hasExactKeys(raw, ["purpose", "sourceKind", "paperId"])) {
    issues.add("request.change_invalid", path);
    return null;
  }
  return { purpose, source_kind: sourceKind, paper_id: paperId };
}

function wireValueChange(issues: Issues, raw: Record<string, unknown>, path: IssuePath, batch: BatchState): Wire | null {
  const target = wireTarget(issues, raw.target, path);
  const fieldKey = raw.fieldKey;
  if (!isFieldKey(fieldKey)) {
    issues.add("field.unknown", [...path, "fieldKey"]);
    return null;
  }
  if (target && EVIDENCE_FIELDS[fieldKey].scope !== target.scope) issues.add("field.wrong_scope", [...path, "fieldKey"]);
  if (target) {
    const key = `${target.key}|${fieldKey}`;
    if (batch.targets.has(key)) issues.add("request.change_invalid", [...path, "target"]);
    batch.targets.add(key);
  }
  const version = raw.expectedValueVersion;
  const versionOk = raw.op === "set_value" ? version === null || toValueVersion(version) !== null : toValueVersion(version) !== null;
  if (!versionOk) issues.add("request.expected_value_version_invalid", [...path, "expectedValueVersion"]);
  const base = { op: raw.op as string, target: target?.wire ?? null, field_key: fieldKey, expected_value_version: (version as number | null) ?? null };
  if (raw.op === "clear_value") return base;

  const state = raw.state;
  if (!isValueState(state)) {
    issues.add("state.unknown", [...path, "state"]);
    return null;
  }
  const reason = raw.stateReason;
  if (state === "unclear" ? !isStateReason(reason) : reason !== null) {
    issues.add(state === "unclear" ? "state_reason.required" : "state_reason.not_allowed", [...path, "stateReason"]);
  }
  let content: Json = null;
  if (state === "reported") content = wireContent(issues, fieldKey, raw.content, path);
  else if (raw.content !== null) issues.add("value.not_allowed", [...path, "content"]);
  const note = raw.note;
  if (note !== null && typeof note !== "string") issues.add("note.not_text", [...path, "note"]);
  if (!Array.isArray(raw.references)) {
    issues.add("references.not_list", [...path, "references"]);
    return null;
  }
  const references = raw.references.map((reference, index) => wireReference(issues, reference, [...path, "references", index]));
  return {
    ...base,
    value_state: state,
    state_reason: (reason as StateReason | null) ?? null,
    content,
    note: typeof note === "string" ? note : null,
    references,
  };
}

function wireChange(issues: Issues, raw: unknown, index: number, batch: BatchState): Wire | null {
  const path = ["changes", index];
  if (!isObject(raw) || typeof raw.op !== "string" || !(raw.op in CHANGE_KEYS)) {
    issues.add("request.change_invalid", path);
    return null;
  }
  const op = raw.op as SaveChange["op"];
  if (!hasExactKeys(raw, CHANGE_KEYS[op])) {
    issues.add("request.change_invalid", path);
    return null;
  }
  const label = (max: number, required: ValidationCode, tooLong: ValidationCode) => {
    const value = raw.displayLabel;
    if (typeof value !== "string" || findPostgresTextProblem(value) || isNormalizationEmpty(value)) issues.add(required, [...path, "displayLabel"]);
    else if (codePointLength(value) > max) issues.add(tooLong, [...path, "displayLabel"]);
    return value as string;
  };
  const position = () => {
    if (!isPosition(raw.position)) issues.add("request.change_invalid", [...path, "position"]);
    return raw.position as number;
  };
  const newRef = (refs: string[]) => {
    const ref = raw.ref;
    if (typeof ref !== "string" || !BATCH_REF.test(ref) || batch.armRefs.includes(ref) || batch.outcomeRefs.includes(ref)) {
      issues.add("request.change_invalid", [...path, "ref"]);
    } else {
      refs.push(ref);
    }
    return ref as string;
  };
  const existing = (key: "armId" | "outcomeId", seen: Set<string>, removed: Set<string> | null) => {
    const id = key === "armId" ? toArmId(raw[key]) : toOutcomeId(raw[key]);
    if (!id || seen.has(id)) {
      issues.add("request.change_invalid", [...path, key]);
      return null;
    }
    seen.add(id);
    removed?.add(id);
    return id;
  };
  const role = () => {
    if (!isArmRole(raw.armRole)) issues.add("request.change_invalid", [...path, "armRole"]);
    return raw.armRole as ArmRole;
  };

  switch (op) {
    case "add_arm":
      return { op, ref: newRef(batch.armRefs), arm_role: role(), display_label: label(ARM_LABEL_MAX_LENGTH, "arm.label_required", "arm.label_too_long"), position: position() };
    case "update_arm":
      return { op, arm_id: existing("armId", batch.armIds, null), arm_role: role(), display_label: label(ARM_LABEL_MAX_LENGTH, "arm.label_required", "arm.label_too_long"), position: position() };
    case "remove_arm":
      return { op, arm_id: existing("armId", batch.armIds, batch.removedArms) };
    case "add_outcome":
      return { op, ref: newRef(batch.outcomeRefs), display_label: label(OUTCOME_LABEL_MAX_LENGTH, "outcome.label_required", "outcome.label_too_long"), position: position() };
    case "update_outcome":
      return { op, outcome_id: existing("outcomeId", batch.outcomeIds, null), display_label: label(OUTCOME_LABEL_MAX_LENGTH, "outcome.label_required", "outcome.label_too_long"), position: position() };
    case "remove_outcome":
      return { op, outcome_id: existing("outcomeId", batch.outcomeIds, batch.removedOutcomes) };
    case "set_value":
    case "clear_value":
      return wireValueChange(issues, raw, path, batch);
  }
}

/**
 * One atomic batch of changes inside one study, at an expected study version.
 * 1-200 changes; each entity named at most once. The batch is a set, not a
 * script: the server applies it in a fixed phase order and checks every rule
 * that spans the batch on its final state.
 */
export function prepareSaveChanges(input: {
  readonly studyId: string;
  readonly expectedVersion: number;
  readonly changes: readonly SaveChange[];
  readonly requestId: string;
}): Prepared<SaveChangesRequest> {
  const issues = new Issues();
  const { studyId, version, requestId } = envelope(issues, input);
  const changes: unknown = input.changes;
  const batch: BatchState = {
    armRefs: [],
    outcomeRefs: [],
    armIds: new Set(),
    outcomeIds: new Set(),
    removedArms: new Set(),
    removedOutcomes: new Set(),
    targets: new Set(),
  };
  let wire: (Wire | null)[] = [];
  if (!Array.isArray(changes)) issues.add("request.changes_not_list", ["changes"]);
  else if (changes.length === 0) issues.add("request.changes_empty", ["changes"]);
  else if (changes.length > EVIDENCE_FIELD_LIMITS.changesPerSave) issues.add("request.too_many_changes", ["changes"]);
  else {
    wire = changes.map((change, index) => wireChange(issues, change, index, batch));
    // Whatever the order of the batch: no value change targets a group or
    // outcome it removes, and every ref names one it adds.
    wire.forEach((change, index) => {
      const target = change?.target as Record<string, unknown> | null | undefined;
      if (!target) return;
      const bad =
        (typeof target.arm_id === "string" && batch.removedArms.has(target.arm_id)) ||
        (typeof target.outcome_id === "string" && batch.removedOutcomes.has(target.outcome_id)) ||
        (typeof target.arm_ref === "string" && !batch.armRefs.includes(target.arm_ref)) ||
        (typeof target.outcome_ref === "string" && !batch.outcomeRefs.includes(target.outcome_ref));
      if (bad) issues.add("request.change_invalid", ["changes", index, "target"]);
    });
  }
  return finish(issues, () => ({
    op: "save_changes" as const,
    functionName: "evidence_save_changes" as const,
    requestId: requestId!,
    studyId: studyId!,
    expectedVersion: version!,
    armRefs: [...batch.armRefs],
    outcomeRefs: [...batch.outcomeRefs],
    args: { p_study_id: studyId!, p_expected_version: version!, p_changes: wire as Json, p_request_id: requestId! },
  }));
}

/**
 * Confirm or Flag one recorded value at the `value_version` on screen. Confirm
 * takes an optional note; Flag needs one of at least 3 characters. Neither may
 * be blank after normalization v1. Whether Confirm is allowed is the server's
 * decision (`checkConfirm` explains it in advance; `confirm_blocked` names
 * what is missing).
 */
export function prepareReviewField(input: {
  readonly studyId: string;
  readonly expectedVersion: number;
  readonly valueId: string;
  readonly expectedValueVersion: number;
  readonly action: ReviewAction;
  readonly note: string | null;
  readonly requestId: string;
}): Prepared<ReviewFieldRequest> {
  const issues = new Issues();
  const { studyId, version, requestId } = envelope(issues, input);
  const valueId = toValueId(input.valueId);
  if (!valueId) issues.add("request.value_id_invalid", ["valueId"]);
  const valueVersion = toValueVersion(input.expectedValueVersion);
  if (!valueVersion) issues.add("request.expected_value_version_invalid", ["expectedValueVersion"]);
  const action = input.action;
  if (action !== "confirm" && action !== "flag") issues.add("request.review_action_invalid", ["action"]);
  const note: unknown = input.note;
  if (note === undefined) issues.add("request.review_note_missing", ["note"]);
  else if (note === null) {
    if (action === "flag") issues.add("review.flag_note_required", ["note"]);
  } else if (typeof note !== "string" || findPostgresTextProblem(note)) issues.add("note.malformed", ["note"]);
  else if (isNormalizationEmpty(note)) issues.add(action === "flag" ? "review.flag_note_required" : "note.blank", ["note"]);
  else if (codePointLength(note) > VALUE_NOTE_MAX_LENGTH) issues.add("note.too_long", ["note"]);
  else if (action === "flag" && codePointLength(btrimSpaces(note)) < FLAG_NOTE_MIN_LENGTH) issues.add("review.flag_note_required", ["note"]);
  return finish(issues, () => ({
    op: "review_fields" as const,
    functionName: "evidence_review_fields" as const,
    requestId: requestId!,
    studyId: studyId!,
    expectedVersion: version!,
    valueId: valueId!,
    expectedValueVersion: valueVersion!,
    action,
    args: {
      p_study_id: studyId!,
      p_expected_version: version!,
      p_value_id: valueId!,
      p_expected_value_version: valueVersion!,
      p_action: action,
      p_note: input.note,
      p_request_id: requestId!,
    },
  }));
}

/**
 * Save the abstract the user is looking at as the link's new current copy
 * ("Use current abstract"), or its first copy. `expectedAbstractSha256` is the
 * lowercase hex SHA-256 of the UTF-8 abstract text displayed; when the library
 * abstract has changed since, the server answers `source_changed_again`.
 */
export function prepareRebaseSource(input: {
  readonly studyId: string;
  readonly paperId: string;
  readonly expectedVersion: number;
  readonly expectedAbstractSha256: string;
  readonly requestId: string;
}): Prepared<RebaseSourceRequest> {
  const issues = new Issues();
  const { studyId, version, requestId } = envelope(issues, input);
  const paperId = toPaperId(input.paperId);
  if (!paperId) issues.add("request.paper_id_invalid", ["paperId"]);
  const sha = input.expectedAbstractSha256;
  if (typeof sha !== "string" || !SHA256_HEX.test(sha)) issues.add("request.abstract_sha256_invalid", ["expectedAbstractSha256"]);
  return finish(issues, () => ({
    op: "rebase_source" as const,
    functionName: "evidence_rebase_source" as const,
    requestId: requestId!,
    studyId: studyId!,
    expectedVersion: version!,
    paperId: paperId!,
    args: {
      p_study_id: studyId!,
      p_paper_id: paperId!,
      p_expected_version: version!,
      p_expected_abstract_sha256: sha,
      p_request_id: requestId!,
    },
  }));
}

/** The typed change a wire change came from, for `isPreparedFieldRequest`. */
function changeFromWire(wire: Record<string, unknown>): unknown {
  const target = (t: unknown) => {
    if (!isObject(t)) return t;
    if ("arm_id" in t) return { scope: t.scope, armId: t.arm_id };
    if ("arm_ref" in t) return { scope: t.scope, armRef: t.arm_ref };
    if ("outcome_id" in t) return { scope: t.scope, outcomeId: t.outcome_id };
    if ("outcome_ref" in t) return { scope: t.scope, outcomeRef: t.outcome_ref };
    return { scope: t.scope };
  };
  const content = (c: unknown) => {
    if (!isObject(c)) return c;
    if (c.shape === "integer_with_reported_text") return { shape: c.shape, reportedText: c.reported_text, value: c.value };
    return { ...c };
  };
  const reference = (r: unknown) => {
    if (!isObject(r)) return r;
    if ("anchor_id" in r) return { anchorId: r.anchor_id };
    const out: Record<string, unknown> = { purpose: r.purpose, sourceKind: r.source_kind, paperId: r.paper_id };
    if ("snapshot_id" in r) out.snapshotId = r.snapshot_id;
    if ("quote_text" in r) Object.assign(out, { quoteText: r.quote_text, occurrence: r.occurrence, expectedMatchCount: r.expected_match_count });
    if ("locator_kind" in r) out.locator = r.locator_kind === null && r.locator_text === null ? null : { kind: r.locator_kind, text: r.locator_text };
    return out;
  };
  switch (wire.op) {
    case "add_arm":
      return { op: wire.op, ref: wire.ref, armRole: wire.arm_role, displayLabel: wire.display_label, position: wire.position };
    case "update_arm":
      return { op: wire.op, armId: wire.arm_id, armRole: wire.arm_role, displayLabel: wire.display_label, position: wire.position };
    case "remove_arm":
      return { op: wire.op, armId: wire.arm_id };
    case "add_outcome":
      return { op: wire.op, ref: wire.ref, displayLabel: wire.display_label, position: wire.position };
    case "update_outcome":
      return { op: wire.op, outcomeId: wire.outcome_id, displayLabel: wire.display_label, position: wire.position };
    case "remove_outcome":
      return { op: wire.op, outcomeId: wire.outcome_id };
    case "clear_value":
      return { op: wire.op, target: target(wire.target), fieldKey: wire.field_key, expectedValueVersion: wire.expected_value_version };
    case "set_value":
      return {
        op: wire.op,
        target: target(wire.target),
        fieldKey: wire.field_key,
        expectedValueVersion: wire.expected_value_version,
        state: wire.value_state,
        stateReason: wire.state_reason,
        content: content(wire.content),
        note: wire.note,
        references: Array.isArray(wire.references) ? wire.references.map(reference) : wire.references,
      };
    default:
      return wire;
  }
}

/**
 * Whether `request` is exactly what the matching `prepare*` builds from its own
 * arguments — so a hand-built object with an extra, missing, forged or
 * unvalidated argument is never sent.
 */
export function isPreparedFieldRequest(request: unknown): request is FieldRequest {
  if (!request || typeof request !== "object") return false;
  const r = request as FieldRequest;
  const args = r.args as Record<string, unknown> | undefined;
  if (!args || typeof args !== "object") return false;
  let rebuilt: Prepared<FieldRequest>;
  switch (r.op) {
    case "save_changes":
      rebuilt = prepareSaveChanges({
        studyId: args.p_study_id as string,
        expectedVersion: args.p_expected_version as number,
        changes: (Array.isArray(args.p_changes) ? args.p_changes.map((c) => (isObject(c) ? changeFromWire(c) : c)) : args.p_changes) as SaveChange[],
        requestId: args.p_request_id as string,
      });
      break;
    case "review_fields":
      rebuilt = prepareReviewField({
        studyId: args.p_study_id as string,
        expectedVersion: args.p_expected_version as number,
        valueId: args.p_value_id as string,
        expectedValueVersion: args.p_expected_value_version as number,
        action: args.p_action as ReviewAction,
        note: args.p_note as string | null,
        requestId: args.p_request_id as string,
      });
      break;
    case "rebase_source":
      rebuilt = prepareRebaseSource({
        studyId: args.p_study_id as string,
        paperId: args.p_paper_id as string,
        expectedVersion: args.p_expected_version as number,
        expectedAbstractSha256: args.p_expected_abstract_sha256 as string,
        requestId: args.p_request_id as string,
      });
      break;
    default:
      return false;
  }
  return rebuilt.ok && JSON.stringify(rebuilt.request) === JSON.stringify(request);
}

/** Whether `name` is one of the three PR-A3 client RPCs. */
export function isEvidenceFieldRpc(name: unknown): name is EvidenceFieldRpc {
  return typeof name === "string" && (EVIDENCE_FIELD_RPCS as readonly string[]).includes(name);
}
