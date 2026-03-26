-- Make the attachments bucket private and replace the public-read RLS policy
-- with an owner-only read policy, so files are only accessible via signed URLs.
--
-- Idempotent: creates the bucket if missing, enforces private + limits if it exists.

-- 1. Create bucket if missing; enforce private + limits if it already exists.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'attachments',
  'attachments',
  false,
  20971520,
  ARRAY['image/jpeg','image/png','image/webp','image/gif','application/pdf']
)
ON CONFLICT (id) DO UPDATE SET
  public = false,
  file_size_limit = 20971520,
  allowed_mime_types = ARRAY['image/jpeg','image/png','image/webp','image/gif','application/pdf'];

-- 2. Drop the old public-read policy
DROP POLICY IF EXISTS "attachments_public_read" ON storage.objects;

-- 3. Create owner-only read policy (matches existing write/delete policies)
CREATE POLICY "attachments_owner_read" ON storage.objects
  FOR SELECT USING (
    bucket_id = 'attachments'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );
