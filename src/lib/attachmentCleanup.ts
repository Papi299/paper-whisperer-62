/**
 * Draining the durable attachment-cleanup queue.
 *
 * ATTACHMENT-ORPHAN-CLEANUP-HARDENING-001. Postgres and Supabase Storage cannot
 * share a transaction, so attachment deletion is split in two: the database
 * records the cleanup intent in `attachment_cleanup_queue` in the SAME
 * transaction that removes the metadata naming the object, and this module —
 * running in the authenticated browser session that already holds Storage DELETE
 * on its own prefix — performs the physical removal afterwards and acknowledges
 * the row.
 *
 * That split is what makes the operation recoverable. Before it, a failed
 * Storage removal left no record anywhere; now a failure simply leaves the queue
 * row in place, and the next drain tries again.
 *
 * ── What this module is not ────────────────────────────────────────────────
 *
 * It is not a job framework, and it must not become one. There is no scheduler,
 * no timer, no polling loop, no service worker and no server-side worker. It
 * runs exactly twice per opportunity: immediately after a user action that
 * queued something, and once when an authenticated application session starts.
 * If the user never returns, the queue row waits, and the account-deletion Edge
 * Function's independent Storage sweep remains the final safety net.
 *
 * ── Safety rules ───────────────────────────────────────────────────────────
 *
 * 1. **Every path is re-validated here**, immediately before it can reach
 *    `remove()`, even though the RPC that wrote it validated it too. The
 *    database is a boundary, not a proof about this tab's signed-in user.
 * 2. **Both failure shapes count.** Supabase Storage reports most failures by
 *    returning `{ error }` rather than throwing, so inspecting only `catch` sees
 *    a clean run where none happened.
 * 3. **Acknowledge only after Storage confirms.** A row is deleted only once the
 *    batch containing it came back clean. If acknowledgement itself fails the
 *    row stays, and the next pass removes an already-absent object — which
 *    Supabase Storage treats as a no-op — and retries the acknowledgement.
 * 4. **Nothing identifying is logged.** No path, file name, paper id or user id
 *    ever reaches the console; only counts and a stable message.
 */

import { supabase } from "@/integrations/supabase/client";
import {
  isAttachmentCleanupSchemaMissing,
  noteAttachmentCleanupObjectPresent,
} from "@/lib/attachmentCleanupAvailability";

/** The private bucket holding attachment binaries. */
export const ATTACHMENTS_BUCKET = "attachments";

/** The durable queue table. */
export const CLEANUP_QUEUE_TABLE = "attachment_cleanup_queue";

/** Rows requested per PostgREST page. Well below the 1000-row default cap. */
export const CLEANUP_QUEUE_PAGE_SIZE = 200;

/**
 * Paths per `remove()` call. Supabase Storage documents a hard limit of 1000;
 * 100 keeps a single failing request from stalling a large drain and keeps the
 * acknowledgement granularity fine enough that one bad batch costs little.
 */
export const CLEANUP_REMOVE_BATCH_SIZE = 100;

/**
 * Pages read in one pass. A bound, not an expectation: a normal queue holds a
 * handful of rows. It exists so a pathological queue cannot turn one session
 * start into an unbounded loop — the remainder is simply picked up next time.
 */
export const CLEANUP_MAX_PAGES = 20;

/** One queued cleanup job, projected to the two columns the drain needs. */
export interface AttachmentCleanupJob {
  id: string;
  file_path: string;
}

/**
 * The outcome of one drain pass.
 *
 * `status` is what callers branch on:
 *
 *  * `unavailable` — this environment predates the cleanup migration. No Storage
 *    call was made and no claim is made about orphans.
 *  * `completed` — nothing was pending, or everything pending was removed and
 *    acknowledged.
 *  * `pending` — at least one job remains. Either Storage refused, or the queue
 *    could not be read, or a queued path failed re-validation. It will be
 *    retried; it has NOT been lost.
 */
export interface AttachmentCleanupResult {
  status: "completed" | "pending" | "unavailable";
  /** Objects removed AND acknowledged in this pass. */
  removed: number;
  /** Jobs known to remain. `null` when the queue itself could not be read. */
  pending: number | null;
}

/**
 * Whether `filePath` is safely inside `userId`'s attachments namespace.
 *
 * Mirrors `public.attachment_cleanup_path_is_safe` exactly, and for the same
 * reason: the first path segment is the security boundary that the Storage RLS
 * policies enforce through `storage.foldername(name)[1]`, so a path failing this
 * check must never reach `remove()`.
 *
 * Rejects an empty or over-long path, any backslash (the classic way to smuggle
 * a separator past a `/`-based check), any control character, anything that is
 * not exactly `<user>/<paper>/<name>`, any empty / `.` / `..` segment (which
 * covers absolute paths, trailing slashes and `//` collapses), and any first
 * segment that is not exactly this user's id.
 */
export function isSafeCleanupPath(userId: string, filePath: unknown): boolean {
  if (typeof userId !== "string" || userId.length === 0) return false;
  if (typeof filePath !== "string") return false;
  if (filePath.length === 0 || filePath.length > 1024) return false;
  if (filePath.includes("\\")) return false;
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  if (/[\u0000-\u001F\u007F]/.test(filePath)) return false;

  const segments = filePath.split("/");
  if (segments.length !== 3) return false;
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return false;
  }
  return segments[0] === userId;
}

