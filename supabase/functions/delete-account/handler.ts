/**
 * delete-account — the complete request path, expressed without any runtime
 * binding.
 *
 * `index.ts` supplies the real Supabase clients and calls `Deno.serve`; every
 * decision that matters for security lives here: method gating, bearer-token
 * extraction, the authoritative `getUser(token)` check, the server-side
 * confirmation contract, the Storage-before-Auth ordering, and the fact that
 * the deletion target is read from the authenticated user and from nowhere
 * else.
 *
 * The module uses **no** Deno API and **no** remote import, so the actual
 * handler — not a re-implementation of it — is exercised by Vitest with fake
 * clients. Security-sensitive logic is therefore never duplicated for
 * testability.
 */

import {
  ATTACHMENTS_BUCKET,
  checkDeletionConfirmation,
  deleteUserStorageObjects,
  StorageCleanupError,
  type StorageNamespaceClient,
} from "../_shared/accountDeletion.ts";

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

/**
 * User-facing copy. Deliberately identical for every internal failure cause so
 * the response never discloses which stage failed.
 */
export const GENERIC_FAILURE = "Your account could not be deleted. Please try again.";

/** Minimal shape of the caller-scoped (anon-key + bearer) client. */
export interface CallerAuthClient {
  auth: {
    getUser(token: string): Promise<{
      data: { user: { id?: unknown } | null };
      error: unknown;
    }>;
  };
}

/** Minimal shape of the elevated, server-only client. */
export interface AdminClient {
  storage: { from(bucket: string): StorageNamespaceClient };
  auth: {
    admin: {
      deleteUser(userId: string, shouldSoftDelete: boolean): Promise<{ error: unknown }>;
    };
  };
}

export interface DeleteAccountDeps {
  /** Build a client scoped to the caller's bearer token. */
  createCallerClient(token: string): CallerAuthClient;
  /**
   * Build the elevated server-only client. Returns `null` when the Edge runtime
   * provided no usable secret key — the handler then fails safe rather than
   * continuing with insufficient privileges.
   */
  createAdminClient(): AdminClient | null;
  /** Injected so tests can assert exactly what is (and is not) logged. */
  logger?: { log(message: string): void; error(message: string): void };
}

function fail(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), { status, headers: jsonHeaders });
}

/** Extract the raw bearer token, or null when the header is absent/malformed. */
export function readBearerToken(header: string | null | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

export async function handleDeleteAccountRequest(
  req: Request,
  deps: DeleteAccountDeps,
): Promise<Response> {
  const logger = deps.logger ?? console;

  // 1. CORS preflight — answered before auth and before any mutation.
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // 2. Only POST may reach the destructive path. Every other method is refused
  //    before the token is even read, so it can never mutate anything.
  if (req.method !== "POST") {
    return fail(405, "method_not_allowed", "This endpoint accepts POST only.");
  }

  try {
    // 3. Bearer token required.
    const token = readBearerToken(req.headers.get("Authorization"));
    if (!token) {
      return fail(401, "unauthenticated", "You must be signed in to delete your account.");
    }

    // 4. Authoritative network validation of THIS token. Passing it explicitly
    //    means the check can never fall back to an ambient session, and a user
    //    already removed by an earlier partial attempt fails here.
    const caller = deps.createCallerClient(token);
    const { data, error: authError } = await caller.auth.getUser(token);
    const authenticatedId = data?.user?.id;
    if (authError || typeof authenticatedId !== "string" || authenticatedId === "") {
      return fail(401, "unauthenticated", "You must be signed in to delete your account.");
    }

    // The single source of truth for everything below. The request body is
    // never consulted for a target, so a `user_id` sent by a tampered client is
    // structurally incapable of redirecting the deletion.
    const userId = authenticatedId;

    // 5. Server-enforced destructive confirmation, re-validated independently
    //    of the client and before any privileged client is constructed.
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      body = null;
    }
    if (!checkDeletionConfirmation(body).ok) {
      return fail(
        400,
        "invalid_confirmation",
        "Type the confirmation phrase exactly to delete your account.",
      );
    }

    // 6. Elevated, server-only client. Never returned, never logged.
    const admin = deps.createAdminClient();
    if (!admin) {
      logger.error("delete-account: no elevated server key available in the Edge environment");
      return fail(500, "account_deletion_failed", GENERIC_FAILURE);
    }

    // 7. Storage first, always. Supabase refuses to delete an Auth user that
    //    still owns Storage objects, and deleting Auth first would strand the
    //    binaries with no owner left to clean them up. Objects are enumerated
    //    from Storage itself rather than from `paper_attachments`, so an orphan
    //    whose metadata row is gone is still removed.
    try {
      const removed = await deleteUserStorageObjects(
        admin.storage.from(ATTACHMENTS_BUCKET),
        userId,
      );
      // Safe operational context only: a count and a fixed label — no path,
      // object name, user id, token, or key.
      logger.log(`delete-account: storage cleanup removed ${removed} object(s)`);
    } catch (err) {
      const code = err instanceof StorageCleanupError ? err.code : "unknown";
      logger.error(`delete-account: storage cleanup failed (${code})`);
      // The Auth user is intentionally left intact. The operation stays safe to
      // retry, and reporting success here would be a lie.
      return fail(500, "storage_cleanup_failed", GENERIC_FAILURE);
    }

    // 8. Hard-delete the Auth user. `false` is the explicit non-soft-delete
    //    argument: PFA-C04 requires the account to actually cease to exist, so
    //    the deleted credentials can never sign in again.
    const { error: deleteError } = await admin.auth.admin.deleteUser(userId, false);
    if (deleteError) {
      logger.error("delete-account: auth user deletion failed");
      // Storage is already clean; a retry re-runs an empty cleanup and proceeds
      // straight to this step, so the operation remains safely retryable.
      return fail(500, "account_deletion_failed", GENERIC_FAILURE);
    }

    // 9. Success carries no user record, email, token, or Storage listing —
    //    only the fact that the deletion completed.
    return new Response(JSON.stringify({ status: "deleted" }), {
      status: 200,
      headers: jsonHeaders,
    });
  } catch (err) {
    // Bounded: the error's own message only — never a header, token, key, body,
    // or raw provider response.
    logger.error(
      `delete-account: unexpected error: ${err instanceof Error ? err.message : "unknown"}`,
    );
    return fail(500, "account_deletion_failed", GENERIC_FAILURE);
  }
}
