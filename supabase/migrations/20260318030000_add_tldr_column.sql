DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'papers' AND column_name = 'tldr'
  ) THEN
    ALTER TABLE public.papers ADD COLUMN tldr text;
  END IF;
END $$;
