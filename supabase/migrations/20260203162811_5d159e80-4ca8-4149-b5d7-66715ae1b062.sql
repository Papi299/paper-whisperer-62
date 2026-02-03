-- Create study_type_pool table for storing study types of interest
CREATE TABLE public.study_type_pool (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  study_type TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.study_type_pool ENABLE ROW LEVEL SECURITY;

-- RLS policies
CREATE POLICY "Users can view own study type pool"
  ON public.study_type_pool FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own study type pool"
  ON public.study_type_pool FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own study type pool"
  ON public.study_type_pool FOR DELETE
  USING (auth.uid() = user_id);

-- Unique constraint to prevent duplicate study types per user
CREATE UNIQUE INDEX study_type_pool_user_study_type_idx
  ON public.study_type_pool (user_id, lower(study_type));