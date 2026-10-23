/**
 * The owner-only pilot, as the Study Record UI mirrors it (EVIDENCE-RECORDS-001C1).
 *
 * The server decides: every create, edit and link RPC calls
 * `evidence_records_assert_writable()`, which reads the caller's role from
 * `internal_user_access` on every call and refuses anything but exactly
 * `owner` with `42501 evidence_records_not_enabled` (PR-A2 §2). This module
 * only decides what the UI OFFERS, from the same `get_current_user_access`
 * projection the rest of the app reads — never from a JWT claim, an email
 * address, browser storage or a role the client supplied — and it fails
 * closed: while the role is loading, after the lookup failed, and for every
 * role but exactly `owner` (a manager is not an owner), nothing is offered.
 *
 * Viewing and deleting are not gated, on the server or here. Row level
 * security returns a user's own study records and nothing else, and
 * `evidence_delete_study` is open to whoever owns the study, so a user whose
 * pilot role was removed keeps View and Delete for the records they hold.
 */

export type StudyRecordWriteAccess =
  /** The role is still loading: offer nothing yet. */
  | "checking"
  /** Exactly `owner`: create and edit are offered. */
  | "allowed"
  /** Any other role, or none: view and delete only. */
  | "not_allowed"
  /** The lookup failed: treated like `not_allowed`, and said so. */
  | "unknown";

/** The part of `useCurrentUserAccess()`'s result this reads. */
export interface AccessLookup {
  readonly access: { readonly role: string };
  readonly isLoading: boolean;
  readonly isError: boolean;
}

export function studyRecordWriteAccess(lookup: AccessLookup): StudyRecordWriteAccess {
  if (lookup.isLoading) return "checking";
  if (lookup.isError) return "unknown";
  return lookup.access.role === "owner" ? "allowed" : "not_allowed";
}

/** Whether create and edit may be offered. Only `allowed` qualifies. */
export function canOfferStudyRecordWrites(access: StudyRecordWriteAccess): boolean {
  return access === "allowed";
}
