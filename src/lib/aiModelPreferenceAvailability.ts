/**
 * Recognising "the AI-model preference table is not installed here".
 *
 * AI-MODEL-SELECTION-001A adds `public.user_ai_preferences` in a migration that,
 * like every other, reaches Production separately from the code that reads it.
 * Full account export must survive that window: a user asking for all of their
 * data during a rollout should get all of their data, not an error about a table
 * their environment has not received yet.
 *
 * The tolerance is exactly one condition — `user_ai_preferences` does not exist
 * — and it is deliberately NOT the author-identity classifier reused, because
 * that one only recognises 001C object names and would return false here,
 * turning the rollout window into a hard export failure.
 *
 * Everything else still fails the export: permission denied, an RLS refusal, an
 * authentication failure, a network error, a timeout, a malformed query, a
 * malformed response, a missing *unrelated* table, a generic 4xx/5xx. Once the
 * schema exists, a genuine read failure must never be silently converted into
 * "this user has no preference" — that would hand someone an archive that omits
 * a choice they made, which is precisely the failure this export exists to
 * prevent.
 */

import { isMissingDatabaseObjectError } from "./missingDatabaseObject";

/**
 * The single object whose absence is tolerated. `ai_model_catalog` is
 * deliberately NOT listed: the export never reads it, so a missing-catalog error
 * arriving on this path would mean something unexpected and must surface.
 */
const AI_MODEL_PREFERENCE_OBJECT_NAMES = ["user_ai_preferences"] as const;

/**
 * Whether this error means `user_ai_preferences` is absent from this
 * environment — i.e. it predates migration
 * `20260902120000_add_ai_model_selection_foundation.sql`.
 *
 * Requires BOTH a missing-object code AND a mention of `user_ai_preferences` in
 * the error text, so a missing-table error naming any other relation stays a
 * real, export-failing error.
 */
export function isAiModelPreferenceSchemaMissing(error: unknown): boolean {
  return isMissingDatabaseObjectError(error, AI_MODEL_PREFERENCE_OBJECT_NAMES);
}
