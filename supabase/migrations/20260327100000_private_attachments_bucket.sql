-- Make the attachments bucket private and replace the public-read RLS policy
-- with an owner-only read policy, so files are only accessible via signed URLs.

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
