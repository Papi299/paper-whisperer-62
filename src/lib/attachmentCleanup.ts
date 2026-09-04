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
 * 5. **The bound is honest.** The pass reads at most `CLEANUP_MAX_PAGES` pages
 *    and reports `completed` only when it actually SAW the end of the queue.
 *    Finishing the work it fetched is not the same as finishing the queue.
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
 *
 * Reaching it is not an error and does not raise the bound; it changes what the
 * pass is allowed to CLAIM. See `fetchCleanupJobs`.
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
 *  * `completed` — the drain saw the END of the queue and everything it saw is
 *    gone. This is the only status that claims there is no pending cleanup.
 *  * `pending` — work remains. Either Storage refused, or the queue could not be
 *    read, or a queued path failed re-validation, or the page bound was reached
 *    before the end of the queue was observed. It will be retried; it has NOT
 *    been lost.
 *
 * `completed` is deliberately hard to earn. A pass that removed every job it
 * FETCHED has not finished if it never saw the end of the queue — see
 * `fetchCleanupJobs`.
 */
export interface AttachmentCleanupResult {
  status: "completed" | "pending" | "unavailable";
  /** Objects removed AND acknowledged in this pass. */
  removed: number;
  /**
   * Jobs known to remain, or `null` when that number is genuinely unknown —
   * the queue could not be read at all, or enumeration stopped at the page
   * bound with rows still unseen. It is never a guess: a caller that needs a
   * number and gets `null` must say "pending", not "none".
   */
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
 * ── `truncated` ───────────────────────────────────────────────────────────
 *
 * The page bound is a real bound: this function will not read a
 * `CLEANUP_MAX_PAGES + 1`-th page under any circumstances. So it reports
 * whether it actually reached the end of the queue, which is a different
 * question from whether it stopped.
 *
 * Enumeration is COMPLETE when a page came back short (or empty): a page holding
 * fewer than `CLEANUP_QUEUE_PAGE_SIZE` rows is the last page by definition. It
 * is TRUNCATED when the last page the bound allowed came back FULL — that is
 * exactly the case where more rows may exist and this pass will never see them.
 * A caller that treated a truncated read as the whole queue would report
 * `completed` for a queue it had only partly drained.
 *
 * Returns `failed` when the queue could not be read at all; throws nothing.
 */
async function fetchCleanupJobs(
  userId: string,
): Promise<
  { jobs: AttachmentCleanupJob[]; truncated: boolean } | { unavailable: true } | { failed: true }
> {
  const jobs: AttachmentCleanupJob[] = [];
  // Only cleared by observing the end of the queue. Starting from "truncated"
  // means a loop that somehow exits without seeing a short page still reports
  // the cautious answer.
  let truncated = true;

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
    if (rows.length < CLEANUP_QUEUE_PAGE_SIZE) {
      // A short page is the end of the queue. Nothing is unseen.
      truncated = false;
      break;
    }
  }

  return { jobs, truncated };
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

  const { jobs, truncated } = fetched;
  if (jobs.length === 0) return { status: "completed", removed: 0, pending: 0 };

  // A queued path outside this user's namespace cannot be produced by the RPCs
  // that write the queue. It is filtered rather than deleted: refusing to act on
  // it is the safe response, and removing the row would discard evidence.
  const safeJobs = jobs.filter((job) => isSafeCleanupPath(userId, job.file_path));

  const removed = await removeAndAcknowledge(userId, safeJobs);
  const pending = jobs.length - removed;

  if (truncated) {
    // Every job this pass FETCHED may well be gone, but the queue was longer
    // than one bounded pass can enumerate, so the remainder is unknown — not
    // zero. Reporting `completed` here is the false claim this branch exists to
    // prevent; the next authenticated session takes the following window.
    console.warn("attachment-cleanup: the pending queue is longer than one pass can drain");
    return { status: "pending", removed, pending: null };
  }

  if (pending > 0) {
    console.warn(`attachment-cleanup: ${pending} cleanup job(s) still pending`);
  }

  return { status: pending > 0 ? "pending" : "completed", removed, pending };
}
