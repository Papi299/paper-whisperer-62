/**
 * Review mode's pure model (EVIDENCE-RECORDS-001C2A; Requirements-001A §I,
 * FK-PROOF-001 §J).
 *
 * Review is of SAVED values only. Every item here is built from the record as
 * read (`StudyRecordData`) — the persisted value, its persisted references and
 * the saved copies they name — and never from the draft. The draft is read for
 * one thing: whether a saved value has an unsaved edit, or belongs to a group
 * or outcome the draft removes, in which case its actions wait until the edit
 * is saved or undone. A quote the user added, removed or changed in the draft
 * therefore can never appear here as the evidence a Confirm is made against.
 *
 * The rules decide only what is OFFERED. The PR-A3 review RPC
 * (`evidence_review_fields`) re-checks everything, binds the review to the
 * value's exact `value_version`, and its answer stands:
 *   * Confirm is offered only to a user who may write, while the editor is
 *     idle, for a value with no unsaved edit or pending removal, when PR-B's
 *     `checkConfirm` allows it — which counts sources through the shared
 *     `checkStateReferences`, so an empty list of references never satisfies a
 *     required source. A version already reviewed offers no Confirm at all.
 *   * Flag is offered under the same conditions; its note is checked by
 *     `checkFlag` where it is typed.
 *   * Nothing here ever confirms anything, and there is no record-level
 *     status: the summary counts values by their own review status.
 */

import { EVIDENCE_FIELDS, FIELD_KEYS, type ArmRole, type FieldKey, type FieldSection } from "@/lib/evidence/fieldDictionary";
import type { AnchorId, ArmId, OutcomeId, PaperId, ValueId } from "@/lib/evidence/ids";
import { storedMatchContext, type QuoteContext } from "@/lib/evidence/matcher";
import { normalizeEvidenceV1WithMap, type NormalizationMap } from "@/lib/evidence/normalization";
import { checkConfirm, type ConfirmBlock } from "@/lib/evidence/review";
import { summarizeSupport } from "@/lib/evidence/states";
import type { FullTextLocator, RecordedValue, ReferenceSourceKind, ReviewStatus, StoredReference } from "@/lib/evidence/types";
import { valueKey, type StudyRecordDraft } from "./draft";
import { targetIdOf, type SnapshotInfo, type StudyRecordData, type StudyRecordLink } from "./read";
import { linkSourcesOf } from "./validateDraft";

/** Code points of context shown on each side of a quote: about a sentence (001A §I3). */
export const REVIEW_QUOTE_CONTEXT_LENGTH = 100;

export type ReviewFilter = "needs_review" | "all";

/** What the editor is doing, reduced to whether a review may start. */
export type ReviewActivity =
  | "idle"
  /** A save, link change, deletion or review is in flight. */
  | "busy"
  /** An earlier action's outcome is unknown, or the record must be reloaded before going on. */
  | "unresolved"
  /** The record was changed elsewhere (a version conflict, or a change seen on reading it back). */
  | "changed_elsewhere";

export interface ReviewContext {
  /** Whether Confirm and Flag may be offered at all: the owner pilot, mirrored, and a record still writable. */
  readonly canWrite: boolean;
  readonly activity: ReviewActivity;
}

/** Why a card's actions wait, besides the value's own Confirm blocks. Listed in the order they are checked. */
export const REVIEW_HOLDS = [
  "busy",
  "unresolved",
  "changed_elsewhere",
  "group_removal_pending",
  "outcome_removal_pending",
  "unsaved_edit",
] as const;
export type ReviewHold = (typeof REVIEW_HOLDS)[number];

/** What a value describes, with the SAVED name of its group or outcome. */
export type ReviewItemTarget =
  | { readonly scope: "study" }
  | { readonly scope: "arm"; readonly armId: ArmId; readonly role: ArmRole; readonly name: string }
  | { readonly scope: "outcome"; readonly outcomeId: OutcomeId; readonly name: string };