/** Split `items` into bounded batches. */
function chunk<T>(items: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

/**
 * Read the caller's own pending cleanup jobs, oldest first.
 *
 * Paginated: one PostgREST response is never assumed to be the whole queue.
 * Ordered by `created_at` then `id` so paging is deterministic even when several
 * rows share a timestamp — an unordered page boundary can repeat or skip rows.
 *
 * Every page is read before anything is deleted, so the offsets cannot shift
 * underneath the walk.
 *
 * Returns `null` when the queue could not be read at all; throws nothing.
 */
async function fetchCleanupJobs(
  userId: string,
): Promise<{ jobs: AttachmentCleanupJob[] } | { unavailable: true } | { failed: true }> {
  const jobs: AttachmentCleanupJob[] = [];

  for (let page = 0; page < CLEANUP_MAX_PAGES; page++) {
    const from = page * CLEANUP_QUEUE_PAGE_SIZE;
    const to = from + CLEANUP_QUEUE_PAGE_SIZE - 1;

    let data: AttachmentCleanupJob[] | null = null;
    let error: unknown = null;
    try {
      // The explicit `.eq("user_id", …)` is defense-in-depth on top of the
      // table's SELECT-own policy — the same S2 client-scoping rule every other
      // owned-table read in this repository follows.
      ({ data, error } = await supabase
        .from(CLEANUP_QUEUE_TABLE)
        .select("id, file_path")
        .eq("user_id", userId)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to));
    } catch (thrown) {
      error = thrown;
    }

    if (error) {
      if (isAttachmentCleanupSchemaMissing(error)) return { unavailable: true };
      return { failed: true };
    }

    // The table answered, so this environment has the cleanup schema. Recorded
    // so a later missing-object error is read as a partial install rather than
    // as an ordinary pre-migration database.
    noteAttachmentCleanupObjectPresent(CLEANUP_QUEUE_TABLE);

    const rows = data ?? [];
    jobs.push(...rows);
    if (rows.length < CLEANUP_QUEUE_PAGE_SIZE) break;
  }

  return { jobs };
}

/**
 * Remove the Storage objects for `jobs` and acknowledge the rows that succeeded.
 *
 * Stops at the first failing batch rather than grinding through the rest: when
 * Storage is refusing, continuing turns one user action into dozens of doomed
 * requests. The untried remainder stays queued and is picked up next pass.
 *
 * Returns how many jobs were both removed and acknowledged.
 */
async function removeAndAcknowledge(
  userId: string,
  jobs: readonly AttachmentCleanupJob[],
): Promise<number> {
  let removed = 0;

  for (const batch of chunk(jobs, CLEANUP_REMOVE_BATCH_SIZE)) {
    let storageError: unknown = null;
    try {
      const { error } = await supabase.storage
        .from(ATTACHMENTS_BUCKET)
        .remove(batch.map((job) => job.file_path));
      storageError = error ?? null;
    } catch (thrown) {
      // Both shapes are failures. A thrown network error and a returned
      // `{ error }` mean the same thing here: the object may still exist.
      storageError = thrown;
    }
    if (storageError) break;

    // Acknowledge only what Storage just confirmed. The explicit
    // `.eq("user_id", …)` is defense-in-depth on top of the DELETE-own policy.
    let ackError: unknown = null;
    try {
      const { error } = await supabase
        .from(CLEANUP_QUEUE_TABLE)
        .delete()
        .eq("user_id", userId)
        .in(
          "id",
          batch.map((job) => job.id),
        );
      ackError = error ?? null;
    } catch (thrown) {
      ackError = thrown;
    }
    // A failed acknowledgement is NOT success. The binary is gone, but the job
    // is not finished until the row is, and re-removing an absent object next
    // pass is a no-op.
    if (ackError) break;

    removed += batch.length;
  }

  return removed;
}

/**
 * Run one bounded pass over the caller's pending attachment cleanup.
 *
 * Never throws: every failure is reported through the returned status, because
 * callers invoke this after an operation that has ALREADY committed and must not
 * be able to turn a cleanup problem into a failure of the thing the user asked
 * for.
 */
export async function drainAttachmentCleanupQueue(
  userId: string | null | undefined,
): Promise<AttachmentCleanupResult> {
  if (!userId) return { status: "completed", removed: 0, pending: 0 };

  const fetched = await fetchCleanupJobs(userId);

  if ("unavailable" in fetched) {
    return { status: "unavailable", removed: 0, pending: null };
  }
  if ("failed" in fetched) {
    // The queue could not be read, so nothing can be claimed about what remains.
    console.warn("attachment-cleanup: pending queue could not be read");
    return { status: "pending", removed: 0, pending: null };
  }

  const { jobs } = fetched;
  if (jobs.length === 0) return { status: "completed", removed: 0, pending: 0 };

  // A queued path outside this user's namespace cannot be produced by the RPCs
  // that write the queue. It is filtered rather than deleted: refusing to act on
  // it is the safe response, and removing the row would discard evidence.
  const safeJobs = jobs.filter((job) => isSafeCleanupPath(userId, job.file_path));

  const removed = await removeAndAcknowledge(userId, safeJobs);
  const pending = jobs.length - removed;

  if (pending > 0) {
    console.warn(`attachment-cleanup: ${pending} cleanup job(s) still pending`);
  }

  return { status: pending > 0 ? "pending" : "completed", removed, pending };
}
