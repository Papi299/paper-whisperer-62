-- Generated tsvector column for full-text search with weighted fields
ALTER TABLE papers ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(abstract, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(journal, '')), 'C') ||
    setweight(to_tsvector('english', coalesce(authors::text, '')), 'C')
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
