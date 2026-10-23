/**
 * The Study Record editor's draft (EVIDENCE-RECORDS-001C1).
 *
 * In memory only: nothing here is written to browser storage, and nothing is
 * saved until the user presses Save (Requirements-001 §E5 — no autosave).
 *
 * A draft is the user's intended final state of what they touched, on top of
 * the record as loaded (the "base"):
 *
 *   * the study header (label, design family, notes);
 *   * the groups and outcomes, in display order — existing ones keyed by their
 *     id, new ones by a local key that doubles as the batch `ref`;
 *   * the groups and outcomes marked for removal;
 *   * one entry per value the user touched, holding its whole new state. An
 *     entry that comes back to equal the stored value is dropped, so "dirty"
 *     means exactly "Save would change something".
 *
 * Each value entry remembers the `value_version` it was based on, captured
 * when the user first touched it. That is what the save sends as
 * `expected_value_version`, so a value someone changed in another tab is
 * refused by the server (`evidence_version_conflict`) instead of being
 * silently overwritten — even if the record on screen was reloaded since.
 *
 * Nothing is rewritten: text is stored as typed; a confirmed number is parsed
 * strictly from what the user entered and is never filled in for them; content
 * is kept while the user tries another state and only sent for Reported.
 */

import {
  EVIDENCE_FIELDS,
  FIELD_KEYS,
  INTERVENTION_DESIGN_PROFILES,
  type ArmRole,
  type DesignProfile,
  type FieldKey,
} from "@/lib/evidence/fieldDictionary";
import type { ChangeTarget, ReferenceChange, SaveChange } from "@/lib/evidence/fieldRequests";
import type { AnchorId, ArmId, OutcomeId, PaperId, SnapshotId } from "@/lib/evidence/ids";
import type {
  FieldContent,
  FullTextLocator,
  RecordedValue,
  ReferenceSourceKind,
  StateReason,
  StoredReference,
  ValueState,
} from "@/lib/evidence/types";
import type { ReferenceDraft } from "@/lib/evidence/validation";
import { targetIdOf, type StudyRecordData } from "./read";

// ── Keys ─────────────────────────────────────────────────────────────────────

/** "study", "arm:<key>" or "outcome:<key>"; an existing group or outcome's key is its id. */
export type TargetKey = string;
export const STUDY_TARGET: TargetKey = "study";
export const armTarget = (key: string): TargetKey => `arm:${key}`;
export const outcomeTarget = (key: string): TargetKey => `outcome:${key}`;
export const valueKey = (target: TargetKey, fieldKey: FieldKey): string => `${target}|${fieldKey}`;

export function parseTargetKey(target: TargetKey): { scope: "study" } | { scope: "arm" | "outcome"; key: string } {
  if (target === STUDY_TARGET) return { scope: "study" };
  const [scope, ...rest] = target.split(":");
  if ((scope === "arm" || scope === "outcome") && rest.length > 0) return { scope, key: rest.join(":") };
  throw new Error("Unknown study record target");
}

export function parseValueKey(key: string): { target: TargetKey; fieldKey: FieldKey } {
  const at = key.lastIndexOf("|");
  return { target: key.slice(0, at), fieldKey: key.slice(at + 1) as FieldKey };
}

// ── Draft shapes ─────────────────────────────────────────────────────────────

export interface DraftArm {
  readonly key: string;
  /** Null until the server has created the group. */
  readonly id: ArmId | null;
  readonly role: ArmRole;
  readonly displayLabel: string;
}

export interface DraftOutcome {
  readonly key: string;
  readonly id: OutcomeId | null;
  readonly displayLabel: string;
}

/** A removed group or outcome, kept so the removal can be undone before saving. */
export interface RemovedEntity<Id> {
  readonly id: Id;
  readonly displayLabel: string;
  /** Where it was, for Undo. */
  readonly index: number;
}

/** A field's value as the inputs hold it: strings, converted only when saved. */
export type DraftContent =
  | { readonly shape: "text"; readonly text: string }
  /** "" while no option is chosen. */
  | { readonly shape: "code"; readonly code: string }
  /** `valueText` is the confirmed whole number exactly as the user typed it. */
  | { readonly shape: "integer_with_reported_text"; readonly reportedText: string; readonly valueText: string }
  | { readonly shape: "text_list"; readonly entries: readonly string[] };

