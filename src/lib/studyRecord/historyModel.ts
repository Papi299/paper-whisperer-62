/**
 * What History can honestly say about one change event (EVIDENCE-RECORDS-001C2B).
 *
 * Pure: a mapped `HistoryEvent` and the record as loaded now go in; a
 * description comes out, which `historyCopy.ts` puts into words. Nothing here
 * reads the network, the clock or the editor's draft.
 *
 * WHAT HISTORY HOLDS (PR-A2 and PR-A3 §HISTORY). The study label and the names
 * of groups and outcomes are recorded as written. Codes, whole numbers, states,
 * review statuses, ids, versions and copy numbers are recorded in clear. Every
 * other user text — values, list entries, notes, review notes, locators — and
 * every quote is recorded only as `{sha256, chars}` (a list as `{sha256,
 * count}`). So History can say that a value's text changed, and never what it
 * said: a fingerprint is compared for equality and then dropped — it is never
 * shown, decoded or treated as text.
 *
 * NEVER TODAY'S STATE PRESENTED AS THEN. What an event established is
 * described as history. What it does not hold is not filled in from the
 * current record: a value event names its group only by id, so the group is
 * described by its CURRENT name, marked as current (`HistoryTarget.current`),
 * or as removed; a linked paper is described by its current title, marked the
 * same way. No current value, note or review note ever stands in for an
 * earlier one.
 *
 * FAILS CLOSED, PER EVENT. Every digest is untrusted JSON. Only the fields
 * described here are read, each after checking its type, its vocabulary and
 * the rules the writing RPC follows (a save always leaves a value Not
 * reviewed, a Flag always has a note, before and after describe one value…);
 * unknown fields are ignored and never shown. An event whose details fail any
 * check is `unreadable`: it keeps its type, which the row's CHECK established,
 * and says nothing more. `review_reset` is in the vocabulary but no installed
 * RPC writes it (a save records the review it cleared in `value_saved`), so it
 * is `unreadable` too, whatever it holds.
 */

import {
  EVIDENCE_FIELDS,
  isArmRole,
  isDesignProfile,
  isFieldKey,
  type ArmRole,
  type DesignProfile,
  type FieldDefinition,
  type FieldKey,
} from "@/lib/evidence/fieldDictionary";
import { isCanonicalUuid, MAX_POSTGRES_INTEGER } from "@/lib/evidence/ids";
import { codePointLength } from "@/lib/evidence/normalization";
import {
  isLinkStatus,
  isLocatorKind,
  isReferencePurpose,
  isReferenceSourceKind,
  isReviewStatus,
  isStateReason,
  isValueState,
  type EventType,
  type HistoryEvent,
  type LinkStatus,
  type ReferencePurpose,
  type ReferenceSourceKind,
  type ReviewStatus,
  type StateReason,
  type ValueState,
  type ValueTarget,
} from "@/lib/evidence/types";
import type { StudyRecordData } from "./read";

// ── The record as loaded now ─────────────────────────────────────────────────

/** What History may name from the record as loaded now — always marked as current. */
export interface HistoryContext {
  readonly arms: ReadonlyMap<string, { readonly name: string; readonly role: ArmRole }>;
  readonly outcomes: ReadonlyMap<string, { readonly name: string }>;
  /** Each linked paper's title in the library (null when it couldn't be read). */
  readonly papers: ReadonlyMap<string, { readonly title: string | null }>;
  /** Each recorded value's target. A value's target never changes. */
  readonly values: ReadonlyMap<string, ValueTarget>;
}

export function historyContextOf(record: StudyRecordData): HistoryContext {
  return Object.freeze({
    arms: new Map(record.arms.map((arm) => [arm.id as string, Object.freeze({ name: arm.displayLabel, role: arm.role })])),
    outcomes: new Map(record.outcomes.map((outcome) => [outcome.id as string, Object.freeze({ name: outcome.displayLabel })])),
    papers: new Map(record.links.map((link) => [link.link.paperId as string, Object.freeze({ title: link.paperTitle })])),
    values: new Map(record.values.map((value) => [value.id as string, value.target])),
  });
}

