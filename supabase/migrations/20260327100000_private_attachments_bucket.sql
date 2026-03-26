-- Make the attachments bucket private and replace the public-read RLS policy
-- with an owner-only read policy, so files are only accessible via signed URLs.
--
-- PREREQUISITE: The 'attachments' bucket must already exist in storage.buckets.
-- It was created via the Supabase dashboard (not tracked in migrations).
-- For a fresh Supabase project, create the bucket first:
--
--   INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
--   VALUES (
--     'attachments',
--     'attachments',
--     false,
--     20971520,
--     ARRAY['image/jpeg','image/png','image/webp','image/gif','application/pdf']
--   );
--
-- If the bucket already exists, the UPDATE below handles the public→private change.

-- 1. Make the bucket private (public buckets bypass RLS for reads entirely)
UPDATE storage.buckets SET public = false WHERE id = 'attachments';

-- 2. Drop the old public-read policy
DROP POLICY IF EXISTS "attachments_public_read" ON storage.objects;

-- 3. Create owner-only read policy (matches existing write/delete policies)
CREATE POLICY "attachments_owner_read" ON storage.objects
  FOR SELECT USING (
    bucket_id = 'attachments'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );
