/**
 * PFA-C04 — client-side constants and error normalization for self-service
 * account deletion.
 *
 * This module holds no authorization logic. The destructive decision is made
 * exclusively by the `delete-account` Edge Function, which re-validates the
 * confirmation phrase itself and derives the deleted user from the
 * authenticated bearer token. What lives here is only what the browser needs:
 * the phrase to render and gate the button on, and a mapping from the
 * function's stable error codes to copy a user can act on.
 *
 * The phrase is intentionally a **separate constant** from the Edge Function's
 * `supabase/functions/_shared/accountDeletion.ts` copy: the deployed function
 * and the bundled application are different runtime and bundling domains, the
 * same reason `src/lib/pubmedIdentifiers.ts` and
 * `supabase/functions/_shared/identifierDetection.ts` are separate. Both suites
 * pin their copy to the same literal.
 */

/** The exact phrase a user must type before deletion is possible. */
export const ACCOUNT_DELETION_CONFIRMATION = "DELETE MY ACCOUNT";

/** The Edge Function that performs the deletion. */
export const DELETE_ACCOUNT_FUNCTION = "delete-account";

/** Shown for any failure whose cause the user cannot act on. */
export const GENERIC_DELETION_FAILURE =
  "Your account could not be deleted. Please try again.";

/**
 * True only for an exact match. No trimming, no case folding — the server
 * applies the identical rule, so a phrase the button accepts is a phrase the
 * server accepts, and vice versa.
 */
export function isDeletionConfirmed(input: string): boolean {
  return input === ACCOUNT_DELETION_CONFIRMATION;
}

/**
 * Map a `delete-account` error code to user-safe copy.
 *
 * Unknown codes — and every raw Postgres/Storage/Auth/network string — collapse
 * to the generic message, so an internal detail can never reach the UI.
 */
export function accountDeletionMessage(code: unknown): string {
  switch (code) {
    case "unauthenticated":
      return "Your session has expired. Sign in again to delete your account.";
    case "invalid_confirmation":
      return "Type the confirmation phrase exactly to delete your account.";
    default:
      return GENERIC_DELETION_FAILURE;
  }
}

/** Where a deleted user lands. */
export const POST_DELETION_PATH = "/auth";

/**
 * Leave the application with a **hard** navigation after a successful deletion.
 *
 * A router `navigate()` would keep the same JavaScript context alive, so every
 * in-memory React Query cache entry, hook state, and module-level value
 * belonging to the now-deleted account would survive the transition. Replacing
 * the document discards all of it, and `replace` (rather than `assign`) keeps
 * the deleted-account Dashboard out of session history.
 */
export function redirectToAuthPage(): void {
  window.location.replace(POST_DELETION_PATH);
}

/**
 * Recover the stable error code from a failed `functions.invoke` call.
 *
 * `supabase-js` surfaces a non-2xx function response as a `FunctionsHttpError`
 * carrying the original `Response` on `context`; the code lives in that JSON
 * body. Anything unreadable yields `null`, which
 * {@link accountDeletionMessage} turns into the generic message. The raw body
 * is never returned to the caller.
 */
export async function readDeletionErrorCode(error: unknown): Promise<string | null> {
  const context = (error as { context?: unknown } | null)?.context;
  if (!context || typeof (context as Response).json !== "function") return null;
  try {
    const body = await (context as Response).json();
    const code = (body as { error?: unknown } | null)?.error;
    return typeof code === "string" ? code : null;
  } catch {
    return null;
  }
}
