-- RECON-INTEGRITY-001 — enforce C23 ownership and pool integrity (amended C23).
--
-- Converges the twelve C23 targets — user_id on the eight owner-scoped tables
-- (papers, projects, tags, keyword_pool, keyword_exclusion_pool, study_type_pool,
-- study_type_exclusion_pool, synonym_pool), synonym_pool.canonical_term,
-- synonym_pool.synonyms, study_type_pool.hierarchy_rank and
-- study_type_pool.specificity_weight — to NOT NULL, and (amended C23) restores the
-- canonical DEFAULT '{}'::text[] on synonym_pool.synonyms, which production lacks.
--
-- Exactly two supported global starting states:
--   S1 (clean replay):        all twelve targets already NOT NULL and
--                             synonym_pool.synonyms already has DEFAULT '{}'::text[]
--                             → validate the complete manifest, perform no DDL.
--   S2 (audited production):  all twelve targets nullable, zero NULL values in all
--                             twelve, and synonym_pool.synonyms has NO default
--                             → under deterministic ACCESS EXCLUSIVE locks, recheck
--                             zero-null, then SET DEFAULT '{}'::text[] on
--                             synonym_pool.synonyms and SET NOT NULL on exactly the
--                             twelve manifest columns.
-- Any other state (mixed nullability, a NULL value in any target, an unexpected
-- default — including "all NOT NULL but synonyms has no default" and "all nullable
-- but synonyms already has a default" — a missing/renamed/wrong-type/generated/
-- identity target) fails in Phase A before any DDL.
--
-- The migration never runs UPDATE / INSERT / DELETE / TRUNCATE, never uses CASCADE,
-- never backfills or invents data, and changes no default other than the one
-- approved synonym_pool.synonyms default.
--
-- Lock mode and rationale: ALTER TABLE ... SET NOT NULL requires ACCESS EXCLUSIVE.
-- Phase B therefore acquires ACCESS EXCLUSIVE directly, once per table, in one
-- deterministic alphabetical order. Acquiring a weaker write-blocking lock (e.g.
-- SHARE) first and upgrading later would create a lock-upgrade deadlock window;
-- taking the final mode up front in a single global order prevents both deadlocks
-- and any concurrent INSERT/UPDATE from introducing a NULL between the under-lock
-- zero-null recheck and the SET NOT NULL DDL. The locks are held only for catalog
-- reads, aggregate counts and the bounded DDL. S1 acquires no locks: it performs no
-- mutation and the already-present constraints enforce the invariant.

DO $recon$
DECLARE
  -- Single manifest: schema is always public; per target we record the expected
  -- type, the state-specific expected default (deparsed form, JSON null = no
  -- default), and the canonical final default. For eleven targets S1/S2/final
  -- defaults are identical; synonym_pool.synonyms differs (S2 has no default).
  v_manifest CONSTANT jsonb := '[
    {"tbl":"papers",                    "col":"user_id",            "typ":"uuid",    "s1_def":null,             "s2_def":null,  "fin_def":null},
    {"tbl":"projects",                  "col":"user_id",            "typ":"uuid",    "s1_def":null,             "s2_def":null,  "fin_def":null},
    {"tbl":"tags",                      "col":"user_id",            "typ":"uuid",    "s1_def":null,             "s2_def":null,  "fin_def":null},
    {"tbl":"keyword_pool",              "col":"user_id",            "typ":"uuid",    "s1_def":null,             "s2_def":null,  "fin_def":null},
    {"tbl":"keyword_exclusion_pool",    "col":"user_id",            "typ":"uuid",    "s1_def":null,             "s2_def":null,  "fin_def":null},
    {"tbl":"study_type_pool",           "col":"user_id",            "typ":"uuid",    "s1_def":null,             "s2_def":null,  "fin_def":null},
    {"tbl":"study_type_exclusion_pool", "col":"user_id",            "typ":"uuid",    "s1_def":null,             "s2_def":null,  "fin_def":null},
    {"tbl":"synonym_pool",              "col":"user_id",            "typ":"uuid",    "s1_def":null,             "s2_def":null,  "fin_def":null},
    {"tbl":"synonym_pool",              "col":"canonical_term",     "typ":"text",    "s1_def":null,             "s2_def":null,  "fin_def":null},
    {"tbl":"synonym_pool",              "col":"synonyms",           "typ":"text[]",  "s1_def":"''{}''::text[]", "s2_def":null,  "fin_def":"''{}''::text[]"},
    {"tbl":"study_type_pool",           "col":"hierarchy_rank",     "typ":"integer", "s1_def":"99",             "s2_def":"99",  "fin_def":"99"},
    {"tbl":"study_type_pool",           "col":"specificity_weight", "typ":"integer", "s1_def":"1",              "s2_def":"1",   "fin_def":"1"}
  ]'::jsonb;

  v_tables    text[];
  v_state     text;
  v_cnt_all   int;
  v_cnt_dist  int;
  v_cnt_tbl   int;
  v_notnull   int;
  r           record;
  t           text;
  v_relkind   char;
  v_oid       oid;
  v_nulls     bigint;
  v_rows      bigint;
  -- Phase A captures for Phase C reconciliation
  v_obs       jsonb := '[]'::jsonb;  -- per-target observed metadata
  v_rowcounts jsonb := '{}'::jsonb;  -- per-table row-count baseline
  v_inv       jsonb := '{}'::jsonb;  -- per-table object/metadata inventory
  v_chk       jsonb;
  o           record;
