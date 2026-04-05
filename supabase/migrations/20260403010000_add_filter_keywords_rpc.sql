-- Server-side keyword filter: checks keywords, mesh_terms, and substances
-- with synonym normalization via the user's synonym_pool.
--
-- Semantics: For each selected keyword, the paper must have a matching term
-- (case-insensitive) in at least one of: keywords, mesh_terms, or substances.
-- mesh_terms and substances are normalized through the user's synonym_pool
-- at query time. keywords are already synonym-normalized at enrichment time.
--
-- Returns paper IDs matching ALL selected keywords (AND semantics).
-- Follows the same TABLE(paper_id UUID) pattern as search_papers.

CREATE OR REPLACE FUNCTION filter_papers_by_keywords(
  p_user_id UUID,
  p_keywords TEXT[]
)
RETURNS TABLE(paper_id UUID)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH synonym_map AS (
    -- Build synonym → canonical mapping from user's synonym pool
    SELECT lower(syn) AS synonym, lower(sp.canonical_term) AS canonical
    FROM synonym_pool sp,
    LATERAL unnest(sp.synonyms) AS syn
    WHERE sp.user_id = p_user_id
    UNION ALL
    -- Canonical terms map to themselves
    SELECT lower(sp.canonical_term), lower(sp.canonical_term)
    FROM synonym_pool sp
    WHERE sp.user_id = p_user_id
  )
  SELECT p.id AS paper_id
  FROM papers p
  WHERE p.user_id = p_user_id
  AND NOT EXISTS (
    -- Every selected keyword must be found in at least one column
    SELECT 1 FROM unnest(p_keywords) AS kw
    WHERE NOT (
      -- keywords: already enriched/synonym-normalized at import time
      EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(COALESCE(p.keywords, '[]'::jsonb)) k
        WHERE lower(k) = lower(kw)
      )
      -- mesh_terms: normalize through synonym map at query time
      OR EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(COALESCE(p.mesh_terms, '[]'::jsonb)) m
        LEFT JOIN synonym_map sm ON lower(m) = sm.synonym
        WHERE COALESCE(sm.canonical, lower(m)) = lower(kw)
      )
      -- substances: normalize through synonym map at query time
      OR EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(COALESCE(p.substances, '[]'::jsonb)) s
        LEFT JOIN synonym_map sm ON lower(s) = sm.synonym
        WHERE COALESCE(sm.canonical, lower(s)) = lower(kw)
      )
    )
  );
END;
$$;