/** One saved copy of a link's abstract, as a reference names it. */
export interface ReviewCopy {
  /** The copy as read: its id, number and capture time. */
  readonly snapshot: SnapshotInfo;
  /** How many copies the link has. */
  readonly total: number;
  /** Whether it is the link's current copy — the only copy whose text this view holds. */
  readonly current: boolean;
}

export interface ReviewPaper {
  readonly paperId: PaperId;
  /** The paper's title in the library; null when it could not be read. */
  readonly title: string | null;
}

/** One persisted reference of a value, described for review. */
export type ReviewSource =
  | {
      readonly kind: "quote";
      readonly id: AnchorId;
      readonly paper: ReviewPaper;
      /** Null only if the copy is not among the link's copies, which the read refuses. */
      readonly copy: ReviewCopy | null;
      readonly quoteText: string;
      /** The server's match: which occurrence of how many. */
      readonly occurrence: number;
      readonly count: number;
      /** The passage in its copy with context, located by the server's offsets. Null unless the copy is the current one. */
      readonly context: QuoteContext | null;
    }
  | {
      readonly kind: "full_text";
      readonly id: AnchorId;
      readonly paper: ReviewPaper;
      readonly purpose: "supports" | "examined";
      /** The user's location in the full text; an examined full text may have none. */
      readonly locator: FullTextLocator | null;
    }
  | { readonly kind: "examined_abstract"; readonly id: AnchorId; readonly paper: ReviewPaper; readonly copy: ReviewCopy | null }
  | {
      readonly kind: "unavailable";
      readonly id: AnchorId;
      readonly paper: ReviewPaper;
      readonly sourceKind: ReferenceSourceKind;
      /** For the abstract: whether the link has a saved copy now (it had none when this was recorded). */
      readonly copyNow: boolean;
    };

export type ConfirmOffer =
  | { readonly kind: "offered" }
  | { readonly kind: "held"; readonly hold: ReviewHold }
  | { readonly kind: "blocked"; readonly reasons: readonly ConfirmBlock[] }
  /** This exact version is already reviewed: there is nothing to confirm (001A §I5). */
  | { readonly kind: "already_reviewed" }
  /** The user may not write: no action is offered. */
  | { readonly kind: "none" };

export type FlagOffer = { readonly kind: "offered" } | { readonly kind: "held"; readonly hold: ReviewHold } | { readonly kind: "none" };

export interface ReviewItem {
  /** The value's key in the editor (`valueKey`), for Edit and focus. */
  readonly key: string;
  /** The persisted value, exactly as read. Nothing else is shown as the value. */
  readonly value: RecordedValue;
  readonly fieldKey: FieldKey;
  readonly section: FieldSection;
  readonly target: ReviewItemTarget;
  /** Items with the same group are shown together: a section of the study, one group, or one outcome. */
  readonly groupId: string;
  /** The persisted references, in their stored order: supporting, then examined, then unavailable. */
  readonly sources: readonly ReviewSource[];
  /** Requirements-001 §F5: every supporting source is an abstract quote. */
  readonly fromAbstractOnly: boolean;
  /** The linked papers whose saved abstract this value refers to, in reference order. */
  readonly abstractPaperIds: readonly PaperId[];
  /** Not reviewed, flagged or needing re-review — anything but this version reviewed by you. */
  readonly needsReview: boolean;
  /** What `checkConfirm` says of the saved value, whoever is looking and whatever the editor is doing. */
  readonly confirmCheck: "allowed" | "already_reviewed" | "blocked";
  readonly confirm: ConfirmOffer;
  readonly flag: FlagOffer;
}

const SECTION_ORDER: readonly FieldSection[] = ["study_design", "participants", "interventions", "outcomes"];

