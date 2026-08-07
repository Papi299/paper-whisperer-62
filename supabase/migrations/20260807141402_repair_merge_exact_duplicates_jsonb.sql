-- MERGE-EXACT-DUPLICATES-JSONB-REPAIR-001
--
-- Repairs the successful path of public.merge_exact_duplicates(uuid, uuid[]).
--
-- Defect being repaired
-- ─────────────────────
-- The function was written in 20260306020000_add_dedup_merge_rpc.sql against
-- text[] metadata columns. 20260331010000_convert_columns_to_jsonb.sql converted
-- authors / keywords / raw_keywords / mesh_terms / substances / statistical_methods
-- to jsonb, but the function body was never reconciled, so the successful merge
-- path still evaluates unnest(papers.keywords) / unnest(p2.mesh_terms) /
-- unnest(p2.substances) against jsonb and aborts with:
--
--   ERROR: function unnest(jsonb) does not exist   (SQLSTATE 42883)
--
-- Every authenticated duplicate merge therefore fails once ownership validation
-- passes. The guard/rejection paths were unaffected, which is why the defect was
-- invisible to the existing security suite.
--
-- The stale body also compared jsonb authors against '{}' — the empty JSON
-- *object*, never equal to the empty JSON *array* '[]' that the schema defaults
-- to — so the authors fallback could never fire even had the statement run. And
-- raw_keywords, tldr and notes postdate the original RPC and were never merged
-- at all.
--
-- Data-preservation gaps closed at the same time
-- ─────────────────────────────────────────────
-- paper_attachments.paper_id references papers(id) ON DELETE CASCADE, and the
-- original body consolidated only paper_tags and paper_projects before deleting
-- the discard rows. Repairing the JSONB error alone would therefore have made a
-- silent data-loss path reachable: attachment metadata belonging to a discard
-- paper would cascade away on the first successful merge. Attachments are now
-- re-parented onto the keep paper before any delete. The Storage object is
-- addressed by paper_attachments.file_path, which is untouched, so no object is
-- copied, moved or renamed. Because no attachment row is deleted, the AFTER
-- DELETE refund_storage_quota trigger never fires and the BEFORE INSERT
-- check_and_consume_storage_quota trigger is never reached, so user_storage_usage
-- is provably unchanged by a merge.
--
-- The original body also updated the keep row *before* deleting the discards.
-- With the per-user partial unique indexes idx_papers_user_pmid_unique and
-- idx_papers_user_doi_unique, transferring an identifier from a discard to a keep
-- paper that lacks one would collide transiently against the still-present
-- discard row. Metadata is now captured first, discards are deleted next, and the
-- keep row is updated last, so the identifier is always free when it is assigned.
--
-- The signature, return type, security context, bounded search_path and EXECUTE
-- surface are all preserved exactly; this migration adds no overload and widens
-- no privilege.

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
    COALESCE(k.raw_study_type,      (SELECT d.raw_study_type      FROM discard d WHERE d.raw_study_type      IS NOT NULL ORDER BY d.created_at, d.id LIMIT 1)) AS raw_study_type,
    COALESCE(k.tldr,                (SELECT d.tldr                FROM discard d WHERE d.tldr                IS NOT NULL ORDER BY d.created_at, d.id LIMIT 1)) AS tldr,
    COALESCE(k.notes,               (SELECT d.notes               FROM discard d WHERE d.notes               IS NOT NULL ORDER BY d.created_at, d.id LIMIT 1)) AS notes,
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
    abstract            = v_merged.abstract,
    journal             = v_merged.journal,
    year                = v_merged.year,
    pmid                = v_merged.pmid,
    doi                 = v_merged.doi,
    study_type          = v_merged.study_type,
    statistical_methods = v_merged.statistical_methods,
    pubmed_url          = v_merged.pubmed_url,
    journal_url         = v_merged.journal_url,
    drive_url           = v_merged.drive_url,
    raw_study_type      = v_merged.raw_study_type,
    tldr                = v_merged.tldr,
    notes               = v_merged.notes,
    authors             = v_merged.authors,
    keywords            = v_merged.keywords,
    raw_keywords        = v_merged.raw_keywords,
    mesh_terms          = v_merged.mesh_terms,
    substances          = v_merged.substances,
    updated_at          = now()
  WHERE id = p_keep_id
    AND user_id = v_user_id;
END;
$$;

-- CREATE OR REPLACE preserves the existing ACL, but the least-privilege surface
-- is re-asserted rather than assumed. This reproduces exactly the grants made by
-- 20260802025704_harden_rpc_and_relational_ownership.sql.
REVOKE ALL ON FUNCTION public.merge_exact_duplicates(uuid, uuid[]) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION public.merge_exact_duplicates(uuid, uuid[]) TO authenticated;

-- Fail-closed self-check: the repair must not have altered the security contract.
DO $verify$
DECLARE
  v_count   integer;
  v_row     record;
BEGIN
  SELECT count(*)::integer INTO v_count
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'merge_exact_duplicates';

  IF v_count <> 1 THEN
    RAISE EXCEPTION 'repair_dedup: expected exactly 1 merge_exact_duplicates overload, found %', v_count;
  END IF;

  SELECT p.prosecdef,
         p.proconfig,
         pg_get_userbyid(p.proowner)                AS owner,
         pg_get_function_result(p.oid)              AS ret,
         pg_get_function_identity_arguments(p.oid)  AS args,
         COALESCE(p.proacl::text, '')               AS acl
  INTO v_row
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'merge_exact_duplicates';

  IF NOT v_row.prosecdef THEN
    RAISE EXCEPTION 'repair_dedup: merge_exact_duplicates lost SECURITY DEFINER';
  END IF;
  IF v_row.proconfig IS DISTINCT FROM ARRAY['search_path=public'] THEN
    RAISE EXCEPTION 'repair_dedup: unexpected search_path setting %', v_row.proconfig;
  END IF;
  IF v_row.owner <> 'postgres' THEN
    RAISE EXCEPTION 'repair_dedup: unexpected owner %', v_row.owner;
  END IF;
  IF v_row.ret <> 'void' THEN
    RAISE EXCEPTION 'repair_dedup: unexpected return type %', v_row.ret;
  END IF;
  IF v_row.args <> 'p_keep_id uuid, p_discard_ids uuid[]' THEN
    RAISE EXCEPTION 'repair_dedup: unexpected signature %', v_row.args;
  END IF;

  -- authenticated may execute; PUBLIC, anon and service_role may not.
  IF has_function_privilege('anon', 'public.merge_exact_duplicates(uuid,uuid[])', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.merge_exact_duplicates(uuid,uuid[])', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.merge_exact_duplicates(uuid,uuid[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'repair_dedup: unexpected EXECUTE surface %', v_row.acl;
  END IF;
END;
$verify$;
