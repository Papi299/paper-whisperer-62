-- PUBMED-API-PUBLICATION-TYPE-STRUCTURE-001
--
-- Adds persistent structured publication-type provenance and teaches the two
-- RPCs that own paper provenance to carry it.
--
-- Why a second column at all
-- ──────────────────────────
-- PubMed states publication types as discrete values, and an official one may
-- contain a comma of its own:
--
--   Clinical Trial, Phase II
--   Research Support, N.I.H., Extramural
--
-- papers.raw_study_type stores the comma-joined form those values were flattened
-- into. Splitting it back apart cannot distinguish a separator from a comma
-- inside one type, so "Clinical Trial, Phase II" re-reads as the two false
-- values "Clinical Trial" and "Phase II" — a wrong, less specific match against
-- the user's study-type pool. The boundaries have to be stored, not recovered.
--
-- The three concepts stay distinct:
--   * study_type            — Paperlume's current winning classification;
--   * raw_study_type        — the legacy joined source string, unchanged;
--   * raw_publication_types — NEW, the discrete source values when a source
--                             stated them.
--
-- Neither existing column is removed, renamed, or repurposed.
--
-- No historical backfill
-- ──────────────────────
-- Existing rows get SQL NULL from the ADD COLUMN itself; no UPDATE runs. A
-- stored "Clinical Trial, Phase II, Multicenter Study" is genuinely ambiguous —
-- it may have meant two types or three — so string_to_array() or any equivalent
-- inference would fabricate provenance rather than recover it. NULL states the
-- truth: no trustworthy boundaries were persisted for this row. Every read path
-- treats NULL as "fall back to raw_study_type", which is exactly the behavior
-- those rows have today.
--
-- Storage shape follows the table's existing convention: authors, keywords,
-- raw_keywords, mesh_terms and substances are all jsonb, so this is jsonb too
-- rather than introducing a first text[] list column.
--
-- Signatures, SECURITY DEFINER posture, bounded search_path, ownership guards,
-- return shapes and EXECUTE surfaces of both functions are preserved exactly.
-- No overload is added and no privilege is widened.

-- ══ 1. The column ══════════════════════════════════════════════════════════
ALTER TABLE public.papers
  ADD COLUMN raw_publication_types jsonb;

COMMENT ON COLUMN public.papers.raw_publication_types IS
  'Discrete source publication types (PubMed API / native NBIB), boundaries '
  'intact. NULL means no trustworthy structured provenance was persisted for '
  'this row — read raw_study_type instead. Never derived by splitting '
  'raw_study_type: an official type may contain a comma of its own.';

-- Fail closed on malformed provenance. A non-null value is a non-empty JSON
-- array of strings and nothing else: a JSON object, a bare scalar, or an array
-- holding a number are all rejected outright, and an empty array is rejected
-- because it conveys nothing NULL does not already convey — keeping NULL the
-- single representation of "no structured provenance".
--
-- jsonb_path_exists/2 is IMMUTABLE and needs no subquery, so the whole rule is
-- one deterministic column-level CHECK. It validates against NULL fine, so the
-- existing rows this migration leaves NULL all satisfy it and the constraint
-- can be added validated in place.
ALTER TABLE public.papers
  ADD CONSTRAINT papers_raw_publication_types_string_array_check
  CHECK (
    raw_publication_types IS NULL
    OR (
      jsonb_typeof(raw_publication_types) = 'array'
      AND jsonb_array_length(raw_publication_types) > 0
      AND NOT jsonb_path_exists(raw_publication_types, '$[*] ? (@.type() != "string")')
    )
  );

