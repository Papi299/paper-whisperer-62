/**
 * Identities and versions of the study-record domain (EVIDENCE-RECORDS-001B).
 *
 * Every identity is a UUID string at runtime and a distinct branded type at
 * compile time. A paper id therefore cannot be passed where a study id is
 * expected: a study is never a paper. One paper can report several studies, and
 * one study may be reported in several papers, so the two identities must never
 * be interchangeable (Requirements-001 §G; PR-A1 section 3). The same holds for
 * the link, the saved copy, the group, the outcome, the recorded value and the
 * source reference: each has its own identity.
 *
 * Nothing here infers an identity. A study id comes from the server (or from
 * a row the server wrote), never from a title, an author, a PMID or a DOI.
 *
 * The constructors accept `unknown`, so they are safe on untrusted input: a
 * value that is not a canonical UUID yields null, never a guess. A valid id is
 * returned in lowercase, the form PostgreSQL prints a uuid in.
 */

declare const brand: unique symbol;

/** A string that has been checked and given a role. */
export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type PaperId = Brand<string, "PaperId">;
export type StudyId = Brand<string, "StudyId">;
export type LinkId = Brand<string, "LinkId">;
export type SnapshotId = Brand<string, "SnapshotId">;
export type ArmId = Brand<string, "ArmId">;
export type OutcomeId = Brand<string, "OutcomeId">;
export type ValueId = Brand<string, "ValueId">;
export type AnchorId = Brand<string, "AnchorId">;
export type EventId = Brand<string, "EventId">;

/**
 * The client-generated id of one user action. A retry of the same action
 * reuses it; a different action — including the same edit after a version
 * conflict — gets a new one (FK-PROOF-001 I-1; docs/evidence-records-lifecycle.md
 * §5). This library never generates one: generating needs a browser API, and
 * the caller owns the "same action or new action" decision.
 */
export type RequestId = Brand<string, "RequestId">;

/** `evidence_studies.row_version`: committed write requests on the study. */
export type StudyVersion = Brand<number, "StudyVersion">;

/** `evidence_field_values.value_version`: changes to one recorded value. */
export type ValueVersion = Brand<number, "ValueVersion">;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** PostgreSQL `integer`, which every version column is. */
export const MAX_POSTGRES_INTEGER = 2147483647;

/** Whether `value` is a UUID in the canonical 8-4-4-4-12 hexadecimal form. */
export function isCanonicalUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function toId<T extends string>(value: unknown): T | null {
  return isCanonicalUuid(value) ? (value.toLowerCase() as T) : null;
}

export const toPaperId = (value: unknown): PaperId | null => toId<PaperId>(value);
export const toStudyId = (value: unknown): StudyId | null => toId<StudyId>(value);
export const toLinkId = (value: unknown): LinkId | null => toId<LinkId>(value);
export const toSnapshotId = (value: unknown): SnapshotId | null => toId<SnapshotId>(value);
export const toArmId = (value: unknown): ArmId | null => toId<ArmId>(value);
export const toOutcomeId = (value: unknown): OutcomeId | null => toId<OutcomeId>(value);
export const toValueId = (value: unknown): ValueId | null => toId<ValueId>(value);
export const toAnchorId = (value: unknown): AnchorId | null => toId<AnchorId>(value);
export const toEventId = (value: unknown): EventId | null => toId<EventId>(value);
export const toRequestId = (value: unknown): RequestId | null => toId<RequestId>(value);

function toVersion<T extends number>(value: unknown): T | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_POSTGRES_INTEGER
    ? (value as T)
    : null;
}

/** A study version: an integer from 1 to the PostgreSQL integer maximum. */
export const toStudyVersion = (value: unknown): StudyVersion | null => toVersion<StudyVersion>(value);

/** A value version: an integer from 1 to the PostgreSQL integer maximum. */
export const toValueVersion = (value: unknown): ValueVersion | null => toVersion<ValueVersion>(value);
