import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { PaperAttachment } from "@/types/database";
import { drainAttachmentCleanupQueue } from "@/lib/attachmentCleanup";
import {
  isAttachmentCleanupSchemaMissing,
  noteAttachmentCleanupObjectPresent,
} from "@/lib/attachmentCleanupAvailability";

const MAX_SIZE_BYTES = 20 * 1024 * 1024; // 20 MB
const ALLOWED_TYPES = ["application/pdf", "image/jpeg", "image/png", "image/gif", "image/webp"];
const BUCKET = "attachments";
const SIGNED_URL_EXPIRY = 3600; // 1 hour

export interface Attachment {
  id: string;
  paper_id: string;
  user_id: string;
  file_path: string;
  file_name: string;
  file_type: string;
  size_bytes: number;
  created_at: string;
  publicUrl: string;
}

/** Called after every upload/delete so the parent can sync the table cache. */
export type OnAttachmentsChange = (paperId: string, attachments: PaperAttachment[]) => void;

/**
 * Remove one just-uploaded object from Storage, reporting both failure shapes.
 *
 * The immediate, non-durable compensation, and the whole story on a database
 * that predates the cleanup migration. `remove()` reports most failures by
 * RETURNING `{ error }` rather than throwing, so a bare `await` inside a
 * `try/catch` — which is what this path used to be — reports success for every
 * one of them.
 */
async function removeStorageObject(filePath: string): Promise<boolean> {
  try {
    const { error } = await supabase.storage.from(BUCKET).remove([filePath]);
    return !error;
  } catch {
    return false;
  }
}

/**
 * How many times one object's finalization may be attempted.
 *
 * A retry is safe ONLY because `finalize_attachment_upload` is idempotent per
 * path: it reports the durable outcome of an earlier attempt instead of redoing
 * it, so a second call cannot insert a second row or charge quota twice. The
 * bound is small on purpose — this is reconciliation of an ambiguous response,
 * not a resilience layer, and there is no timer, backoff or scheduled retry
 * anywhere in it.
 */
const FINALIZE_MAX_ATTEMPTS = 2;

/** The row shape `finalize_attachment_upload` returns alongside its status. */
interface FinalizeRow {
  status: string;
  attachment_id: string | null;
  attachment_paper_id: string | null;
  attachment_user_id: string | null;
  attachment_file_path: string | null;
  attachment_file_name: string | null;
  attachment_file_type: string | null;
  attachment_size_bytes: number | null;
  attachment_created_at: string | null;
}

/**
 * What the server established about one uploaded object.
 *
 *  * `saved` — metadata is committed (by this call or by an earlier attempt of
 *    it). The row is authoritative; no cleanup exists or may be created.
 *  * `queued` — the metadata was rejected and durable cleanup intent is
 *    committed instead. The object is garbage and may be removed.
 *  * `unavailable` — this database predates the cleanup migration.
 *  * `unresolved` — the database did not answer. NOTHING is known, so nothing
 *    may be deleted.
 */
type FinalizeOutcome =
  | { kind: "saved"; attachment: Omit<Attachment, "publicUrl"> }
  | { kind: "queued" }
  | { kind: "unavailable" }
  | { kind: "unresolved" };

/** Project a finalization row onto the shape the list renders. */
function rowToAttachment(row: FinalizeRow): Omit<Attachment, "publicUrl"> | null {
  if (
    !row.attachment_id || !row.attachment_paper_id || !row.attachment_user_id ||
    !row.attachment_file_path || !row.attachment_file_name ||
    !row.attachment_file_type || row.attachment_size_bytes === null ||
    !row.attachment_created_at
  ) {
    return null;
  }
  return {
    id: row.attachment_id,
    paper_id: row.attachment_paper_id,
    user_id: row.attachment_user_id,
    file_path: row.attachment_file_path,
    file_name: row.attachment_file_name,
    file_type: row.attachment_file_type,
    size_bytes: row.attachment_size_bytes,
    created_at: row.attachment_created_at,
  };
}

/**
 * Ask the server to finalize one uploaded object, and take its answer as final.
 *
 * ── Why the browser no longer inserts the metadata itself ──────────────────
 *
 * It used to: upload, INSERT, and — if the INSERT looked like it failed — ask a
 * separate RPC whether a metadata row existed, deleting the object when none
 * did. That check cannot see a transaction still in flight, and "the INSERT
 * failed" is only ever what THIS TAB OBSERVED. A request whose response was lost
 * commits anyway, so the sequence could delete a valid, quota-charged
 * attachment's binary a moment before its row became visible.
 *
 * So the upload, the metadata and the cleanup decision are one server-side
 * transaction now, serialized per (user, path). This function's only job is to
 * repeat the call when the transport fails and to report what the SERVER said —
 * never what this tab inferred.
 *
 * Never throws.
 */
async function finalizeAttachmentUpload(
  paperId: string,
  filePath: string,
  file: File,
): Promise<FinalizeOutcome> {
  for (let attempt = 0; attempt < FINALIZE_MAX_ATTEMPTS; attempt++) {
    let data: unknown = null;
    let error: unknown = null;
    try {
      ({ data, error } = await supabase.rpc("finalize_attachment_upload", {
        p_paper_id: paperId,
        p_file_path: filePath,
        p_file_name: file.name,
        p_file_type: file.type,
        p_size_bytes: file.size,
      }));
    } catch (thrown) {
      // A thrown transport error and a returned `{ error }` mean the same thing
      // here: this tab does not know what the database did.
      error = thrown;
    }

    if (!error) {
      noteAttachmentCleanupObjectPresent("finalize_attachment_upload");
      const row = Array.isArray(data) ? (data[0] as FinalizeRow | undefined) : undefined;

      if (row?.status === "cleanup_queued") return { kind: "queued" };
      if (row?.status === "metadata_committed" || row?.status === "metadata_present") {
        const attachment = rowToAttachment(row);
        // A success status with an unusable row is not a success. Falling
        // through to `unresolved` keeps the object rather than deleting it on
        // the strength of a response nobody can interpret.
        if (attachment) return { kind: "saved", attachment };
      }
      return { kind: "unresolved" };
    }

    // A database that predates the migration answers this way on every attempt,
    // so there is nothing to retry — switch paths immediately.
    if (isAttachmentCleanupSchemaMissing(error)) return { kind: "unavailable" };
  }

  // Every attempt failed in transport. The object may be a valid attachment or
  // it may be garbage; there is no evidence either way, and guessing is the
  // thing that used to destroy files.
  return { kind: "unresolved" };
}

