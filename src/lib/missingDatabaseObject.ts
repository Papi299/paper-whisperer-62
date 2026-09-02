/**
 * Recognising "this database object does not exist here".
 *
 * Paperlume applies migrations to Production separately from — and before — the
 * code that uses them. In the window between, and on any Vercel Preview built
 * from a branch whose migration Production has not yet received, the frontend
 * will ask a database that has never heard of a table for its contents. Some
 * features must survive that window rather than break.
 *
 * This module is the single implementation of that judgement. It exists so the
 * decision is written once: each feature supplies the object names it is willing
 * to treat as legitimately absent, and nothing else about the classification is
 * re-invented per caller.
 *
 * It is deliberately narrow, and the narrowness is the point. A permission
 * error, a network failure, an RLS refusal or a malformed request is a REAL
 * error and must surface: swallowing those turns "your data failed to load" into
 * a silently empty screen — or, worse, into an account export that omits data
 * the user has. Only the "this object does not exist" family, naming an object
 * the caller declared, is the compatibility case.
 */

/** The shape Supabase/PostgREST errors arrive in. Structural, not the SDK type. */
interface PostgrestLikeError {
  code?: string | null;
  message?: string | null;
  details?: string | null;
  hint?: string | null;
}

/**
 * Postgres SQLSTATEs meaning "the thing you named does not exist".
 *
 *  * 42P01 undefined_table — the table is genuinely absent.
 *  * 42883 undefined_function — the RPC is genuinely absent.
 *  * 42704 undefined_object — raised by some paths for a missing object.
 */
const MISSING_OBJECT_SQLSTATES = new Set(["42P01", "42883", "42704"]);

/**
 * PostgREST's own codes for a name it cannot find in its schema cache.
 *
 *  * PGRST205 — table/view not found.
 *  * PGRST202 — function not found in the schema cache.
 *
 * These arrive instead of a SQLSTATE because PostgREST resolves the name before
 * it ever reaches Postgres, so they are the codes actually seen in practice.
 */
const MISSING_SCHEMA_CACHE_CODES = new Set(["PGRST205", "PGRST202"]);

/**
 * Whether `error` means one of `objectNames` is absent from this environment.
 *
 * Requires BOTH halves:
 *
 *   1. a missing-object code — a SQLSTATE from the undefined-object family, or
 *      one of PostgREST's schema-cache codes;
 *   2. a mention of one of the caller's own object names somewhere in the error
 *      text (message, details or hint), compared case-insensitively.
 *
 * The second half is what keeps this from becoming "if anything goes wrong,
 * pretend the feature is not installed". A missing-table error naming some
 * *other* relation is a genuine schema problem elsewhere in the product, and
 * reporting it as "this subsystem is absent" would hide it.
 *
 * Callers should wrap this in a named, feature-specific predicate rather than
 * passing names at each call site, so the set of tolerated objects is declared
 * in exactly one reviewable place per feature.
 */
export function isMissingDatabaseObjectError(
  error: unknown,
  objectNames: readonly string[],
): boolean {
  if (!error || typeof error !== "object") return false;

  const candidate = error as PostgrestLikeError;
  const code = typeof candidate.code === "string" ? candidate.code : "";
  if (!MISSING_OBJECT_SQLSTATES.has(code) && !MISSING_SCHEMA_CACHE_CODES.has(code)) {
    return false;
  }

  const haystack = [candidate.message, candidate.details, candidate.hint]
    .filter((part): part is string => typeof part === "string")
    .join(" ")
    .toLowerCase();

  return objectNames.some((name) => haystack.includes(name.toLowerCase()));
}