function copyOf(link: StudyRecordLink | undefined, snapshotId: string): ReviewCopy | null {
  const snapshot = link?.snapshots.find((candidate) => candidate.id === snapshotId);
  if (!link || !snapshot) return null;
  return Object.freeze({ snapshot, total: link.snapshots.length, current: link.currentCopy?.id === snapshotId });
}

/** The value's references, described for review. Only the current copies' text is read. */
function describeSources(
  value: RecordedValue,
  links: ReadonlyMap<string, StudyRecordLink>,
  mapOf: (link: StudyRecordLink) => NormalizationMap | null,
): ReviewSource[] {
  return value.references.map((reference: StoredReference): ReviewSource => {
    const link = links.get(reference.paperId);
    const paper: ReviewPaper = Object.freeze({ paperId: reference.paperId, title: link?.paperTitle ?? null });
    if (reference.purpose === "supports" && reference.sourceKind === "abstract") {
      const copy = copyOf(link, reference.snapshotId);
      const map = copy?.current && link ? mapOf(link) : null;
      return Object.freeze({
        kind: "quote",
        id: reference.id,
        paper,
        copy,
        quoteText: reference.quoteText,
        occurrence: reference.match.occurrence,
        count: reference.match.count,
        context: map ? storedMatchContext(map, reference.match.normalizedStart, reference.match.normalizedEnd, REVIEW_QUOTE_CONTEXT_LENGTH) : null,
      });
    }
    if (reference.purpose === "supports") {
      return Object.freeze({ kind: "full_text", id: reference.id, paper, purpose: "supports", locator: reference.locator });
    }
    if (reference.purpose === "examined") {
      return reference.sourceKind === "abstract"
        ? Object.freeze({ kind: "examined_abstract", id: reference.id, paper, copy: copyOf(link, reference.snapshotId) })
        : Object.freeze({ kind: "full_text", id: reference.id, paper, purpose: "examined", locator: reference.locator });
    }
    return Object.freeze({
      kind: "unavailable",
      id: reference.id,
      paper,
      sourceKind: reference.sourceKind,
      copyNow: reference.sourceKind === "abstract" && !!link?.currentCopy,
    });
  });
}

/** The first hold of a value, in `REVIEW_HOLDS` order; null when nothing holds it. */
function holdOf(
  value: RecordedValue,
  key: string,
  draft: StudyRecordDraft,
  activity: ReviewActivity,
  removedArms: ReadonlySet<string>,
  removedOutcomes: ReadonlySet<string>,
): ReviewHold | null {
  if (activity !== "idle") return activity;
  if (value.target.scope === "arm" && removedArms.has(value.target.armId)) return "group_removal_pending";
  if (value.target.scope === "outcome" && removedOutcomes.has(value.target.outcomeId)) return "outcome_removal_pending";
  // An entry exists exactly when saving would change the value (draft.ts `setValueEdit`).
  if (draft.values.has(key)) return "unsaved_edit";
  return null;
}

/**
 * The persisted references of every value, described for review, by value id.
 * It depends on the record alone, so a caller can compute it once per read
 * rather than on every edit of the draft. Each current copy is normalized once.
 */
export function describeRecordSources(base: StudyRecordData): ReadonlyMap<string, readonly ReviewSource[]> {
  const links = new Map(base.links.map((link) => [link.link.paperId as string, link]));
  const maps = new Map<string, NormalizationMap>();
  const mapOf = (link: StudyRecordLink) => {
    const copy = link.currentCopy;
    if (!copy) return null;
    let map = maps.get(copy.id);
    if (!map) {
      map = normalizeEvidenceV1WithMap(copy.exactText);
      maps.set(copy.id, map);
    }
    return map;
  };
  return new Map(base.values.map((value) => [value.id as string, Object.freeze(describeSources(value, links, mapOf))]));
}

/**
 * One review item per persisted value, in display order: by section of the
 * field dictionary, then by target in saved order (the study; groups by
 * position; outcomes by position), then by field. `sources` must be
 * `describeRecordSources(base)` of the same `base`.
 */
