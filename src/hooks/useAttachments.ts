import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { PaperAttachment } from "@/types/database";

const MAX_SIZE_BYTES = 20 * 1024 * 1024; // 20 MB
const ALLOWED_TYPES = ["application/pdf", "image/jpeg", "image/png", "image/gif", "image/webp", "image/svg+xml"];
const BUCKET = "attachments";

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

      const withUrls: Attachment[] = (data ?? []).map((row) => {
        const { data: urlData } = supabase.storage.from(BUCKET).getPublicUrl(row.file_path);
        return { ...row, publicUrl: urlData.publicUrl };
      });

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
      const isAllowed = ALLOWED_TYPES.includes(file.type) || file.type.startsWith("image/");
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
          await supabase.storage.from(BUCKET).remove([filePath]);
          toast({ title: `Failed to save "${file.name}"`, description: dbError.message, variant: "destructive" });
          continue;
        }

        const { data: urlData } = supabase.storage.from(BUCKET).getPublicUrl(filePath);
        uploaded.push({ ...inserted, publicUrl: urlData.publicUrl });
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
  }, [paperId, userId, toast, notifyParent]);

  const deleteAttachment = useCallback(async (attachment: Attachment) => {
    if (!userId) return;
    try {
      // 1. Remove from storage
      const { error: storageError } = await supabase.storage
        .from(BUCKET)
        .remove([attachment.file_path]);

      if (storageError) throw storageError;

      // 2. Delete DB record
      const { error: dbError } = await supabase
        .from("paper_attachments")
        .delete()
        .eq("id", attachment.id);

      if (dbError) throw dbError;

      setAttachments((prev) => {
        const next = prev.filter((a) => a.id !== attachment.id);
        notifyParent(next);
        return next;
      });
      toast({ title: "Attachment deleted" });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      toast({ title: "Delete failed", description: msg, variant: "destructive" });
    }
  }, [userId, toast, notifyParent]);

  return { attachments, loading, uploading, uploadAttachments, deleteAttachment, refetch: fetchAttachments };
}
