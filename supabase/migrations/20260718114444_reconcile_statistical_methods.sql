-- RECON-STATISTICAL-METHODS-001 (decision C20): reconcile papers.statistical_methods
-- to canonical JSON-string storage.
--
-- Canonical end state:
--   * column type jsonb, nullable, NOT generated/identity, NO default
--   * every stored value is SQL NULL or a top-level JSON string
--   * validated CHECK constraint papers_statistical_methods_json_string_check
--   * safe_bulk_insert_papers normalizes its statistical_methods input to the
--     same invariant (missing/JSON null -> SQL NULL, string kept, array joined,
--     object/number/boolean -> per-row error)
--
-- Supported starting states (anything else fails in Phase A before any mutation):
--   S1 clean local replay: statistical_methods text NULL, no default, no constraint
--   S2 production:         statistical_methods jsonb NULL DEFAULT '[]'::jsonb,
--                          values limited to SQL NULL / JSON null / string / array
--
-- Approved transitional normalization (C20):
--   SQL NULL   -> SQL NULL          JSON null -> SQL NULL
--   JSON string -> unchanged        JSON array -> one JSON string, elements
--   joined in order with ', ' via PostgreSQL text extraction (#>> '{}');
--   JSON null elements are omitted by string_agg; empty array -> "".
--   Top-level object/number/boolean are unsupported and abort the migration.

-- ── Phase A: classify and validate before ANY mutation ───────────────────────
DO $recon$
DECLARE
  v_reloid          oid;
  v_attnum          int2;
  v_type            text;
  v_notnull         boolean;
  v_generated       text;
  v_identity        text;
  v_default         text;
  v_def_oid         oid;
  v_state           text;
  v_cnt             bigint;
  v_total           bigint;
  v_pre_sql_null    bigint;
  v_pre_json_null   bigint;
  v_pre_string      bigint;
  v_pre_array       bigint;
  v_expected_null   bigint;
  v_expected_string bigint;
  v_bulk            record;
  v_merge           record;
BEGIN
  -- A1: table exists
  SELECT c.oid INTO v_reloid
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'papers' AND c.relkind = 'r';
  IF v_reloid IS NULL THEN
    RAISE EXCEPTION 'recon_sm A1: table public.papers not found';
  END IF;

  -- A2: column exists, live, nullable, non-generated, non-identity.
  -- Also capture the column's OWN pg_attrdef object OID: it is the single
  -- dependency on the column that A7 may permit (JSONB state only).
  SELECT a.attnum, format_type(a.atttypid, a.atttypmod), a.attnotnull,
         a.attgenerated::text, a.attidentity::text, pg_get_expr(d.adbin, d.adrelid), d.oid
  INTO v_attnum, v_type, v_notnull, v_generated, v_identity, v_default, v_def_oid
  FROM pg_attribute a
  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE a.attrelid = v_reloid AND a.attname = 'statistical_methods'
    AND NOT a.attisdropped;
  IF v_attnum IS NULL THEN
    RAISE EXCEPTION 'recon_sm A2: column papers.statistical_methods not found';
  END IF;
  IF v_notnull THEN
    RAISE EXCEPTION 'recon_sm A2: statistical_methods is unexpectedly NOT NULL';
  END IF;
  IF v_generated <> '' OR v_identity <> '' THEN
    RAISE EXCEPTION 'recon_sm A2: statistical_methods is generated/identity (generated=%, identity=%)',
      v_generated, v_identity;
  END IF;

  -- A3: classify the starting state as exactly text (S1) or jsonb (S2)
  IF v_type = 'text' THEN
    v_state := 'text';
  ELSIF v_type = 'jsonb' THEN
    v_state := 'jsonb';
  ELSE
    RAISE EXCEPTION 'recon_sm A3: unsupported column type %; expected text or jsonb', v_type;
  END IF;

  -- A4: default must match the known state exactly.
  -- Text state: no default and therefore no own pg_attrdef object.
  -- JSONB state: exactly one own pg_attrdef object deparsing to '[]'::jsonb.
  IF v_state = 'text' AND (v_default IS NOT NULL OR v_def_oid IS NOT NULL) THEN
    RAISE EXCEPTION 'recon_sm A4: unexpected default % on text-state column (expected none)', v_default;
  END IF;
  IF v_state = 'jsonb' AND (v_default IS DISTINCT FROM '''[]''::jsonb' OR v_def_oid IS NULL) THEN
    RAISE EXCEPTION 'recon_sm A4: unexpected default % on jsonb-state column (expected ''[]''::jsonb)',
      COALESCE(v_default, '<none>');
  END IF;

  -- A5: no existing constraint may involve the column, and the canonical
  -- constraint name must not already exist on the table
  SELECT count(*) INTO v_cnt
  FROM pg_constraint con
  WHERE con.conrelid = v_reloid AND v_attnum = ANY (con.conkey);
  IF v_cnt <> 0 THEN
    RAISE EXCEPTION 'recon_sm A5: % unexpected constraint(s) already involve statistical_methods', v_cnt;
  END IF;
  SELECT count(*) INTO v_cnt
  FROM pg_constraint con
  WHERE con.conrelid = v_reloid
    AND con.conname = 'papers_statistical_methods_json_string_check';
  IF v_cnt <> 0 THEN
    RAISE EXCEPTION 'recon_sm A5: constraint papers_statistical_methods_json_string_check already exists';
  END IF;

  -- A6: no index may involve the column
  SELECT count(*) INTO v_cnt
  FROM pg_index x
  WHERE x.indrelid = v_reloid
    AND (v_attnum = ANY (x.indkey::int2[])
         OR pg_get_indexdef(x.indexrelid) ILIKE '%statistical_methods%');
  IF v_cnt <> 0 THEN
    RAISE EXCEPTION 'recon_sm A6: % unexpected index(es) involve statistical_methods', v_cnt;
  END IF;

  -- A7: enumerate every direct catalog dependency on the column
  -- (views/rewrite rules, policies, trigger expressions, constraints,
  -- expression indexes, other columns' pg_attrdef objects — i.e. stored
  -- generated-column expressions and other defaults — and any other class).
  -- The ONLY permitted dependency is the column's OWN default object,
  -- matched by exact pg_attrdef OID, and only in the JSONB starting state.
  -- Restrictive (non-CASCADE) DDL in Phase B remains the terminal backstop
  -- for any dependency class not proactively enumerated here.
  SELECT count(*) INTO v_cnt
  FROM pg_depend dep
  WHERE dep.refclassid = 'pg_class'::regclass
    AND dep.refobjid = v_reloid
    AND dep.refobjsubid = v_attnum
    AND NOT (v_state = 'jsonb'
             AND dep.classid = 'pg_attrdef'::regclass
             AND dep.objid = v_def_oid);
  IF v_cnt <> 0 THEN
    RAISE EXCEPTION 'recon_sm A7: % unexpected dependency(ies) on statistical_methods (only the column''s own default object is permitted, and only in the jsonb state)', v_cnt;
  END IF;

  -- A8: in the jsonb state, unsupported top-level categories abort before any
  -- mutation (dynamic SQL so the text state never plans jsonb expressions)
  IF v_state = 'jsonb' THEN
    EXECUTE $q$
      SELECT count(*) FROM public.papers
      WHERE jsonb_typeof(statistical_methods) IN ('object', 'number', 'boolean')
    $q$ INTO v_cnt;
    IF v_cnt <> 0 THEN
      RAISE EXCEPTION 'recon_sm A8: % row(s) hold unsupported top-level JSON object/number/boolean values; aborting before any mutation', v_cnt;
    END IF;
  END IF;

  -- A9: record aggregate category counts for Phase C reconciliation
  SELECT count(*), count(*) FILTER (WHERE statistical_methods IS NULL)
  INTO v_total, v_pre_sql_null
  FROM public.papers;
  IF v_state = 'text' THEN
    v_expected_null   := v_pre_sql_null;
    v_expected_string := v_total - v_pre_sql_null;
  ELSE
    EXECUTE $q$
      SELECT count(*) FILTER (WHERE jsonb_typeof(statistical_methods) = 'null'),
             count(*) FILTER (WHERE jsonb_typeof(statistical_methods) = 'string'),
             count(*) FILTER (WHERE jsonb_typeof(statistical_methods) = 'array')
      FROM public.papers
    $q$ INTO v_pre_json_null, v_pre_string, v_pre_array;
    IF v_pre_sql_null + v_pre_json_null + v_pre_string + v_pre_array <> v_total THEN
      RAISE EXCEPTION 'recon_sm A9: category counts do not partition the table (%+%+%+% <> %)',
        v_pre_sql_null, v_pre_json_null, v_pre_string, v_pre_array, v_total;
    END IF;
    v_expected_null   := v_pre_sql_null + v_pre_json_null;
    v_expected_string := v_pre_string + v_pre_array;
  END IF;

  -- A10: both RPCs must exist EXACTLY in their approved pre-migration form.
  -- safe_bulk_insert_papers is about to be replaced, so the replacement is
  -- gated on the exact approved old body (md5 of prosrc as created by
  -- 20260330010100_update_bulk_insert_raw_keywords.sql, verified identical
  -- in production) and on every metadata property individually — an
  -- unexpected production-side change is never silently overwritten.
  SELECT count(*) INTO v_cnt
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'safe_bulk_insert_papers';
  IF v_cnt <> 1 THEN
    RAISE EXCEPTION 'recon_sm A10: expected exactly 1 safe_bulk_insert_papers overload, found %', v_cnt;
  END IF;
  SELECT pg_get_function_identity_arguments(p.oid) AS args,
         pg_get_function_result(p.oid)             AS rettype,
         p.prokind::text    AS kind,
         l.lanname          AS lang,
         p.prosecdef        AS secdef,
         p.provolatile::text AS vol,
         p.proisstrict      AS strict_mode,
         p.proleakproof     AS leakproof,
         p.proparallel::text AS parallel_mode,
         p.proconfig        AS config,
         p.proowner         AS owner_oid,
         p.proacl::text     AS acl,
         md5(p.prosrc)      AS body_md5
  INTO v_bulk
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  JOIN pg_language l ON l.oid = p.prolang
  WHERE n.nspname = 'public' AND p.proname = 'safe_bulk_insert_papers';
  IF v_bulk.args <> 'p_user_id uuid, p_papers jsonb' OR v_bulk.rettype <> 'jsonb' THEN
    RAISE EXCEPTION 'recon_sm A10: safe_bulk_insert_papers signature mismatch (% -> %)', v_bulk.args, v_bulk.rettype;
  END IF;
  IF v_bulk.kind <> 'f' OR v_bulk.lang <> 'plpgsql' OR NOT v_bulk.secdef
     OR v_bulk.vol <> 'v' OR v_bulk.strict_mode OR v_bulk.leakproof
     OR v_bulk.parallel_mode <> 'u' THEN
    RAISE EXCEPTION 'recon_sm A10: safe_bulk_insert_papers metadata mismatch (kind=%, lang=%, secdef=%, vol=%, strict=%, leakproof=%, parallel=%)',
      v_bulk.kind, v_bulk.lang, v_bulk.secdef, v_bulk.vol, v_bulk.strict_mode, v_bulk.leakproof, v_bulk.parallel_mode;
  END IF;
  IF v_bulk.config IS DISTINCT FROM ARRAY['search_path=public'] THEN
    RAISE EXCEPTION 'recon_sm A10: safe_bulk_insert_papers configuration is exactly %, expected exactly {search_path=public}',
      COALESCE(v_bulk.config::text, '<none>');
  END IF;
  IF v_bulk.body_md5 <> '85cde6c56d75117f9dfa605264da7b60' THEN
    RAISE EXCEPTION 'recon_sm A10: safe_bulk_insert_papers pre-migration body fingerprint % does not match the approved body (85cde6c56d75117f9dfa605264da7b60); refusing to overwrite an unexpected body', v_bulk.body_md5;
  END IF;

  -- merge_exact_duplicates: identified deterministically (it is never modified;
  -- Phase C proves body, metadata, owner, and ACL all remain unchanged).
  SELECT count(*) INTO v_cnt
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'merge_exact_duplicates';
  IF v_cnt <> 1 THEN
    RAISE EXCEPTION 'recon_sm A10: expected exactly 1 merge_exact_duplicates overload, found %', v_cnt;
  END IF;
  SELECT pg_get_function_identity_arguments(p.oid) AS args,
         pg_get_function_result(p.oid)             AS rettype,
         p.prokind::text    AS kind,
         l.lanname          AS lang,
         p.prosecdef        AS secdef,
         p.provolatile::text AS vol,
         p.proconfig        AS config,
         p.proowner         AS owner_oid,
         p.proacl::text     AS acl,
         md5(p.prosrc)      AS body_md5
  INTO v_merge
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  JOIN pg_language l ON l.oid = p.prolang
  WHERE n.nspname = 'public' AND p.proname = 'merge_exact_duplicates';
  IF v_merge.args <> 'p_keep_id uuid, p_discard_ids uuid[]' OR v_merge.rettype <> 'void'
     OR v_merge.kind <> 'f' OR v_merge.lang <> 'plpgsql' OR NOT v_merge.secdef
     OR v_merge.vol <> 'v'
     OR v_merge.config IS DISTINCT FROM ARRAY['search_path=public'] THEN
    RAISE EXCEPTION 'recon_sm A10: merge_exact_duplicates signature/metadata mismatch';
  END IF;
  IF v_merge.body_md5 <> '477aeca22f8eca66ba5402989145ebd0' THEN
    RAISE EXCEPTION 'recon_sm A10: merge_exact_duplicates body fingerprint % does not match the approved body (477aeca22f8eca66ba5402989145ebd0)', v_merge.body_md5;
  END IF;

  -- Hand the classification, expected postconditions, and captured
  -- owner/ACL state to Phases B and C.
  CREATE TEMP TABLE _recon_sm_state ON COMMIT DROP AS
  SELECT v_state            AS state,
         v_total            AS pre_total,
         v_expected_null    AS expected_null,
         v_expected_string  AS expected_string,
         v_bulk.owner_oid   AS bulk_owner,
         v_bulk.acl         AS bulk_acl,
         v_merge.owner_oid  AS merge_owner,
         v_merge.acl        AS merge_acl;
END
$recon$;

-- ── Phase B1: convert the clean-replay text state to jsonb ───────────────────
-- to_jsonb(text) wraps every text value as one JSON string; the text is never
-- parsed as JSON, so values like '["ANOVA"]' or 'null' stay literal strings.
DO $recon$
DECLARE
  v_state text;
BEGIN
  SELECT state INTO v_state FROM _recon_sm_state;
  IF v_state = 'text' THEN
    EXECUTE $sql$
      ALTER TABLE public.papers
        ALTER COLUMN statistical_methods TYPE jsonb
        USING (CASE WHEN statistical_methods IS NULL THEN NULL
                    ELSE to_jsonb(statistical_methods) END)
    $sql$;
  END IF;
END
$recon$;

-- ── Phase B2: normalize transitional JSON categories (column is jsonb now) ───
UPDATE public.papers
SET statistical_methods = CASE jsonb_typeof(statistical_methods)
      WHEN 'null'  THEN NULL
      WHEN 'array' THEN (
        SELECT to_jsonb(COALESCE(string_agg(e.elem #>> '{}', ', ' ORDER BY e.ord), ''))
        FROM jsonb_array_elements(statistical_methods) WITH ORDINALITY AS e(elem, ord)
      )
    END
WHERE jsonb_typeof(statistical_methods) IN ('null', 'array');

-- ── Phase B3: remove the noncanonical array default (no replacement) ─────────
ALTER TABLE public.papers ALTER COLUMN statistical_methods DROP DEFAULT;

-- ── Phase B4: add the canonical validated CHECK constraint ───────────────────
ALTER TABLE public.papers
  ADD CONSTRAINT papers_statistical_methods_json_string_check
  CHECK (statistical_methods IS NULL OR jsonb_typeof(statistical_methods) = 'string');

-- ── Phase B5: reconcile safe_bulk_insert_papers input normalization ──────────
-- Identical to the previous definition except for the canonical
-- statistical_methods normalization. The normalization runs inside the
-- per-paper BEGIN/EXCEPTION block, so an unsupported value yields a per-row
-- 'error' result without aborting the rest of the batch.
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
  v_statistical_methods jsonb;
BEGIN
  IF p_user_id <> auth.uid() THEN
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

      INSERT INTO papers (
        user_id, title, authors, year, journal, pmid, doi,
        abstract, study_type, raw_study_type, statistical_methods,
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
$$;

-- ── Phase C: exact end-state assertions ──────────────────────────────────────
DO $recon$
DECLARE
  v_pre        record;
  v_type       text;
  v_notnull    boolean;
  v_generated  text;
  v_identity   text;
  v_default    text;
  v_cnt        bigint;
  v_total      bigint;
  v_null_cnt   bigint;
  v_string_cnt bigint;
  v_condef     text;
  v_validated  boolean;
  v_bulk       record;
  v_merge      record;
BEGIN
  SELECT * INTO v_pre FROM _recon_sm_state;

  -- C1: column shape
  SELECT format_type(a.atttypid, a.atttypmod), a.attnotnull,
         a.attgenerated::text, a.attidentity::text, pg_get_expr(d.adbin, d.adrelid)
  INTO v_type, v_notnull, v_generated, v_identity, v_default
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE n.nspname = 'public' AND c.relname = 'papers'
    AND a.attname = 'statistical_methods' AND NOT a.attisdropped;
  IF v_type IS DISTINCT FROM 'jsonb' THEN
    RAISE EXCEPTION 'recon_sm C1: final type is %, expected jsonb', v_type;
  END IF;
  IF v_notnull THEN
    RAISE EXCEPTION 'recon_sm C1: column must remain nullable';
  END IF;
  IF v_generated <> '' OR v_identity <> '' THEN
    RAISE EXCEPTION 'recon_sm C1: column must not be generated/identity';
  END IF;
  IF v_default IS NOT NULL THEN
    RAISE EXCEPTION 'recon_sm C1: default % must not exist', v_default;
  END IF;

  -- C2: exactly one constraint involves the column — the canonical validated CHECK
  SELECT count(*) INTO v_cnt
  FROM pg_constraint con
  JOIN pg_class c ON c.oid = con.conrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'statistical_methods'
  WHERE n.nspname = 'public' AND c.relname = 'papers'
    AND a.attnum = ANY (con.conkey);
  IF v_cnt <> 1 THEN
    RAISE EXCEPTION 'recon_sm C2: expected exactly 1 constraint on statistical_methods, found %', v_cnt;
  END IF;
  SELECT pg_get_constraintdef(con.oid), con.convalidated
  INTO v_condef, v_validated
  FROM pg_constraint con
  JOIN pg_class c ON c.oid = con.conrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'papers'
    AND con.conname = 'papers_statistical_methods_json_string_check'
    AND con.contype = 'c';
  IF v_condef IS NULL THEN
    RAISE EXCEPTION 'recon_sm C2: canonical CHECK constraint not found';
  END IF;
  IF NOT v_validated THEN
    RAISE EXCEPTION 'recon_sm C2: canonical constraint is not validated';
  END IF;
  IF v_condef <> 'CHECK (((statistical_methods IS NULL) OR (jsonb_typeof(statistical_methods) = ''string''::text)))' THEN
    RAISE EXCEPTION 'recon_sm C2: constraint definition mismatch: %', v_condef;
  END IF;

  -- C3: data invariant and category reconciliation
  SELECT count(*),
         count(*) FILTER (WHERE statistical_methods IS NULL),
         count(*) FILTER (WHERE jsonb_typeof(statistical_methods) = 'string'),
         count(*) FILTER (WHERE jsonb_typeof(statistical_methods)
                          IN ('null', 'array', 'object', 'number', 'boolean'))
  INTO v_total, v_null_cnt, v_string_cnt, v_cnt
  FROM public.papers;
  IF v_cnt <> 0 THEN
    RAISE EXCEPTION 'recon_sm C3: % row(s) still hold non-string JSON categories', v_cnt;
  END IF;
  IF v_total <> v_pre.pre_total THEN
    RAISE EXCEPTION 'recon_sm C3: row count changed (% -> %)', v_pre.pre_total, v_total;
  END IF;
  IF v_null_cnt <> v_pre.expected_null THEN
    RAISE EXCEPTION 'recon_sm C3: SQL NULL count % does not reconcile (expected %)',
      v_null_cnt, v_pre.expected_null;
  END IF;
  IF v_string_cnt <> v_pre.expected_string THEN
    RAISE EXCEPTION 'recon_sm C3: JSON string count % does not reconcile (expected %)',
      v_string_cnt, v_pre.expected_string;
  END IF;
  IF v_null_cnt + v_string_cnt <> v_total THEN
    RAISE EXCEPTION 'recon_sm C3: NULL + string (%+%) does not cover all % rows',
      v_null_cnt, v_string_cnt, v_total;
  END IF;

  -- C4: safe_bulk_insert_papers carries EXACTLY the canonical new body
  -- (md5 of the complete prosrc created by Phase B5 — any inserted or removed
  -- statement changes the fingerprint) with every metadata property, the
  -- owner, and the ACL preserved from Phase A.
  SELECT count(*) INTO v_cnt
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'safe_bulk_insert_papers';
  IF v_cnt <> 1 THEN
    RAISE EXCEPTION 'recon_sm C4: expected exactly 1 safe_bulk_insert_papers overload, found %', v_cnt;
  END IF;
  SELECT pg_get_function_identity_arguments(p.oid) AS args,
         pg_get_function_result(p.oid)             AS rettype,
         p.prokind::text    AS kind,
         l.lanname          AS lang,
         p.prosecdef        AS secdef,
         p.provolatile::text AS vol,
         p.proisstrict      AS strict_mode,
         p.proleakproof     AS leakproof,
         p.proparallel::text AS parallel_mode,
         p.proconfig        AS config,
         p.proowner         AS owner_oid,
         p.proacl::text     AS acl,
         md5(p.prosrc)      AS body_md5
  INTO v_bulk
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  JOIN pg_language l ON l.oid = p.prolang
  WHERE n.nspname = 'public' AND p.proname = 'safe_bulk_insert_papers';
  IF v_bulk.args <> 'p_user_id uuid, p_papers jsonb' OR v_bulk.rettype <> 'jsonb'
     OR v_bulk.kind <> 'f' OR v_bulk.lang <> 'plpgsql' OR NOT v_bulk.secdef
     OR v_bulk.vol <> 'v' OR v_bulk.strict_mode OR v_bulk.leakproof
     OR v_bulk.parallel_mode <> 'u' THEN
    RAISE EXCEPTION 'recon_sm C4: safe_bulk_insert_papers post-migration signature/metadata mismatch';
  END IF;
  IF v_bulk.config IS DISTINCT FROM ARRAY['search_path=public'] THEN
    RAISE EXCEPTION 'recon_sm C4: safe_bulk_insert_papers post-migration configuration is exactly %, expected exactly {search_path=public}',
      COALESCE(v_bulk.config::text, '<none>');
  END IF;
  IF v_bulk.body_md5 <> '17ea201f8b75466e580f0f46178afc22' THEN
    RAISE EXCEPTION 'recon_sm C4: safe_bulk_insert_papers body fingerprint % is not the canonical post-migration body (17ea201f8b75466e580f0f46178afc22)', v_bulk.body_md5;
  END IF;
  IF v_bulk.owner_oid <> v_pre.bulk_owner THEN
    RAISE EXCEPTION 'recon_sm C4: safe_bulk_insert_papers owner changed during migration';
  END IF;
  IF v_bulk.acl IS DISTINCT FROM v_pre.bulk_acl THEN
    RAISE EXCEPTION 'recon_sm C4: safe_bulk_insert_papers ACL changed during migration (no grant may be added or removed)';
  END IF;

  -- C5: merge_exact_duplicates is completely unchanged — body fingerprint,
  -- signature, metadata, configuration, owner, and ACL.
  SELECT count(*) INTO v_cnt
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'merge_exact_duplicates';
  IF v_cnt <> 1 THEN
    RAISE EXCEPTION 'recon_sm C5: expected exactly 1 merge_exact_duplicates overload, found %', v_cnt;
  END IF;
  SELECT pg_get_function_identity_arguments(p.oid) AS args,
         pg_get_function_result(p.oid)             AS rettype,
         p.prokind::text    AS kind,
         l.lanname          AS lang,
         p.prosecdef        AS secdef,
         p.provolatile::text AS vol,
         p.proconfig        AS config,
         p.proowner         AS owner_oid,
         p.proacl::text     AS acl,
         md5(p.prosrc)      AS body_md5
  INTO v_merge
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  JOIN pg_language l ON l.oid = p.prolang
  WHERE n.nspname = 'public' AND p.proname = 'merge_exact_duplicates';
  IF v_merge.body_md5 <> '477aeca22f8eca66ba5402989145ebd0'
     OR v_merge.args <> 'p_keep_id uuid, p_discard_ids uuid[]' OR v_merge.rettype <> 'void'
     OR v_merge.kind <> 'f' OR v_merge.lang <> 'plpgsql' OR NOT v_merge.secdef
     OR v_merge.vol <> 'v'
     OR v_merge.config IS DISTINCT FROM ARRAY['search_path=public']
     OR v_merge.owner_oid <> v_pre.merge_owner
     OR v_merge.acl IS DISTINCT FROM v_pre.merge_acl THEN
    RAISE EXCEPTION 'recon_sm C5: merge_exact_duplicates changed during migration';
  END IF;

  DROP TABLE _recon_sm_state;
END
$recon$;