/** A new source reference, in the shape `ReferenceChange` will carry. */
export type NewReference =
  | {
      readonly purpose: "supports";
      readonly sourceKind: "abstract";
      readonly paperId: PaperId;
      readonly snapshotId: SnapshotId;
      /** Exactly what the user selected or typed. */
      readonly quoteText: string;
      /** With several occurrences: the 1-based one chosen, and how many the user saw. Both null otherwise. */
      readonly occurrence: number | null;
      readonly expectedMatchCount: number | null;
    }
  | { readonly purpose: "supports"; readonly sourceKind: "full_text"; readonly paperId: PaperId; readonly locator: FullTextLocator }
  | { readonly purpose: "examined"; readonly sourceKind: "abstract"; readonly paperId: PaperId; readonly snapshotId: SnapshotId }
  | { readonly purpose: "examined"; readonly sourceKind: "full_text"; readonly paperId: PaperId; readonly locator: FullTextLocator | null }
  | { readonly purpose: "unavailable"; readonly sourceKind: ReferenceSourceKind; readonly paperId: PaperId };

export type DraftReference =
  /** A stored reference kept exactly as it is (`{anchor_id}` on the wire). */
  | { readonly kind: "kept"; readonly reference: StoredReference }
  | { readonly kind: "new"; readonly localId: string; readonly reference: NewReference };

export interface DraftValueEdit {
  /** True: the stored value is cleared, back to "Not yet recorded". */
  readonly cleared: boolean;
  /** The `value_version` this edit was based on; null for a field not recorded then. */
  readonly expectedValueVersion: number | null;
  /** Null: not recorded. */
  readonly state: ValueState | null;
  readonly stateReason: StateReason | null;
  /** Held while another state is tried; sent only for Reported. */
  readonly content: DraftContent | null;
  /** "" means no note. */
  readonly note: string;
  readonly references: readonly DraftReference[];
}

export interface StudyHeaderDraft {
  readonly label: string;
  readonly designProfile: DesignProfile;
  /** "" means no notes. */
  readonly notes: string;
}

export interface StudyRecordDraft {
  readonly header: StudyHeaderDraft;
  readonly arms: readonly DraftArm[];
  readonly outcomes: readonly DraftOutcome[];
  readonly removedArms: readonly RemovedEntity<ArmId>[];
  readonly removedOutcomes: readonly RemovedEntity<OutcomeId>[];
  /** By `valueKey`; only the values the user touched. */
  readonly values: ReadonlyMap<string, DraftValueEdit>;
  /** Next number for local keys (`arm_1`, `outcome_2`, `ref_3`). */
  readonly nextLocal: number;
}

// ── From the base ────────────────────────────────────────────────────────────

export function createDraft(base: StudyRecordData): StudyRecordDraft {
  return {
    header: { label: base.header.label, designProfile: base.header.designProfile, notes: base.header.notes ?? "" },
    arms: base.arms.map((arm) => ({ key: arm.id, id: arm.id, role: arm.role, displayLabel: arm.displayLabel })),
    outcomes: base.outcomes.map((outcome) => ({ key: outcome.id, id: outcome.id, displayLabel: outcome.displayLabel })),
    removedArms: [],
    removedOutcomes: [],
    values: new Map(),
    nextLocal: 1,
  };
}

/** The stored values, by `valueKey` (existing groups and outcomes are keyed by id). */
export function indexBaseValues(base: StudyRecordData): ReadonlyMap<string, RecordedValue> {
  const index = new Map<string, RecordedValue>();
  for (const value of base.values) index.set(valueKey(targetIdOf(value), value.fieldKey), value);
  return index;
}

export function contentFromRecorded(content: FieldContent): DraftContent {
  switch (content.shape) {
    case "text":
      return { shape: "text", text: content.text };
    case "code":
      return { shape: "code", code: content.code };
    case "integer_with_reported_text":
      return { shape: "integer_with_reported_text", reportedText: content.reportedText, valueText: String(content.value) };
    case "text_list":
      return { shape: "text_list", entries: [...content.entries] };
  }
}