BEGIN
  ---------------------------------------------------------------------------
  -- Manifest self-checks
  ---------------------------------------------------------------------------
  SELECT count(*),
         count(DISTINCT (m->>'tbl') || '.' || (m->>'col')),
         count(DISTINCT m->>'tbl')
    INTO v_cnt_all, v_cnt_dist, v_cnt_tbl
    FROM jsonb_array_elements(v_manifest) AS m;
  IF v_cnt_all <> 12 OR v_cnt_dist <> 12 OR v_cnt_tbl <> 8 THEN
    RAISE EXCEPTION 'RECON-INTEGRITY-001: manifest self-check failed (targets=%, distinct=%, tables=%; expected 12/12/8)',
      v_cnt_all, v_cnt_dist, v_cnt_tbl;
  END IF;

  -- Deterministic (alphabetical) table order, used for locking and iteration.
  SELECT array_agg(x ORDER BY x)
    INTO v_tables
    FROM (SELECT DISTINCT m->>'tbl' AS x FROM jsonb_array_elements(v_manifest) AS m) s;

  ---------------------------------------------------------------------------
  -- Phase A — complete classification and validation. No DDL, no locks, no
  -- data mutation of any kind.
  ---------------------------------------------------------------------------
  -- A.1 Every relation exists in public and is an ordinary table.
  FOREACH t IN ARRAY v_tables LOOP
    SELECT c.oid, c.relkind INTO v_oid, v_relkind
      FROM pg_catalog.pg_class c
     WHERE c.relnamespace = 'public'::regnamespace AND c.relname = t;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'RECON-INTEGRITY-001: Phase A — table public.% does not exist', t;
    END IF;
    IF v_relkind <> 'r' THEN
      RAISE EXCEPTION 'RECON-INTEGRITY-001: Phase A — public.% is not an ordinary table (relkind=%)', t, v_relkind;
    END IF;
  END LOOP;

  -- A.2 Every target column exists, is live, has the exact expected type, and is
  --     a plain (non-generated, non-identity) column. Capture observed metadata.
  FOR r IN
    SELECT (m->>'tbl') AS tbl, (m->>'col') AS col, (m->>'typ') AS typ,
           (m->>'s1_def') AS s1_def, (m->>'s2_def') AS s2_def, (m->>'fin_def') AS fin_def
      FROM jsonb_array_elements(v_manifest) AS m
     ORDER BY m->>'tbl', m->>'col'
  LOOP
    SELECT a.attnum,
           format_type(a.atttypid, a.atttypmod) AS col_type,
           a.attnotnull, a.attgenerated, a.attidentity,
           pg_get_expr(d.adbin, d.adrelid) AS def
      INTO o
      FROM pg_catalog.pg_attribute a
      JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
      LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE c.relnamespace = 'public'::regnamespace AND c.relname = r.tbl
       AND a.attname = r.col AND a.attnum > 0 AND NOT a.attisdropped;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'RECON-INTEGRITY-001: Phase A — column public.%.% does not exist or is dropped', r.tbl, r.col;
    END IF;
    IF o.col_type <> r.typ THEN
      RAISE EXCEPTION 'RECON-INTEGRITY-001: Phase A — public.%.% has type % (expected %)', r.tbl, r.col, o.col_type, r.typ;
    END IF;
    IF o.attgenerated <> '' THEN
      RAISE EXCEPTION 'RECON-INTEGRITY-001: Phase A — public.%.% is a generated column (unsupported)', r.tbl, r.col;
    END IF;
    IF o.attidentity <> '' THEN
      RAISE EXCEPTION 'RECON-INTEGRITY-001: Phase A — public.%.% is an identity column (unsupported)', r.tbl, r.col;
    END IF;
    v_obs := v_obs || jsonb_build_array(jsonb_build_object(
      'tbl', r.tbl, 'col', r.col,
      'attnum', o.attnum, 'notnull', o.attnotnull, 'def', o.def,
      's1_def', r.s1_def, 's2_def', r.s2_def, 'fin_def', r.fin_def, 'typ', r.typ));
  END LOOP;

  -- A.3 Global nullability classification: exactly S1 (12 NOT NULL) or S2 (0).
  SELECT count(*) FILTER (WHERE (e->>'notnull')::boolean)
    INTO v_notnull
    FROM jsonb_array_elements(v_obs) AS e;
  IF v_notnull = 12 THEN
    v_state := 'S1';
  ELSIF v_notnull = 0 THEN
    v_state := 'S2';
  ELSE
    RAISE EXCEPTION 'RECON-INTEGRITY-001: Phase A — mixed nullability state (% of 12 targets NOT NULL); only exact S1 (12) or exact S2 (0) is supported. Aborting before any change.', v_notnull;
  END IF;

  -- A.4 State-specific default validation. This rejects the unsupported states
  --     "all NOT NULL but synonyms has no default" (classified S1, default check
  --     fails) and "all nullable but synonyms already carries a default"
  --     (classified S2, default check fails), plus any unexpected default on any
  --     other target in either state.
  FOR o IN SELECT * FROM jsonb_to_recordset(v_obs)
             AS x(tbl text, col text, def text, s1_def text, s2_def text)
  LOOP
    IF v_state = 'S1' THEN
      IF o.def IS DISTINCT FROM o.s1_def THEN
        RAISE EXCEPTION 'RECON-INTEGRITY-001: Phase A — public.%.% default is "%" but state S1 expects "%"',
          o.tbl, o.col, coalesce(o.def, '<none>'), coalesce(o.s1_def, '<none>');
      END IF;
    ELSE
      IF o.def IS DISTINCT FROM o.s2_def THEN
        RAISE EXCEPTION 'RECON-INTEGRITY-001: Phase A — public.%.% default is "%" but state S2 expects "%"',
          o.tbl, o.col, coalesce(o.def, '<none>'), coalesce(o.s2_def, '<none>');
      END IF;
    END IF;
  END LOOP;

  -- A.5 Zero-null gate on every target. Never backfilled; any NULL aborts here.
  FOR o IN SELECT * FROM jsonb_to_recordset(v_obs) AS x(tbl text, col text) LOOP
    EXECUTE format('SELECT count(*) FROM public.%I WHERE %I IS NULL', o.tbl, o.col) INTO v_nulls;
    IF v_nulls <> 0 THEN
      RAISE EXCEPTION 'RECON-INTEGRITY-001: Phase A — public.%.% contains % NULL value(s); this migration never backfills. Aborting before any change.', o.tbl, o.col, v_nulls;
    END IF;
  END LOOP;

  -- A.6 Row-count baseline (re-captured under lock in S2, where it is authoritative).
  FOREACH t IN ARRAY v_tables LOOP
    EXECUTE format('SELECT count(*) FROM public.%I', t) INTO v_rows;
    v_rowcounts := v_rowcounts || jsonb_build_object(t, v_rows);
  END LOOP;

  -- A.7 Preservation inventory per table: RLS/FORCE, owner, ACL, and md5
  --     fingerprints of policies, constraints (incl. FKs), indexes, non-internal
  --     triggers, and of every NON-target column's (name, nullability, type,
  --     default) — proving in Phase C that exactly the twelve targets (plus the
  --     one approved default) were affected and nothing else.
  FOREACH t IN ARRAY v_tables LOOP
    SELECT jsonb_build_object(
      'rls',    c.relrowsecurity,
      'force',  c.relforcerowsecurity,
      'owner',  pg_get_userbyid(c.relowner),
      'acl',    coalesce(c.relacl::text, '<default>'),
      'policies', (SELECT coalesce(md5(string_agg(p.polname || '|' || p.polcmd::text || '|'
                          || coalesce(pg_get_expr(p.polqual, p.polrelid), '') || '|'
                          || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') || '|'
                          || p.polroles::text || '|' || p.polpermissive::text, '||' ORDER BY p.polname)), 'none')
                     FROM pg_catalog.pg_policy p WHERE p.polrelid = c.oid),
      'constraints', (SELECT coalesce(md5(string_agg(cn.conname || '|' || pg_get_constraintdef(cn.oid), '||' ORDER BY cn.conname)), 'none')
                     FROM pg_catalog.pg_constraint cn WHERE cn.conrelid = c.oid),
      'indexes', (SELECT coalesce(md5(string_agg(i.indexname || '|' || i.indexdef, '||' ORDER BY i.indexname)), 'none')
                     FROM pg_catalog.pg_indexes i WHERE i.schemaname = 'public' AND i.tablename = c.relname),
      'triggers', (SELECT coalesce(md5(string_agg(tg.tgname || '|' || pg_get_triggerdef(tg.oid), '||' ORDER BY tg.tgname)), 'none')
                     FROM pg_catalog.pg_trigger tg WHERE tg.tgrelid = c.oid AND NOT tg.tgisinternal),
      'nontarget', (SELECT coalesce(md5(string_agg(a.attname || '|' || a.attnotnull::text || '|'
                          || format_type(a.atttypid, a.atttypmod) || '|'
                          || coalesce(pg_get_expr(d.adbin, d.adrelid), ''), '||' ORDER BY a.attnum)), 'none')
                     FROM pg_catalog.pg_attribute a
                     LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                    WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
                      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_manifest) mm
                                       WHERE mm->>'tbl' = c.relname AND mm->>'col' = a.attname)))
      INTO v_chk
      FROM pg_catalog.pg_class c
     WHERE c.relnamespace = 'public'::regnamespace AND c.relname = t;
    v_inv := v_inv || jsonb_build_object(t, v_chk);
  END LOOP;

  RAISE NOTICE 'RECON-INTEGRITY-001: Phase A passed — global state % (12/12 targets validated, zero NULLs)', v_state;

  ---------------------------------------------------------------------------
  -- Phase B — deterministic locking, under-lock recheck, bounded DDL (S2 only).
  ---------------------------------------------------------------------------
  IF v_state = 'S2' THEN
    -- B.1 Deterministic alphabetical ACCESS EXCLUSIVE lock acquisition (see the
    --     header comment for the mode rationale).
    FOREACH t IN ARRAY v_tables LOOP
      EXECUTE format('LOCK TABLE public.%I IN ACCESS EXCLUSIVE MODE', t);
    END LOOP;

    -- B.2 Under-lock recheck: nullability, the state-critical synonyms default,
    --     and all twelve zero-null gates. Aborts if anything changed between
    --     Phase A and lock acquisition.
    FOR o IN SELECT * FROM jsonb_to_recordset(v_obs) AS x(tbl text, col text, s2_def text) LOOP
      SELECT a.attnotnull, pg_get_expr(d.adbin, d.adrelid) AS def
        INTO r
        FROM pg_catalog.pg_attribute a
        JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
        LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE c.relnamespace = 'public'::regnamespace AND c.relname = o.tbl
         AND a.attname = o.col AND a.attnum > 0 AND NOT a.attisdropped;
      IF NOT FOUND OR r.attnotnull OR r.def IS DISTINCT FROM o.s2_def THEN
        RAISE EXCEPTION 'RECON-INTEGRITY-001: under-lock recheck — public.%.% changed between Phase A and lock acquisition. Aborting before DDL.', o.tbl, o.col;
      END IF;
      EXECUTE format('SELECT count(*) FROM public.%I WHERE %I IS NULL', o.tbl, o.col) INTO v_nulls;
      IF v_nulls <> 0 THEN
        RAISE EXCEPTION 'RECON-INTEGRITY-001: under-lock recheck — public.%.% now contains % NULL value(s). Aborting before DDL.', o.tbl, o.col, v_nulls;
      END IF;
    END LOOP;

    -- B.3 Authoritative row-count baseline under lock (no writer can change it now).
    FOREACH t IN ARRAY v_tables LOOP
      EXECUTE format('SELECT count(*) FROM public.%I', t) INTO v_rows;
      v_rowcounts := v_rowcounts || jsonb_build_object(t, v_rows);
    END LOOP;

    -- B.4 Bounded DDL: the one approved default plus exactly twelve SET NOT NULL,
    --     grouped per table, schema-qualified, no CASCADE, no DML.
    EXECUTE 'ALTER TABLE public.synonym_pool
               ALTER COLUMN synonyms SET DEFAULT ''{}''::text[],
               ALTER COLUMN synonyms SET NOT NULL,
               ALTER COLUMN canonical_term SET NOT NULL,
               ALTER COLUMN user_id SET NOT NULL';
    EXECUTE 'ALTER TABLE public.study_type_pool
               ALTER COLUMN hierarchy_rank SET NOT NULL,
               ALTER COLUMN specificity_weight SET NOT NULL,
               ALTER COLUMN user_id SET NOT NULL';
    EXECUTE 'ALTER TABLE public.papers ALTER COLUMN user_id SET NOT NULL';
    EXECUTE 'ALTER TABLE public.projects ALTER COLUMN user_id SET NOT NULL';
    EXECUTE 'ALTER TABLE public.tags ALTER COLUMN user_id SET NOT NULL';
    EXECUTE 'ALTER TABLE public.keyword_pool ALTER COLUMN user_id SET NOT NULL';
    EXECUTE 'ALTER TABLE public.keyword_exclusion_pool ALTER COLUMN user_id SET NOT NULL';
    EXECUTE 'ALTER TABLE public.study_type_exclusion_pool ALTER COLUMN user_id SET NOT NULL';

    RAISE NOTICE 'RECON-INTEGRITY-001: Phase B applied — 1 default set, 12 columns set NOT NULL';
  ELSE
    RAISE NOTICE 'RECON-INTEGRITY-001: Phase B skipped — state S1 is already canonical (structural no-op)';
  END IF;

  ---------------------------------------------------------------------------
  -- Phase C — exact end-state verification (both states). Any failure aborts
  -- the whole transaction, leaving zero persistent mutation.
  ---------------------------------------------------------------------------
  FOR o IN SELECT * FROM jsonb_to_recordset(v_obs)
             AS x(tbl text, col text, attnum int, typ text, fin_def text)
  LOOP
    SELECT a.attnum, format_type(a.atttypid, a.atttypmod) AS col_type,
           a.attnotnull, a.attgenerated, a.attidentity,
           pg_get_expr(d.adbin, d.adrelid) AS def
      INTO r
      FROM pg_catalog.pg_attribute a
      JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
      LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE c.relnamespace = 'public'::regnamespace AND c.relname = o.tbl
       AND a.attname = o.col AND a.attnum > 0 AND NOT a.attisdropped;
    IF NOT FOUND
       OR NOT r.attnotnull
       OR r.col_type <> o.typ
       OR r.attgenerated <> '' OR r.attidentity <> ''
       OR r.attnum <> o.attnum
       OR r.def IS DISTINCT FROM o.fin_def THEN
      RAISE EXCEPTION 'RECON-INTEGRITY-001: Phase C — public.%.% is not in the exact canonical end state (notnull=%, type=%, attnum=% vs %, default="%" vs "%")',
        o.tbl, o.col, r.attnotnull, r.col_type, r.attnum, o.attnum, coalesce(r.def, '<none>'), coalesce(o.fin_def, '<none>');
    END IF;
    EXECUTE format('SELECT count(*) FROM public.%I WHERE %I IS NULL', o.tbl, o.col) INTO v_nulls;
    IF v_nulls <> 0 THEN
      RAISE EXCEPTION 'RECON-INTEGRITY-001: Phase C — public.%.% contains % NULL value(s) after migration', o.tbl, o.col, v_nulls;
    END IF;
  END LOOP;

  FOREACH t IN ARRAY v_tables LOOP
    EXECUTE format('SELECT count(*) FROM public.%I', t) INTO v_rows;
    IF v_rows <> (v_rowcounts->>t)::bigint THEN
      RAISE EXCEPTION 'RECON-INTEGRITY-001: Phase C — public.% row count changed (% -> %)', t, v_rowcounts->>t, v_rows;
    END IF;
    SELECT jsonb_build_object(
      'rls',    c.relrowsecurity,
      'force',  c.relforcerowsecurity,
      'owner',  pg_get_userbyid(c.relowner),
      'acl',    coalesce(c.relacl::text, '<default>'),
      'policies', (SELECT coalesce(md5(string_agg(p.polname || '|' || p.polcmd::text || '|'
                          || coalesce(pg_get_expr(p.polqual, p.polrelid), '') || '|'
                          || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') || '|'
                          || p.polroles::text || '|' || p.polpermissive::text, '||' ORDER BY p.polname)), 'none')
                     FROM pg_catalog.pg_policy p WHERE p.polrelid = c.oid),
      'constraints', (SELECT coalesce(md5(string_agg(cn.conname || '|' || pg_get_constraintdef(cn.oid), '||' ORDER BY cn.conname)), 'none')
                     FROM pg_catalog.pg_constraint cn WHERE cn.conrelid = c.oid),
      'indexes', (SELECT coalesce(md5(string_agg(i.indexname || '|' || i.indexdef, '||' ORDER BY i.indexname)), 'none')
                     FROM pg_catalog.pg_indexes i WHERE i.schemaname = 'public' AND i.tablename = c.relname),
      'triggers', (SELECT coalesce(md5(string_agg(tg.tgname || '|' || pg_get_triggerdef(tg.oid), '||' ORDER BY tg.tgname)), 'none')
                     FROM pg_catalog.pg_trigger tg WHERE tg.tgrelid = c.oid AND NOT tg.tgisinternal),
      'nontarget', (SELECT coalesce(md5(string_agg(a.attname || '|' || a.attnotnull::text || '|'
                          || format_type(a.atttypid, a.atttypmod) || '|'
                          || coalesce(pg_get_expr(d.adbin, d.adrelid), ''), '||' ORDER BY a.attnum)), 'none')
                     FROM pg_catalog.pg_attribute a
                     LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                    WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
                      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_manifest) mm
                                       WHERE mm->>'tbl' = c.relname AND mm->>'col' = a.attname)))
      INTO v_chk
      FROM pg_catalog.pg_class c
     WHERE c.relnamespace = 'public'::regnamespace AND c.relname = t;
    IF v_chk IS DISTINCT FROM (v_inv->t) THEN
      RAISE EXCEPTION 'RECON-INTEGRITY-001: Phase C — public.% object inventory changed (RLS/policies/constraints/indexes/triggers/owner/ACL/non-target columns). Before: % After: %', t, v_inv->t, v_chk;
    END IF;
  END LOOP;

  RAISE NOTICE 'RECON-INTEGRITY-001: Phase C passed — canonical end state verified (started as %)', v_state;
END
$recon$;
