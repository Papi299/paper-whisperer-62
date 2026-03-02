-- Add raw_study_type column to preserve original PubMed publication types
ALTER TABLE public.papers ADD COLUMN raw_study_type text DEFAULT NULL;

-- Backfill: copy current study_type as raw_study_type for existing papers
UPDATE public.papers SET raw_study_type = study_type WHERE raw_study_type IS NULL;