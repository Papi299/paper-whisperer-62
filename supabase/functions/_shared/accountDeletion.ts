/**
 * PFA-C04 — pure, runtime-agnostic core of self-service account deletion.
 *
 * Everything security-sensitive that can be expressed without a network call
 * lives here: the destructive confirmation contract, the Storage namespace
 * rule, the bounded recursive/paginated Storage enumeration, and the batching
 * that feeds `remove()`. The Deno entrypoint
 * (`supabase/functions/delete-account/index.ts`) supplies only the real
 * Supabase clients and the HTTP shell.
 *
 * The module deliberately uses **no** Deno API and **no** remote import, so it
 * is Node-importable and covered directly by Vitest — the same arrangement the
 * repository already uses for `geminiMonitoring.ts`, `providerError.ts` and
 * `identifierDetection.ts`. Security-sensitive logic is therefore tested
 * exactly once, in the module that actually runs it, rather than duplicated
 * into a test-only copy.
 */

/**
 * The exact destructive confirmation phrase. The server compares against this
 * literal; the client renders it and gates its final button on it. The two are
 * intentionally separate constants in separate runtime domains (Deno function
 * vs bundled browser app) — see `src/lib/accountDeletion.ts` — and each suite
 * pins its own copy to this literal.
 */
export const ACCOUNT_DELETION_CONFIRMATION = "DELETE MY ACCOUNT";

/** Private bucket holding per-user attachment binaries. */
export const ATTACHMENTS_BUCKET = "attachments";

/** Objects requested per `list()` page. */
export const STORAGE_LIST_PAGE_SIZE = 100;

/**
 * Maximum object paths per `remove()` call. Supabase Storage documents a hard
 * limit of 1000 objects per `remove()`; batching at exactly that limit keeps
 * the call count minimal without relying on undocumented headroom.
 */
export const STORAGE_REMOVE_BATCH_SIZE = 1000;

/**
 * Maximum directory depth walked below the user's own prefix. The product
 * contract is `<userId>/<paperId>/<uniqueName>` (depth 2). The bound exists so
 * a pathological or adversarial listing can never drive unbounded recursion;
 * exceeding it fails closed rather than silently leaving objects behind.
 */
export const STORAGE_MAX_DEPTH = 8;

/** Raised for every enumeration/validation failure. Carries a stable `code`. */
export class StorageCleanupError extends Error {
  readonly code: string;
  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StorageCleanupError";
    this.code = code;
  }
}

/** The subset of a Storage `list()` entry this module relies on. */
export interface StorageListEntry {
  name?: unknown;
  /** `null` for a prefix ("folder"); a string for a real object. */
  id?: unknown;
}

export interface StorageListResult {
  data?: StorageListEntry[] | null;
  error?: { message?: string } | null;
}

export interface StorageRemoveResult {
  data?: unknown;
  error?: { message?: string } | null;
}

/** Injected Storage surface — the real client in Deno, a fake in tests. */
export interface StorageNamespaceClient {
  list(
    prefix: string,
    options: { limit: number; offset: number; sortBy: { column: string; order: string } },
  ): Promise<StorageListResult>;
  remove(paths: string[]): Promise<StorageRemoveResult>;
}

/**
 * The one and only Storage namespace a deletion may touch: the authenticated
 * user's own prefix, with an explicit trailing separator so `<uuid>` can never
 * prefix-match a *different* id that merely starts with the same characters.
 */
export function userStoragePrefix(userId: string): string {
  assertUserId(userId);
  return `${userId}/`;
}

function assertUserId(userId: unknown): asserts userId is string {
  if (typeof userId !== "string" || userId.trim() === "" || userId !== userId.trim()) {
    throw new StorageCleanupError("invalid_user_id", "Storage cleanup requires a concrete user id.");
  }
  // The authenticated id is always a UUID. Refusing anything else means a path
  // separator, wildcard, or traversal segment can never enter the prefix.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) {
    throw new StorageCleanupError("invalid_user_id", "Storage cleanup requires a UUID user id.");
  }
}

/**
 * Validate one listing entry's `name` before it is ever concatenated into a
 * path. A name is a single path *segment*: it may not be blank, may not carry a
 * separator, and may not be a relative-traversal segment. Anything else fails
 * closed — an unexpected listing shape must abort the deletion, never widen it.
 */