export function buildReviewItems(
  base: StudyRecordData,
  draft: StudyRecordDraft,
  context: ReviewContext,
  sources: ReadonlyMap<string, readonly ReviewSource[]> = describeRecordSources(base),
): ReviewItem[] {
  const linkSources = linkSourcesOf(base);
  const arms = new Map(base.arms.map((arm, index) => [arm.id as string, { arm, index }]));
  const outcomes = new Map(base.outcomes.map((outcome, index) => [outcome.id as string, { outcome, index }]));
  const removedArms = new Set<string>(draft.removedArms.map((entry) => entry.id));
  const removedOutcomes = new Set<string>(draft.removedOutcomes.map((entry) => entry.id));

  const items = base.values.map((value) => {
    const key = valueKey(targetIdOf(value), value.fieldKey);
    let target: ReviewItemTarget;
    let section: FieldSection;
    let targetIndex = 0;
    let groupId: string;
    if (value.target.scope === "arm") {
      const found = arms.get(value.target.armId);
      target = { scope: "arm", armId: value.target.armId, role: found?.arm.role ?? "intervention", name: found?.arm.displayLabel ?? "" };
      section = "interventions";
      targetIndex = found?.index ?? 0;
      groupId = `arm:${value.target.armId}`;
    } else if (value.target.scope === "outcome") {
      const found = outcomes.get(value.target.outcomeId);
      target = { scope: "outcome", outcomeId: value.target.outcomeId, name: found?.outcome.displayLabel ?? "" };
      section = "outcomes";
      targetIndex = found?.index ?? 0;
      groupId = `outcome:${value.target.outcomeId}`;
    } else {
      target = { scope: "study" };
      section = EVIDENCE_FIELDS[value.fieldKey].section;
      groupId = `section:${section}`;
    }

    const check = checkConfirm(value, value.valueVersion, linkSources);
    const hold = holdOf(value, key, draft, context.activity, removedArms, removedOutcomes);
    let confirm: ConfirmOffer;
    if (!context.canWrite) confirm = { kind: "none" };
    else if (check.kind === "already_reviewed") confirm = { kind: "already_reviewed" };
    else if (hold) confirm = { kind: "held", hold };
    else if (check.kind === "blocked") confirm = { kind: "blocked", reasons: check.reasons };
    else confirm = { kind: "offered" };
    const flag: FlagOffer = !context.canWrite ? { kind: "none" } : hold ? { kind: "held", hold } : { kind: "offered" };

    const abstractPaperIds = [...new Set(value.references.filter((r) => r.sourceKind === "abstract").map((r) => r.paperId))];
    const item: ReviewItem = Object.freeze({
      key,
      value,
      fieldKey: value.fieldKey,
      section,
      target: Object.freeze(target),
      groupId,
      sources: sources.get(value.id) ?? Object.freeze([]),
      fromAbstractOnly: summarizeSupport(value).fromAbstractOnly,
      abstractPaperIds: Object.freeze(abstractPaperIds),
      needsReview: check.kind !== "already_reviewed",
      confirmCheck: check.kind,
      confirm: Object.freeze(confirm),
      flag: Object.freeze(flag),
    });
    return { item, order: [SECTION_ORDER.indexOf(section), targetIndex, FIELD_KEYS.indexOf(value.fieldKey)] };
  });

  items.sort((a, b) => a.order[0] - b.order[0] || a.order[1] - b.order[1] || a.order[2] - b.order[2]);
  return items.map((entry) => entry.item);
}

export interface ReviewSummary {
  /** Every persisted value. */
  readonly recorded: number;
  /** By each value's own review status. */
  readonly counts: Readonly<Record<ReviewStatus, number>>;
  /** Values whose saved content or sources block Confirm until they are edited and saved. */
  readonly cannotConfirmYet: number;
}

