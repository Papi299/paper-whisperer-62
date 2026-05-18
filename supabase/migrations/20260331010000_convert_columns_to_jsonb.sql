-- Capture the schema drift on `papers.authors`, `papers.keywords`,
-- `papers.mesh_terms`, and `papers.substances`.
--
-- Production altered these four columns from `text[]` to `jsonb` via the
-- Supabase/Lovable dashboard between the March 2026 RPC wave (which uses
-- `unnest(text[])` semantics) and the April 2026 RPC wave (which uses
-- `jsonb_array_elements_text(jsonb)` / `COALESCE(col, '[]'::jsonb)`
-- semantics). The alter was never committed to the repo, so fresh local
-- replays diverged from production and failed during the April migrations:
--
--   • 20260330010000_add_raw_keywords_column.sql — `UPDATE papers SET
--     raw_keywords = keywords` fails because `keywords` is `text[]` and
--     `raw_keywords` is `jsonb`.
--   • 20260405010000_add_keyword_options_rpc.sql — `LANGUAGE sql`
--     function body fails create-time type-check on
--     `jsonb_array_elements_text(COALESCE(p.keywords, '[]'::jsonb))`.
--   • Other April migrations relying on the same jsonb shape.
--
-- This migration captures that conversion in repo-tracked form. It is
-- idempotent: it inspects `information_schema.columns` first and only
-- runs the type alter when the column is still `text[]` (fresh local
-- replay path). When it runs on production (where the columns are
-- already `jsonb`), the conditional block is a no-op and the migration
-- recreates only `search_vector` + its GIN index.
--
-- Why drop and re-add `search_vector`:
--   The generated column references `authors` (and downstream rebuilds
--   reference `authors` + `keywords`). Postgres rejects `ALTER COLUMN
--   ... TYPE jsonb` while a generated column depends on the column. We
--   drop the generated column, alter the underlying columns, then re-
--   add the generated column using the `immutable_english_tsvector_jsonb`
--   wrapper from `20260305020000_add_full_text_search.sql`.
--
--   Tsvector contents produced by `immutable_english_tsvector_jsonb(j)`
--   for a jsonb authors array are byte-identical in token shape to what
--   the prior `to_tsvector('english', authors::text)` produced when
--   `authors` was `text[]` (modulo curly-brace vs. JSON-bracket noise
--   tokens, both of which are filtered by the English stemmer / stop
--   list). Search ranking and `matched_*` attribution are operationally
--   unchanged.

-- ── 1. Ensure the IMMUTABLE wrappers exist (idempotent) ──
--
-- These wrappers were introduced in `20260305020000_add_full_text_search.sql`
-- via `CREATE OR REPLACE FUNCTION`. On a fresh LOCAL replay the wrappers
-- already exist by the time this migration runs (CREATE OR REPLACE is a
-- no-op in that case). On PRODUCTION, `20260305020000` was applied with
-- its original content (no wrappers) and Supabase's migration ledger tracks
-- it as applied — so it will NOT be re-run, and the wrappers do NOT exist
-- there. Re-declaring them here makes this migration safe to apply on
-- production: production gets the wrappers at this point in the timeline,
-- local sees the no-op. All three wrappers are present so this migration
-- can stand alone if anyone ever runs it in isolation against a database
-- that doesn't already have them.

CREATE OR REPLACE FUNCTION public.immutable_english_tsvector_text(t text)
RETURNS tsvector
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$ SELECT to_tsvector('english'::regconfig, COALESCE(t, '')) $$;

CREATE OR REPLACE FUNCTION public.immutable_english_tsvector_textarr(arr text[])
RETURNS tsvector
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$ SELECT to_tsvector('english'::regconfig, COALESCE(arr::text, '')) $$;

CREATE OR REPLACE FUNCTION public.immutable_english_tsvector_jsonb(j jsonb)
RETURNS tsvector
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$ SELECT to_tsvector('english'::regconfig, COALESCE(j::text, '')) $$;

-- ── 2. Drop search_vector (depends on authors via generated expression) ──
ALTER TABLE public.papers DROP COLUMN IF EXISTS search_vector;

-- ── 3. Convert array columns to jsonb (idempotent) ──
DO $$
DECLARE
  v_data_type text;
BEGIN
  SELECT data_type INTO v_data_type
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'papers'
    AND column_name = 'authors';

  IF v_data_type = 'ARRAY' THEN
    -- Fresh local replay path: columns are still text[]. Convert all four.
    ALTER TABLE public.papers
      ALTER COLUMN authors    DROP DEFAULT,
      ALTER COLUMN keywords   DROP DEFAULT,
      ALTER COLUMN mesh_terms DROP DEFAULT,
      ALTER COLUMN substances DROP DEFAULT;

    ALTER TABLE public.papers
      ALTER COLUMN authors    TYPE jsonb USING to_jsonb(authors),
      ALTER COLUMN keywords   TYPE jsonb USING to_jsonb(keywords),
      ALTER COLUMN mesh_terms TYPE jsonb USING to_jsonb(mesh_terms),
      ALTER COLUMN substances TYPE jsonb USING to_jsonb(substances);

    ALTER TABLE public.papers
      ALTER COLUMN authors    SET DEFAULT '[]'::jsonb,
      ALTER COLUMN keywords   SET DEFAULT '[]'::jsonb,
      ALTER COLUMN mesh_terms SET DEFAULT '[]'::jsonb,
      ALTER COLUMN substances SET DEFAULT '[]'::jsonb;
  END IF;
  -- Production path: data_type is already 'jsonb'; the block is skipped.
END $$;

-- ── 4. Re-add search_vector using the jsonb wrapper ──
ALTER TABLE public.papers ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (
    setweight(immutable_english_tsvector_text(title), 'A') ||
    setweight(immutable_english_tsvector_text(abstract), 'B') ||
    setweight(immutable_english_tsvector_text(journal), 'C') ||
    setweight(immutable_english_tsvector_jsonb(authors), 'C')
  ) STORED;

-- ── 5. Recreate the GIN index ──
CREATE INDEX IF NOT EXISTS idx_papers_search_vector
  ON public.papers USING GIN(search_vector);