function assertSegment(name: unknown): asserts name is string {
  if (typeof name !== "string" || name === "") {
    throw new StorageCleanupError(
      "malformed_listing",
      "Storage listing returned an entry without a usable name.",
    );
  }
  if (name.includes("/") || name.includes("\\") || name === "." || name === "..") {
    throw new StorageCleanupError(
      "malformed_listing",
      "Storage listing returned an entry whose name is not a single path segment.",
    );
  }
}

/**
 * Recursively enumerate every object under the user's own prefix.
 *
 * - **Paginated.** One `list()` response is never assumed to be complete; pages
 *   are requested until a short page is returned, so a directory holding far
 *   more than one page is fully covered.
 * - **Recursive.** Supabase Storage `list()` is single-level: prefixes come back
 *   as entries with a null `id`. Each is walked, bounded by
 *   {@link STORAGE_MAX_DEPTH}.
 * - **Storage-sourced.** Paths come from Storage itself, never from
 *   `paper_attachments`, so an orphaned object whose metadata row is gone is
 *   still discovered and deleted.
 * - **Scoped.** Every returned path is re-checked against the user's prefix
 *   before it is returned, so nothing outside `<userId>/` can reach `remove()`.
 */
export async function collectUserStorageObjects(
  storage: StorageNamespaceClient,
  userId: string,
): Promise<string[]> {
  const prefix = userStoragePrefix(userId);
  const found: string[] = [];
  const seen = new Set<string>();
  // Depth 0 is the user's own root; `""` is the path suffix below it.
  const queue: Array<{ suffix: string; depth: number }> = [{ suffix: "", depth: 0 }];

  while (queue.length > 0) {
    const { suffix, depth } = queue.shift()!;
    if (depth > STORAGE_MAX_DEPTH) {
      throw new StorageCleanupError(
        "listing_too_deep",
        "Storage namespace is nested deeper than the supported bound.",
      );
    }

    // Listing path has no trailing slash; `userId` alone lists the user's root.
    const listPath = suffix === "" ? userId : `${userId}/${suffix}`;
    let offset = 0;

    for (;;) {
      const { data, error } = await storage.list(listPath, {
        limit: STORAGE_LIST_PAGE_SIZE,
        offset,
        // A stable order makes pagination by offset well-defined.
        sortBy: { column: "name", order: "asc" },
      });

      if (error) {
        throw new StorageCleanupError(
          "listing_failed",
          "Storage listing failed for the account namespace.",
          { cause: error },
        );
      }
      if (!Array.isArray(data)) {
        throw new StorageCleanupError(
          "malformed_listing",
          "Storage listing returned an unexpected payload.",
        );
      }
      if (data.length === 0) break;

      for (const entry of data) {
        if (entry === null || typeof entry !== "object") {
          throw new StorageCleanupError(
            "malformed_listing",
            "Storage listing returned a non-object entry.",
          );
        }
        assertSegment(entry.name);
        const childSuffix = suffix === "" ? entry.name : `${suffix}/${entry.name}`;
        const fullPath = `${userId}/${childSuffix}`;

        // A prefix ("folder") has no object id; a real object always has one.
        if (entry.id === null || entry.id === undefined) {
          queue.push({ suffix: childSuffix, depth: depth + 1 });
          continue;
        }

        // Defense in depth: the path is built from the user's own id, but it is
        // re-validated before it can ever be handed to remove().
        if (!fullPath.startsWith(prefix)) {
          throw new StorageCleanupError(
            "prefix_escape",
            "Refusing to delete a Storage object outside the account namespace.",
          );
        }
        // Two pages can legitimately repeat an entry if objects shift between
        // requests; deleting a path twice is harmless but pointless.
        if (!seen.has(fullPath)) {
          seen.add(fullPath);
          found.push(fullPath);
        }
      }

      if (data.length < STORAGE_LIST_PAGE_SIZE) break;
      offset += data.length;
    }
  }

  return found;
}