/** An empty value of `fieldKey`'s shape, for a field taking a value for the first time. */
export function emptyContent(fieldKey: FieldKey): DraftContent {
  switch (EVIDENCE_FIELDS[fieldKey].shape) {
    case "text":
      return { shape: "text", text: "" };
    case "code":
      return { shape: "code", code: "" };
    case "integer_with_reported_text":
      return { shape: "integer_with_reported_text", reportedText: "", valueText: "" };
    case "text_list":
      return { shape: "text_list", entries: [""] };
  }
}

export function editFromRecorded(value: RecordedValue): DraftValueEdit {
  return {
    cleared: false,
    expectedValueVersion: value.valueVersion,
    state: value.state,
    stateReason: value.stateReason,
    content: value.content ? contentFromRecorded(value.content) : null,
    note: value.note ?? "",
    references: value.references.map((reference) => ({ kind: "kept", reference })),
  };
}

export const NOT_RECORDED_EDIT: DraftValueEdit = Object.freeze({
  cleared: false,
  expectedValueVersion: null,
  state: null,
  stateReason: null,
  content: null,
  note: "",
  references: Object.freeze([]),
});

/** What a field shows: the user's edit, else the stored value, else nothing recorded. */
export function viewValue(
  baseValues: ReadonlyMap<string, RecordedValue>,
  draft: StudyRecordDraft,
  key: string,
): { readonly edit: DraftValueEdit; readonly recorded: RecordedValue | null; readonly touched: boolean } {
  const recorded = baseValues.get(key) ?? null;
  const edit = draft.values.get(key);
  if (edit) return { edit, recorded, touched: true };
  return { edit: recorded ? editFromRecorded(recorded) : NOT_RECORDED_EDIT, recorded, touched: false };
}

// ── Equality with the stored value ───────────────────────────────────────────

function contentMatches(content: DraftContent | null, stored: FieldContent | null): boolean {
  if (!content || !stored || content.shape !== stored.shape) return content === null && stored === null;
  switch (content.shape) {
    case "text":
      return stored.shape === "text" && content.text === stored.text;
    case "code":
      return stored.shape === "code" && content.code === stored.code;
    case "integer_with_reported_text":
      return (
        stored.shape === "integer_with_reported_text" &&
        content.reportedText === stored.reportedText &&
        content.valueText === String(stored.value)
      );
    case "text_list":
      return (
        stored.shape === "text_list" &&
        content.entries.length === stored.entries.length &&
        content.entries.every((entry, index) => entry === stored.entries[index])
      );
  }
}

/**
 * Whether saving `edit` would leave `recorded` exactly as it is — the rule
 * the server's own no-op check uses (field operations §3.6): same state,
 * reason, note and content, and every stored reference kept by id, supporting
 * ones in their stored order. A new reference always counts as a change.
 */
export function editMatchesRecorded(edit: DraftValueEdit, recorded: RecordedValue | null): boolean {
  if (!recorded) return !edit.cleared && edit.state === null;
  if (edit.cleared || edit.state !== recorded.state) return false;
  if ((edit.state === "unclear" ? edit.stateReason : null) !== recorded.stateReason) return false;
  if ((edit.note === "" ? null : edit.note) !== recorded.note) return false;
  if (edit.state === "reported" && !contentMatches(edit.content, recorded.content)) return false;
  if (edit.references.length !== recorded.references.length) return false;
  const kept: StoredReference[] = [];
  for (const reference of edit.references) {
    if (reference.kind !== "kept") return false;
    kept.push(reference.reference);
  }
  const supports = (list: readonly StoredReference[]) => list.filter((r) => r.purpose === "supports").map((r) => r.id);
  const assessments = (list: readonly StoredReference[]) => list.filter((r) => r.purpose !== "supports").map((r) => r.id).sort();
  return (
    JSON.stringify(supports(kept)) === JSON.stringify(supports(recorded.references)) &&
    JSON.stringify(assessments(kept)) === JSON.stringify(assessments(recorded.references))
  );
}

// ── Updates ──────────────────────────────────────────────────────────────────

/**
 * Set the edit of one value. The `expectedValueVersion` of the first edit is
 * kept for good, so later edits of the same field still name the version the
 * user started from. An edit equal to the stored value is dropped.
 */
