-- Create paper_attachments table
CREATE TABLE IF NOT EXISTS public.paper_attachments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_id    uuid NOT NULL REFERENCES public.papers(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  file_path   text NOT NULL,
  file_name   text NOT NULL,
  file_type   text NOT NULL,
  size_bytes  integer NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.paper_attachments ENABLE ROW LEVEL SECURITY;

-- Policies: owner-only access
CREATE POLICY "owner select"
  ON public.paper_attachments FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "owner insert"
  ON public.paper_attachments FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "owner delete"
  ON public.paper_attachments FOR DELETE
  USING (auth.uid() = user_id);

-- Index for fast lookups by paper
CREATE INDEX IF NOT EXISTS idx_paper_attachments_paper_id
  ON public.paper_attachments (paper_id);