// ── Descriptions ─────────────────────────────────────────────────────────────

/** What a change was about, named only as History can honestly name it. */
export type HistoryTarget =
  | { readonly scope: "study" }
  /** A group. `current` is its name and role in the record as loaded now — never its name back then; null once it no longer exists. */
  | { readonly scope: "arm"; readonly current: { readonly name: string; readonly role: ArmRole } | null }
  | { readonly scope: "outcome"; readonly current: { readonly name: string } | null }
  /** History doesn't record it, and the record no longer says (an anchor event of a value since cleared). */
  | { readonly scope: "unknown" };

export interface HistoryField {
  /** Null for a key this version of PaperLume doesn't know. */
  readonly fieldKey: FieldKey | null;
  readonly target: HistoryTarget;
}

/** A linked paper, by the identity the event recorded. `current` holds its title today, while it is still linked. */
export interface HistoryPaper {
  readonly current: { readonly title: string | null } | null;
}

/** A group's or outcome's name: as the event recorded it, or — when the event doesn't hold it — as it is now. */
export type HistoryName = { readonly source: "event"; readonly name: string } | { readonly source: "current"; readonly name: string } | null;

export interface Pair<T> {
  readonly from: T;
  readonly to: T;
}

/** What a saved value's digest lets History say about its content. Never its text. */
export type SnapshotContent =
  | { readonly shape: "code"; readonly code: string }
  | { readonly shape: "number"; readonly value: number }
  | { readonly shape: "text"; readonly chars: number }
  | { readonly shape: "list"; readonly entries: number };

export interface SourceCounts {
  /** Quotes from a saved copy of an abstract. */
  readonly quotes: number;
  /** Full-text locations the user gave. */
  readonly fullText: number;
  readonly examined: number;
  readonly unavailable: number;
}

export type ClearedReview = Exclude<ReviewStatus, "unreviewed">;

/** How a note compares between before and after, by fingerprint: never its text. */
export type NoteChange = "added" | "changed" | "removed" | "unchanged" | "none";

export interface ValueSaved {
  /** No value existed before: this save recorded it. */
  readonly created: boolean;
  readonly state: { readonly from: ValueState | null; readonly to: ValueState };
  /** An Unclear value's reason, before and after. */
  readonly stateReason: { readonly from: StateReason | null; readonly to: StateReason | null };
  readonly content: { readonly from: SnapshotContent | null; readonly to: SnapshotContent | null; readonly changed: boolean };
  readonly note: NoteChange;
  readonly sources: { readonly to: SourceCounts; readonly changed: boolean };
  /** The review this save cleared: any saved change returns a value to Not reviewed. */
  readonly reviewCleared: ClearedReview | null;
}

export type ReviewChange = "confirmed" | "flagged" | "needs_rereview";

