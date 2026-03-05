-- RPC to detect exact-match duplicate papers across the ENTIRE papers table.
-- Groups by exact PMID or normalized (lowercased, trimmed) DOI.
-- Leverages existing B-tree indexes idx_papers_pmid and idx_papers_doi.
-- Returns a JSONB array of duplicate groups for the calling user.

CREATE OR REPLACE FUNCTION public.get_duplicate_papers()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_result jsonb;
BEGIN
  WITH pmid_groups AS (
    SELECT
      'pmid' AS match_type,
      p.pmid AS match_value,
      jsonb_agg(
        jsonb_build_object(
          'id', p.id,
          'title', p.title,
          'authors', p.authors,
          'year', p.year,
          'journal', p.journal,
          'pmid', p.pmid,
          'doi', p.doi,
          'abstract', p.abstract,
          'study_type', p.study_type,
          'keywords', p.keywords,
          'created_at', p.created_at
        )
        ORDER BY p.created_at ASC
      ) AS papers
    FROM papers p
    WHERE p.user_id = v_user_id
      AND p.pmid IS NOT NULL
      AND p.pmid <> ''
    GROUP BY p.pmid
    HAVING count(*) > 1
  ),
  doi_groups AS (
    SELECT
      'doi' AS match_type,
      lower(trim(p.doi)) AS match_value,
      jsonb_agg(
        jsonb_build_object(
          'id', p.id,
          'title', p.title,
          'authors', p.authors,
          'year', p.year,
          'journal', p.journal,
          'pmid', p.pmid,
          'doi', p.doi,
          'abstract', p.abstract,
          'study_type', p.study_type,
          'keywords', p.keywords,
          'created_at', p.created_at
        )
        ORDER BY p.created_at ASC
      ) AS papers
    FROM papers p
    WHERE p.user_id = v_user_id
      AND p.doi IS NOT NULL
      AND trim(p.doi) <> ''
    GROUP BY lower(trim(p.doi))
    HAVING count(*) > 1
  ),
  all_groups AS (
    SELECT match_type, match_value, papers FROM pmid_groups
    UNION ALL
    SELECT match_type, match_value, papers FROM doi_groups
  )
  SELECT coalesce(jsonb_agg(
    jsonb_build_object(
      'match_type', match_type,
      'match_value', match_value,
      'papers', papers
    )
  ), '[]'::jsonb)
  INTO v_result
  FROM all_groups;

  RETURN v_result;
END;
$$;
