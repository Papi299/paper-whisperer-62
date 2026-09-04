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
 * The immediate, non-durable compensation. It is the whole story on a database
 * that predates the cleanup migration, and the last resort when the durable
 * queue itself could not be written. `remove()` reports most failures by
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
    // Set when the compensation RPC proves a metadata row exists for a file this
    // browser believed had failed. The list is then refetched rather than
    // patched, because what is on the server is the thing to trust.
    let reconcileAfterUpload = false;
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
          // ── Upload compensation ──────────────────────────────────────────
          //
          // The binary is in Storage and (as far as this browser can tell) no
          // metadata row describes it. Order is unchanged from before this
          // hardening — upload first, metadata second — but the compensation is
          // no longer a single fire-and-forget `remove()` whose failure vanished.
          //
          // The database is asked to record the intent durably FIRST, because it
          // also knows something this browser does not: whether the insert
          // actually committed. A request that timed out or lost its response
          // reports an error here while having written the row, and deleting the
          // object then would destroy a valid, quota-charged attachment. The RPC
          // answers `metadata_present` for exactly that case and queues nothing.
          const { data: queueStatus, error: queueError } = await supabase.rpc(
            "queue_untracked_attachment_cleanup",
            { p_paper_id: paperId, p_file_path: filePath },
          );

          if (!queueError) {
            noteAttachmentCleanupObjectPresent("queue_untracked_attachment_cleanup");

            if (queueStatus === "metadata_present") {
              // The insert committed after all. Do NOT touch Storage; reconcile
              // the list instead, and say so rather than reporting a failure the
              // database contradicts.
              reconcileAfterUpload = true;
              toast({
                title: `"${file.name}" was saved`,
                description: "Saving reported an error, but the file is stored. The list has been refreshed.",
              });
              continue;
            }

            // Queued. Try to finish it now; if that fails the row survives and
            // the next authenticated session retries it.
            const cleanup = await drainAttachmentCleanupQueue(userId);
            if (cleanup.status === "pending") {
              toast({
                title: `Failed to save "${file.name}"`,
                description: "The uploaded file could not be removed yet; cleanup will retry automatically.",
                variant: "destructive",
              });
            } else {
              toast({ title: `Failed to save "${file.name}"`, description: dbError.message, variant: "destructive" });
            }
            continue;
          }

          // The durable path is unavailable. Two different reasons, one
          // immediate fallback, two different things to tell the user.
          const oldSchema = isAttachmentCleanupSchemaMissing(queueError);
          const removed = await removeStorageObject(filePath);

          if (removed) {
            toast({ title: `Failed to save "${file.name}"`, description: dbError.message, variant: "destructive" });
          } else if (oldSchema) {
            toast({
              title: `Failed to save "${file.name}"`,
              description: "The uploaded file could not be removed and may still be stored.",
              variant: "destructive",
            });
          } else {
            // Both the database and Storage refused. Nothing can persist the
            // intent, and claiming cleanup happened would be a lie.
            toast({
              title: `Failed to save "${file.name}"`,
              description: "The uploaded file could not be removed and cleanup could not be recorded. Please try again later.",
              variant: "destructive",
            });
          }
          continue;
        }

        const { data: signedData } = await supabase.storage
          .from(BUCKET)
          .createSignedUrl(filePath, SIGNED_URL_EXPIRY);
        uploaded.push({ ...inserted, publicUrl: signedData?.signedUrl ?? "" });
      }

      if (uploaded.length > 0) {
        setAttachments((prev) => {
          const next = [...prev, ...uploaded];
          notifyParent(next);
          return next;
        });
        toast({ title: uploaded.length === 1 ? "Attachment uploaded" : `${uploaded.length} attachments uploaded` });
      }

      if (reconcileAfterUpload) {
        await fetchAttachments();
      }
    } finally {
      setUploading(false);
    }
  }, [paperId, userId, toast, notifyParent, fetchAttachments]);

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
      // must stay visible.
      toast({ title: "Delete failed", description: rpcError.message, variant: "destructive" });
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