export type HistoryChange =
  | { readonly kind: "study_created"; readonly label: string; readonly designProfile: DesignProfile }
  | {
      readonly kind: "study_updated";
      readonly label: Pair<string> | null;
      readonly designProfile: Pair<DesignProfile> | null;
      readonly notes: "added" | "changed" | "removed" | null;
    }
  | { readonly kind: "link_created"; readonly paper: HistoryPaper; readonly status: LinkStatus }
  | { readonly kind: "link_status_changed"; readonly paper: HistoryPaper; readonly status: Pair<LinkStatus> }
  | { readonly kind: "link_removed"; readonly paper: HistoryPaper; readonly status: LinkStatus; readonly copies: number }
  /** A saved copy of a linked paper's abstract. `first`: no earlier copy (at creation); otherwise a rebase's new copy. */
  | { readonly kind: "source_captured"; readonly paper: HistoryPaper; readonly seq: number; readonly chars: number; readonly first: boolean }
  | {
      readonly kind: "source_rebased";
      readonly paper: HistoryPaper;
      /** No earlier copy (`previous_snapshot_id` null): this rebase saved the link's first copy, so it had no quote to recheck. */
      readonly first: boolean;
      /** Quotes on the copy it replaced, each looked for in the new one: `rematched + notFound + ambiguous`. */
      readonly rechecked: number;
      readonly rematched: number;
      readonly notFound: number;
      readonly ambiguous: number;
      /** Values it moved to Needs re-review — never those already there, which it leaves as they were. */
      readonly needRereview: number;
    }
  | { readonly kind: "anchor_rematched"; readonly field: HistoryField; readonly seq: Pair<number> }
  | { readonly kind: "anchor_not_rematched"; readonly field: HistoryField; readonly keptSeq: number; readonly outcome: "not_found" | "ambiguous" | "invalid" }
  | { readonly kind: "group_added"; readonly name: string; readonly role: ArmRole }
  | { readonly kind: "group_updated"; readonly name: HistoryName; readonly renamed: Pair<string> | null; readonly role: Pair<ArmRole> | null; readonly moved: boolean }
  | { readonly kind: "group_removed"; readonly name: string; readonly role: ArmRole; readonly values: number }
  | { readonly kind: "outcome_added"; readonly name: string }
  | { readonly kind: "outcome_updated"; readonly name: HistoryName; readonly renamed: Pair<string> | null; readonly moved: boolean }
  | { readonly kind: "outcome_removed"; readonly name: string; readonly values: number }
  | { readonly kind: "value_saved"; readonly field: HistoryField; readonly saved: ValueSaved }
  | { readonly kind: "value_cleared"; readonly field: HistoryField; readonly state: ValueState; readonly stateReason: StateReason | null; readonly reviewCleared: ClearedReview | null }
  /** One value's review: what it became, what it was, and how its review note compares. */
  | { readonly kind: "review"; readonly change: ReviewChange; readonly field: HistoryField; readonly from: ReviewStatus; readonly note: NoteChange }
  /** A known event whose details this version can't read — and `review_reset`, which no installed RPC writes. */
  | { readonly kind: "unreadable"; readonly type: Exclude<EventType, "request">; readonly field: HistoryField | null };

// ── Untrusted JSON ───────────────────────────────────────────────────────────

type Json = Readonly<Record<string, unknown>>;

const isObject = (value: unknown): value is Json => value !== null && typeof value === "object" && !Array.isArray(value);
const isNat = (value: unknown, min = 0, max = MAX_POSTGRES_INTEGER): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
const SHA256 = /^[0-9a-f]{64}$/;

/** A refusal inside a parser: the event becomes `unreadable`. */
class Unreadable extends Error {}
function need<T>(value: T | null | undefined | false): T {
  if (value === null || value === undefined || value === false) throw new Unreadable();
  return value;
}

/** `{sha256, chars}`: a text's fingerprint and length — never the text. */
function textDigest(value: unknown): { readonly sha256: string; readonly chars: number } | null {
  if (!isObject(value) || typeof value.sha256 !== "string" || !SHA256.test(value.sha256) || !isNat(value.chars, 1)) return null;
  return { sha256: value.sha256, chars: value.chars };
}
function optionalTextDigest(value: unknown): { readonly sha256: string; readonly chars: number } | null {
  return value === null ? null : need(textDigest(value));
}

function label(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim() !== "" && codePointLength(value) <= max ? value : null;
}
const uuid = (value: unknown): string | null => (isCanonicalUuid(value) ? value.toLowerCase() : null);

/** The keys that differ between a before and an after: the same set, at least one, all from `allowed`. */
function changedKeys(before: unknown, after: unknown, allowed: readonly string[]): string[] {
  const from = need(isObject(before) && before);
  const to = need(isObject(after) && after);
  const keys = Object.keys(to).filter((key) => allowed.includes(key));
  const fromKeys = Object.keys(from).filter((key) => allowed.includes(key));
  need(keys.length > 0 && keys.length === fromKeys.length && keys.every((key) => fromKeys.includes(key)));
  return keys;
}

// ── One value, as `evidence_value_digest` records it ─────────────────────────

interface ParsedReference {
  readonly purpose: ReferencePurpose;
  readonly sourceKind: ReferenceSourceKind;
  /** Compared for equality only. */
  readonly signature: string;
}

interface ValueDigest {
  readonly valueId: string;
  readonly fieldKey: string;
  readonly armId: string | null;
  readonly outcomeId: string | null;
  readonly state: ValueState;
  readonly stateReason: StateReason | null;
  readonly content: SnapshotContent | null;
  /** Compared for equality only; null when there is no content. */
  readonly contentPrint: string | null;
  readonly notePrint: string | null;
  readonly reviewStatus: ReviewStatus;
  readonly reviewNotePrint: string | null;
  readonly references: readonly ParsedReference[];
}

function parseContent(fieldKey: string, state: ValueState, value: unknown): { readonly content: SnapshotContent | null; readonly print: string | null } {
  if (state !== "reported") {
    need(value === null);
    return { content: null, print: null };
  }
  const content = need(isObject(value) && value);
  // The field's own shape decides what its content may be; a key this version doesn't know has none.
  const definition: FieldDefinition | null = isFieldKey(fieldKey) ? EVIDENCE_FIELDS[fieldKey] : null;
  const shape = definition?.shape ?? null;
  if ("code" in content) {
    const code = need(typeof content.code === "string" && content.code);
    need(definition !== null && definition.shape === "code" && definition.codes.includes(code));
    return { content: { shape: "code", code }, print: `code:${code}` };
  }
  if ("entries" in content) {
    need(shape === "text_list");
    const entries = need(isObject(content.entries) && content.entries);
    need(typeof entries.sha256 === "string" && SHA256.test(entries.sha256) && isNat(entries.count, 1));
    return { content: { shape: "list", entries: entries.count as number }, print: `list:${entries.sha256 as string}` };
  }
  if ("value" in content || "reported_text" in content) {
    if (definition === null || definition.shape !== "integer_with_reported_text") throw new Unreadable();
    const number = content.value;
    need(isNat(number, definition.integer.min, definition.integer.max));
    const reported = need(textDigest(content.reported_text));
    return { content: { shape: "number", value: number as number }, print: `number:${number as number}:${reported.sha256}` };
  }
  need(shape === "text");
  const text = need(textDigest(content.text));
  return { content: { shape: "text", chars: text.chars }, print: `text:${text.sha256}` };
}

function parseReference(value: unknown): ParsedReference {
  const reference = need(isObject(value) && value);
  const purpose = need(isReferencePurpose(reference.purpose) && reference.purpose);
  const sourceKind = need(isReferenceSourceKind(reference.source_kind) && reference.source_kind);
  const anchorId = need(uuid(reference.anchor_id));
  const paperId = need(uuid(reference.paper_id));
  const snapshotId = reference.snapshot_id === null ? null : need(uuid(reference.snapshot_id));
  const position = reference.position === null ? null : need(isNat(reference.position, 0, 2) && (reference.position as number));
  // A quote and a locator are recorded as fingerprints, or not at all.
  const quote = reference.quote === null ? null : need(textDigest(reference.quote));
  const locator = reference.locator;
  const locatorText = locator === null ? null : need(isObject(locator) && isLocatorKind(locator.kind) && textDigest(locator.text));
  const signature = [anchorId, purpose, sourceKind, paperId, snapshotId ?? "", String(position ?? ""), quote?.sha256 ?? "", locatorText?.sha256 ?? ""].join("|");
  return { purpose, sourceKind, signature };
}