/** Counts of the persisted values, derived on every render and never stored. */
export function reviewSummary(items: readonly ReviewItem[]): ReviewSummary {
  const counts: Record<ReviewStatus, number> = { unreviewed: 0, user_reviewed: 0, disputed: 0, needs_rereview: 0 };
  for (const item of items) counts[item.value.review.status] += 1;
  return Object.freeze({
    recorded: items.length,
    counts: Object.freeze(counts),
    cannotConfirmYet: items.filter((item) => item.confirmCheck === "blocked").length,
  });
}

/**
 * The items a filter shows, and always those of `keep` (values with an open
 * Flag note, G3). Filtering never changes anything persisted.
 */
export function filterReviewItems(items: readonly ReviewItem[], filter: ReviewFilter, keep: readonly string[] = []): ReviewItem[] {
  return filter === "all" ? [...items] : items.filter((item) => item.needsReview || keep.includes(item.value.id));
}

/**
 * The item "Confirm & next" moves to: the first one after `afterKey` that
 * needs review, wrapping round to the start; never `afterKey` itself. Null
 * when nothing else needs review.
 */
export function nextNeedingReview(items: readonly ReviewItem[], afterKey: string): ReviewItem | null {
  const index = items.findIndex((item) => item.key === afterKey);
  const ordered = index < 0 ? items : [...items.slice(index + 1), ...items.slice(0, index)];
  return ordered.find((item) => item.needsReview && item.key !== afterKey) ?? null;
}

/** What one link's saved abstract can show of a value's persisted references. */
export interface ReviewCopyFocus {
  /** Whether the value refers to this link's abstract at all. */
  readonly refersToAbstract: boolean;
  /** Its supporting quotes on the link's current copy: the passages to highlight. */
  readonly currentQuotes: number;
  /** Whether it says the current copy was examined. */
  readonly examinedCurrent: boolean;
  /** Whether it says this paper had no abstract to check. */
  readonly unavailable: boolean;
  /** Earlier copies its quotes or examined references name, oldest first: this view does not show them. */
  readonly earlierCopies: readonly SnapshotInfo[];
}

/** How `item`'s persisted references relate to the saved copies of the link to `paperId`. */
export function reviewCopyFocus(item: ReviewItem, paperId: string): ReviewCopyFocus {
  const sources = item.sources.filter((source) => source.paper.paperId === paperId);
  const earlier = new Map<string, SnapshotInfo>();
  let currentQuotes = 0;
  let examinedCurrent = false;
  let unavailable = false;
  let refersToAbstract = false;
  for (const source of sources) {
    if (source.kind === "quote" || source.kind === "examined_abstract") {
      refersToAbstract = true;
      if (source.copy?.current) {
        if (source.kind === "quote") currentQuotes += 1;
        else examinedCurrent = true;
      } else if (source.copy) {
        earlier.set(source.copy.snapshot.id, source.copy.snapshot);
      }
    } else if (source.kind === "unavailable" && source.sourceKind === "abstract") {
      refersToAbstract = true;
      unavailable = true;
    }
  }
  return Object.freeze({
    refersToAbstract,
    currentQuotes,
    examinedCurrent,
    unavailable,
    earlierCopies: Object.freeze([...earlier.values()].sort((a, b) => a.seq - b.seq)),
  });
}

export type ReviewTargetState =
  | { readonly kind: "current"; readonly item: ReviewItem }
  /** The value is no longer saved. */
  | { readonly kind: "not_recorded" }
  /** The saved value is no longer the version the card showed. */
  | { readonly kind: "stale_version" };

/** Whether a press on the card of `valueId`, showing `shownVersion`, still names the saved value. */
export function reviewTargetState(items: readonly ReviewItem[], valueId: ValueId, shownVersion: number): ReviewTargetState {
  const item = items.find((candidate) => candidate.value.id === valueId);
  if (!item) return { kind: "not_recorded" };
  if (item.value.valueVersion !== shownVersion) return { kind: "stale_version" };
  return { kind: "current", item };
}