export function useAttachments(
  paperId: string | null | undefined,
  userId: string | null | undefined,
  onAttachmentsChange?: OnAttachmentsChange,
) {
  const { toast } = useToast();
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);

  const fetchAttachments = useCallback(async () => {
    if (!paperId || !userId) return;
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("paper_attachments")
        .select("*")
        .eq("paper_id", paperId)
        .order("created_at", { ascending: true });

      if (error) throw error;

      const rows = data ?? [];
      let signedUrls: (string | null)[] = rows.map(() => null);
      if (rows.length > 0) {
        const paths = rows.map((row) => row.file_path);
        const { data: signedData } = await supabase.storage
          .from(BUCKET)
          .createSignedUrls(paths, SIGNED_URL_EXPIRY);
        if (signedData) {
          signedUrls = signedData.map((entry) => entry.signedUrl);
        }
      }

      const withUrls: Attachment[] = rows.map((row, i) => ({
        ...row,
        publicUrl: signedUrls[i] ?? "",
      }));
      setAttachments(withUrls);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      toast({ title: "Failed to load attachments", description: msg, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [paperId, userId, toast]);

  useEffect(() => {
    fetchAttachments();
  }, [fetchAttachments]);

  /** Convert current attachments to lightweight PaperAttachment[] and notify parent. */
  const notifyParent = useCallback((current: Attachment[]) => {
    if (!paperId || !onAttachmentsChange) return;
    const lightweight: PaperAttachment[] = current.map((a) => ({
      id: a.id,
      file_name: a.file_name,
      file_path: a.file_path,
      file_type: a.file_type,
    }));
    onAttachmentsChange(paperId, lightweight);
  }, [paperId, onAttachmentsChange]);

  /**
   * Pre-migration upload finalization: INSERT the metadata from this tab, and
   * compensate immediately if it fails.
   *
   * Reached only when `finalize_attachment_upload` is absent — a database that
   * predates migration `20260904120000`. Merging to `main` deploys the frontend
   * while the migration is a separate step, so uploads must keep working inside
   * that window, and this is the behaviour that shipped there. It carries the
   * lost-response weakness the durable path exists to remove, and it cannot be
   * fixed from the client against a schema with no queue and no finalization
   * RPC: the whole repair lives in the migration.
   *
   * Its user-visible strings are deliberately the ones that shipped, so merging
   * this branch does not quietly change what Production says today. One thing IS
   * fixed, because it is a defect rather than a limitation: `remove()` reports
   * most failures by RETURNING `{ error }`, and the original ignored that, so a
   * file left behind was reported as cleaned up.
   */
  const legacyFinalizeUpload = useCallback(async (
    file: File,
    filePath: string,
    uploaded: Attachment[],
  ) => {
    if (!paperId || !userId) return;

    const { data: inserted, error: dbError } = await supabase
      .from("paper_attachments")
      .insert({
        paper_id: paperId,
        user_id: userId,
        file_path: filePath,
        file_name: file.name,
        file_type: file.type,
        size_bytes: file.size,
      })
      .select()
      .single();

    if (dbError) {
      const removed = await removeStorageObject(filePath);
      toast({
        title: `Failed to save "${file.name}"`,
        description: removed
          ? dbError.message
          : "The uploaded file could not be removed and may still be stored.",
        variant: "destructive",
      });
      return;
    }

    const { data: signedData } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(filePath, SIGNED_URL_EXPIRY);
    uploaded.push({ ...inserted, publicUrl: signedData?.signedUrl ?? "" });
  }, [paperId, userId, toast]);

  const uploadAttachments = useCallback(async (files: File[]) => {
    if (!paperId || !userId || files.length === 0) return;

    // Validate all files first
    const validFiles: File[] = [];
    for (const file of files) {
      if (file.size > MAX_SIZE_BYTES) {
        toast({ title: `"${file.name}" too large (max 20MB).`, variant: "destructive" });
        continue;
      }
      const isAllowed = ALLOWED_TYPES.includes(file.type);
      if (!isAllowed) {
        toast({ title: `"${file.name}" is not a valid type (images/PDFs only).`, variant: "destructive" });
        continue;
      }
      validFiles.push(file);
    }

    if (validFiles.length === 0) return;

    setUploading(true);
    const uploaded: Attachment[] = [];
    try {
      for (const file of validFiles) {
        const ext = file.name.split(".").pop() ?? "bin";
        const uniqueName = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
        const filePath = `${userId}/${paperId}/${uniqueName}`;

        const { error: storageError } = await supabase.storage
          .from(BUCKET)
          .upload(filePath, file, { contentType: file.type, upsert: false });

        if (storageError) {
          toast({ title: `Failed to upload "${file.name}"`, description: storageError.message, variant: "destructive" });
          continue;
        }

        // ── Finalization ────────────────────────────────────────────────
        //
        // One server call decides, atomically, whether this object becomes an
        // attachment or becomes garbage. The browser does not INSERT the
        // metadata and does not get a vote: see finalizeAttachmentUpload.
        const outcome = await finalizeAttachmentUpload(paperId, filePath, file);

        if (outcome.kind === "saved") {
          const { data: signedData } = await supabase.storage
            .from(BUCKET)
            .createSignedUrl(filePath, SIGNED_URL_EXPIRY);
          uploaded.push({ ...outcome.attachment, publicUrl: signedData?.signedUrl ?? "" });
          continue;
        }

        if (outcome.kind === "queued") {
          // The database rejected the metadata and committed the intent to
          // remove the object in the same transaction. Finishing that now is an
          // optimisation; the intent survives whatever Storage does.
          const cleanup = await drainAttachmentCleanupQueue(userId);
          toast({
            title: `Failed to save "${file.name}"`,
            description: cleanup.status === "pending"
              ? "The uploaded file could not be removed yet; cleanup will retry automatically."
              : "The uploaded file has been removed.",
            variant: "destructive",
          });
          continue;
        }

        if (outcome.kind === "unavailable") {
          await legacyFinalizeUpload(file, filePath, uploaded);
          continue;
        }

        // `unresolved`: the database never answered. The object might be a
        // perfectly valid attachment whose row committed after the response was
        // lost, so it is NOT deleted and no cleanup is claimed. Account deletion
        // sweeps Storage independently and remains the backstop.
        toast({
          title: `Failed to save "${file.name}"`,
          description: "The upload could not be confirmed, so the file was left in place. Please try again.",
          variant: "destructive",
        });
      }

      if (uploaded.length > 0) {
        setAttachments((prev) => {
          const next = [...prev, ...uploaded];
          notifyParent(next);
          return next;
        });
        toast({ title: uploaded.length === 1 ? "Attachment uploaded" : `${uploaded.length} attachments uploaded` });
      }
    } finally {
      setUploading(false);
    }
  }, [paperId, userId, toast, notifyParent, legacyFinalizeUpload]);

  /**
   * Pre-migration deletion: remove the Storage object, then the metadata row.
   *
   * This is the behaviour that shipped before the cleanup queue existed, and it
   * stays exactly right for a database that predates the migration: Storage
   * first means a Storage failure leaves BOTH halves intact, so nothing is
   * orphaned and the user can genuinely retry. Its opposite failure — Storage
   * succeeding and the metadata delete failing — is why the durable path exists,
   * but it is not made better by reordering here.
   *
   * The one thing this fixes relative to the original is error observation:
   * `remove()` returns `{ error }` far more often than it throws.
   */
  const legacyDeleteAttachment = useCallback(async (attachment: Attachment) => {
    if (!userId) return;
    const removed = await removeStorageObject(attachment.file_path);
    if (!removed) {
      toast({
        title: "Delete failed",
        description: "The attachment file could not be removed. Please try again.",
        variant: "destructive",
      });
      return;
    }

    // Explicit `user_id` filter is defense-in-depth on top of the
    // `paper_attachments` table's RLS.
    const { error: dbError } = await supabase
      .from("paper_attachments")
      .delete()
      .eq("id", attachment.id)
      .eq("user_id", userId);

    if (dbError) {
      toast({ title: "Delete failed", description: dbError.message, variant: "destructive" });
      return;
    }

    setAttachments((prev) => {
      const next = prev.filter((a) => a.id !== attachment.id);
      notifyParent(next);
      return next;
    });
    toast({ title: "Attachment deleted" });
  }, [userId, toast, notifyParent]);

  const deleteAttachment = useCallback(async (attachment: Attachment) => {
    if (!userId) return;

    // ── Logical deletion first, atomically ────────────────────────────────
    //
    // One transaction records the Storage cleanup intent and removes the
    // metadata row, so the path can never stop being reachable without the
    // database still knowing about it. The quota refund trigger fires from that
    // same DELETE, unchanged.
    const { error: rpcError } = await supabase.rpc("delete_attachment_with_cleanup", {
      p_attachment_id: attachment.id,
    });

    if (rpcError) {
      if (isAttachmentCleanupSchemaMissing(rpcError)) {
        await legacyDeleteAttachment(attachment);
        return;
      }
      // A real failure: nothing committed, so the attachment is still there and
      // must stay visible. The RPC's guard text is internal — it names paths,
      // namespaces and ownership rules — so the user gets a bounded, stable
      // sentence instead.
      toast({
        title: "Delete failed",
        description: "The attachment could not be deleted. Please try again.",
        variant: "destructive",
      });
      return;
    }

    noteAttachmentCleanupObjectPresent("delete_attachment_with_cleanup");

    // Committed. The attachment is gone from the user's library whatever
    // happens next, so the UI must not be rolled back by a Storage problem.
    setAttachments((prev) => {
      const next = prev.filter((a) => a.id !== attachment.id);
      notifyParent(next);
      return next;
    });

    const cleanup = await drainAttachmentCleanupQueue(userId);
    if (cleanup.status === "pending") {
      // Truthful and bounded: the delete succeeded, the file has not gone yet,
      // and nobody needs to do anything about it.
      toast({
        title: "Attachment deleted",
        description: "File cleanup is pending and will retry automatically.",
      });
    } else {
      toast({ title: "Attachment deleted" });
    }
  }, [userId, toast, notifyParent, legacyDeleteAttachment]);

  return { attachments, loading, uploading, uploadAttachments, deleteAttachment, refetch: fetchAttachments };
}