function parseValueDigest(value: unknown): ValueDigest {
  const digest = need(isObject(value) && value);
  const valueId = need(uuid(digest.value_id));
  const fieldKey = need(typeof digest.field_key === "string" && digest.field_key !== "" && digest.field_key);
  const armId = digest.arm_id === null ? null : need(uuid(digest.arm_id));
  const outcomeId = digest.outcome_id === null ? null : need(uuid(digest.outcome_id));
  need(armId === null || outcomeId === null);
  if (isFieldKey(fieldKey)) need(EVIDENCE_FIELDS[fieldKey].scope === (armId ? "arm" : outcomeId ? "outcome" : "study"));
  const state = need(isValueState(digest.value_state) && digest.value_state);
  const stateReason = digest.state_reason === null ? null : need(isStateReason(digest.state_reason) && digest.state_reason);
  need((state === "unclear") === (stateReason !== null));
  const { content, print } = parseContent(fieldKey, state, digest.content);
  const note = optionalTextDigest(digest.note);
  const review = need(isObject(digest.review) && digest.review);
  const reviewStatus = need(isReviewStatus(review.status) && review.status);
  const reviewNote = optionalTextDigest(review.note);
  const references = need(Array.isArray(digest.references) && digest.references).map(parseReference);
  return {
    valueId,
    fieldKey,
    armId,
    outcomeId,
    state,
    stateReason,
    content,
    contentPrint: print,
    notePrint: note?.sha256 ?? null,
    reviewStatus,
    reviewNotePrint: reviewNote?.sha256 ?? null,
    references,
  };
}

function countSources(references: readonly ParsedReference[]): SourceCounts {
  const count = (test: (reference: ParsedReference) => boolean) => references.filter(test).length;
  return Object.freeze({
    quotes: count((r) => r.purpose === "supports" && r.sourceKind === "abstract"),
    fullText: count((r) => r.purpose === "supports" && r.sourceKind === "full_text"),
    examined: count((r) => r.purpose === "examined"),
    unavailable: count((r) => r.purpose === "unavailable"),
  });
}

// ── Naming against the record as loaded now ──────────────────────────────────

function targetOf(context: HistoryContext, armId: string | null, outcomeId: string | null): HistoryTarget {
  if (armId) return { scope: "arm", current: context.arms.get(armId) ?? null };
  if (outcomeId) return { scope: "outcome", current: context.outcomes.get(outcomeId) ?? null };
  return { scope: "study" };
}

function fieldOf(context: HistoryContext, event: HistoryEvent, digest: ValueDigest): HistoryField {
  // The row's field key and target must be the digest's: one value, described once.
  need(event.fieldKey === digest.fieldKey && uuid(event.targetId) === digest.valueId);
  return { fieldKey: isFieldKey(digest.fieldKey) ? digest.fieldKey : null, target: targetOf(context, digest.armId, digest.outcomeId) };
}

/** An anchor event names its value by id only: its target is the value's, if the value is still recorded. */
function anchorFieldOf(context: HistoryContext, event: HistoryEvent, valueId: string): HistoryField {
  const fieldKey = need(event.fieldKey);
  const target = context.values.get(valueId);
  const named: HistoryTarget = !target
    ? isFieldKey(fieldKey) && EVIDENCE_FIELDS[fieldKey].scope === "study"
      ? { scope: "study" }
      : { scope: "unknown" }
    : target.scope === "arm"
      ? targetOf(context, target.armId, null)
      : target.scope === "outcome"
        ? targetOf(context, null, target.outcomeId)
        : { scope: "study" };
  return { fieldKey: isFieldKey(fieldKey) ? fieldKey : null, target: named };
}

function paperOf(context: HistoryContext, paperId: unknown): HistoryPaper {
  const id = need(uuid(paperId));
  return { current: context.papers.get(id) ?? null };
}

// ── The events ───────────────────────────────────────────────────────────────

function noteChange(before: string | null, after: string | null): NoteChange {
  if (before === after) return after === null ? "none" : "unchanged";
  return before === null ? "added" : after === null ? "removed" : "changed";
}

/** Both digests describe the same value. */
function sameValue(before: ValueDigest, after: ValueDigest): boolean {
  return before.valueId === after.valueId && before.fieldKey === after.fieldKey && before.armId === after.armId && before.outcomeId === after.outcomeId;
}

