-- Server-side short-query search (<3 chars) via ILIKE substring matching.
-- Semantically identical to the client-side `.toLowerCase().includes(query)`
-- that was previously used for queries shorter than 3 characters.
--
-- Fields checked: title, journal, abstract, authors (any element)
-- Same fields as the client-side short search in applyClientFilters.
--
-- Performance: Sequential scan on the user's papers. For typical single-user
-- library sizes (hundreds to low thousands), this is fast enough.
-- A pg_trgm GIN index could be added later if needed.

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
        SELECT 1 FROM unnest(p.authors) AS a
        WHERE a ILIKE '%' || p_query || '%'
      )
    );
$$;