export function setValueEdit(
  baseValues: ReadonlyMap<string, RecordedValue>,
  draft: StudyRecordDraft,
  key: string,
  next: Omit<DraftValueEdit, "expectedValueVersion">,
): StudyRecordDraft {
  const previous = draft.values.get(key);
  const recorded = baseValues.get(key) ?? null;
  const expectedValueVersion = previous ? previous.expectedValueVersion : recorded ? recorded.valueVersion : null;
  const edit: DraftValueEdit = { ...next, expectedValueVersion };
  const values = new Map(draft.values);
  // Only an edit made against the version on screen can be dropped as a no-op.
  if (editMatchesRecorded(edit, recorded) && expectedValueVersion === (recorded?.valueVersion ?? null)) values.delete(key);
  else values.set(key, edit);
  return { ...draft, values };
}

/** Discard the user's edit of one value. */
export function revertValue(draft: StudyRecordDraft, key: string): StudyRecordDraft {
  if (!draft.values.has(key)) return draft;
  const values = new Map(draft.values);
  values.delete(key);
  return { ...draft, values };
}

export function updateHeader(draft: StudyRecordDraft, patch: Partial<StudyHeaderDraft>): StudyRecordDraft {
  return { ...draft, header: { ...draft.header, ...patch } };
}

export function nextLocalKey(draft: StudyRecordDraft, prefix: "arm" | "outcome" | "ref"): { key: string; draft: StudyRecordDraft } {
  return { key: `${prefix}_${draft.nextLocal}`, draft: { ...draft, nextLocal: draft.nextLocal + 1 } };
}

export function addArm(draft: StudyRecordDraft, role: ArmRole, displayLabel: string): { key: string; draft: StudyRecordDraft } {
  const { key, draft: next } = nextLocalKey(draft, "arm");
  return { key, draft: { ...next, arms: [...next.arms, { key, id: null, role, displayLabel }] } };
}

export function addOutcome(draft: StudyRecordDraft, displayLabel: string): { key: string; draft: StudyRecordDraft } {
  const { key, draft: next } = nextLocalKey(draft, "outcome");
  return { key, draft: { ...next, outcomes: [...next.outcomes, { key, id: null, displayLabel }] } };
}

export function updateArm(draft: StudyRecordDraft, key: string, patch: Partial<Pick<DraftArm, "role" | "displayLabel">>): StudyRecordDraft {
  return { ...draft, arms: draft.arms.map((arm) => (arm.key === key ? { ...arm, ...patch } : arm)) };
}

export function updateOutcome(draft: StudyRecordDraft, key: string, patch: Partial<Pick<DraftOutcome, "displayLabel">>): StudyRecordDraft {
  return { ...draft, outcomes: draft.outcomes.map((outcome) => (outcome.key === key ? { ...outcome, ...patch } : outcome)) };
}

function move<T extends { key: string }>(list: readonly T[], key: string, delta: -1 | 1): readonly T[] {
  const index = list.findIndex((item) => item.key === key);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= list.length) return list;
  const next = [...list];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

export function moveArm(draft: StudyRecordDraft, key: string, delta: -1 | 1): StudyRecordDraft {
  return { ...draft, arms: move(draft.arms, key, delta) };
}

export function moveOutcome(draft: StudyRecordDraft, key: string, delta: -1 | 1): StudyRecordDraft {
  return { ...draft, outcomes: move(draft.outcomes, key, delta) };
}

function dropTargetValues(values: ReadonlyMap<string, DraftValueEdit>, target: TargetKey): Map<string, DraftValueEdit> {
  const next = new Map(values);
  for (const key of values.keys()) if (parseValueKey(key).target === target) next.delete(key);
  return next;
}

/**
 * Remove a group. A saved group is marked for removal — its values and their
 * sources go with it when the user saves, and Undo brings it back until then.
 * A group added in this draft is simply dropped, with its draft values.
 */
export function removeArm(draft: StudyRecordDraft, key: string): StudyRecordDraft {
  const index = draft.arms.findIndex((arm) => arm.key === key);
  if (index < 0) return draft;
  const arm = draft.arms[index];
  const values = dropTargetValues(draft.values, armTarget(key));
  const arms = draft.arms.filter((candidate) => candidate.key !== key);
  const removedArms = arm.id ? [...draft.removedArms, { id: arm.id, displayLabel: arm.displayLabel, index }] : draft.removedArms;
  return { ...draft, arms, values, removedArms };
}