function describeValueSaved(context: HistoryContext, event: HistoryEvent): HistoryChange {
  const after = parseValueDigest(event.after);
  const field = fieldOf(context, event, after);
  // A save always leaves the value Not reviewed, with no review note (PR-A3 phase 5).
  need(after.reviewStatus === "unreviewed" && after.reviewNotePrint === null);
  const before = event.before === null ? null : parseValueDigest(event.before);
  if (before) need(sameValue(before, after));
  const sources = (digest: ValueDigest | null) => (digest ? digest.references.map((r) => r.signature).join("\n") : null);
  return {
    kind: "value_saved",
    field,
    saved: Object.freeze({
      created: before === null,
      state: { from: before?.state ?? null, to: after.state },
      stateReason: { from: before?.stateReason ?? null, to: after.stateReason },
      content: { from: before?.content ?? null, to: after.content, changed: before !== null && before.contentPrint !== after.contentPrint },
      note: noteChange(before?.notePrint ?? null, after.notePrint),
      sources: { to: countSources(after.references), changed: before !== null && sources(before) !== sources(after) },
      reviewCleared: before && before.reviewStatus !== "unreviewed" ? before.reviewStatus : null,
    }),
  };
}

function describeValueCleared(context: HistoryContext, event: HistoryEvent): HistoryChange {
  need(event.after === null);
  const before = parseValueDigest(event.before);
  return {
    kind: "value_cleared",
    field: fieldOf(context, event, before),
    state: before.state,
    stateReason: before.stateReason,
    reviewCleared: before.reviewStatus !== "unreviewed" ? before.reviewStatus : null,
  };
}

const REVIEW_RESULT: Readonly<Record<"review_confirmed" | "review_flagged" | "review_needs_rereview", { change: ReviewChange; status: ReviewStatus }>> = {
  review_confirmed: { change: "confirmed", status: "user_reviewed" },
  review_flagged: { change: "flagged", status: "disputed" },
  review_needs_rereview: { change: "needs_rereview", status: "needs_rereview" },
};

function describeReview(context: HistoryContext, event: HistoryEvent, type: keyof typeof REVIEW_RESULT): HistoryChange {
  const before = parseValueDigest(event.before);
  const after = parseValueDigest(event.after);
  const field = fieldOf(context, event, after);
  need(sameValue(before, after));
  const { change, status } = REVIEW_RESULT[type];
  need(after.reviewStatus === status);
  // A review changes no value: its state, content and note stay as they were.
  need(before.state === after.state && before.contentPrint === after.contentPrint && before.notePrint === after.notePrint);
  // A Flag always has a note (PR-A1 review_note_check).
  if (change === "flagged") need(after.reviewNotePrint !== null);
  return { kind: "review", change, field, from: before.reviewStatus, note: noteChange(before.reviewNotePrint, after.reviewNotePrint) };
}

function describeStudy(event: HistoryEvent): HistoryChange {
  if (event.type === "study_created") {
    need(event.before === null);
    const after = need(isObject(event.after) && event.after);
    return {
      kind: "study_created",
      label: need(label(after.label, 120)),
      designProfile: need(isDesignProfile(after.design_profile) && after.design_profile),
    };
  }
  const keys = changedKeys(event.before, event.after, ["label", "design_profile", "notes"]);
  const before = event.before as Json;
  const after = event.after as Json;
  const notes = (value: unknown) => (value === null ? null : need(textDigest(value)).sha256);
  let notesChange: "added" | "changed" | "removed" | null = null;
  if (keys.includes("notes")) {
    const [from, to] = [notes(before.notes), notes(after.notes)];
    need(from !== to);
    notesChange = from === null ? "added" : to === null ? "removed" : "changed";
  }
  const pairOf = <T>(key: string, read: (value: unknown) => T | null): Pair<T> | null => {
    if (!keys.includes(key)) return null;
    const pair = { from: need(read(before[key])), to: need(read(after[key])) };
    need(pair.from !== pair.to);
    return pair;
  };
  return {
    kind: "study_updated",
    label: pairOf("label", (value) => label(value, 120)),
    designProfile: pairOf("design_profile", (value) => (isDesignProfile(value) ? value : null)),
    notes: notesChange,
  };
}

