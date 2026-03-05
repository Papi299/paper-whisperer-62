-- Atomic RPC to merge duplicate papers. Executes inside a single transaction:
-- 1. Unions paper_tags from discards onto keep paper (ON CONFLICT skip)
-- 2. Unions paper_projects from discards onto keep paper (ON CONFLICT skip)
-- 3. Coalesces NULL scalar fields in keep paper from discards
-- 4. Unions array fields (keywords, mesh_terms, substances) with deduplication
-- 5. Deletes discard papers (CASCADE removes their junction rows)

CREATE OR REPLACE FUNCTION public.merge_exact_duplicates(
  p_keep_id uuid,
  p_discard_ids uuid[]
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid := auth.uid();
BEGIN
  -- Verify ownership of keep paper
  IF NOT EXISTS (
    SELECT 1 FROM papers WHERE id = p_keep_id AND user_id = v_user_id
  ) THEN
    RAISE EXCEPTION 'Keep paper not found or access denied';
  END IF;

  -- Verify ownership of ALL discard papers
  IF EXISTS (
    SELECT 1 FROM unnest(p_discard_ids) AS did
    WHERE NOT EXISTS (
      SELECT 1 FROM papers WHERE id = did AND user_id = v_user_id
    )
  ) THEN
    RAISE EXCEPTION 'One or more discard papers not found or access denied';
  END IF;

  -- 1. Move tags from discards to keep (skip already-existing)
  INSERT INTO paper_tags (paper_id, tag_id)
  SELECT p_keep_id, pt.tag_id
  FROM paper_tags pt
  WHERE pt.paper_id = ANY(p_discard_ids)
  ON CONFLICT (paper_id, tag_id) DO NOTHING;

  -- 2. Move projects from discards to keep (skip already-existing)
  INSERT INTO paper_projects (paper_id, project_id)
  SELECT p_keep_id, pp.project_id
  FROM paper_projects pp
  WHERE pp.paper_id = ANY(p_discard_ids)
  ON CONFLICT (paper_id, project_id) DO NOTHING;

  -- 3. Coalesce NULL scalar and array fields from discards into keep paper
  UPDATE papers SET
    abstract = COALESCE(papers.abstract,
      (SELECT p2.abstract FROM papers p2
       WHERE p2.id = ANY(p_discard_ids) AND p2.abstract IS NOT NULL
       ORDER BY p2.created_at ASC LIMIT 1)),
    journal = COALESCE(papers.journal,
      (SELECT p2.journal FROM papers p2
       WHERE p2.id = ANY(p_discard_ids) AND p2.journal IS NOT NULL
       ORDER BY p2.created_at ASC LIMIT 1)),
    year = COALESCE(papers.year,
      (SELECT p2.year FROM papers p2
       WHERE p2.id = ANY(p_discard_ids) AND p2.year IS NOT NULL
       ORDER BY p2.created_at ASC LIMIT 1)),
    pmid = COALESCE(papers.pmid,
      (SELECT p2.pmid FROM papers p2
       WHERE p2.id = ANY(p_discard_ids) AND p2.pmid IS NOT NULL
       ORDER BY p2.created_at ASC LIMIT 1)),
    doi = COALESCE(papers.doi,
      (SELECT p2.doi FROM papers p2
       WHERE p2.id = ANY(p_discard_ids) AND p2.doi IS NOT NULL
       ORDER BY p2.created_at ASC LIMIT 1)),
    study_type = COALESCE(papers.study_type,
      (SELECT p2.study_type FROM papers p2
       WHERE p2.id = ANY(p_discard_ids) AND p2.study_type IS NOT NULL
       ORDER BY p2.created_at ASC LIMIT 1)),
    statistical_methods = COALESCE(papers.statistical_methods,
      (SELECT p2.statistical_methods FROM papers p2
       WHERE p2.id = ANY(p_discard_ids) AND p2.statistical_methods IS NOT NULL
       ORDER BY p2.created_at ASC LIMIT 1)),
    pubmed_url = COALESCE(papers.pubmed_url,
      (SELECT p2.pubmed_url FROM papers p2
       WHERE p2.id = ANY(p_discard_ids) AND p2.pubmed_url IS NOT NULL
       ORDER BY p2.created_at ASC LIMIT 1)),
    journal_url = COALESCE(papers.journal_url,
      (SELECT p2.journal_url FROM papers p2
       WHERE p2.id = ANY(p_discard_ids) AND p2.journal_url IS NOT NULL
       ORDER BY p2.created_at ASC LIMIT 1)),
    drive_url = COALESCE(papers.drive_url,
      (SELECT p2.drive_url FROM papers p2
       WHERE p2.id = ANY(p_discard_ids) AND p2.drive_url IS NOT NULL
       ORDER BY p2.created_at ASC LIMIT 1)),
    raw_study_type = COALESCE(papers.raw_study_type,
      (SELECT p2.raw_study_type FROM papers p2
       WHERE p2.id = ANY(p_discard_ids) AND p2.raw_study_type IS NOT NULL
       ORDER BY p2.created_at ASC LIMIT 1)),
    -- Authors: keep existing if non-empty, otherwise take from first discard
    authors = CASE
      WHEN papers.authors = '{}' OR papers.authors IS NULL THEN
        COALESCE(
          (SELECT p2.authors FROM papers p2
           WHERE p2.id = ANY(p_discard_ids) AND p2.authors <> '{}'
           ORDER BY p2.created_at ASC LIMIT 1),
          papers.authors
        )
      ELSE papers.authors
    END,
    -- Array fields: union all values with deduplication
    keywords = COALESCE(
      (SELECT array_agg(DISTINCT kw) FROM (
        SELECT unnest(papers.keywords) AS kw
        UNION
        SELECT unnest(p2.keywords)
        FROM papers p2 WHERE p2.id = ANY(p_discard_ids)
      ) sub WHERE kw IS NOT NULL),
      '{}'
    ),
    mesh_terms = COALESCE(
      (SELECT array_agg(DISTINCT mt) FROM (
        SELECT unnest(papers.mesh_terms) AS mt
        UNION
        SELECT unnest(p2.mesh_terms)
        FROM papers p2 WHERE p2.id = ANY(p_discard_ids)
      ) sub WHERE mt IS NOT NULL),
      '{}'
    ),
    substances = COALESCE(
      (SELECT array_agg(DISTINCT s) FROM (
        SELECT unnest(papers.substances) AS s
        UNION
        SELECT unnest(p2.substances)
        FROM papers p2 WHERE p2.id = ANY(p_discard_ids)
      ) sub WHERE s IS NOT NULL),
      '{}'
    ),
    updated_at = now()
  WHERE papers.id = p_keep_id;

  -- 4. Delete discard papers (ON DELETE CASCADE removes junction rows)
  DELETE FROM papers
  WHERE id = ANY(p_discard_ids)
    AND user_id = v_user_id;
END;
$$;
