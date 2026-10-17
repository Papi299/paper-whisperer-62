/**
 * Domain types of study records (EVIDENCE-RECORDS-001B).
 *
 * Two layers, deliberately linked so they cannot drift apart silently:
 *
 *   * `*Row` types are the generated Supabase row types with only their closed
 *     vocabularies narrowed. `Narrow` refuses an override for a column the
 *     generated type does not have, and one that widens rather than narrows, so
 *     a renamed or retyped column breaks the typecheck here.
 *   * The camelCase domain models are what the pure helpers of this library
 *     take. `records.ts` maps the narrowed rows onto them, column by column, so
 *     the mapping is checked by the compiler as well.
 *
 * Every closed vocabulary below is the exact list of a PR-A1 CHECK or a PR-A2
 * argument check; `fieldDictionary.parity.test.ts` compares each one with the
 * migration SQL.
 *
 * PROVENANCE IS KEPT APART (Requirements-001 §I1, §I5). The stored library
 * abstract, the server's saved copy, the user's value, the user's full-text
 * locator, the server's abstract match and the user's review are different
 * kinds of fact, and each has its own type here. In particular an advisory
 * browser match (`AdvisoryQuoteMatch` in `matcher.ts`) is not a
 * `ServerAttestedMatch` and cannot be passed as one.
 */

import type { Database } from "@/integrations/supabase/types";
import type { ArmRole, DesignProfile, FieldKey } from "./fieldDictionary";
import type {
  AnchorId,
  ArmId,
  EventId,
  LinkId,
  OutcomeId,
  PaperId,
  RequestId,
  SnapshotId,
  StudyId,
  StudyVersion,
  ValueId,
  ValueVersion,
} from "./ids";
import type { CodePointOffset } from "./normalization";

// ── Closed vocabularies ──────────────────────────────────────────────────────

/** `evidence_field_values_value_state_check`. No row at all means "Not yet recorded". */
export const VALUE_STATES = ["reported", "not_reported", "unclear", "not_applicable", "source_unavailable"] as const;
export type ValueState = (typeof VALUE_STATES)[number];

/** `evidence_field_values_state_reason_check`: present exactly when the state is unclear. */
export const STATE_REASONS = ["ambiguous", "conflicting", "incomplete"] as const;
export type StateReason = (typeof STATE_REASONS)[number];

