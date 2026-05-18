-- Add raw_keywords column to preserve original imported keywords before enrichment.
-- Follows the same pattern as raw_study_type (migration 20260302150530).
-- raw_keywords is the immutable source-of-truth for keyword reevaluation;
-- the enriched keywords column is recomputed from raw_keywords + title + abstract + config.

-- The keywords column is jsonb in the live database (altered from text[] by Supabase/Lovable).
-- raw_keywords must match that type for the backfill and for consistent read/write paths.
ALTER TABLE public.papers ADD COLUMN raw_keywords jsonb DEFAULT '[]'::jsonb;

-- Backfill: copy current keywords as approximate raw source for legacy papers.
-- This is not perfectly exact for pre-existing papers (may include synonym-derived
-- canonical terms from import-time extraction), but is the best available
-- approximation. See plan for detailed analysis of bounded imprecision.
--
-- Explicit `::jsonb` cast: production's `keywords` column was altered from
-- `text[]` to `jsonb` by the Supabase/Lovable dashboard (see comment above),
-- but no committed migration captures that schema change. Without the cast,
-- a fresh local replay (where `keywords` is still `text[]`) fails parse-time
-- type checking with `column "raw_keywords" is of type jsonb but expression
-- is of type text[]`. The cast is a no-op when `keywords` is already
-- `jsonb` (production) and routes through `to_jsonb(text[])` when it isn't
-- (local) — same row content in both cases.
UPDATE public.papers SET raw_keywords = to_jsonb(keywords) WHERE raw_keywords = '[]'::jsonb;
