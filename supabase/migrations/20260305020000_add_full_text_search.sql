-- ── IMMUTABLE wrapper functions for the search_vector generated column ──
--
-- PostgreSQL requires expressions inside `GENERATED ALWAYS AS (...) STORED`
-- to be IMMUTABLE. The natural `to_tsvector('english', coalesce(col, ''))`
-- form is STABLE (not IMMUTABLE) for two reasons:
--
--   1. The two-argument `to_tsvector(text, text)` overload is STABLE because
--      the first argument requires a `text → regconfig` resolution at call
--      time. The `to_tsvector(regconfig, text)` overload is IMMUTABLE, but
--      Postgres only routes to it when the first argument is *already*
--      typed `regconfig` at parse time. An `'english'::regconfig` cast is
--      not always sufficient on newer Postgres versions.
--   2. The `jsonb::text` cast (`jsonb_out`) is STABLE, which infects any
--      expression that calls it (we use it on `authors::text`).
--
-- These two wrappers wrap each shape in an explicitly IMMUTABLE SQL
-- function. The body still calls the underlying STABLE functions, but
-- because we declare the wrapper IMMUTABLE the planner trusts the
-- declaration for the generated-column check. The tsvector output is
-- byte-identical to calling `to_tsvector('english', x)` directly, so
-- search ranking, GIN index contents, and `matched_*` attribution are
-- unchanged.
--
-- The wrappers are created with `CREATE OR REPLACE` and persist across
-- migrations. Later migrations that rebuild `search_vector` (notes,
-- keywords waves) reuse them — no need to redefine.

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

-- Companion wrapper for jsonb array columns. The local replay history has
-- `authors`/`keywords`/`mesh_terms`/`substances` as `text[]` at this
-- migration's timestamp, but production altered them to `jsonb` via the
-- Supabase/Lovable dashboard during the April 2026 wave — captured in repo
-- by `20260331010000_convert_columns_to_jsonb.sql`. From that migration
-- forward, search_vector rebuilds use the `_jsonb` wrapper.
CREATE OR REPLACE FUNCTION public.immutable_english_tsvector_jsonb(j jsonb)
RETURNS tsvector
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$ SELECT to_tsvector('english'::regconfig, COALESCE(j::text, '')) $$;

-- Generated tsvector column for full-text search with weighted fields
ALTER TABLE papers ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (
    setweight(immutable_english_tsvector_text(title), 'A') ||
    setweight(immutable_english_tsvector_text(abstract), 'B') ||
    setweight(immutable_english_tsvector_text(journal), 'C') ||
    setweight(immutable_english_tsvector_textarr(authors), 'C')
  ) STORED;

-- GIN index for fast full-text queries
CREATE INDEX IF NOT EXISTS idx_papers_search_vector
  ON papers USING GIN(search_vector);

-- RPC for full-text search with ranking
CREATE OR REPLACE FUNCTION search_papers(
  p_user_id UUID,
  p_query TEXT,
  p_limit INTEGER DEFAULT 100,
  p_offset INTEGER DEFAULT 0
)
RETURNS TABLE(paper_id UUID, rank REAL)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT p.id AS paper_id,
         ts_rank(p.search_vector, websearch_to_tsquery('english', p_query)) AS rank
  FROM papers p
  WHERE p.user_id = p_user_id
    AND p.search_vector @@ websearch_to_tsquery('english', p_query)
  ORDER BY rank DESC
  LIMIT p_limit OFFSET p_offset;
END;
$$;