/** Split `paths` into bounded batches of at most `size` entries. */
export function chunkPaths(paths: string[], size = STORAGE_REMOVE_BATCH_SIZE): string[][] {
  if (!Number.isInteger(size) || size < 1) {
    throw new StorageCleanupError("invalid_batch_size", "Storage remove batch size must be >= 1.");
  }
  const batches: string[][] = [];
  for (let i = 0; i < paths.length; i += size) {
    batches.push(paths.slice(i, i + size));
  }
  return batches;
}

/**
 * Enumerate and delete every Storage object owned by `userId`.
 *
 * Returns the number of object paths passed to `remove()`. Throws
 * {@link StorageCleanupError} on any listing or removal failure — the caller
 * must treat that as "do not delete the Auth user".
 *
 * Retry-safe: an already-empty namespace performs no `remove()` call at all and
 * succeeds, and Supabase Storage treats removing an already-absent path as a
 * no-op, so re-invoking after a partial attempt proceeds cleanly.
 */
export async function deleteUserStorageObjects(
  storage: StorageNamespaceClient,
  userId: string,
): Promise<number> {
  const prefix = userStoragePrefix(userId);
  const paths = await collectUserStorageObjects(storage, userId);
  if (paths.length === 0) return 0;

  for (const batch of chunkPaths(paths)) {
    // Final gate immediately before the destructive call: no path in any batch
    // may sit outside the authenticated user's own namespace.
    for (const path of batch) {
      if (!path.startsWith(prefix)) {
        throw new StorageCleanupError(
          "prefix_escape",
          "Refusing to delete a Storage object outside the account namespace.",
        );
      }
    }
    const { error } = await storage.remove(batch);
    if (error) {
      throw new StorageCleanupError(
        "remove_failed",
        "Storage objects could not be removed for the account namespace.",
        { cause: error },
      );
    }
  }

  return paths.length;
}

/** Outcome of validating a `delete-account` request body. */
export type ConfirmationCheck =
  | { ok: true }
  | { ok: false; reason: "malformed_body" | "missing_confirmation" | "wrong_confirmation" };

/**
 * Server-side enforcement of the destructive contract.
 *
 * The body must be a JSON object carrying exactly the confirmation phrase.
 * A boolean flag is never accepted as the destructive proof, and a `user_id`
 * (or any other field) in the body is structurally ignored — it can never
 * influence the deletion target, which is derived only from the authenticated
 * token in the caller.
 */
export function checkDeletionConfirmation(body: unknown): ConfirmationCheck {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, reason: "malformed_body" };
  }
  const confirmation = (body as Record<string, unknown>).confirmation;
  if (typeof confirmation !== "string" || confirmation === "") {
    return { ok: false, reason: "missing_confirmation" };
  }
  // Strict exact match: no trimming, no case folding, no normalization. A
  // near-miss such as "DELETE" or "delete my account" is rejected.
  if (confirmation !== ACCOUNT_DELETION_CONFIRMATION) {
    return { ok: false, reason: "wrong_confirmation" };
  }
  return { ok: true };
}

/**
 * Choose the elevated server-only key from the Edge runtime's auto-provided
 * environment, preferring the current secret-key mechanism.
 *
 * `SUPABASE_SECRET_KEYS` is a JSON dictionary keyed by key name (`default` for
 * the key Supabase creates first); `SUPABASE_SERVICE_ROLE_KEY` is the legacy
 * plain string. Both are injected by the platform, so neither requires a
 * manually managed Production secret. Returns `null` when neither is usable —
 * the caller turns that into a safe 500 rather than proceeding unprivileged.
 *
 * Pure: takes the two raw values, never reads the environment, and never logs.
 */
export function selectEdgeSecretKey(
  secretKeysJson: string | null | undefined,
  serviceRoleKey: string | null | undefined,
): string | null {
  if (typeof secretKeysJson === "string" && secretKeysJson.trim() !== "") {
    try {
      const parsed = JSON.parse(secretKeysJson);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        const preferred = (parsed as Record<string, unknown>).default;
        if (typeof preferred === "string" && preferred.trim() !== "") return preferred;
      }
    } catch {
      // Unparseable value: fall through to the legacy key rather than throwing
      // an error whose message could quote the raw (secret-bearing) string.
    }
  }
  if (typeof serviceRoleKey === "string" && serviceRoleKey.trim() !== "") return serviceRoleKey;
  return null;
}
