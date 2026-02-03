-- Add mesh_terms and substances columns to papers table
ALTER TABLE public.papers ADD COLUMN IF NOT EXISTS mesh_terms text[] DEFAULT '{}'::text[];
ALTER TABLE public.papers ADD COLUMN IF NOT EXISTS substances text[] DEFAULT '{}'::text[];