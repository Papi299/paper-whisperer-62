import { supabase } from "@/integrations/supabase/client";
import { getErrorMessage } from "@/lib/errorUtils";

/** What the pre-migration deletion path managed to do. */
export interface LegacyPaperDeletionResult {
  /** Whether the papers were actually deleted from Postgres. */
  ok: boolean;
  /** Human-readable reason when `ok` is false. Empty otherwise. */
  message: string;
  /**
   * Whether Storage cleanup failed after a successful database deletion. On this
   * path a failure is genuinely unrecoverable — nothing records the paths — so
   * the caller must say so rather than reporting an unqualified success.
   */
  cleanupFailed: boolean;
}

/**
 * Delete papers the way PaperLume did before the durable cleanup queue existed.
 *
 * Reached only when `delete_papers_with_attachment_cleanup` is absent — that is,
 * on a database that predates migration `20260904120000`. Merging to `main`
 * deploys the frontend through Vercel while the migration is a separate step, so
 * this window is real and paper deletion has to keep working inside it.
 *
 * The sequence is unchanged from what shipped: read the attachment paths, delete
 * the papers (metadata cascades, quota refunds), then ask Storage to remove the
 * objects. The cleanup is best-effort and, on failure, lossy — that is precisely
 * the gap the queue closes, and it cannot be closed from the client against a
 * schema that has no queue.
 *
 * One thing IS fixed here, because it is a defect rather than a limitation:
 * `storage.remove()` reports most failures by RETURNING `{ error }` rather than
 * throwing, so the original `try { await remove() } catch` reported success for
 * every one of them. Both shapes now count, and the caller can tell the user the
 * truth about what remains.
 */
export async function legacyDeletePapersWithBestEffortCleanup(
  userId: string,
  paperIds: readonly string[],
): Promise<LegacyPaperDeletionResult> {
  // Attachment paths must be read BEFORE the delete — the cascade takes the
  // metadata rows with the papers.
  const { data: attachments, error: readError } = await supabase
    .from("paper_attachments")
    .select("file_path")
    .in("paper_id", [...paperIds]);

  if (readError) {
    return { ok: false, message: getErrorMessage(readError), cleanupFailed: false };
  }

  const storagePaths = (attachments ?? []).map((row) => row.file_path);

  // The explicit `.eq("user_id", userId)` is defense-in-depth on top of the
  // `papers` table's RLS, matching every other mutation in this hook family.
  const { error: deleteError } = await supabase
    .from("papers")
    .delete()
    .in("id", [...paperIds])
    .eq("user_id", userId);

  if (deleteError) {
    return { ok: false, message: getErrorMessage(deleteError), cleanupFailed: false };
  }

  if (storagePaths.length === 0) {
    return { ok: true, message: "", cleanupFailed: false };
  }

  let cleanupFailed = false;
  try {
    const { error: storageError } = await supabase.storage.from("attachments").remove(storagePaths);
    cleanupFailed = Boolean(storageError);
  } catch {
    cleanupFailed = true;
  }

  return { ok: true, message: "", cleanupFailed };
}
