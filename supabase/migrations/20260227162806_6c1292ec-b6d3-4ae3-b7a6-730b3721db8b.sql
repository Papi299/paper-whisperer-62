ALTER TABLE public.study_type_pool
  ADD COLUMN specificity_weight INTEGER NOT NULL DEFAULT 1;

CREATE POLICY "Users can update own study type pool"
  ON public.study_type_pool FOR UPDATE
  USING (auth.uid() = user_id);