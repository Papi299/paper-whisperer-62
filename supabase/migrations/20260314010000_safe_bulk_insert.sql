-- Safe bulk insert: inserts papers row-by-row, swallowing unique_violation
-- errors so that valid papers are always saved even when some are duplicates.
-- Returns a JSONB array of per-row results.
CREATE OR REPLACE FUNCTION public.safe_bulk_insert_papers(
  p_user_id uuid,
  p_papers jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_paper jsonb;
  v_index int := 0;
  v_results jsonb := '[]'::jsonb;
  v_inserted_id uuid;
BEGIN
  -- Verify the caller owns p_user_id
  IF p_user_id <> auth.uid() THEN
    RAISE EXCEPTION 'Unauthorized: user mismatch';
  END IF;

  FOR v_paper IN SELECT jsonb_array_elements(p_papers)
  LOOP
    BEGIN
      INSERT INTO papers (
        user_id, title, authors, year, journal, pmid, doi,
        abstract, study_type, raw_study_type, statistical_methods,
        keywords, mesh_terms, substances,
        pubmed_url, journal_url, drive_url
      ) VALUES (
        p_user_id,
        v_paper->>'title',
        COALESCE(
          (SELECT array_agg(e::text) FROM jsonb_array_elements_text(v_paper->'authors') e),
          '{}'::text[]
        ),
        (v_paper->>'year')::int,
        v_paper->>'journal',
        v_paper->>'pmid',
        v_paper->>'doi',
        v_paper->>'abstract',
        v_paper->>'study_type',
        v_paper->>'raw_study_type',
        v_paper->>'statistical_methods',
        COALESCE(
          (SELECT array_agg(e::text) FROM jsonb_array_elements_text(v_paper->'keywords') e),
          '{}'::text[]
        ),
        COALESCE(
          (SELECT array_agg(e::text) FROM jsonb_array_elements_text(v_paper->'mesh_terms') e),
          '{}'::text[]
        ),
        COALESCE(
          (SELECT array_agg(e::text) FROM jsonb_array_elements_text(v_paper->'substances') e),
          '{}'::text[]
        ),
        v_paper->>'pubmed_url',
        v_paper->>'journal_url',
        v_paper->>'drive_url'
      )
      RETURNING id INTO v_inserted_id;

      v_results := v_results || jsonb_build_object(
        'index', v_index,
        'id', v_inserted_id,
        'status', 'inserted'
      );

    EXCEPTION
      WHEN unique_violation THEN
        v_results := v_results || jsonb_build_object(
          'index', v_index,
          'status', 'duplicate',
          'error_message', SQLERRM
        );
      WHEN OTHERS THEN
        v_results := v_results || jsonb_build_object(
          'index', v_index,
          'status', 'error',
          'error_message', SQLERRM
        );
    END;

    v_index := v_index + 1;
  END LOOP;

  RETURN v_results;
END;
$$;
