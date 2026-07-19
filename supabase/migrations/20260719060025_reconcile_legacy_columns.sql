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
--        hard-coded below (type OID, typmod, attnum, nullability, default,
--        collation, storage, compression, statistics target, ACL, comment and
--        zero security labels), only canonical-empty values, and no dependency
--        other than each column's own default object → lock, recheck, drop.
--
-- Hardened (RECON-LEGACY-COLUMNS-001A) to close whole-row, publication and
-- exact-metadata gaps:
--   * exact attnum / type OID / typmod / security-label guards per target;
--   * exact approved routine inventory (behavioral fingerprint identical across
--     environments; owner/ACL fingerprint pinned per state) so a new, removed or
--     changed routine aborts rather than being silently accepted;
--   * whole-row routine idioms (%ROWTYPE, SELECT *, to_jsonb/row_to_json/agg of a
--     whole row, row-type results) and whole-row views/rules/composite-type
--     consumers are rejected — a function can consume the full row without ever
--     naming a target column;
--   * strict publication guard (no FOR ALL TABLES, neither table a member, no
--     column list pins a target);
--   * expanded preservation inventory (extended statistics, publications,
--     security labels, comments, and every remaining column's full definition)
--     proven byte-identical in Phase C.
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
  -- att  = exact live attnum. toid = exact pg_type OID. tmod = exact atttypmod.
  -- def is the deparsed pg_get_expr() form of the column's own default, or NULL
  -- for "must have no default". coll: 'none' = attcollation 0, 'db_default' =
  -- the database default collation. empt: approved emptiness rule.
  v_manifest CONSTANT jsonb := jsonb_build_array(
    jsonb_build_object('tbl','papers',       'col','urls',         'att',11, 'typ','jsonb', 'toid',3802, 'tmod',-1, 'def','''[]''::jsonb', 'coll','none',       'empt','jsonb_empty_array'),
    jsonb_build_object('tbl','synonym_pool', 'col','primary_term', 'att',2,  'typ','text',  'toid',25,   'tmod',-1, 'def',NULL,            'coll','db_default', 'empt','all_sql_null'),
    jsonb_build_object('tbl','synonym_pool', 'col','variants',     'att',3,  'typ','jsonb', 'toid',3802, 'tmod',-1, 'def','''[]''::jsonb', 'coll','none',       'empt','jsonb_empty_array')
  );
  v_tables CONSTANT text[] := ARRAY['papers','synonym_pool'];  -- deterministic lock order

  -- Exact approved public routine inventory (23 routines). The behavioral
  -- fingerprint (schema, name, identity args, result, kind, language, security
  -- definer, volatility, strictness, leakproof, parallel, config, body md5) is
  -- byte-identical between the linked project and a clean local replay, so it is
  -- required in every state. Owner/ACL differ by environment, so the full
  -- fingerprint is pinned per state. Any drift aborts the migration.
  v_routines_count   CONSTANT int  := 23;
  v_routines_noacl   CONSTANT text := 'c0c14ef5f3e85c33a5eebec8402fc0db';
  v_routines_full_s1 CONSTANT text := '1f65886109bf875238c517d764af4c5f';  -- clean local replay
  v_routines_full_s2 CONSTANT text := 'c0b444c8102b5e3b0fc241ba7b53dde9';  -- audited production

  m            record;
  t            text;
  v_state      text;
  v_pass       int;
  v_present    int;
  v_cnt        bigint;
  v_rows       bigint;
  v_expect_coll oid;
  r            record;
  v_rt_count   int;
  v_rt_full    text;
  v_rt_noacl   text;

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
    -- Exact approved routine inventory (whole-row API-shape gate).
    -- Runs in EVERY state: a new/removed/changed routine — including one
    -- that consumes a full table row without naming a target column —
    -- aborts before any DDL, in both S1 and S2, pre-lock and under lock.
    ----------------------------------------------------------------
    SELECT count(*),
           md5(string_agg(
             n.nspname||'|'||p.proname||'|'||pg_get_function_identity_arguments(p.oid)||'|'||
             pg_get_function_result(p.oid)||'|'||p.prokind::text||'|'||l.lanname||'|'||
             p.prosecdef::text||'|'||p.provolatile::text||'|'||p.proisstrict::text||'|'||
             p.proleakproof::text||'|'||p.proparallel::text||'|'||
             COALESCE(array_to_string(p.proconfig,','),'-')||'|'||
             pg_get_userbyid(p.proowner)||'|'||COALESCE(p.proacl::text,'-')||'|'||md5(p.prosrc),
             chr(10) ORDER BY p.proname, pg_get_function_identity_arguments(p.oid))),
           md5(string_agg(
             n.nspname||'|'||p.proname||'|'||pg_get_function_identity_arguments(p.oid)||'|'||
             pg_get_function_result(p.oid)||'|'||p.prokind::text||'|'||l.lanname||'|'||
             p.prosecdef::text||'|'||p.provolatile::text||'|'||p.proisstrict::text||'|'||
             p.proleakproof::text||'|'||p.proparallel::text||'|'||
             COALESCE(array_to_string(p.proconfig,','),'-')||'|'||md5(p.prosrc),
             chr(10) ORDER BY p.proname, pg_get_function_identity_arguments(p.oid)))
      INTO v_rt_count, v_rt_full, v_rt_noacl
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_language  l ON l.oid = p.prolang
     WHERE n.nspname = 'public';

    IF v_rt_count <> v_routines_count THEN
      RAISE EXCEPTION 'RECON-LEGACY-COLUMNS-001: public routine count is % (expected %) — inventory drift', v_rt_count, v_routines_count;
    END IF;
    -- Behavioral fingerprint is byte-identical across environments: any added,
    -- removed or changed routine (body/signature/behavior) aborts everywhere.
    IF v_rt_noacl <> v_routines_noacl THEN
      RAISE EXCEPTION 'RECON-LEGACY-COLUMNS-001: public routine behavioral inventory drift (a routine was added, removed or changed)';
    END IF;
    -- Owner/ACL is environment-determined (the clean-replay baseline uses local
    -- roles; production uses its own). Both are audited; the live inventory must
    -- match one of them exactly. A tampered owner/ACL matches neither and aborts.
    IF v_rt_full <> v_routines_full_s1 AND v_rt_full <> v_routines_full_s2 THEN
      RAISE EXCEPTION 'RECON-LEGACY-COLUMNS-001: public routine owner/ACL inventory matches neither the audited clean-replay nor the production baseline';
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
        'xstat', (SELECT COALESCE(md5(string_agg(s.stxname || ':' || pg_get_statisticsobjdef(s.oid), '|' ORDER BY s.stxname)), 'none')
                  FROM pg_statistic_ext s WHERE s.stxrelid = ('public.' || t)::regclass),
        'pub', (SELECT COALESCE(md5(string_agg(z.pubname || ':' || z.attrs, '|' ORDER BY z.pubname, z.attrs)), 'none') FROM (
                  SELECT pub.pubname AS pubname, COALESCE(pr.prattrs::text, 'ALL') AS attrs
                    FROM pg_publication_rel pr JOIN pg_publication pub ON pub.oid = pr.prpubid
                   WHERE pr.prrelid = ('public.' || t)::regclass
                  UNION ALL
                  SELECT pub.pubname, 'FOR_ALL_TABLES' FROM pg_publication pub WHERE pub.puballtables
                ) z),
        'seclab', (SELECT COALESCE(md5(string_agg(sl.provider || ':' || sl.objsubid::text || ':' || sl.label, '|' ORDER BY sl.provider, sl.objsubid)), 'none')
                  FROM pg_seclabel sl WHERE sl.classoid = 'pg_class'::regclass AND sl.objoid = ('public.' || t)::regclass),
        'comment', (SELECT COALESCE(obj_description(('public.' || t)::regclass, 'pg_class'), '-')),
        'cols', (SELECT md5(string_agg(a.attname || ':' || a.atttypid::text || ':' || format_type(a.atttypid, a.atttypmod) || ':' ||
                        a.attnotnull::text || ':' || COALESCE(pg_get_expr(ad.adbin, ad.adrelid), '-') || ':' ||
                        a.attgenerated::text || ':' || a.attidentity::text || ':' ||
                        a.attcollation::text || ':' || a.attstorage::text || ':' || COALESCE(a.attcompression::text, '') || ':' ||
                        COALESCE(a.attstattarget::text, '-') || ':' || COALESCE(a.attacl::text, '-') || ':' ||
                        COALESCE(col_description(a.attrelid, a.attnum), '-') || ':' ||
                        (SELECT COALESCE(md5(string_agg(sl.provider || '=' || sl.label, ',' ORDER BY sl.provider)), '-')
                           FROM pg_seclabel sl WHERE sl.classoid = 'pg_class'::regclass
                            AND sl.objoid = a.attrelid AND sl.objsubid = a.attnum), '|' ORDER BY a.attname))
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
             AS x(tbl text, col text, att int, typ text, toid oid, tmod int, def text, coll text, empt text) LOOP

      SELECT a.attnum, a.atttypid, a.atttypmod, format_type(a.atttypid, a.atttypmod) AS ftype,
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

      -- Exact live attnum.
      IF r.attnum <> m.att THEN
        RAISE EXCEPTION 'RECON-LEGACY-COLUMNS-001: %.% is at attnum % (expected %)', m.tbl, m.col, r.attnum, m.att;
      END IF;
      -- Exact type OID and typmod, in addition to the rendered type.
      IF r.atttypid <> m.toid THEN
        RAISE EXCEPTION 'RECON-LEGACY-COLUMNS-001: %.% has type OID % (expected %)', m.tbl, m.col, r.atttypid, m.toid;
      END IF;
      IF r.atttypmod <> m.tmod THEN
        RAISE EXCEPTION 'RECON-LEGACY-COLUMNS-001: %.% has typmod % (expected %)', m.tbl, m.col, r.atttypmod, m.tmod;
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

      -- Security labels (all providers). The audited S2 state has none.
      SELECT count(*) INTO v_cnt FROM pg_seclabel sl
       WHERE sl.classoid = 'pg_class'::regclass
         AND sl.objoid = ('public.' || m.tbl)::regclass
         AND sl.objsubid = r.attnum;
      IF v_cnt <> 0 THEN
        RAISE EXCEPTION 'RECON-LEGACY-COLUMNS-001: %.% carries % security label(s)', m.tbl, m.col, v_cnt;
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

    ----------------------------------------------------------------
    -- S2 table-level whole-row and publication guards (once per pass)
    ----------------------------------------------------------------

    -- (1) Strict publication state: no FOR ALL TABLES publication anywhere,
    -- and neither target table is a member of any publication (with or
    -- without a column list). A whole-table publication would stream the
    -- row shape downstream and must block the drop.
    SELECT count(*) INTO v_cnt FROM pg_publication WHERE puballtables;
    IF v_cnt <> 0 THEN
      RAISE EXCEPTION 'RECON-LEGACY-COLUMNS-001: % FOR ALL TABLES publication(s) exist; refusing to drop', v_cnt;
    END IF;
    FOREACH t IN ARRAY v_tables LOOP
      SELECT count(*) INTO v_cnt FROM pg_publication_rel pr
       WHERE pr.prrelid = ('public.' || t)::regclass;
      IF v_cnt <> 0 THEN
        RAISE EXCEPTION 'RECON-LEGACY-COLUMNS-001: public.% is a member of % publication(s); refusing to drop', t, v_cnt;
      END IF;
    END LOOP;

    -- (2) Whole-row routine consumers: a function/procedure that references a
    -- target table and uses a whole-row idiom (%ROWTYPE, SELECT *, to_jsonb/
    -- row_to_json/json(b)_agg of a whole-row variable, or a row-type result)
    -- consumes every column — including the ones being dropped — without
    -- naming them. Scoped to routines that mention a target table.
    SELECT count(*) INTO v_cnt
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
       AND (p.prosrc ~* '\y(papers|synonym_pool)\y'
            OR pg_get_function_arguments(p.oid) ~* '\y(papers|synonym_pool)\y'
            OR pg_get_function_result(p.oid)    ~* '\y(papers|synonym_pool)\y')
       AND (p.prosrc ~* '(papers|synonym_pool)[[:space:]]*%[[:space:]]*rowtype'
            OR p.prosrc ~* 'select[[:space:]]+\*[[:space:]]+from[[:space:]]+(public\.)?(papers|synonym_pool)\y'
            OR p.prosrc ~* '(to_jsonb|to_json|row_to_json|json_agg|jsonb_agg)[[:space:]]*\([[:space:]]*[a-z_][a-z0-9_]*[[:space:]]*\)'
            OR pg_get_function_result(p.oid) ~* '\y(setof[[:space:]]+)?(public\.)?(papers|synonym_pool)\y');
    IF v_cnt <> 0 THEN
      RAISE EXCEPTION 'RECON-LEGACY-COLUMNS-001: % routine(s) consume a papers/synonym_pool whole row (whole-row-contract drift)', v_cnt;
    END IF;

    -- (3) Whole-row views / materialized views / rules: a SELECT * or a
    -- whole-row projection of a target table depends on the full row shape.
    SELECT count(*) INTO v_cnt
      FROM pg_rewrite w
      JOIN pg_class c ON c.oid = w.ev_class
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
       AND c.relkind IN ('v', 'm')
       AND pg_get_ruledef(w.oid) ~* 'select[[:space:]]+\*[[:space:]]+from[[:space:]]+(public\.)?(papers|synonym_pool)\y';
    IF v_cnt <> 0 THEN
      RAISE EXCEPTION 'RECON-LEGACY-COLUMNS-001: % view/matview(s) select the whole papers/synonym_pool row', v_cnt;
    END IF;

    -- (4) Composite row-type consumers: anything that references either table's
    -- composite row type (a column, parameter or object typed `papers`/
    -- `synonym_pool`) depends on the row shape. Internal/automatic dependencies
    -- (the tables' own array types) are deptype 'i'/'a' and excluded.
    SELECT count(*) INTO v_cnt FROM pg_depend d
     WHERE d.refclassid = 'pg_type'::regclass
       AND d.refobjid IN (SELECT c.reltype FROM pg_class c
                          WHERE c.oid IN ('public.papers'::regclass, 'public.synonym_pool'::regclass))
       AND d.deptype = 'n';
    IF v_cnt <> 0 THEN
      RAISE EXCEPTION 'RECON-LEGACY-COLUMNS-001: % object(s) depend on the papers/synonym_pool composite row type', v_cnt;
    END IF;

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

  -- Preservation: policies, constraints, indexes, triggers, extended statistics,
  -- publications, security labels, comments, RLS/owner/ACL and every remaining
  -- live-column definition are byte-identical to the pre-state. (Identical
  -- expression to the Phase A capture above.)
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
      'xstat', (SELECT COALESCE(md5(string_agg(s.stxname || ':' || pg_get_statisticsobjdef(s.oid), '|' ORDER BY s.stxname)), 'none')
                FROM pg_statistic_ext s WHERE s.stxrelid = ('public.' || t)::regclass),
      'pub', (SELECT COALESCE(md5(string_agg(z.pubname || ':' || z.attrs, '|' ORDER BY z.pubname, z.attrs)), 'none') FROM (
                SELECT pub.pubname AS pubname, COALESCE(pr.prattrs::text, 'ALL') AS attrs
                  FROM pg_publication_rel pr JOIN pg_publication pub ON pub.oid = pr.prpubid
                 WHERE pr.prrelid = ('public.' || t)::regclass
                UNION ALL
                SELECT pub.pubname, 'FOR_ALL_TABLES' FROM pg_publication pub WHERE pub.puballtables
              ) z),
      'seclab', (SELECT COALESCE(md5(string_agg(sl.provider || ':' || sl.objsubid::text || ':' || sl.label, '|' ORDER BY sl.provider, sl.objsubid)), 'none')
                FROM pg_seclabel sl WHERE sl.classoid = 'pg_class'::regclass AND sl.objoid = ('public.' || t)::regclass),
      'comment', (SELECT COALESCE(obj_description(('public.' || t)::regclass, 'pg_class'), '-')),
      'cols', (SELECT md5(string_agg(a.attname || ':' || a.atttypid::text || ':' || format_type(a.atttypid, a.atttypmod) || ':' ||
                      a.attnotnull::text || ':' || COALESCE(pg_get_expr(ad.adbin, ad.adrelid), '-') || ':' ||
                      a.attgenerated::text || ':' || a.attidentity::text || ':' ||
                      a.attcollation::text || ':' || a.attstorage::text || ':' || COALESCE(a.attcompression::text, '') || ':' ||
                      COALESCE(a.attstattarget::text, '-') || ':' || COALESCE(a.attacl::text, '-') || ':' ||
                      COALESCE(col_description(a.attrelid, a.attnum), '-') || ':' ||
                      (SELECT COALESCE(md5(string_agg(sl.provider || '=' || sl.label, ',' ORDER BY sl.provider)), '-')
                         FROM pg_seclabel sl WHERE sl.classoid = 'pg_class'::regclass
                          AND sl.objoid = a.attrelid AND sl.objsubid = a.attnum), '|' ORDER BY a.attname))
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