/** `evidence_field_values_review_status_check`. */
export const REVIEW_STATUSES = ["unreviewed", "user_reviewed", "disputed", "needs_rereview"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

/** `evidence_field_values_review_reason_check`: present exactly when the status is needs_rereview. */
export const REVIEW_REASONS = ["source_changed"] as const;
export type ReviewReason = (typeof REVIEW_REASONS)[number];

/** `evidence_field_values_extraction_method_check`: manual entry only in the MVP. */
export const EXTRACTION_METHODS = ["manual"] as const;
export type ExtractionMethod = (typeof EXTRACTION_METHODS)[number];

/** `evidence_field_anchors_purpose_check` (FK-PROOF-001 §J). */
export const REFERENCE_PURPOSES = ["supports", "examined", "unavailable"] as const;
export type ReferencePurpose = (typeof REFERENCE_PURPOSES)[number];

/**
 * `evidence_field_anchors_source_kind_check`. There is no `other_source`: non-
 * library sources are deferred (Requirements-001A PD-4).
 */
export const REFERENCE_SOURCE_KINDS = ["abstract", "full_text"] as const;
export type ReferenceSourceKind = (typeof REFERENCE_SOURCE_KINDS)[number];

/** `evidence_field_anchors_locator_kind_check`. */
export const LOCATOR_KINDS = ["page", "section", "table", "figure", "paragraph", "other"] as const;
export type LocatorKind = (typeof LOCATOR_KINDS)[number];

/** `evidence_study_reports_link_status_check`. */
export const LINK_STATUSES = ["provisional", "user_confirmed"] as const;
export type LinkStatus = (typeof LINK_STATUSES)[number];

/** `evidence_study_reports_link_basis_check`. Only `created_from_paper` can be written today. */
export const LINK_BASES = ["created_from_paper", "user_linked"] as const;
export type LinkBasis = (typeof LINK_BASES)[number];

/** `evidence_set_link`'s `p_action`: operations on an EXISTING link only. */
export const LINK_ACTIONS = ["confirm", "mark_provisional", "remove"] as const;
export type LinkAction = (typeof LINK_ACTIONS)[number];

/** `evidence_source_snapshots_source_kind_check`. */
export const SNAPSHOT_SOURCE_KINDS = ["library_abstract"] as const;
export type SnapshotSourceKind = (typeof SNAPSHOT_SOURCE_KINDS)[number];

/** `evidence_events_event_type_check`. */
export const EVENT_TYPES = [
  "request",
  "study_created",
  "study_updated",
  "link_created",
  "link_status_changed",
  "link_removed",
  "source_captured",
  "source_rebased",
  "anchor_rematched",
  "anchor_not_rematched",
  "arm_added",
  "arm_updated",
  "arm_removed",
  "outcome_added",
  "outcome_updated",
  "outcome_removed",
  "value_saved",
  "value_cleared",
  "review_confirmed",
  "review_flagged",
  "review_reset",
  "review_needs_rereview",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** `evidence_events_op_check`. The last three have no RPC yet (PR-A3). */
export const REQUEST_OPS = [
  "create_study",
  "update_study",
  "save_changes",
  "review_fields",
  "set_link",
  "rebase_source",
] as const;
export type RequestOp = (typeof REQUEST_OPS)[number];

function member<T extends string>(list: readonly T[]) {
  return (value: unknown): value is T => typeof value === "string" && (list as readonly string[]).includes(value);
}

export const isValueState = member(VALUE_STATES);
export const isStateReason = member(STATE_REASONS);
export const isReviewStatus = member(REVIEW_STATUSES);
export const isReviewReason = member(REVIEW_REASONS);
export const isReferencePurpose = member(REFERENCE_PURPOSES);
export const isReferenceSourceKind = member(REFERENCE_SOURCE_KINDS);
export const isLocatorKind = member(LOCATOR_KINDS);
export const isLinkStatus = member(LINK_STATUSES);
export const isLinkBasis = member(LINK_BASES);
export const isLinkAction = member(LINK_ACTIONS);
export const isEventType = member(EVENT_TYPES);
export const isRequestOp = member(REQUEST_OPS);

// ── Generated rows, narrowed ─────────────────────────────────────────────────

type PublicTables = Database["public"]["Tables"];
type GeneratedRow<T extends keyof PublicTables> = PublicTables[T]["Row"];

/**
 * Replace columns of a generated row with narrower types. Each override must
 * name an existing column and be assignable to its generated type.
 */
export type Narrow<Row, Overrides extends { [K in keyof Overrides]: K extends keyof Row ? Row[K] : never }> = Omit<
  Row,
  keyof Overrides
> &
  Overrides;

export type EvidenceStudyRow = Narrow<GeneratedRow<"evidence_studies">, { design_profile: DesignProfile }>;
export type EvidenceStudyReportRow = Narrow<
  GeneratedRow<"evidence_study_reports">,
  { link_status: LinkStatus; link_basis: LinkBasis }
>;
export type EvidenceSourceSnapshotRow = Narrow<
  GeneratedRow<"evidence_source_snapshots">,
  { source_kind: SnapshotSourceKind; normalization_version: "v1" }
>;
export type EvidenceArmRow = Narrow<GeneratedRow<"evidence_arms">, { arm_role: ArmRole }>;
export type EvidenceOutcomeRow = GeneratedRow<"evidence_outcomes">;
export type EvidenceFieldValueRow = Narrow<
  GeneratedRow<"evidence_field_values">,
  {
    field_key: FieldKey;
    value_state: ValueState;
    state_reason: StateReason | null;
    extraction_method: ExtractionMethod;
    review_status: ReviewStatus;
    review_reason: ReviewReason | null;
  }
>;
export type EvidenceFieldAnchorRow = Narrow<
  GeneratedRow<"evidence_field_anchors">,
  {
    purpose: ReferencePurpose;
    source_kind: ReferenceSourceKind;
    normalization_version: "v1" | null;
    locator_kind: LocatorKind | null;
  }
>;
export type EvidenceEventRow = Narrow<GeneratedRow<"evidence_events">, { event_type: EventType; op: RequestOp | null }>;

// ── Domain models ────────────────────────────────────────────────────────────

/** The study header: what the lifecycle RPCs read and write. */
export interface StudyHeader {
  readonly id: StudyId;
  readonly label: string;
  readonly designProfile: DesignProfile;
  /** Free text, never treated as evidence. Absent is null, never "". */
  readonly notes: string | null;
  readonly version: StudyVersion;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** "This paper reports this study" — a user assertion, never inferred. */
export interface StudyReportLink {
  readonly id: LinkId;
  readonly studyId: StudyId;
  readonly paperId: PaperId;
  readonly status: LinkStatus;
  readonly basis: LinkBasis;
}

/**
 * The server's immutable saved copy of a paper's abstract, for one study-report
 * link. "The abstract as stored in your PaperLume library" at capture time —
 * nothing checked it against a publisher or PubMed. The link's current copy is
 * its highest `seq`.
 */
export interface SourceSnapshot {
  readonly id: SnapshotId;
  readonly studyId: StudyId;
  readonly paperId: PaperId;
  readonly seq: number;
  readonly sourceKind: SnapshotSourceKind;
  readonly exactText: string;
  readonly charCount: number;
  readonly normalizationVersion: "v1";
  readonly capturedAt: string;
}

/** A group: structure, not evidence. */
export interface Arm {
  readonly id: ArmId;
  readonly studyId: StudyId;
  readonly role: ArmRole;
  readonly displayLabel: string;
  readonly position: number;
}

/** An outcome: structure, not evidence. */
export interface Outcome {
  readonly id: OutcomeId;
  readonly studyId: StudyId;
  readonly displayLabel: string;
  readonly position: number;
}

/** What a value describes: the study, one group or one outcome — never two. */
export type ValueTarget =
  | { readonly scope: "study" }
  | { readonly scope: "arm"; readonly armId: ArmId }
  | { readonly scope: "outcome"; readonly outcomeId: OutcomeId };

/** A user-provided typed value, in the shape its field requires. Stored verbatim. */
export type FieldContent =
  | { readonly shape: "text"; readonly text: string }
  | { readonly shape: "code"; readonly code: string }
  | { readonly shape: "integer_with_reported_text"; readonly reportedText: string; readonly value: number }
  | { readonly shape: "text_list"; readonly entries: readonly string[] };

/** A user-provided full-text location. Always the user's assertion; PaperLume never checks it. */
export interface FullTextLocator {
  readonly kind: LocatorKind;
  readonly text: string;
}

/**
 * The match columns of a stored abstract quote. Computed by the server against
 * the immutable copy the quote names, when the quote was written; the browser
 * can never set them. Offsets are code points of the v1-normalized copy.
 */
export interface ServerAttestedMatch {
  readonly attestation: "server";
  readonly normalizedStart: CodePointOffset;
  readonly normalizedEnd: CodePointOffset;
  readonly occurrence: number;
  readonly count: number;
  readonly normalizationVersion: "v1";
  readonly matchedAt: string;
}

/** A stored source reference (`evidence_field_anchors`), by purpose and source kind. */
export type StoredReference =
  | {
      readonly id: AnchorId;
      readonly purpose: "supports";
      readonly sourceKind: "abstract";
      readonly paperId: PaperId;
      readonly snapshotId: SnapshotId;
      readonly position: number;
      readonly quoteText: string;
      readonly match: ServerAttestedMatch;
    }
  | {
      readonly id: AnchorId;
      readonly purpose: "supports";
      readonly sourceKind: "full_text";
      readonly paperId: PaperId;
      readonly position: number;
      readonly locator: FullTextLocator;
    }
  | {
      readonly id: AnchorId;
      readonly purpose: "examined";
      readonly sourceKind: "abstract";
      readonly paperId: PaperId;
      readonly snapshotId: SnapshotId;
    }
  | {
      readonly id: AnchorId;
      readonly purpose: "examined";
      readonly sourceKind: "full_text";
      readonly paperId: PaperId;
      readonly locator: FullTextLocator | null;
    }
  | {
      readonly id: AnchorId;
      readonly purpose: "unavailable";
      readonly sourceKind: ReferenceSourceKind;
      readonly paperId: PaperId;
    };

/** The human review of one value. Only the user's Confirm creates `user_reviewed`. */
export interface ReviewState {
  readonly status: ReviewStatus;
  readonly reason: ReviewReason | null;
  readonly note: string | null;
  readonly reviewedAt: string | null;
  readonly reviewedVersion: ValueVersion | null;
}

/** One recorded value (a row of `evidence_field_values`) with its source references. */
export interface RecordedValue {
  readonly id: ValueId;
  readonly studyId: StudyId;
  readonly target: ValueTarget;
  readonly fieldKey: FieldKey;
  readonly state: ValueState;
  readonly stateReason: StateReason | null;
  /** Present exactly when the state is reported. */
  readonly content: FieldContent | null;
  readonly note: string | null;
  readonly extractionMethod: ExtractionMethod;
  readonly review: ReviewState;
  readonly valueVersion: ValueVersion;
  readonly references: readonly StoredReference[];
}

/** One history row: a request header (ordinal 0) or a change event. */
export interface HistoryEvent {
  readonly id: EventId;
  readonly studyId: StudyId;
  readonly studyVersion: StudyVersion;
  readonly ordinal: number;
  readonly type: EventType;
  readonly requestId: RequestId;
  readonly op: RequestOp | null;
  readonly targetId: string | null;
  readonly fieldKey: string | null;
  readonly before: unknown;
  readonly after: unknown;
  readonly occurredAt: string;
}
