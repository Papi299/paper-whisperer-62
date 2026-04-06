-- Re-create the search_papers_short function.
-- The original migration (20260329010000) was tracked as applied but the
-- function is missing from the remote schema (PGRST202).
-- CREATE OR REPLACE is idempotent — safe to run even if the function exists.

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
      OR EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(COALESCE(p.authors, '[]'::jsonb)) AS a
        WHERE a ILIKE '%' || p_query || '%'
      )
    );
$$;

-- Ensure PostgREST can see the function for authenticated users.
GRANT EXECUTE ON FUNCTION search_papers_short(UUID, TEXT) TO authenticated;
