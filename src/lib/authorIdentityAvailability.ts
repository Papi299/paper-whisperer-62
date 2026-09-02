/**
 * Recognising "the author-identity subsystem is not installed here".
 *
 * AUTHOR-IDENTITY-RESOLUTION-001C adds four tables and six RPCs in a migration
 * that, by design, is applied to Production separately from — and before — the
 * code that uses it. In between, and on any Vercel Preview built from this
 * branch while Production still predates the migration, the frontend will ask a
 * database that has never heard of `author_identities` for its contents.
 *
 * That must not break Paperlume. Analytics falls back to 001A textual grouping,
 * the identity manager reports itself unavailable, and every unrelated feature
 * carries on. This module is the single place that decides whether an error is
 * that specific, expected condition.
 *
 * It is deliberately narrow. A permission error, a network failure, an RLS
 * refusal or a malformed request is a REAL error and must surface: swallowing
 * those would turn "your data failed to load" into a silently empty screen, and
 * a graceful degradation that hides genuine faults is worse than a crash. Only
 * the "this object does not exist" family is treated as the compatibility case.
 *
 * The code/text matching itself lives in `missingDatabaseObject.ts`, shared with
 * the other feature that needs the same judgement. What stays here is the part
 * that is actually 001C-specific: the list of object names below.
 */

import { isMissingDatabaseObjectError } from "./missingDatabaseObject";

/** Every 001C object name, so a missing-object error elsewhere is not misread. */
const IDENTITY_OBJECT_NAMES = [
  "author_identities",
  "author_identity_aliases",
  "author_identity_links",
  "author_identity_merges",
  "create_author_identity_from_mention",
  "link_author_mention_to_identity",
  "unlink_author_mention_identity",
  "merge_author_identities",
  "unmerge_author_identity",
  "delete_empty_author_identity",
] as const;

/**
 * Whether this error means the 001C schema is absent from this environment.
 *
 * Requires BOTH a missing-object code AND a mention of a 001C object somewhere
 * in the error text. The second half matters: a missing-table error naming some
 * *other* relation is a genuine schema problem in an unrelated part of the
 * product, and reporting it as "identity subsystem not installed" would hide it.
 */
export function isAuthorIdentitySchemaMissing(error: unknown): boolean {
  return isMissingDatabaseObjectError(error, IDENTITY_OBJECT_NAMES);
}