export function removeOutcome(draft: StudyRecordDraft, key: string): StudyRecordDraft {
  const index = draft.outcomes.findIndex((outcome) => outcome.key === key);
  if (index < 0) return draft;
  const outcome = draft.outcomes[index];
  const values = dropTargetValues(draft.values, outcomeTarget(key));
  const outcomes = draft.outcomes.filter((candidate) => candidate.key !== key);
  const removedOutcomes = outcome.id
    ? [...draft.removedOutcomes, { id: outcome.id, displayLabel: outcome.displayLabel, index }]
    : draft.removedOutcomes;
  return { ...draft, outcomes, values, removedOutcomes };
}

/** Undo a removal: the group comes back as it was saved. */
export function restoreArm(base: StudyRecordData, draft: StudyRecordDraft, id: ArmId): StudyRecordDraft {
  const removed = draft.removedArms.find((entry) => entry.id === id);
  const stored = base.arms.find((arm) => arm.id === id);
  if (!removed || !stored) return draft;
  const arms = [...draft.arms];
  arms.splice(Math.min(removed.index, arms.length), 0, { key: stored.id, id: stored.id, role: stored.role, displayLabel: stored.displayLabel });
  return { ...draft, arms, removedArms: draft.removedArms.filter((entry) => entry.id !== id) };
}

export function restoreOutcome(base: StudyRecordData, draft: StudyRecordDraft, id: OutcomeId): StudyRecordDraft {
  const removed = draft.removedOutcomes.find((entry) => entry.id === id);
  const stored = base.outcomes.find((outcome) => outcome.id === id);
  if (!removed || !stored) return draft;
  const outcomes = [...draft.outcomes];
  outcomes.splice(Math.min(removed.index, outcomes.length), 0, { key: stored.id, id: stored.id, displayLabel: stored.displayLabel });
  return { ...draft, outcomes, removedOutcomes: draft.removedOutcomes.filter((entry) => entry.id !== id) };
}

// ── Dirty ────────────────────────────────────────────────────────────────────

export function headerChanged(base: StudyRecordData, draft: StudyRecordDraft): boolean {
  const { header } = draft;
  return (
    header.label !== base.header.label ||
    header.designProfile !== base.header.designProfile ||
    (header.notes === "" ? null : header.notes) !== base.header.notes
  );
}

export function isDraftDirty(base: StudyRecordData, draft: StudyRecordDraft): boolean {
  return headerChanged(base, draft) || buildChanges(base, draft).length > 0;
}

// ── Changes ──────────────────────────────────────────────────────────────────

export type ChangeOrigin =
  | { readonly kind: "arm"; readonly key: string }
  | { readonly kind: "outcome"; readonly key: string }
  | { readonly kind: "value"; readonly key: string };

/** One change of the save, with what it came from (to point a refusal at the right input). */
export interface DraftChange {
  readonly change: SaveChange;
  readonly origin: ChangeOrigin;
  /**
   * Must be sent with the group and outcome changes, in the first batch: a
   * change to a group's role and the clearing of a value the new role cannot
   * hold are checked together, on the batch's final state.
   */
  readonly withStructure: boolean;
}

/** A confirmed number as typed: undefined when blank, NaN when not a plain whole number. */
export function parseConfirmedInteger(valueText: string): number | undefined {
  const text = valueText.replace(/^ +| +$/g, "");
  if (text === "") return undefined;
  return /^[0-9]+$/.test(text) ? Number(text) : Number.NaN;
}

/** The typed value a field's content is saved as. A malformed number stays malformed for validation to report. */
export function toFieldContent(content: DraftContent): FieldContent {
  switch (content.shape) {
    case "text":
      return { shape: "text", text: content.text };
    case "code":
      return { shape: "code", code: content.code };
    case "integer_with_reported_text":
      return { shape: "integer_with_reported_text", reportedText: content.reportedText, value: parseConfirmedInteger(content.valueText) as number };
    case "text_list":
      return { shape: "text_list", entries: [...content.entries] };
  }
}

