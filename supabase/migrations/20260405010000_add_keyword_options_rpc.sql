-- Server-side keyword aggregation for the keyword dropdown.
-- Returns distinct terms from keywords, mesh_terms, and substances
-- columns across all filtered papers. Supports the same filter predicates
-- as the papers list query (ID-based filter, year range, study types).

CREATE OR REPLACE FUNCTION get_keyword_options(
  p_user_id UUID,
  p_paper_ids UUID[] DEFAULT NULL,
  p_year_from INT DEFAULT NULL,
  p_year_to INT DEFAULT NULL,
  p_study_types TEXT[] DEFAULT NULL
)
RETURNS TABLE(keyword TEXT)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT DISTINCT term AS keyword
  FROM papers p
  CROSS JOIN LATERAL (
    SELECT jsonb_array_elements_text(COALESCE(p.keywords, '[]'::jsonb)) AS term
    UNION ALL
    SELECT jsonb_array_elements_text(COALESCE(p.mesh_terms, '[]'::jsonb))
    UNION ALL
    SELECT jsonb_array_elements_text(COALESCE(p.substances, '[]'::jsonb))
  ) terms
  WHERE p.user_id = p_user_id
  AND (p_paper_ids IS NULL OR p.id = ANY(p_paper_ids))
  AND (p_year_from IS NULL OR p.year >= p_year_from)
  AND (p_year_to IS NULL OR p.year <= p_year_to)
  AND (p_study_types IS NULL OR p.study_type = ANY(p_study_types))
  ORDER BY keyword;
$$;

-- Grant access to authenticated users
GRANT EXECUTE ON FUNCTION get_keyword_options(UUID, UUID[], INT, INT, TEXT[]) TO authenticated;