-- ══ 2. safe_bulk_insert_papers ═════════════════════════════════════════════
-- Identical to the definition installed by
-- 20260802025704_harden_rpc_and_relational_ownership.sql except for the new
-- raw_publication_types input handling. The full NULL-auth + caller-mismatch
-- guard, the statistical_methods canonicalization, the per-row BEGIN/EXCEPTION
-- model and the result shape are reproduced unchanged.
--
-- Normalization runs inside the per-paper block, so a malformed value produces
-- a per-row 'error' result — the batch continues and no row is stored with
-- corrupted provenance. The legacy joined string is never a source for it: a
-- payload that omits the key simply stores NULL.
CREATE OR REPLACE FUNCTION public.safe_bulk_insert_papers(p_user_id uuid, p_papers jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_paper jsonb;
  v_index int := 0;
  v_results jsonb := '[]'::jsonb;
  v_inserted_id uuid;
  v_statistical_methods jsonb;
  v_raw_publication_types jsonb;
BEGIN
  IF p_user_id IS NULL
     OR auth.uid() IS NULL
     OR p_user_id <> auth.uid()
  THEN
    RAISE EXCEPTION 'Unauthorized: user mismatch';
  END IF;

  FOR v_paper IN SELECT jsonb_array_elements(p_papers)
  LOOP
    BEGIN
      -- Canonical C20 storage: SQL NULL or one JSON string.
      v_statistical_methods := v_paper->'statistical_methods';
      IF v_statistical_methods IS NULL
         OR jsonb_typeof(v_statistical_methods) = 'null' THEN
        v_statistical_methods := NULL;
      ELSIF jsonb_typeof(v_statistical_methods) = 'string' THEN
        NULL; -- already canonical
      ELSIF jsonb_typeof(v_statistical_methods) = 'array' THEN
        SELECT to_jsonb(COALESCE(string_agg(e.elem #>> '{}', ', ' ORDER BY e.ord), ''))
        INTO v_statistical_methods
        FROM jsonb_array_elements(v_statistical_methods) WITH ORDINALITY AS e(elem, ord);
      ELSE
        RAISE EXCEPTION 'statistical_methods must be null, a JSON string, or a JSON array; got %',
          jsonb_typeof(v_statistical_methods);
      END IF;

      -- Canonical structured provenance: SQL NULL, or a non-empty JSON array of
      -- non-blank strings in source order. A missing key and JSON null both mean
      -- "this source stated no boundaries"; anything that is not an array of
      -- strings is malformed input and fails the row rather than being coerced.
      v_raw_publication_types := v_paper->'raw_publication_types';
      IF v_raw_publication_types IS NULL
         OR jsonb_typeof(v_raw_publication_types) = 'null' THEN
        v_raw_publication_types := NULL;
      ELSIF jsonb_typeof(v_raw_publication_types) = 'array' THEN
        IF jsonb_path_exists(v_raw_publication_types, '$[*] ? (@.type() != "string")') THEN
          RAISE EXCEPTION 'raw_publication_types must be a JSON array of strings';
        END IF;
        -- Trim, drop blanks, preserve order. An array that holds nothing usable
        -- collapses to NULL, because it carries no more provenance than absence.
        SELECT jsonb_agg(t.trimmed ORDER BY e.ord)
        INTO v_raw_publication_types
        FROM jsonb_array_elements_text(v_raw_publication_types) WITH ORDINALITY AS e(elem, ord)
        CROSS JOIN LATERAL (SELECT btrim(e.elem) AS trimmed) t
        WHERE t.trimmed <> '';
      ELSE
        RAISE EXCEPTION 'raw_publication_types must be null or a JSON array of strings; got %',
          jsonb_typeof(v_raw_publication_types);
      END IF;

      INSERT INTO papers (
        user_id, title, authors, year, journal, pmid, doi,
        abstract, study_type, raw_study_type, raw_publication_types,
        statistical_methods,
        keywords, raw_keywords, mesh_terms, substances,
        pubmed_url, journal_url, drive_url
      ) VALUES (
        p_user_id,
        v_paper->>'title',
        COALESCE(v_paper->'authors', '[]'::jsonb),
        (v_paper->>'year')::int,
        v_paper->>'journal',
        v_paper->>'pmid',
        v_paper->>'doi',
        v_paper->>'abstract',
        v_paper->>'study_type',
        v_paper->>'raw_study_type',
        v_raw_publication_types,
        v_statistical_methods,
        COALESCE(v_paper->'keywords', '[]'::jsonb),
        COALESCE(v_paper->'raw_keywords', '[]'::jsonb),
        COALESCE(v_paper->'mesh_terms', '[]'::jsonb),
        COALESCE(v_paper->'substances', '[]'::jsonb),
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
$function$;

-- ══ 3. merge_exact_duplicates ══════════════════════════════════════════════
-- Identical to the definition installed by
-- 20260807141402_repair_merge_exact_duplicates_jsonb.sql except that the raw
-- study-type provenance is now chosen as a coherent PAIR.
--
-- raw_study_type and raw_publication_types are two representations of the same
-- source statement, so taking them from different rows would manufacture a
-- pairing no source ever made — e.g. a keep row's joined string next to an
-- unrelated discard's boundaries. Both are therefore read from one source row:
--
--   1. the keep paper, when it has a raw_study_type;
--   2. otherwise the earliest discard by the function's existing
--      (created_at, id) ordering that has one, contributing BOTH of its values;
--   3. otherwise the keep paper's own values (both effectively absent) — a
--      legacy keep row never borrows boundaries from an unrelated discard just
--      to become non-null.
--
-- Publication types are never unioned across duplicates: this is one source's
-- provenance, not a keyword collection, and merging two records' types would
-- describe a paper that does not exist.
--
-- Rule 1 followed by rule 2 reproduces the previous raw_study_type COALESCE
-- exactly, so no existing merge choice changes. Every other behavior — scalar
-- coalescing, whole-value authors, JSONB list union, junction union, attachment
-- re-parenting, delete-before-update identifier ordering — is byte-for-byte the
-- repaired body.
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
  v_owned   integer;
  v_merged  record;
BEGIN
  -- ══ 1. Validation ════════════════════════════════════════════════════════
  -- Every check runs before the first persistent mutation, so a rejected call
  -- is provably side-effect free. The function is SECURITY DEFINER and its owner
  -- (postgres) holds BYPASSRLS, so these explicit auth.uid() predicates — not
  -- row-level security — are the authorization boundary.

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF p_keep_id IS NULL THEN
    RAISE EXCEPTION 'Keep paper id is required';
  END IF;

  IF p_discard_ids IS NULL OR cardinality(p_discard_ids) = 0 THEN
    RAISE EXCEPTION 'At least one discard paper id is required';
  END IF;

  IF EXISTS (SELECT 1 FROM unnest(p_discard_ids) AS d WHERE d IS NULL) THEN
    RAISE EXCEPTION 'Discard paper ids must not contain NULL';
  END IF;

  -- The keep paper must never be reachable through its own discard list.
  IF p_keep_id = ANY(p_discard_ids) THEN
    RAISE EXCEPTION 'Keep paper cannot also be listed as a discard paper';
  END IF;

  -- Repeated discard ids are malformed input, not a merge instruction: reject
  -- rather than silently normalising, so the caller learns its request was wrong.
  IF cardinality(p_discard_ids) <>
     (SELECT count(DISTINCT d)::integer FROM unnest(p_discard_ids) AS d) THEN
    RAISE EXCEPTION 'Discard paper ids must be unique';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM papers WHERE id = p_keep_id AND user_id = v_user_id
  ) THEN
    RAISE EXCEPTION 'Keep paper not found or access denied';
  END IF;

  -- All-or-nothing: every discard id must resolve to an existing caller-owned
  -- paper. Counting owned rows rejects unknown and foreign ids alike.
  SELECT count(*)::integer INTO v_owned
  FROM papers
  WHERE id = ANY(p_discard_ids) AND user_id = v_user_id;

  IF v_owned <> cardinality(p_discard_ids) THEN
    RAISE EXCEPTION 'One or more discard papers not found or access denied';
  END IF;

  -- ══ 2. Capture the merged metadata before anything is deleted ════════════
  WITH keep AS (
    SELECT * FROM papers WHERE id = p_keep_id
  ),
  discard AS (
    SELECT * FROM papers WHERE id = ANY(p_discard_ids)
  ),
  -- Deterministic source order for list metadata: the keep paper first, then
  -- the discards by (created_at, id).
  ordered AS (
    SELECT s.keywords, s.raw_keywords, s.mesh_terms, s.substances,
           row_number() OVER (ORDER BY s.grp, s.created_at, s.id) AS rn
    FROM (
      SELECT 0 AS grp, k.created_at, k.id,
             k.keywords, k.raw_keywords, k.mesh_terms, k.substances
      FROM keep k
      UNION ALL
      SELECT 1, d.created_at, d.id,
             d.keywords, d.raw_keywords, d.mesh_terms, d.substances
      FROM discard d
    ) s
  ),
  -- Unpivot the four list columns, keeping each element's source row (rn) and
  -- its position inside its own JSON array (ord). Anything that is not a JSON
  -- array — including SQL NULL — contributes nothing.
  elems AS (
    SELECT f.field, e.val, o.rn, e.ord
    FROM ordered o
    CROSS JOIN LATERAL (VALUES
      ('keywords'::text,     o.keywords),
      ('raw_keywords'::text, o.raw_keywords),
      ('mesh_terms'::text,   o.mesh_terms),
      ('substances'::text,   o.substances)
    ) AS f(field, arr)
    CROSS JOIN LATERAL jsonb_array_elements_text(
      CASE WHEN jsonb_typeof(f.arr) = 'array' THEN f.arr ELSE '[]'::jsonb END
    ) WITH ORDINALITY AS e(val, ord)
  ),
  -- Exact-value deduplication that retains the first occurrence only.
  firsts AS (
    SELECT DISTINCT ON (field, val) field, val, rn, ord
    FROM elems
    ORDER BY field, val, rn, ord
  ),
  lists AS (
    SELECT
      COALESCE((SELECT jsonb_agg(val ORDER BY rn, ord) FROM firsts WHERE field = 'keywords'),     '[]'::jsonb) AS keywords,
      COALESCE((SELECT jsonb_agg(val ORDER BY rn, ord) FROM firsts WHERE field = 'raw_keywords'), '[]'::jsonb) AS raw_keywords,
      COALESCE((SELECT jsonb_agg(val ORDER BY rn, ord) FROM firsts WHERE field = 'mesh_terms'),   '[]'::jsonb) AS mesh_terms,
      COALESCE((SELECT jsonb_agg(val ORDER BY rn, ord) FROM firsts WHERE field = 'substances'),   '[]'::jsonb) AS substances
  ),
  -- The single source row that supplies BOTH raw study-type representations:
  -- the keep paper first (grp 0), then the discards by (created_at, id). Rows
  -- with no raw_study_type cannot establish the pair and are not candidates.
  provenance AS (
    SELECT s.raw_study_type, s.raw_publication_types
    FROM (
      SELECT 0 AS grp, k.created_at, k.id, k.raw_study_type, k.raw_publication_types
      FROM keep k
      UNION ALL
      SELECT 1, d.created_at, d.id, d.raw_study_type, d.raw_publication_types
      FROM discard d
    ) s
    WHERE s.raw_study_type IS NOT NULL
    ORDER BY s.grp, s.created_at, s.id
    LIMIT 1
  )
  SELECT
    -- Scalar metadata: the keep value wins; a NULL keep value is filled from the
    -- earliest discard that has one, ordered by (created_at, id).
    COALESCE(k.abstract,            (SELECT d.abstract            FROM discard d WHERE d.abstract            IS NOT NULL ORDER BY d.created_at, d.id LIMIT 1)) AS abstract,
    COALESCE(k.journal,             (SELECT d.journal             FROM discard d WHERE d.journal             IS NOT NULL ORDER BY d.created_at, d.id LIMIT 1)) AS journal,
    COALESCE(k.year,                (SELECT d.year                FROM discard d WHERE d.year                IS NOT NULL ORDER BY d.created_at, d.id LIMIT 1)) AS year,
    COALESCE(k.pmid,                (SELECT d.pmid                FROM discard d WHERE d.pmid                IS NOT NULL ORDER BY d.created_at, d.id LIMIT 1)) AS pmid,
    COALESCE(k.doi,                 (SELECT d.doi                 FROM discard d WHERE d.doi                 IS NOT NULL ORDER BY d.created_at, d.id LIMIT 1)) AS doi,
    COALESCE(k.study_type,          (SELECT d.study_type          FROM discard d WHERE d.study_type          IS NOT NULL ORDER BY d.created_at, d.id LIMIT 1)) AS study_type,
    COALESCE(k.statistical_methods, (SELECT d.statistical_methods FROM discard d WHERE d.statistical_methods IS NOT NULL ORDER BY d.created_at, d.id LIMIT 1)) AS statistical_methods,
    COALESCE(k.pubmed_url,          (SELECT d.pubmed_url          FROM discard d WHERE d.pubmed_url          IS NOT NULL ORDER BY d.created_at, d.id LIMIT 1)) AS pubmed_url,
    COALESCE(k.journal_url,         (SELECT d.journal_url         FROM discard d WHERE d.journal_url         IS NOT NULL ORDER BY d.created_at, d.id LIMIT 1)) AS journal_url,
    COALESCE(k.drive_url,           (SELECT d.drive_url           FROM discard d WHERE d.drive_url           IS NOT NULL ORDER BY d.created_at, d.id LIMIT 1)) AS drive_url,
    COALESCE(k.tldr,                (SELECT d.tldr                FROM discard d WHERE d.tldr                IS NOT NULL ORDER BY d.created_at, d.id LIMIT 1)) AS tldr,
    COALESCE(k.notes,               (SELECT d.notes               FROM discard d WHERE d.notes               IS NOT NULL ORDER BY d.created_at, d.id LIMIT 1)) AS notes,
    -- Raw study-type provenance, taken whole from one source row so the joined
    -- string and its boundaries always describe the same source statement.
    -- Falling back to the keep row when no row qualifies leaves a legacy keep
    -- paper exactly as it was rather than borrowing a foreign array.
    COALESCE((SELECT p.raw_study_type FROM provenance p), k.raw_study_type) AS raw_study_type,
    CASE
      WHEN EXISTS (SELECT 1 FROM provenance)
        THEN (SELECT p.raw_publication_types FROM provenance p)
      ELSE k.raw_publication_types
    END AS raw_publication_types,
    -- Authors are a whole-value choice, never a union: a non-empty keep author
    -- list is preserved exactly, otherwise the earliest non-empty discard list
    -- is adopted.
    CASE
      WHEN jsonb_typeof(k.authors) = 'array' AND jsonb_array_length(k.authors) > 0 THEN k.authors
      ELSE COALESCE(
        (SELECT d.authors FROM discard d
          WHERE jsonb_typeof(d.authors) = 'array' AND jsonb_array_length(d.authors) > 0
          ORDER BY d.created_at, d.id LIMIT 1),
        k.authors)
    END AS authors,
    l.keywords, l.raw_keywords, l.mesh_terms, l.substances
  INTO v_merged
  FROM keep k CROSS JOIN lists l;

  -- ══ 3. Preserve relationships before the discards disappear ══════════════
  -- Junction rows cascade on delete, so union them onto the keep paper first.
  -- DISTINCT collapses the same assignment held by several discards; ON CONFLICT
  -- collapses an assignment the keep paper already holds.
  INSERT INTO paper_tags (paper_id, tag_id)
  SELECT DISTINCT p_keep_id, pt.tag_id
  FROM paper_tags pt
  WHERE pt.paper_id = ANY(p_discard_ids)
  ON CONFLICT (paper_id, tag_id) DO NOTHING;

  INSERT INTO paper_projects (paper_id, project_id)
  SELECT DISTINCT p_keep_id, pp.project_id
  FROM paper_projects pp
  WHERE pp.paper_id = ANY(p_discard_ids)
  ON CONFLICT (paper_id, project_id) DO NOTHING;

  -- ══ 4. Re-parent attachments so the cascade cannot destroy them ══════════
  -- Only paper_id changes. id, user_id, file_path, file_name, file_type,
  -- size_bytes and created_at are all left untouched, the Storage object is not
  -- addressed at all, and no quota trigger fires.
  UPDATE paper_attachments
  SET paper_id = p_keep_id
  WHERE paper_id = ANY(p_discard_ids);

  -- ══ 5. Delete the discards, releasing their unique identifier values ═════
  DELETE FROM papers
  WHERE id = ANY(p_discard_ids)
    AND user_id = v_user_id;

  -- ══ 6. Apply the captured metadata to the keep paper ═════════════════════
  -- Runs last so an identifier transferred from a discard cannot collide with
  -- the still-live discard row. id, user_id, title, created_at and insert_order
  -- are never assigned; has_abstract and search_vector are generated columns and
  -- update themselves from their sources.
  UPDATE papers SET
    abstract              = v_merged.abstract,
    journal               = v_merged.journal,
    year                  = v_merged.year,
    pmid                  = v_merged.pmid,
    doi                   = v_merged.doi,
    study_type            = v_merged.study_type,
    statistical_methods   = v_merged.statistical_methods,
    pubmed_url            = v_merged.pubmed_url,
    journal_url           = v_merged.journal_url,
    drive_url             = v_merged.drive_url,
    raw_study_type        = v_merged.raw_study_type,
    raw_publication_types = v_merged.raw_publication_types,
    tldr                  = v_merged.tldr,
    notes                 = v_merged.notes,
    authors               = v_merged.authors,
    keywords              = v_merged.keywords,
    raw_keywords          = v_merged.raw_keywords,
    mesh_terms            = v_merged.mesh_terms,
    substances            = v_merged.substances,
    updated_at            = now()
  WHERE id = p_keep_id
    AND user_id = v_user_id;
END;
$$;

-- ══ 4. Least-privilege surface re-asserted, not assumed ════════════════════
-- CREATE OR REPLACE preserves the existing ACL; these reproduce exactly the
-- grants made by 20260802025704_harden_rpc_and_relational_ownership.sql so a
-- replacement can never silently widen the surface.
REVOKE ALL ON FUNCTION public.safe_bulk_insert_papers(uuid, jsonb) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION public.safe_bulk_insert_papers(uuid, jsonb) TO authenticated;

REVOKE ALL ON FUNCTION public.merge_exact_duplicates(uuid, uuid[]) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION public.merge_exact_duplicates(uuid, uuid[]) TO authenticated;

-- ══ 5. Fail-closed self-check ══════════════════════════════════════════════
-- The additive change must not have altered the column shape or either
-- function's security contract.
DO $verify$
DECLARE
  v_count integer;
  v_row   record;
  v_col   record;
BEGIN
  -- ── Column ──
  SELECT c.data_type, c.is_nullable, c.column_default
  INTO v_col
  FROM information_schema.columns c
  WHERE c.table_schema = 'public'
    AND c.table_name = 'papers'
    AND c.column_name = 'raw_publication_types';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'pubtype_structure: papers.raw_publication_types was not created';
  END IF;
  IF v_col.data_type <> 'jsonb' THEN
    RAISE EXCEPTION 'pubtype_structure: unexpected column type %', v_col.data_type;
  END IF;
  IF v_col.is_nullable <> 'YES' THEN
    RAISE EXCEPTION 'pubtype_structure: raw_publication_types must stay nullable';
  END IF;
  IF v_col.column_default IS NOT NULL THEN
    RAISE EXCEPTION 'pubtype_structure: unexpected column default %', v_col.column_default;
  END IF;

  -- No historical row may have been given a value by this migration.
  IF EXISTS (SELECT 1 FROM public.papers WHERE raw_publication_types IS NOT NULL) THEN
    RAISE EXCEPTION 'pubtype_structure: existing rows must not be backfilled';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.papers'::regclass
      AND conname = 'papers_raw_publication_types_string_array_check'
      AND contype = 'c'
      AND convalidated
  ) THEN
    RAISE EXCEPTION 'pubtype_structure: validated CHECK constraint missing';
  END IF;

  -- ── safe_bulk_insert_papers ──
  SELECT count(*)::integer INTO v_count
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'safe_bulk_insert_papers';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'pubtype_structure: expected exactly 1 safe_bulk_insert_papers overload, found %', v_count;
  END IF;

  SELECT p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS owner,
         pg_get_function_result(p.oid) AS ret,
         pg_get_function_identity_arguments(p.oid) AS args
  INTO v_row
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'safe_bulk_insert_papers';

  IF NOT v_row.prosecdef THEN
    RAISE EXCEPTION 'pubtype_structure: safe_bulk_insert_papers lost SECURITY DEFINER';
  END IF;
  IF v_row.proconfig IS DISTINCT FROM ARRAY['search_path=public'] THEN
    RAISE EXCEPTION 'pubtype_structure: safe_bulk_insert_papers search_path is %', v_row.proconfig;
  END IF;
  IF v_row.owner <> 'postgres' THEN
    RAISE EXCEPTION 'pubtype_structure: safe_bulk_insert_papers owner is %', v_row.owner;
  END IF;
  IF v_row.ret <> 'jsonb' THEN
    RAISE EXCEPTION 'pubtype_structure: safe_bulk_insert_papers returns %', v_row.ret;
  END IF;
  IF v_row.args <> 'p_user_id uuid, p_papers jsonb' THEN
    RAISE EXCEPTION 'pubtype_structure: safe_bulk_insert_papers signature is %', v_row.args;
  END IF;
  IF has_function_privilege('anon', 'public.safe_bulk_insert_papers(uuid,jsonb)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.safe_bulk_insert_papers(uuid,jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.safe_bulk_insert_papers(uuid,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'pubtype_structure: unexpected safe_bulk_insert_papers EXECUTE surface';
  END IF;

  -- ── merge_exact_duplicates ──
  SELECT count(*)::integer INTO v_count
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'merge_exact_duplicates';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'pubtype_structure: expected exactly 1 merge_exact_duplicates overload, found %', v_count;
  END IF;

  SELECT p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS owner,
         pg_get_function_result(p.oid) AS ret,
         pg_get_function_identity_arguments(p.oid) AS args
  INTO v_row
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'merge_exact_duplicates';

  IF NOT v_row.prosecdef THEN
    RAISE EXCEPTION 'pubtype_structure: merge_exact_duplicates lost SECURITY DEFINER';
  END IF;
  IF v_row.proconfig IS DISTINCT FROM ARRAY['search_path=public'] THEN
    RAISE EXCEPTION 'pubtype_structure: merge_exact_duplicates search_path is %', v_row.proconfig;
  END IF;
  IF v_row.owner <> 'postgres' THEN
    RAISE EXCEPTION 'pubtype_structure: merge_exact_duplicates owner is %', v_row.owner;
  END IF;
  IF v_row.ret <> 'void' THEN
    RAISE EXCEPTION 'pubtype_structure: merge_exact_duplicates returns %', v_row.ret;
  END IF;
  IF v_row.args <> 'p_keep_id uuid, p_discard_ids uuid[]' THEN
    RAISE EXCEPTION 'pubtype_structure: merge_exact_duplicates signature is %', v_row.args;
  END IF;
  IF has_function_privilege('anon', 'public.merge_exact_duplicates(uuid,uuid[])', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.merge_exact_duplicates(uuid,uuid[])', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.merge_exact_duplicates(uuid,uuid[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'pubtype_structure: unexpected merge_exact_duplicates EXECUTE surface';
  END IF;
END;
$verify$;