export function toReferenceChange(reference: DraftReference): ReferenceChange {
  if (reference.kind === "kept") return { anchorId: reference.reference.id };
  return { ...reference.reference };
}

/** A reference as the PR-B validator takes it. */
export function toReferenceDraft(reference: DraftReference): ReferenceDraft {
  if (reference.kind === "new") {
    const { reference: r } = reference;
    if (r.purpose === "supports" && r.sourceKind === "abstract") {
      return { purpose: r.purpose, sourceKind: r.sourceKind, paperId: r.paperId, snapshotId: r.snapshotId, quoteText: r.quoteText, occurrence: r.occurrence };
    }
    return { ...r } as ReferenceDraft;
  }
  const r = reference.reference;
  switch (r.purpose) {
    case "supports":
      return r.sourceKind === "abstract"
        ? { purpose: "supports", sourceKind: "abstract", paperId: r.paperId, snapshotId: r.snapshotId, quoteText: r.quoteText, occurrence: r.match.occurrence, anchorId: r.id as AnchorId }
        : { purpose: "supports", sourceKind: "full_text", paperId: r.paperId, locator: { kind: r.locator.kind, text: r.locator.text }, anchorId: r.id };
    case "examined":
      return r.sourceKind === "abstract"
        ? { purpose: "examined", sourceKind: "abstract", paperId: r.paperId, snapshotId: r.snapshotId, anchorId: r.id }
        : { purpose: "examined", sourceKind: "full_text", paperId: r.paperId, locator: r.locator ? { ...r.locator } : null, anchorId: r.id };
    case "unavailable":
      return { purpose: "unavailable", sourceKind: r.sourceKind, paperId: r.paperId, anchorId: r.id };
  }
}

/** The study, a group or an outcome, as a save change names it. */
export function changeTarget(draft: StudyRecordDraft, target: TargetKey): ChangeTarget | null {
  const parsed = parseTargetKey(target);
  if (parsed.scope === "study") return { scope: "study" };
  if (parsed.scope === "arm") {
    const arm = draft.arms.find((candidate) => candidate.key === parsed.key);
    if (!arm) return null;
    return arm.id ? { scope: "arm", armId: arm.id } : { scope: "arm", armRef: arm.key };
  }
  const outcome = draft.outcomes.find((candidate) => candidate.key === parsed.key);
  if (!outcome) return null;
  return outcome.id ? { scope: "outcome", outcomeId: outcome.id } : { scope: "outcome", outcomeRef: outcome.key };
}

/** The `set_value` or `clear_value` a value edit saves as. */
export function valueChange(draft: StudyRecordDraft, key: string, edit: DraftValueEdit): SaveChange | null {
  const { target, fieldKey } = parseValueKey(key);
  const changeTo = changeTarget(draft, target);
  if (!changeTo) return null;
  if (edit.cleared) {
    if (edit.expectedValueVersion === null) return null;
    return { op: "clear_value", target: changeTo, fieldKey, expectedValueVersion: edit.expectedValueVersion };
  }
  if (edit.state === null) return null;
  return {
    op: "set_value",
    target: changeTo,
    fieldKey,
    expectedValueVersion: edit.expectedValueVersion,
    state: edit.state,
    stateReason: edit.state === "unclear" ? edit.stateReason : null,
    content: edit.state === "reported" && edit.content ? toFieldContent(edit.content) : null,
    note: edit.note === "" ? null : edit.note,
    references: edit.references.map(toReferenceChange),
  };
}

function targetOrder(draft: StudyRecordDraft, target: TargetKey): number {
  const parsed = parseTargetKey(target);
  if (parsed.scope === "study") return 0;
  if (parsed.scope === "arm") return 1_000 + draft.arms.findIndex((arm) => arm.key === parsed.key);
  return 100_000 + draft.outcomes.findIndex((outcome) => outcome.key === parsed.key);
}

/**
 * Every group, outcome and value change the draft saves as, in a fixed order:
 * removals, groups, outcomes, then values (study, groups, outcomes; fields in
 * dictionary order). A group's or outcome's position is its index on screen,
 * so the saved order is always distinct and dense. The header is saved by its
 * own RPC (`headerChanged`).
 */
