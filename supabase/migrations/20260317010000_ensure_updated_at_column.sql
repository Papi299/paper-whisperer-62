-- Idempotent migration: ensure updated_at column exists on papers table
-- and add auto-update trigger + synonym canonical term uniqueness index.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'papers' AND column_name = 'updated_at'
  ) THEN
    ALTER TABLE public.papers ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
  END IF;
END $$;

-- Auto-update trigger function
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- Drop existing trigger if present, then re-create
DROP TRIGGER IF EXISTS trg_papers_updated_at ON public.papers;
CREATE TRIGGER trg_papers_updated_at
  BEFORE UPDATE ON public.papers
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- Unique constraint: only the canonical_term must be unique per user in synonym_pool
CREATE UNIQUE INDEX IF NOT EXISTS idx_synonym_pool_user_canonical
  ON public.synonym_pool (user_id, lower(canonical_term));
