-- Storage RLS policies for the 'attachments' bucket.
-- Upload path structure: {userId}/{paperId}/{uniqueName}

-- 1. Public read (bucket is public)
CREATE POLICY "attachments_public_read" ON storage.objects
  FOR SELECT USING (bucket_id = 'attachments');

-- 2. Owner insert — path must start with own auth.uid()
CREATE POLICY "attachments_owner_insert" ON storage.objects
  FOR INSERT WITH CHECK (
    bucket_id = 'attachments'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );

-- 3. Owner update
CREATE POLICY "attachments_owner_update" ON storage.objects
  FOR UPDATE USING (
    bucket_id = 'attachments'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );

-- 4. Owner delete
CREATE POLICY "attachments_owner_delete" ON storage.objects
  FOR DELETE USING (
    bucket_id = 'attachments'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );
