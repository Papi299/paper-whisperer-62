-- Raise search_papers default result limit from 100 to 1000
-- to avoid silently capping full-text search results for larger libraries
CREATE OR REPLACE FUNCTION search_papers(
  p_user_id UUID,
  p_query TEXT,
  p_limit INTEGER DEFAULT 1000,
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