function describeLink(context: HistoryContext, event: HistoryEvent): HistoryChange {
  if (event.type === "link_created") {
    need(event.before === null);
    const after = need(isObject(event.after) && event.after);
    return { kind: "link_created", paper: paperOf(context, after.paper_id), status: need(isLinkStatus(after.link_status) && after.link_status) };
  }
  if (event.type === "link_status_changed") {
    const before = need(isObject(event.before) && event.before);
    const after = need(isObject(event.after) && event.after);
    need(uuid(before.paper_id) !== null && uuid(before.paper_id) === uuid(after.paper_id));
    const from = need(isLinkStatus(before.link_status) && before.link_status);
    const to = need(isLinkStatus(after.link_status) && after.link_status);
    need(from !== to);
    return { kind: "link_status_changed", paper: paperOf(context, after.paper_id), status: { from, to } };
  }
  need(event.after === null);
  const before = need(isObject(event.before) && event.before);
  const copies = need(Array.isArray(before.snapshot_ids) && before.snapshot_ids);
  need(copies.every((id) => uuid(id) !== null));
  return { kind: "link_removed", paper: paperOf(context, before.paper_id), status: need(isLinkStatus(before.link_status) && before.link_status), copies: copies.length };
}

function describeSource(context: HistoryContext, event: HistoryEvent): HistoryChange {
  need(event.before === null);
  const after = need(isObject(event.after) && event.after);
  if (event.type === "source_captured") {
    need(after.source_kind === "library_abstract");
    const previous = after.previous_snapshot_id === null ? null : need(uuid(after.previous_snapshot_id));
    return {
      kind: "source_captured",
      paper: paperOf(context, after.paper_id),
      seq: need(isNat(after.seq, 1) && after.seq),
      chars: need(isNat(after.char_count, 1, 50_000) && after.char_count),
      first: previous === null,
    };
  }
  const count = (key: string) => {
    const value = after[key];
    need(isNat(value));
    return value as number;
  };
  const previous = after.previous_snapshot_id === null ? null : need(uuid(after.previous_snapshot_id));
  return {
    kind: "source_rebased",
    paper: paperOf(context, after.paper_id),
    first: previous === null,
    rechecked: count("quotes_rechecked"),
    rematched: count("rematched"),
    notFound: count("not_found"),
    ambiguous: count("ambiguous"),
    needRereview: count("values_needing_rereview"),
  };
}

function describeAnchor(context: HistoryContext, event: HistoryEvent): HistoryChange {
  const after = need(isObject(event.after) && event.after);
  const valueId = need(uuid(after.value_id));
  const field = anchorFieldOf(context, event, valueId);
  if (event.type === "anchor_rematched") {
    const before = need(isObject(event.before) && event.before);
    need(uuid(before.value_id) === valueId);
    const from = need(isNat(before.seq, 1) && before.seq);
    const to = need(isNat(after.seq, 1) && after.seq);
    need(to > from);
    return { kind: "anchor_rematched", field, seq: { from, to } };
  }
  need(event.before === null);
  const outcome = after.outcome;
  need(outcome === "not_found" || outcome === "ambiguous" || outcome === "invalid");
  return { kind: "anchor_not_rematched", field, keptSeq: need(isNat(after.kept_seq, 1) && after.kept_seq), outcome: outcome as "not_found" | "ambiguous" | "invalid" };
}

