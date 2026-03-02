
-- Add group_name and hierarchy_rank columns to study_type_pool
ALTER TABLE public.study_type_pool
  ADD COLUMN group_name text DEFAULT NULL,
  ADD COLUMN hierarchy_rank integer NOT NULL DEFAULT 99;
