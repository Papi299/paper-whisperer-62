-- RECON-LEGACY-COLUMNS-001 — drop the three empty production-only legacy
-- columns under decision C21 (docs/schema-reconciliation.md §4):
--
--   public.papers.urls                 jsonb DEFAULT '[]'::jsonb  (all rows empty [])
--   public.synonym_pool.primary_term   text, no default           (all rows SQL NULL)
--   public.synonym_pool.variants       jsonb DEFAULT '[]'::jsonb  (all rows empty [])
--
-- Supported global starting states (anything else fails in Phase A, before DDL):
--   S1 — clean replay / already reconciled: all three live columns absent → no DDL.
--   S2 — audited production state: all three present with the exact metadata
--        hard-coded below, only canonical-empty values, and no dependency other
--        than each column's own default object → lock, recheck, drop.
--
-- Dropping a column is structurally irreversible: original attnums and any
-- unrecorded values cannot be reconstructed. Approved because the aggregate
-- checks below (repeated under lock) prove no meaningful value exists.
--
-- No DML of any kind. No CASCADE. No IF EXISTS (a disappearing column must
-- surface as a state failure, not be silently tolerated).

DO $recon$
DECLARE
  -- Exact audited S2 manifest (linked project lioxtgiputfniqbktcsz, 2026-07-19).
  -- def is the deparsed pg_get_expr() form of the column's own default, or NULL
  -- for "must have no default". coll: 'none' = attcollation 0, 'db_default' =
  -- the database default collation. empt: approved emptiness rule.
  v_manifest CONSTANT jsonb := jsonb_build_array(
    jsonb_build_object('tbl','papers',       'col','urls',         'typ','jsonb', 'def','''[]''::jsonb', 'coll','none',       'empt','jsonb_empty_array'),
    jsonb_build_object('tbl','synonym_pool', 'col','primary_term', 'typ','text',  'def',NULL,            'coll','db_default', 'empt','all_sql_null'),
    jsonb_build_object('tbl','synonym_pool', 'col','variants',     'typ','jsonb', 'def','''[]''::jsonb', 'coll','none',       'empt','jsonb_empty_array')
  );
  v_tables CONSTANT text[] := ARRAY['papers','synonym_pool'];  -- deterministic lock order

  m            record;
  t            text;
  v_state      text;
  v_pass       int;
  v_present    int;
  v_cnt        bigint;
  v_rows       bigint;
  v_expect_coll oid;
  r            record;

  -- pre-DDL captures (Phase A / under-lock), compared again in Phase C
  v_rows_papers  bigint;
  v_rows_synonym bigint;
  v_fp_papers    text;
  v_fp_synonym   text;
  v_inv_pre      jsonb := '{}'::jsonb;
  v_inv_post     jsonb;
  v_live_pre     jsonb := '{}'::jsonb;
  v_funcs_pre    text;
  v_funcs_post   text;

BEGIN
  ------------------------------------------------------------------
  -- Manifest self-checks
  ------------------------------------------------------------------
  IF jsonb_array_length(v_manifest) <> 3 THEN
    RAISE EXCEPTION 'RECON-LEGACY-COLUMNS-001: manifest must contain exactly 3 targets';
  END IF;
  SELECT count(DISTINCT x.tbl || '.' || x.col) INTO v_cnt
    FROM jsonb_to_recordset(v_manifest) AS x(tbl text, col text);
  IF v_cnt <> 3 THEN
    RAISE EXCEPTION 'RECON-LEGACY-COLUMNS-001: manifest targets are not distinct';
  END IF;
  SELECT count(DISTINCT x.tbl) INTO v_cnt
    FROM jsonb_to_recordset(v_manifest) AS x(tbl text);
  IF v_cnt <> 2 THEN
    RAISE EXCEPTION 'RECON-LEGACY-COLUMNS-001: manifest must span exactly 2 tables';
  END IF;

  ------------------------------------------------------------------
  -- Phase A, then (in S2) the identical checks again under lock.
  -- pass 1 = pre-lock classification/validation; pass 2 = under-lock recheck.
  ------------------------------------------------------------------
  FOR v_pass IN 1..2 LOOP

    -- Both tables must exist as ordinary tables.
    FOREACH t IN ARRAY v_tables LOOP
      PERFORM 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = t AND c.relkind = 'r';
      IF NOT FOUND THEN
        RAISE EXCEPTION 'RECON-LEGACY-COLUMNS-001: public.% is missing or not an ordinary table', t;
      END IF;
    END LOOP;

    -- Global classification over live columns (attisdropped tombstones ignored).
    SELECT count(*) INTO v_present
      FROM jsonb_to_recordset(v_manifest) AS x(tbl text, col text)
      JOIN pg_attribute a
        ON a.attrelid = ('public.' || x.tbl)::regclass
       AND a.attname  = x.col AND a.attnum > 0 AND NOT a.attisdropped;

    IF v_present = 0 THEN
      v_state := 'S1';
    ELSIF v_present = 3 THEN
      v_state := 'S2';
    ELSE
      RAISE EXCEPTION 'RECON-LEGACY-COLUMNS-001: unsupported partial state — % of 3 legacy columns present; refusing a partial drop', v_present;
    END IF;

    IF v_pass = 2 AND v_state <> 'S2' THEN
      RAISE EXCEPTION 'RECON-LEGACY-COLUMNS-001: state changed to % under lock; aborting', v_state;
    END IF;

    ----------------------------------------------------------------
    -- Preservation inventory + expected final live-column set + row
    -- counts (captured every pass; in S2 the pass-2 under-lock capture
    -- is the authoritative pre-DDL state Phase C compares against)
    ----------------------------------------------------------------
    v_inv_pre  := '{}'::jsonb;
    v_live_pre := '{}'::jsonb;
    FOREACH t IN ARRAY v_tables LOOP
      SELECT jsonb_build_object(
        'rls', (SELECT c.relrowsecurity::text || '/' || c.relforcerowsecurity::text || '/' ||
                       pg_get_userbyid(c.relowner) || '/' || COALESCE(c.relacl::text, '-')
                  FROM pg_class c WHERE c.oid = ('public.' || t)::regclass),
        'pol', (SELECT COALESCE(md5(string_agg(pol.polname || ':' || pol.polcmd::text || ':' ||
                       COALESCE(pg_get_expr(pol.polqual, pol.polrelid), '-') || ':' ||
                       COALESCE(pg_get_expr(pol.polwithcheck, pol.polrelid), '-'), '|' ORDER BY pol.polname)), 'none')
                  FROM pg_policy pol WHERE pol.polrelid = ('public.' || t)::regclass),
        'con', (SELECT COALESCE(md5(string_agg(c.conname || ':' || pg_get_constraintdef(c.oid), '|' ORDER BY c.conname)), 'none')
                  FROM pg_constraint c WHERE c.conrelid = ('public.' || t)::regclass),
        'idx', (SELECT COALESCE(md5(string_agg(indexname || ':' || indexdef, '|' ORDER BY indexname)), 'none')
                  FROM pg_indexes WHERE schemaname = 'public' AND tablename = t),
        'trg', (SELECT COALESCE(md5(string_agg(tg.tgname || ':' || pg_get_triggerdef(tg.oid), '|' ORDER BY tg.tgname)), 'none')
                  FROM pg_trigger tg WHERE tg.tgrelid = ('public.' || t)::regclass AND NOT tg.tgisinternal),
        'cols', (SELECT md5(string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' ||
                        a.attnotnull::text || ':' || COALESCE(pg_get_expr(ad.adbin, ad.adrelid), '-') || ':' ||
                        a.attgenerated::text || ':' || a.attidentity::text || ':' ||
                        a.attcollation::text || ':' || a.attstorage::text, '|' ORDER BY a.attname))
                   FROM pg_attribute a
                   LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
                  WHERE a.attrelid = ('public.' || t)::regclass AND a.attnum > 0 AND NOT a.attisdropped
                    AND NOT (t = 'papers' AND a.attname = 'urls')
                    AND NOT (t = 'synonym_pool' AND a.attname IN ('primary_term', 'variants')))
      ) INTO v_inv_post;  -- scratch
      v_inv_pre := v_inv_pre || jsonb_build_object(t, v_inv_post);

      SELECT jsonb_agg(a.attname ORDER BY a.attname) INTO v_inv_post
        FROM pg_attribute a
       WHERE a.attrelid = ('public.' || t)::regclass AND a.attnum > 0 AND NOT a.attisdropped
         AND NOT (t = 'papers' AND a.attname = 'urls')
         AND NOT (t = 'synonym_pool' AND a.attname IN ('primary_term', 'variants'));
      v_live_pre := v_live_pre || jsonb_build_object(t, v_inv_post);
    END LOOP;

    SELECT md5(string_agg(p.proname || ':' || pg_get_function_identity_arguments(p.oid) || ':' || md5(p.prosrc),
                          '|' ORDER BY p.proname, pg_get_function_identity_arguments(p.oid)))
      INTO v_funcs_pre
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public';

    SELECT count(*) INTO v_rows_papers  FROM public.papers;
    SELECT count(*) INTO v_rows_synonym FROM public.synonym_pool;

    IF v_state = 'S1' THEN
      EXIT;  -- nothing further to validate pre-DDL; Phase C asserts absence
    END IF;

    ----------------------------------------------------------------
    -- S2: exact metadata validation for every target
    ----------------------------------------------------------------
    FOR m IN SELECT * FROM jsonb_to_recordset(v_manifest)
             AS x(tbl text, col text, typ text, def text, coll text, empt text) LOOP

      SELECT a.attnum, format_type(a.atttypid, a.atttypmod) AS ftype,
             a.attnotnull, a.attgenerated, a.attidentity, a.attcollation,
             a.attstorage, a.attcompression, a.attstattarget, a.attacl,
             ad.oid AS def_oid, pg_get_expr(ad.adbin, ad.adrelid) AS def_expr,
             col_description(a.attrelid, a.attnum) AS col_comment
        INTO r
        FROM pg_attribute a
        LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
       WHERE a.attrelid = ('public.' || m.tbl)::regclass
         AND a.attname = m.col AND a.attnum > 0 AND NOT a.attisdropped;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'RECON-LEGACY-COLUMNS-001: %.% disappeared during validation', m.tbl, m.col;
      END IF;

      IF r.ftype <> m.typ THEN
        RAISE EXCEPTION 'RECON-LEGACY-COLUMNS-001: %.% has type % (expected %)', m.tbl, m.col, r.ftype, m.typ;
      END IF;
      IF r.attnotnull THEN
        RAISE EXCEPTION 'RECON-LEGACY-COLUMNS-001: %.% is unexpectedly NOT NULL', m.tbl, m.col;
      END IF;
      IF r.attgenerated <> '' OR r.attidentity <> '' THEN
        RAISE EXCEPTION 'RECON-LEGACY-COLUMNS-001: %.% is generated or identity-backed', m.tbl, m.col;
      END IF;
      IF r.def_expr IS DISTINCT FROM m.def THEN
        RAISE EXCEPTION 'RECON-LEGACY-COLUMNS-001: %.% default is % (expected %)',
          m.tbl, m.col, COALESCE(r.def_expr, '<none>'), COALESCE(m.def, '<none>');
      END IF;
      v_expect_coll := CASE m.coll
                         WHEN 'none' THEN 0
                         ELSE (SELECT oid FROM pg_collation WHERE collname = 'default')
                       END;
      IF r.attcollation <> v_expect_coll THEN
        RAISE EXCEPTION 'RECON-LEGACY-COLUMNS-001: %.% has unexpected collation OID %', m.tbl, m.col, r.attcollation;
      END IF;
      IF r.attstorage <> 'x' OR r.attcompression <> '' THEN
        RAISE EXCEPTION 'RECON-LEGACY-COLUMNS-001: %.% has unexpected storage/compression %/%', m.tbl, m.col, r.attstorage, r.attcompression;
      END IF;
      IF r.attstattarget IS NOT NULL AND r.attstattarget >= 0 THEN
        RAISE EXCEPTION 'RECON-LEGACY-COLUMNS-001: %.% has a custom statistics target', m.tbl, m.col;
      END IF;
      IF r.attacl IS NOT NULL THEN
        RAISE EXCEPTION 'RECON-LEGACY-COLUMNS-001: %.% carries column-level privileges', m.tbl, m.col;
      END IF;
      IF r.col_comment IS NOT NULL THEN
        RAISE EXCEPTION 'RECON-LEGACY-COLUMNS-001: %.% carries a comment', m.tbl, m.col;
      END IF;

      --------------------------------------------------------------
      -- Approved emptiness rule (aggregate only; no row values read out)
      --------------------------------------------------------------
      IF m.empt = 'all_sql_null' THEN
        EXECUTE format('SELECT count(*) FROM public.%I WHERE %I IS NOT NULL', m.tbl, m.col) INTO v_cnt;
        IF v_cnt <> 0 THEN
          RAISE EXCEPTION 'RECON-LEGACY-COLUMNS-001: %.% has % non-NULL row(s); refusing to drop', m.tbl, m.col, v_cnt;
        END IF;
      ELSIF m.empt = 'jsonb_empty_array' THEN
        EXECUTE format('SELECT count(*) FROM public.%I', m.tbl) INTO v_rows;
        EXECUTE format(
          'SELECT count(*) FROM public.%I WHERE %I IS NOT NULL AND jsonb_typeof(%I) = ''array'' AND jsonb_array_length(%I) = 0',
          m.tbl, m.col, m.col, m.col) INTO v_cnt;
        IF v_cnt <> v_rows THEN
          RAISE EXCEPTION 'RECON-LEGACY-COLUMNS-001: %.% — only % of % rows are top-level empty JSON arrays (SQL NULL / JSON null / nonempty / object / scalar present); refusing to drop', m.tbl, m.col, v_cnt, v_rows;
        END IF;
      ELSE
        RAISE EXCEPTION 'RECON-LEGACY-COLUMNS-001: unknown emptiness rule %', m.empt;
      END IF;

      --------------------------------------------------------------
      -- Dependency inventory: nothing may reference the column except
      -- its own default object (whose deparsed form was pinned above).
      --------------------------------------------------------------
      SELECT count(*) INTO v_cnt FROM pg_depend d
       WHERE d.refclassid = 'pg_class'::regclass
         AND d.refobjid = ('public.' || m.tbl)::regclass
         AND d.refobjsubid = r.attnum
         AND NOT (d.classid = 'pg_attrdef'::regclass AND d.objid = COALESCE(r.def_oid, 0));
      IF v_cnt <> 0 THEN
        RAISE EXCEPTION 'RECON-LEGACY-COLUMNS-001: %.% has % catalog dependency(ies) beyond its own default', m.tbl, m.col, v_cnt;
      END IF;

      SELECT count(*) INTO v_cnt FROM pg_constraint c
       WHERE c.conrelid = ('public.' || m.tbl)::regclass AND r.attnum = ANY (c.conkey);
      IF v_cnt <> 0 THEN
        RAISE EXCEPTION 'RECON-LEGACY-COLUMNS-001: %.% appears in % constraint(s)', m.tbl, m.col, v_cnt;
      END IF;

      SELECT count(*) INTO v_cnt FROM pg_index i
       WHERE i.indrelid = ('public.' || m.tbl)::regclass
         AND (r.attnum = ANY (string_to_array(i.indkey::text, ' ')::int2[])
              OR pg_get_expr(i.indexprs, i.indrelid) ~* ('\y' || m.col || '\y')
              OR pg_get_expr(i.indpred,  i.indrelid) ~* ('\y' || m.col || '\y'));
      IF v_cnt <> 0 THEN
        RAISE EXCEPTION 'RECON-LEGACY-COLUMNS-001: %.% appears in % index(es)', m.tbl, m.col, v_cnt;
      END IF;

      SELECT count(*) INTO v_cnt FROM pg_statistic_ext s
       WHERE s.stxrelid = ('public.' || m.tbl)::regclass
         AND r.attnum = ANY (string_to_array(s.stxkeys::text, ' ')::int2[]);
      IF v_cnt <> 0 THEN
        RAISE EXCEPTION 'RECON-LEGACY-COLUMNS-001: %.% appears in % extended statistics object(s)', m.tbl, m.col, v_cnt;
      END IF;

      SELECT count(*) INTO v_cnt
        FROM pg_rewrite w
        JOIN pg_class c ON c.oid = w.ev_class
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
         AND pg_get_ruledef(w.oid) ~* ('\y' || m.col || '\y');
      IF v_cnt <> 0 THEN
        RAISE EXCEPTION 'RECON-LEGACY-COLUMNS-001: % view/rule definition(s) reference %.%', v_cnt, m.tbl, m.col;
      END IF;

      SELECT count(*) INTO v_cnt FROM pg_policy p
       WHERE pg_get_expr(p.polqual, p.polrelid)      ~* ('\y' || m.col || '\y')
          OR pg_get_expr(p.polwithcheck, p.polrelid) ~* ('\y' || m.col || '\y');
      IF v_cnt <> 0 THEN
        RAISE EXCEPTION 'RECON-LEGACY-COLUMNS-001: % RLS policy(ies) reference %.%', v_cnt, m.tbl, m.col;
      END IF;

      SELECT count(*) INTO v_cnt FROM pg_trigger tg
       WHERE NOT tg.tgisinternal AND pg_get_triggerdef(tg.oid) ~* ('\y' || m.col || '\y');
      IF v_cnt <> 0 THEN
        RAISE EXCEPTION 'RECON-LEGACY-COLUMNS-001: % trigger definition(s) reference %.%', v_cnt, m.tbl, m.col;
      END IF;

      -- Any *other* default or generation expression mentioning the column
      -- (the column's own default object is excluded by OID).
      SELECT count(*) INTO v_cnt FROM pg_attrdef ad
       WHERE ad.oid IS DISTINCT FROM r.def_oid
         AND pg_get_expr(ad.adbin, ad.adrelid) ~* ('\y' || m.col || '\y');
      IF v_cnt <> 0 THEN
        RAISE EXCEPTION 'RECON-LEGACY-COLUMNS-001: % other default/generation expression(s) reference %.%', v_cnt, m.tbl, m.col;
      END IF;

      -- Publication column lists must not pin the target column.
      SELECT count(*) INTO v_cnt FROM pg_publication_rel pr
       WHERE pr.prrelid = ('public.' || m.tbl)::regclass
         AND pr.prattrs IS NOT NULL
         AND r.attnum = ANY (string_to_array(pr.prattrs::text, ' ')::int2[]);
      IF v_cnt <> 0 THEN
        RAISE EXCEPTION 'RECON-LEGACY-COLUMNS-001: %.% is pinned in a publication column list', m.tbl, m.col;
      END IF;

      -- Whole-word scan of every non-catalog function/procedure source,
      -- argument list and result signature. PostgreSQL does not dependency-
      -- track string-body PL/pgSQL references, so pg_depend alone is not proof.
      SELECT count(*) INTO v_cnt
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
         AND (p.prosrc ~* ('\y' || m.col || '\y')
              OR pg_get_function_arguments(p.oid) ~* ('\y' || m.col || '\y')
              OR pg_get_function_result(p.oid)    ~* ('\y' || m.col || '\y'));
      IF v_cnt <> 0 THEN
        RAISE EXCEPTION 'RECON-LEGACY-COLUMNS-001: % function/procedure body or signature reference(s) to %.%', v_cnt, m.tbl, m.col;
      END IF;
    END LOOP;

    -- No function may return either table's row type (whole-row API contract).
    SELECT count(*) INTO v_cnt
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
       AND (p.prorettype IN (SELECT c.reltype FROM pg_class c
                              WHERE c.oid IN ('public.papers'::regclass, 'public.synonym_pool'::regclass))
            OR pg_get_function_result(p.oid) ~* '\y(papers|synonym_pool)\y');
    IF v_cnt <> 0 THEN
      RAISE EXCEPTION 'RECON-LEGACY-COLUMNS-001: % function(s) return a papers/synonym_pool row shape', v_cnt;
    END IF;

    ----------------------------------------------------------------
    -- End of pass 1: take the deterministic write-blocking locks and
    -- rerun everything. ACCESS EXCLUSIVE is the mode ALTER TABLE ...
    -- DROP COLUMN takes anyway; acquiring it directly avoids a lock-
    -- upgrade window between validation and DDL. (This does not make
    -- deadlocks with arbitrary concurrent transactions impossible.)
    ----------------------------------------------------------------
    IF v_pass = 1 THEN
      LOCK TABLE public.papers       IN ACCESS EXCLUSIVE MODE;
      LOCK TABLE public.synonym_pool IN ACCESS EXCLUSIVE MODE;
    END IF;
  END LOOP;

  ------------------------------------------------------------------
  -- Phase B — bounded restrictive DDL (S2 only)
  ------------------------------------------------------------------
  IF v_state = 'S2' THEN
    -- Aggregate fingerprints of ALL remaining row data, captured under lock
    -- immediately before the drops (deterministic PK order; hashes only).
    SELECT COALESCE(md5(string_agg(md5((to_jsonb(p.*) - 'urls')::text), '|' ORDER BY p.id)), 'empty')
      INTO v_fp_papers FROM public.papers p;
    SELECT COALESCE(md5(string_agg(md5((to_jsonb(s.*) - 'primary_term' - 'variants')::text), '|' ORDER BY s.id)), 'empty')
      INTO v_fp_synonym FROM public.synonym_pool s;

    ALTER TABLE public.papers
      DROP COLUMN urls;

    ALTER TABLE public.synonym_pool
      DROP COLUMN primary_term,
      DROP COLUMN variants;

    RAISE NOTICE 'RECON-LEGACY-COLUMNS-001: Phase B applied — 3 legacy columns dropped (state S2)';
  ELSE
    RAISE NOTICE 'RECON-LEGACY-COLUMNS-001: Phase B skipped — state S1, no DDL required';
  END IF;

  ------------------------------------------------------------------
  -- Phase C — exact canonical end state
  ------------------------------------------------------------------
  SELECT count(*) INTO v_cnt
    FROM jsonb_to_recordset(v_manifest) AS x(tbl text, col text)
    JOIN pg_attribute a
      ON a.attrelid = ('public.' || x.tbl)::regclass
     AND a.attname  = x.col AND a.attnum > 0 AND NOT a.attisdropped;
  IF v_cnt <> 0 THEN
    RAISE EXCEPTION 'RECON-LEGACY-COLUMNS-001: Phase C — % target column(s) still live', v_cnt;
  END IF;

  -- Exactly the expected live columns remain — proves no fourth column was
  -- removed and every non-target column survived (canonical parity is live
  -- schema; dropped-column tombstones/attnums are intentionally not compared).
  FOREACH t IN ARRAY v_tables LOOP
    SELECT jsonb_agg(a.attname ORDER BY a.attname) INTO v_inv_post
      FROM pg_attribute a
     WHERE a.attrelid = ('public.' || t)::regclass AND a.attnum > 0 AND NOT a.attisdropped;
    IF v_inv_post IS DISTINCT FROM v_live_pre -> t THEN
      RAISE EXCEPTION 'RECON-LEGACY-COLUMNS-001: Phase C — live column set of public.% deviates from the expected end state', t;
    END IF;
  END LOOP;

  -- Preservation: policies, constraints, indexes, triggers, RLS/owner/ACL and
  -- every remaining live-column definition are byte-identical to the pre-state.
  FOREACH t IN ARRAY v_tables LOOP
    SELECT jsonb_build_object(
      'rls', (SELECT c.relrowsecurity::text || '/' || c.relforcerowsecurity::text || '/' ||
                     pg_get_userbyid(c.relowner) || '/' || COALESCE(c.relacl::text, '-')
                FROM pg_class c WHERE c.oid = ('public.' || t)::regclass),
      'pol', (SELECT COALESCE(md5(string_agg(pol.polname || ':' || pol.polcmd::text || ':' ||
                     COALESCE(pg_get_expr(pol.polqual, pol.polrelid), '-') || ':' ||
                     COALESCE(pg_get_expr(pol.polwithcheck, pol.polrelid), '-'), '|' ORDER BY pol.polname)), 'none')
                FROM pg_policy pol WHERE pol.polrelid = ('public.' || t)::regclass),
      'con', (SELECT COALESCE(md5(string_agg(c.conname || ':' || pg_get_constraintdef(c.oid), '|' ORDER BY c.conname)), 'none')
                FROM pg_constraint c WHERE c.conrelid = ('public.' || t)::regclass),
      'idx', (SELECT COALESCE(md5(string_agg(indexname || ':' || indexdef, '|' ORDER BY indexname)), 'none')
                FROM pg_indexes WHERE schemaname = 'public' AND tablename = t),
      'trg', (SELECT COALESCE(md5(string_agg(tg.tgname || ':' || pg_get_triggerdef(tg.oid), '|' ORDER BY tg.tgname)), 'none')
                FROM pg_trigger tg WHERE tg.tgrelid = ('public.' || t)::regclass AND NOT tg.tgisinternal),
      'cols', (SELECT md5(string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' ||
                      a.attnotnull::text || ':' || COALESCE(pg_get_expr(ad.adbin, ad.adrelid), '-') || ':' ||
                      a.attgenerated::text || ':' || a.attidentity::text || ':' ||
                      a.attcollation::text || ':' || a.attstorage::text, '|' ORDER BY a.attname))
                 FROM pg_attribute a
                 LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
                WHERE a.attrelid = ('public.' || t)::regclass AND a.attnum > 0 AND NOT a.attisdropped)
    ) INTO v_inv_post;
    IF v_inv_post IS DISTINCT FROM v_inv_pre -> t THEN
      RAISE EXCEPTION 'RECON-LEGACY-COLUMNS-001: Phase C — preserved object inventory of public.% changed: % vs %', t, v_inv_pre -> t, v_inv_post;
    END IF;
  END LOOP;

  -- Function/procedure signatures and bodies unchanged.
  SELECT md5(string_agg(p.proname || ':' || pg_get_function_identity_arguments(p.oid) || ':' || md5(p.prosrc),
                        '|' ORDER BY p.proname, pg_get_function_identity_arguments(p.oid)))
    INTO v_funcs_post
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public';
  IF v_funcs_post IS DISTINCT FROM v_funcs_pre THEN
    RAISE EXCEPTION 'RECON-LEGACY-COLUMNS-001: Phase C — public function inventory changed';
  END IF;

  IF v_state = 'S2' THEN
    -- Row counts and complete remaining-row-data fingerprints unchanged.
    SELECT count(*) INTO v_cnt FROM public.papers;
    IF v_cnt <> v_rows_papers THEN
      RAISE EXCEPTION 'RECON-LEGACY-COLUMNS-001: Phase C — papers row count changed (% -> %)', v_rows_papers, v_cnt;
    END IF;
    SELECT count(*) INTO v_cnt FROM public.synonym_pool;
    IF v_cnt <> v_rows_synonym THEN
      RAISE EXCEPTION 'RECON-LEGACY-COLUMNS-001: Phase C — synonym_pool row count changed (% -> %)', v_rows_synonym, v_cnt;
    END IF;

    SELECT COALESCE(md5(string_agg(md5(to_jsonb(p.*)::text), '|' ORDER BY p.id)), 'empty') INTO v_funcs_post
      FROM public.papers p;
    IF v_funcs_post <> v_fp_papers THEN
      RAISE EXCEPTION 'RECON-LEGACY-COLUMNS-001: Phase C — papers remaining-data fingerprint changed';
    END IF;
    SELECT COALESCE(md5(string_agg(md5(to_jsonb(s.*)::text), '|' ORDER BY s.id)), 'empty') INTO v_funcs_post
      FROM public.synonym_pool s;
    IF v_funcs_post <> v_fp_synonym THEN
      RAISE EXCEPTION 'RECON-LEGACY-COLUMNS-001: Phase C — synonym_pool remaining-data fingerprint changed';
    END IF;
  END IF;

  RAISE NOTICE 'RECON-LEGACY-COLUMNS-001: Phase C passed — canonical end state verified (state %)', v_state;
END;
$recon$;
