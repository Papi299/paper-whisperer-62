import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

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

export function useAttachments(paperId: string | null | undefined, userId: string | null | undefined) {
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

  const uploadAttachment = useCallback(async (file: File) => {
    if (!paperId || !userId) return;

    // Validate size
    if (file.size > MAX_SIZE_BYTES) {
      toast({ title: "File too large. Max size is 20MB.", variant: "destructive" });
      return;
    }

    // Validate type
    const isAllowed = ALLOWED_TYPES.includes(file.type) || file.type.startsWith("image/");
    if (!isAllowed) {
      toast({ title: "Invalid file type. Only images and PDFs are allowed.", variant: "destructive" });
      return;
    }

    setUploading(true);
    try {
      // Build a unique storage path
      const ext = file.name.split(".").pop() ?? "bin";
      const uniqueName = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
      const filePath = `${userId}/${paperId}/${uniqueName}`;

      // 1. Upload to storage
      const { error: storageError } = await supabase.storage
        .from(BUCKET)
        .upload(filePath, file, { contentType: file.type, upsert: false });

      if (storageError) throw storageError;

      // 2. Insert record into DB
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
        // Roll back storage upload on DB failure
        await supabase.storage.from(BUCKET).remove([filePath]);
        throw dbError;
      }

      const { data: urlData } = supabase.storage.from(BUCKET).getPublicUrl(filePath);
      setAttachments((prev) => [...prev, { ...inserted, publicUrl: urlData.publicUrl }]);
      toast({ title: "Attachment uploaded" });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      toast({ title: "Upload failed", description: msg, variant: "destructive" });
    } finally {
      setUploading(false);
    }
  }, [paperId, userId, toast]);

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

      setAttachments((prev) => prev.filter((a) => a.id !== attachment.id));
      toast({ title: "Attachment deleted" });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      toast({ title: "Delete failed", description: msg, variant: "destructive" });
    }
  }, [userId, toast]);

  return { attachments, loading, uploading, uploadAttachment, deleteAttachment, refetch: fetchAttachments };
}