export function buildChanges(base: StudyRecordData, draft: StudyRecordDraft): DraftChange[] {
  const changes: DraftChange[] = [];
  const baseArms = new Map(base.arms.map((arm) => [arm.id as string, arm]));
  const baseOutcomes = new Map(base.outcomes.map((outcome) => [outcome.id as string, outcome]));
  const roleChanged = new Set<string>();

  for (const removed of draft.removedArms) {
    changes.push({ change: { op: "remove_arm", armId: removed.id }, origin: { kind: "arm", key: removed.id }, withStructure: true });
  }
  for (const removed of draft.removedOutcomes) {
    changes.push({ change: { op: "remove_outcome", outcomeId: removed.id }, origin: { kind: "outcome", key: removed.id }, withStructure: true });
  }
  draft.arms.forEach((arm, position) => {
    const origin = { kind: "arm", key: arm.key } as const;
    if (!arm.id) {
      changes.push({ change: { op: "add_arm", ref: arm.key, armRole: arm.role, displayLabel: arm.displayLabel, position }, origin, withStructure: true });
      return;
    }
    const stored = baseArms.get(arm.id);
    if (!stored) return;
    if (stored.role !== arm.role) roleChanged.add(arm.key);
    if (stored.role !== arm.role || stored.displayLabel !== arm.displayLabel || stored.position !== position) {
      changes.push({ change: { op: "update_arm", armId: arm.id, armRole: arm.role, displayLabel: arm.displayLabel, position }, origin, withStructure: true });
    }
  });
  draft.outcomes.forEach((outcome, position) => {
    const origin = { kind: "outcome", key: outcome.key } as const;
    if (!outcome.id) {
      changes.push({ change: { op: "add_outcome", ref: outcome.key, displayLabel: outcome.displayLabel, position }, origin, withStructure: true });
      return;
    }
    const stored = baseOutcomes.get(outcome.id);
    if (stored && (stored.displayLabel !== outcome.displayLabel || stored.position !== position)) {
      changes.push({ change: { op: "update_outcome", outcomeId: outcome.id, displayLabel: outcome.displayLabel, position }, origin, withStructure: true });
    }
  });

  const valueEntries = [...draft.values.entries()]
    .map(([key, edit]) => ({ key, edit, ...parseValueKey(key) }))
    .sort((a, b) => targetOrder(draft, a.target) - targetOrder(draft, b.target) || FIELD_KEYS.indexOf(a.fieldKey) - FIELD_KEYS.indexOf(b.fieldKey));
  for (const { key, edit, target } of valueEntries) {
    const change = valueChange(draft, key, edit);
    if (!change) continue;
    const parsed = parseTargetKey(target);
    const withStructure = parsed.scope === "arm" && roleChanged.has(parsed.key);
    changes.push({ change, origin: { kind: "value", key }, withStructure });
  }
  return changes;
}

/**
 * The draft after some of its changes were saved (all of them, or the steps
 * before a failure). Saved value edits are dropped — the reloaded record holds
 * them now; a group or outcome the server created takes its id, and its value
 * edits follow it to the new key; saved removals leave the list of removals.
 * Everything not saved stays exactly as it was, with the versions it captured.
 */
export function rebaseAfterSave(
  draft: StudyRecordDraft,
  saved: readonly ChangeOrigin[],
  armIds: ReadonlyMap<string, ArmId>,
  outcomeIds: ReadonlyMap<string, OutcomeId>,
): StudyRecordDraft {
  const savedValues = new Set(saved.flatMap((origin) => (origin.kind === "value" ? [origin.key] : [])));
  const savedArms = new Set(saved.flatMap((origin) => (origin.kind === "arm" ? [origin.key] : [])));
  const savedOutcomes = new Set(saved.flatMap((origin) => (origin.kind === "outcome" ? [origin.key] : [])));

  const renamed = new Map<TargetKey, TargetKey>();
  const arms = draft.arms.map((arm) => {
    const id = arm.id ? null : armIds.get(arm.key);
    if (!id) return arm;
    renamed.set(armTarget(arm.key), armTarget(id));
    return { ...arm, key: id, id };
  });
  const outcomes = draft.outcomes.map((outcome) => {
    const id = outcome.id ? null : outcomeIds.get(outcome.key);
    if (!id) return outcome;
    renamed.set(outcomeTarget(outcome.key), outcomeTarget(id));
    return { ...outcome, key: id, id };
  });

  const values = new Map<string, DraftValueEdit>();
  for (const [key, edit] of draft.values) {
    if (savedValues.has(key)) continue;
    const { target, fieldKey } = parseValueKey(key);
    values.set(valueKey(renamed.get(target) ?? target, fieldKey), edit);
  }
  return {
    ...draft,
    arms,
    outcomes,
    values,
    removedArms: draft.removedArms.filter((entry) => !savedArms.has(entry.id)),
    removedOutcomes: draft.removedOutcomes.filter((entry) => !savedOutcomes.has(entry.id)),
  };
}

