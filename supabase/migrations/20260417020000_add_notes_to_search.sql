-- Include `notes` as a fourth searchable field in the existing full-text and
-- short-query (ILIKE) search pipelines.
--
-- Two surfaces are touched:
--  1. papers.search_vector (generated column, used by search_papers RPC / FTS)
--     — add notes at weight D (lowest rank). Existing weights unchanged:
--       A = title, B = abstract, C = journal + authors.
--  2. search_papers_short RPC (ILIKE for 1-2 char queries)
--     — add `OR p.notes ILIKE '%' || p_query || '%'` to the disjunct cascade.
--
-- The search_papers RPC body itself does NOT change — it already references
-- search_vector and automatically picks up notes once the column is rebuilt.
--
-- Rollback: re-run the original definitions from
--   20260305020000_add_full_text_search.sql (search_vector + search_papers)
--   20260406010000_recreate_short_search_rpc.sql (search_papers_short)

-- ── 1. Rebuild papers.search_vector to include notes at weight D ──
-- Dropping the generated column auto-drops idx_papers_search_vector; both are
-- re-created below. Postgres regenerates the column data for every row when
-- it is re-added (fast at current scale: ~400 rows, sub-second).
ALTER TABLE papers DROP COLUMN IF EXISTS search_vector;

-- Uses the `immutable_english_tsvector_*` wrappers from
-- 20260305020000_add_full_text_search.sql (still present in the schema
-- via CREATE OR REPLACE in the original migration). Tsvector outputs
-- are byte-identical to calling `to_tsvector('english', x)` directly.
ALTER TABLE papers ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (
    setweight(immutable_english_tsvector_text(title), 'A') ||
    setweight(immutable_english_tsvector_text(abstract), 'B') ||
    setweight(immutable_english_tsvector_text(journal), 'C') ||
    setweight(immutable_english_tsvector_jsonb(authors), 'C') ||
    setweight(immutable_english_tsvector_text(notes), 'D')
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_papers_search_vector
  ON papers USING GIN(search_vector);

-- ── 2. Recreate search_papers_short with notes in the ILIKE cascade ──
CREATE OR REPLACE FUNCTION search_papers_short(
  p_user_id UUID,
  p_query TEXT
)
RETURNS TABLE(paper_id UUID)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.id AS paper_id
  FROM papers p
  WHERE p.user_id = p_user_id
    AND (
      p.title ILIKE '%' || p_query || '%'
      OR p.journal ILIKE '%' || p_query || '%'
      OR p.abstract ILIKE '%' || p_query || '%'
      OR p.notes ILIKE '%' || p_query || '%'
      OR EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(COALESCE(p.authors, '[]'::jsonb)) AS a
        WHERE a ILIKE '%' || p_query || '%'
      )
    );
$$;

GRANT EXECUTE ON FUNCTION search_papers_short(UUID, TEXT) TO authenticated;
