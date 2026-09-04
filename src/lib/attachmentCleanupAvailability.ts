/**
 * Recognising "the attachment-cleanup schema is not installed here".
 *
 * ATTACHMENT-ORPHAN-CLEANUP-HARDENING-001 adds one table and three client RPCs
 * in a migration that, like every other, reaches Production separately from —
 * and after — the code that uses it. Merging to `main` deploys the frontend through
 * Vercel; `supabase db push` is a different, separately authorised step. In the
 * window between the two, and on any Vercel Preview built from this branch, the
 * deployed client will ask a database that has never heard of
 * `attachment_cleanup_queue` to delete an attachment.
 *
 * Attachment upload, attachment deletion and paper deletion must keep working
 * through that window. This module is the single place that decides whether an
 * error is that specific, expected condition — and it is deliberately narrow. A
 * permission error, an RLS refusal, a network failure, a constraint violation or
 * a malformed request is a REAL error: converting any of those into "the feature
 * is not installed" would silently drop the user down to the older, lossier
 * cleanup path while a genuine fault went unreported.
 *
 * ── The partial-install case ────────────────────────────────────────────────
 *
 * The migration is transactional, so "the queue table exists but the RPCs do
 * not" is not a state a normal rollout produces. If it is nevertheless observed,
 * old-schema compatibility is the wrong answer: the environment is broken in a
 * way somebody needs to see, not merely behind.
 *
 * So this module keeps one piece of session-scoped evidence — whether any
 * cleanup object has been proven to EXIST during this browser session — and
 * refuses the compatibility verdict once it has. Before the migration nothing is
 * ever observed present, so the fallback works exactly as intended; after it,
 * everything is present and the fallback is unreachable; in between, a
 * contradiction surfaces as a real error rather than as a silent downgrade.
 */

import { isMissingDatabaseObjectError } from "./missingDatabaseObject";

/**
 * Every object name this feature is willing to treat as legitimately absent.
 *
 * The internal path helper and the cleanup-intent tombstone trigger function are
 * deliberately absent from the list: no client ever calls either, so a
 * missing-object error naming one would mean something unexpected and must
 * surface rather than being read as "this database is simply older".
 */
export const ATTACHMENT_CLEANUP_OBJECT_NAMES = [
  "attachment_cleanup_queue",
  "delete_attachment_with_cleanup",
  "delete_papers_with_attachment_cleanup",
  "finalize_attachment_upload",
] as const;

/** Cleanup objects proven to exist in this browser session. */
const observedPresent = new Set<string>();

/**
 * Record that a cleanup object answered successfully.
 *
 * Call this after any interaction with a cleanup object that did NOT fail — a
 * successful RPC, or a queue read that returned rows (or an empty set). It is
 * what lets a later missing-object error be recognised as a partial install
 * rather than as an ordinary pre-migration environment.
 */
export function noteAttachmentCleanupObjectPresent(
  objectName: (typeof ATTACHMENT_CLEANUP_OBJECT_NAMES)[number],
): void {
  observedPresent.add(objectName);
}

/**
 * Whether this error means the cleanup schema is absent from this environment —
 * i.e. it predates migration
 * `20260904120000_add_recoverable_attachment_cleanup_queue.sql`.
 *
 * Requires all three of:
 *
 *   1. a missing-object code (an undefined-table/function SQLSTATE, or one of
 *      PostgREST's schema-cache codes);
 *   2. a mention of one of this feature's own object names in the error text;
 *   3. no cleanup object having already been observed present in this session.
 *
 * (3) is what separates "behind" from "broken". Without it, an environment where
 * the table exists but a function was dropped would quietly serve every user the
 * old lossy cleanup path forever.
 */
export function isAttachmentCleanupSchemaMissing(error: unknown): boolean {
  if (observedPresent.size > 0) return false;
  return isMissingDatabaseObjectError(error, ATTACHMENT_CLEANUP_OBJECT_NAMES);
}

/**
 * Forget the session-scoped presence evidence.
 *
 * Exists for tests, which must be able to exercise the pre-migration and
 * partial-install branches independently. Nothing in the application calls it:
 * the evidence is meant to accumulate for the life of the tab.
 */
export function resetAttachmentCleanupAvailabilityForTests(): void {
  observedPresent.clear();
}