// ── Design family and group roles ────────────────────────────────────────────

export const isInterventionFamily = (profile: DesignProfile): boolean =>
  (INTERVENTION_DESIGN_PROFILES as readonly DesignProfile[]).includes(profile);

/**
 * What moving the draft to `profile` would take away, so the user can resolve
 * it first (Requirements-001 §F2: no data is hidden). Moving to a study
 * without an assigned intervention needs the groups and the number randomized
 * gone; every other move takes nothing away.
 */
export function familyChangeImpact(
  baseValues: ReadonlyMap<string, RecordedValue>,
  draft: StudyRecordDraft,
  profile: DesignProfile,
): { readonly groups: number; readonly groupValues: number; readonly numberRandomized: boolean } {
  if (isInterventionFamily(profile)) return { groups: 0, groupValues: 0, numberRandomized: false };
  const groupTargets = new Set(draft.arms.map((arm) => armTarget(arm.key)));
  let groupValues = 0;
  for (const key of new Set([...baseValues.keys(), ...draft.values.keys()])) {
    if (!groupTargets.has(parseValueKey(key).target)) continue;
    const { edit } = viewValue(baseValues, draft, key);
    if (!edit.cleared && edit.state !== null) groupValues += 1;
  }
  const nKey = valueKey(STUDY_TARGET, "n_randomized");
  const n = viewValue(baseValues, draft, nKey).edit;
  return { groups: draft.arms.length, groupValues, numberRandomized: !n.cleared && n.state !== null };
}

/**
 * Move the draft to `profile`, removing the groups and clearing the number
 * randomized when the new family has neither. The caller asks the user first
 * (`familyChangeImpact`); nothing is removed without that confirmation.
 */
export function changeFamily(
  baseValues: ReadonlyMap<string, RecordedValue>,
  draft: StudyRecordDraft,
  profile: DesignProfile,
): StudyRecordDraft {
  let next = updateHeader(draft, { designProfile: profile });
  if (isInterventionFamily(profile)) return next;
  for (const arm of [...next.arms]) next = removeArm(next, arm.key);
  const nKey = valueKey(STUDY_TARGET, "n_randomized");
  const recorded = baseValues.get(nKey);
  if (recorded) next = setValueEdit(baseValues, next, nKey, { ...NOT_RECORDED_EDIT, cleared: true });
  else next = revertValue(next, nKey);
  return next;
}

/** The value a group of `role` cannot hold: `comparator_type` on a non-comparator. */
export function valuesDisallowedForRole(
  baseValues: ReadonlyMap<string, RecordedValue>,
  draft: StudyRecordDraft,
  armKey: string,
  role: ArmRole,
): FieldKey[] {
  if (role === "comparator") return [];
  const key = valueKey(armTarget(armKey), "comparator_type");
  const { edit } = viewValue(baseValues, draft, key);
  return !edit.cleared && edit.state !== null ? ["comparator_type"] : [];
}

/** Change a group's role, clearing what the new role cannot hold (after the user agreed). */
export function changeArmRole(
  baseValues: ReadonlyMap<string, RecordedValue>,
  draft: StudyRecordDraft,
  armKey: string,
  role: ArmRole,
): StudyRecordDraft {
  let next = updateArm(draft, armKey, { role });
  for (const fieldKey of valuesDisallowedForRole(baseValues, next, armKey, role)) {
    const key = valueKey(armTarget(armKey), fieldKey);
    next = baseValues.has(key) ? setValueEdit(baseValues, next, key, { ...NOT_RECORDED_EDIT, cleared: true }) : revertValue(next, key);
  }
  return next;
}