function describeStructure(context: HistoryContext, event: HistoryEvent): HistoryChange {
  const group = event.type.startsWith("arm_");
  const max = group ? 120 : 200;
  const current = (): HistoryName => {
    const id = need(uuid(event.targetId));
    const now = group ? context.arms.get(id) : context.outcomes.get(id);
    return now ? { source: "current", name: now.name } : null;
  };
  if (event.type === "arm_added" || event.type === "outcome_added") {
    need(event.before === null);
    const after = need(isObject(event.after) && event.after);
    need(isNat(after.position, 0, 99));
    const name = need(label(after.display_label, max));
    return group ? { kind: "group_added", name, role: need(isArmRole(after.arm_role) && after.arm_role) } : { kind: "outcome_added", name };
  }
  if (event.type === "arm_removed" || event.type === "outcome_removed") {
    need(event.after === null);
    const before = need(isObject(event.before) && event.before);
    const name = need(label(before.display_label, max));
    const values = need(Array.isArray(before.values) && before.values);
    return group
      ? { kind: "group_removed", name, role: need(isArmRole(before.arm_role) && before.arm_role), values: values.length }
      : { kind: "outcome_removed", name, values: values.length };
  }
  const keys = changedKeys(event.before, event.after, group ? ["arm_role", "display_label", "position"] : ["display_label", "position"]);
  const before = event.before as Json;
  const after = event.after as Json;
  const renamed = keys.includes("display_label") ? { from: need(label(before.display_label, max)), to: need(label(after.display_label, max)) } : null;
  if (renamed) need(renamed.from !== renamed.to);
  const moved = keys.includes("position");
  if (moved) need(isNat(before.position, 0, 99) && isNat(after.position, 0, 99) && before.position !== after.position);
  const name: HistoryName = renamed ? { source: "event", name: renamed.to } : current();
  if (!group) return { kind: "outcome_updated", name, renamed, moved };
  const role = keys.includes("arm_role") ? { from: need(isArmRole(before.arm_role) && before.arm_role), to: need(isArmRole(after.arm_role) && after.arm_role) } : null;
  if (role) need(role.from !== role.to);
  return { kind: "group_updated", name, renamed, role, moved };
}

/** A field named by an unreadable value event, when its own row says so plainly. */
function fallbackField(context: HistoryContext, event: HistoryEvent): HistoryField | null {
  if (!event.fieldKey) return null;
  const fieldKey = isFieldKey(event.fieldKey) ? event.fieldKey : null;
  return { fieldKey, target: fieldKey && EVIDENCE_FIELDS[fieldKey].scope === "study" ? { scope: "study" } : { scope: "unknown" } };
}

/** What History says about one change event (never a request header). */
export function describeHistoryChange(event: HistoryEvent, context: HistoryContext): HistoryChange {
  if (event.type === "request") throw new TypeError("a request header is not a change");
  const type = event.type;
  try {
    // Every change an installed RPC writes names its target; only value, review and anchor events name a field.
    if (type !== "review_reset") need(uuid(event.targetId));
    switch (type) {
      case "study_created":
      case "study_updated":
        need(event.fieldKey === null);
        return describeStudy(event);
      case "link_created":
      case "link_status_changed":
      case "link_removed":
        need(event.fieldKey === null);
        return describeLink(context, event);
      case "source_captured":
      case "source_rebased":
        need(event.fieldKey === null);
        return describeSource(context, event);
      case "anchor_rematched":
      case "anchor_not_rematched":
        return describeAnchor(context, event);
      case "arm_added":
      case "arm_updated":
      case "arm_removed":
      case "outcome_added":
      case "outcome_updated":
      case "outcome_removed":
        need(event.fieldKey === null);
        return describeStructure(context, event);
      case "value_saved":
        return describeValueSaved(context, event);
      case "value_cleared":
        return describeValueCleared(context, event);
      case "review_confirmed":
      case "review_flagged":
      case "review_needs_rereview":
        return describeReview(context, event, type);
      case "review_reset":
        // In the vocabulary, written by no installed RPC: nothing about it can be read with confidence.
        return { kind: "unreadable", type, field: fallbackField(context, event) };
    }
  } catch (error) {
    if (!(error instanceof Unreadable)) throw error;
    return { kind: "unreadable", type, field: fallbackField(context, event) };
  }
}
