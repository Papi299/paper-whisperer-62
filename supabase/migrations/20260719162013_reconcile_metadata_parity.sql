-- RECON-METADATA-PARITY-001 — reconcile the remaining public-schema metadata
-- drift between a clean local replay and the linked production project, under
-- docs/schema-reconciliation.md §5 item 5 and decision C26. Fifth and final
-- schema-reconciliation migration.
--
-- Two supported starting states (any deviation fails in Phase A, before DDL):
--
--   S1 — clean local replay after the first 64 migrations. Non-canonical for
--        everything EXCEPT created_at (already now()):
--          * projects.updated_at column + update_projects_updated_at trigger present
--          * papers has a duplicate updated_at trigger (update_papers_updated_at)
--          * study_type_pool.created_at is NULLABLE
--          * tags.color default '#8b5cf6'
--          * seven redundant single-column btree indexes present
--
--   S2 — audited linked production after the first 64 migrations. Already
--        canonical for everything EXCEPT the eight timezone('utc', now())
--        created_at defaults.
--
-- Because production predates the first tracked migration its physical column
-- order differs, so every targeted column's live attnum is state-specific and
-- pinned per state (S1 vs S2) in the manifest below; every OTHER column property
-- (type OID, typmod, rendered type, generated/identity state, collation,
-- storage, compression, statistics target, ACL, comment, security labels) is
-- invariant across both states and pinned exactly.
--
-- Canonical end state (both states converge here):
--   * projects.updated_at column absent; update_projects_updated_at absent
--   * papers keeps exactly one updated_at trigger: trg_papers_updated_at
--     (BEFORE UPDATE … EXECUTE FUNCTION set_updated_at()); update_papers_updated_at absent
--   * created_at default = now() on the eight drifted tables
--   * study_type_pool.created_at NOT NULL (default now())
--   * tags.color default = '#e2e8f0'
--   * the seven redundant single-column indexes absent (production's covering
--     composite/unique indexes are the active query contract and are preserved;
--     see the PR description for pg_stat/EXPLAIN/left-prefix evidence)
--
-- Deliberately NOT changed (documented, evidence-backed):
--   * papers.search_vector generation expression — the local immutable-wrapper
--     form and the production inline to_tsvector form produce byte-identical
--     tsvectors across a NULL/empty/punctuation/case/unicode/stopword/number/
--     nested-jsonb corpus; approved benign textual difference (spec §7.8). No
--     table rewrite.
--   * SEC-4 default table grants — a shadow-database diff artifact
--     (schema-reconciliation.md §3); effective privileges already match the
--     RLS-forced security model. No grant is added or removed here.
--
-- Safety: no DML, no data backfill, no CASCADE, no broad grants, no generated-
-- type work. The only value-bearing change is dropping projects.updated_at; row
-- counts and every remaining stored value are proven unchanged in Phase C. All
-- validation runs twice — pre-lock and again under ACCESS EXCLUSIVE — with the
-- concurrency-sensitive inventories (routines, publications, grants/ACL,
-- comments, security labels) captured under lock as late as possible before
-- Phase B and re-proved in Phase C. Any failure rolls back the whole migration.

DO $recon$
DECLARE
  -- eight locked tables (deterministic order) = created_at convergence targets
  v_all_tables CONSTANT text[] := ARRAY[
    'keyword_exclusion_pool','keyword_pool','papers','projects',
    'study_type_exclusion_pool','study_type_pool','synonym_pool','tags'];
  v_ca_tables  CONSTANT text[] := ARRAY[
    'keyword_exclusion_pool','keyword_pool','papers','projects',
    'study_type_exclusion_pool','study_type_pool','synonym_pool','tags'];

  -- Complete per-column metadata manifest. att differs by state; nn/def are the
  -- state-specific mutable attributes; every other field is invariant and exact.
  -- (typoid 1184 = timestamptz, 25 = text; coll 0 = none, 100 = db default;
  -- storage p = plain, x = extended.) s2_att = -1 / s2_def = '' means "absent in S2".
  v_manifest CONSTANT jsonb := jsonb_build_array(
    jsonb_build_object('tbl','keyword_exclusion_pool',   'col','created_at','s1_att',4, 's2_att',3, 'typoid',1184,'typmod',-1,'rtype','timestamp with time zone','coll',0,  'storage','p','s1_nn',true, 's2_nn',true, 's1_def','now()','s2_def','timezone(''utc''::text, now())'),
    jsonb_build_object('tbl','keyword_pool',             'col','created_at','s1_att',4, 's2_att',3, 'typoid',1184,'typmod',-1,'rtype','timestamp with time zone','coll',0,  'storage','p','s1_nn',true, 's2_nn',true, 's1_def','now()','s2_def','timezone(''utc''::text, now())'),
    jsonb_build_object('tbl','papers',                   'col','created_at','s1_att',16,'s2_att',14,'typoid',1184,'typmod',-1,'rtype','timestamp with time zone','coll',0,  'storage','p','s1_nn',true, 's2_nn',true, 's1_def','now()','s2_def','timezone(''utc''::text, now())'),
    jsonb_build_object('tbl','projects',                 'col','created_at','s1_att',6, 's2_att',4, 'typoid',1184,'typmod',-1,'rtype','timestamp with time zone','coll',0,  'storage','p','s1_nn',true, 's2_nn',true, 's1_def','now()','s2_def','timezone(''utc''::text, now())'),
    jsonb_build_object('tbl','study_type_exclusion_pool','col','created_at','s1_att',4, 's2_att',3, 'typoid',1184,'typmod',-1,'rtype','timestamp with time zone','coll',0,  'storage','p','s1_nn',true, 's2_nn',true, 's1_def','now()','s2_def','timezone(''utc''::text, now())'),
    jsonb_build_object('tbl','study_type_pool',          'col','created_at','s1_att',4, 's2_att',4, 'typoid',1184,'typmod',-1,'rtype','timestamp with time zone','coll',0,  'storage','p','s1_nn',false,'s2_nn',true, 's1_def','now()','s2_def','timezone(''utc''::text, now())'),
    jsonb_build_object('tbl','synonym_pool',             'col','created_at','s1_att',5, 's2_att',4, 'typoid',1184,'typmod',-1,'rtype','timestamp with time zone','coll',0,  'storage','p','s1_nn',true, 's2_nn',true, 's1_def','now()','s2_def','timezone(''utc''::text, now())'),
    jsonb_build_object('tbl','tags',                     'col','created_at','s1_att',5, 's2_att',4, 'typoid',1184,'typmod',-1,'rtype','timestamp with time zone','coll',0,  'storage','p','s1_nn',true, 's2_nn',true, 's1_def','now()','s2_def','timezone(''utc''::text, now())'),
    jsonb_build_object('tbl','tags',                     'col','color',     's1_att',4, 's2_att',3, 'typoid',25,  'typmod',-1,'rtype','text',                    'coll',100,'storage','x','s1_nn',false,'s2_nn',false,'s1_def','''#8b5cf6''::text','s2_def','''#e2e8f0''::text'),
    jsonb_build_object('tbl','projects',                 'col','updated_at','s1_att',7, 's2_att',-1,'typoid',1184,'typmod',-1,'rtype','timestamp with time zone','coll',0,  'storage','p','s1_nn',true, 's2_nn',false,'s1_def','now()','s2_def','')
  );

  -- seven redundant single-column btree indexes (canonical: absent) + exact defs
  v_idx7 CONSTANT jsonb := jsonb_build_object(
    'idx_papers_doi',           'CREATE INDEX idx_papers_doi ON public.papers USING btree (doi)',
    'idx_papers_pmid',          'CREATE INDEX idx_papers_pmid ON public.papers USING btree (pmid)',
    'idx_papers_user_id',       'CREATE INDEX idx_papers_user_id ON public.papers USING btree (user_id)',
    'idx_papers_year',          'CREATE INDEX idx_papers_year ON public.papers USING btree (year)',
    'idx_projects_user_id',     'CREATE INDEX idx_projects_user_id ON public.projects USING btree (user_id)',
    'idx_synonym_pool_user_id', 'CREATE INDEX idx_synonym_pool_user_id ON public.synonym_pool USING btree (user_id)',
    'idx_tags_user_id',         'CREATE INDEX idx_tags_user_id ON public.tags USING btree (user_id)');

  -- canonical default expressions (deparsed pg_get_expr form)
  v_now         CONSTANT text := 'now()';
  v_utc         CONSTANT text := 'timezone(''utc''::text, now())';
  v_color_canon CONSTANT text := '''#e2e8f0''::text';

  -- canonical papers trigger (must always survive) and the removable duplicates
  v_trg_keep     CONSTANT text := 'trg_papers_updated_at';
  v_trg_keep_def CONSTANT text := 'CREATE TRIGGER trg_papers_updated_at BEFORE UPDATE ON public.papers FOR EACH ROW EXECUTE FUNCTION set_updated_at()';
  v_trg_pap_dup  CONSTANT text := 'update_papers_updated_at';
  v_trg_pap_def  CONSTANT text := 'CREATE TRIGGER update_papers_updated_at BEFORE UPDATE ON public.papers FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()';
  v_trg_proj     CONSTANT text := 'update_projects_updated_at';
  v_trg_proj_def CONSTANT text := 'CREATE TRIGGER update_projects_updated_at BEFORE UPDATE ON public.projects FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()';

  -- Exact approved public routine inventory (23 routines). Behavioral fingerprint
  -- is environment-independent (required in every state); the full fingerprint
  -- (adds owner + ACL) is environment-specific, so the live value must equal one
  -- of the two audited baselines. Any added/removed/changed routine — including
  -- a changed volatility/secdef/owner/ACL/config with an unchanged body — aborts.
  v_routines_count   CONSTANT int  := 23;
  v_routines_beh     CONSTANT text := 'c0c14ef5f3e85c33a5eebec8402fc0db';   -- behavioral (env-independent)
  v_routines_full_s1 CONSTANT text := '1f65886109bf875238c517d764af4c5f';   -- clean local replay
  v_routines_full_s2 CONSTANT text := 'c0b444c8102b5e3b0fc241ba7b53dde9';   -- audited production

  v_state    text;
  v_pass     int;
  v_cnt      bigint;
  v_txt      text;
  v_k        text;
  v_bool     boolean;
  v_att      int;
  v_exp_att  int;
  v_exp_nn   boolean;
  v_exp_def  text;
  t          text;
  m          record;
  r          record;
  v_rt_count int;
  v_rt_beh   text;
  v_rt_full  text;

  -- preservation captures (pass 2 / under-lock authoritative), re-proved in Phase C
  v_prov_pre  jsonb := '{}'::jsonb;
  v_prov_post jsonb;
  v_rows_pre  jsonb := '{}'::jsonb;
  v_data_pre  jsonb := '{}'::jsonb;

  -- Reusable per-table preservation inventory expression, evaluated into v_prov_post.
  -- Excludes exactly the intended changes: the seven dropped indexes, the two
  -- dropped triggers, the removed projects.updated_at column, and (masked, not
  -- removed) the mutable created_at default, study_type_pool.created_at NOT NULL,
  -- and tags.color default — every other attribute of those columns is preserved.
BEGIN
  ------------------------------------------------------------------
  -- Manifest self-checks
  ------------------------------------------------------------------
  IF jsonb_array_length(v_manifest) <> 10 THEN
    RAISE EXCEPTION 'RECON-METADATA-PARITY-001: manifest must contain exactly 10 columns';
  END IF;

  ------------------------------------------------------------------
  -- Phase A: pass 1 pre-lock, pass 2 under ACCESS EXCLUSIVE lock.
  ------------------------------------------------------------------
  FOR v_pass IN 1..2 LOOP

    FOREACH t IN ARRAY v_all_tables LOOP
      PERFORM 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = t AND c.relkind = 'r';
      IF NOT FOUND THEN
        RAISE EXCEPTION 'RECON-METADATA-PARITY-001: public.% is missing or not an ordinary table', t;
      END IF;
    END LOOP;

    -- Global state via the projects.updated_at bellwether; every other item is
    -- cross-validated against it so a mixed/third state fails closed.
    SELECT count(*) INTO v_cnt FROM pg_attribute a
     WHERE a.attrelid = 'public.projects'::regclass
       AND a.attname = 'updated_at' AND a.attnum > 0 AND NOT a.attisdropped;
    IF v_cnt = 1 THEN v_state := 'S1';
    ELSIF v_cnt = 0 THEN v_state := 'S2';
    ELSE RAISE EXCEPTION 'RECON-METADATA-PARITY-001: projects.updated_at classification anomaly (% live)', v_cnt;
    END IF;

    IF v_pass = 2 AND v_state <> (v_prov_pre ->> '_state') THEN
      RAISE EXCEPTION 'RECON-METADATA-PARITY-001: global state changed under lock (% -> %)', v_prov_pre ->> '_state', v_state;
    END IF;

    ----------------------------------------------------------------
    -- (A1) Complete exact metadata for every manifest column.
    ----------------------------------------------------------------
    FOR m IN SELECT * FROM jsonb_to_recordset(v_manifest)
             AS x(tbl text, col text, s1_att int, s2_att int, typoid oid, typmod int,
                  rtype text, coll oid, storage "char", s1_nn boolean, s2_nn boolean,
                  s1_def text, s2_def text) LOOP
      v_exp_att := CASE v_state WHEN 'S1' THEN m.s1_att ELSE m.s2_att END;
      v_exp_nn  := CASE v_state WHEN 'S1' THEN m.s1_nn  ELSE m.s2_nn  END;
      v_exp_def := CASE v_state WHEN 'S1' THEN m.s1_def ELSE m.s2_def END;

      SELECT a.attnum, a.atttypid, a.atttypmod, format_type(a.atttypid,a.atttypmod) AS rtype,
             a.attnotnull, a.attgenerated, a.attidentity, a.attcollation,
             a.attstorage, a.attcompression, a.attstattarget, a.attacl,
             pg_get_expr(ad.adbin, ad.adrelid) AS def, col_description(a.attrelid,a.attnum) AS comment
        INTO r
        FROM pg_attribute a LEFT JOIN pg_attrdef ad ON ad.adrelid=a.attrelid AND ad.adnum=a.attnum
       WHERE a.attrelid=('public.'||m.tbl)::regclass AND a.attname=m.col AND a.attnum>0 AND NOT a.attisdropped;

      IF v_exp_att = -1 THEN
        -- S2: column must be absent (projects.updated_at only).
        IF FOUND THEN
          RAISE EXCEPTION 'RECON-METADATA-PARITY-001: %.% must be absent in S2 but is present', m.tbl, m.col;
        END IF;
        CONTINUE;
      END IF;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'RECON-METADATA-PARITY-001: %.% is missing in state %', m.tbl, m.col, v_state;
      END IF;
      IF r.attnum <> v_exp_att THEN
        RAISE EXCEPTION 'RECON-METADATA-PARITY-001: %.% is at attnum % (expected % in %)', m.tbl, m.col, r.attnum, v_exp_att, v_state;
      END IF;
      IF r.atttypid <> m.typoid THEN
        RAISE EXCEPTION 'RECON-METADATA-PARITY-001: %.% has type OID % (expected %)', m.tbl, m.col, r.atttypid, m.typoid;
      END IF;
      IF r.atttypmod <> m.typmod THEN
        RAISE EXCEPTION 'RECON-METADATA-PARITY-001: %.% has typmod % (expected %)', m.tbl, m.col, r.atttypmod, m.typmod;
      END IF;
      IF r.rtype <> m.rtype THEN
        RAISE EXCEPTION 'RECON-METADATA-PARITY-001: %.% has type % (expected %)', m.tbl, m.col, r.rtype, m.rtype;
      END IF;
      IF r.attnotnull <> v_exp_nn THEN
        RAISE EXCEPTION 'RECON-METADATA-PARITY-001: %.% notnull=% (expected % in %)', m.tbl, m.col, r.attnotnull, v_exp_nn, v_state;
      END IF;
      IF r.attgenerated <> '' OR r.attidentity <> '' THEN
        RAISE EXCEPTION 'RECON-METADATA-PARITY-001: %.% is generated or identity-backed', m.tbl, m.col;
      END IF;
      IF r.attcollation <> m.coll THEN
        RAISE EXCEPTION 'RECON-METADATA-PARITY-001: %.% has collation OID % (expected %)', m.tbl, m.col, r.attcollation, m.coll;
      END IF;
      IF r.attstorage <> m.storage OR r.attcompression <> '' THEN
        RAISE EXCEPTION 'RECON-METADATA-PARITY-001: %.% has storage/compression %/% (expected %/'''')', m.tbl, m.col, r.attstorage, r.attcompression, m.storage;
      END IF;
      IF r.attstattarget IS NOT NULL AND r.attstattarget >= 0 THEN
        RAISE EXCEPTION 'RECON-METADATA-PARITY-001: %.% has a custom statistics target', m.tbl, m.col;
      END IF;
      IF r.attacl IS NOT NULL THEN
        RAISE EXCEPTION 'RECON-METADATA-PARITY-001: %.% carries column-level privileges', m.tbl, m.col;
      END IF;
      IF r.comment IS NOT NULL THEN
        RAISE EXCEPTION 'RECON-METADATA-PARITY-001: %.% carries a comment', m.tbl, m.col;
      END IF;
      IF r.def IS DISTINCT FROM v_exp_def THEN
        RAISE EXCEPTION 'RECON-METADATA-PARITY-001: %.% default is % (expected % in %)', m.tbl, m.col, COALESCE(r.def,'<none>'), COALESCE(v_exp_def,'<none>'), v_state;
      END IF;
      SELECT count(*) INTO v_cnt FROM pg_seclabel sl
       WHERE sl.classoid='pg_class'::regclass AND sl.objoid=('public.'||m.tbl)::regclass AND sl.objsubid=r.attnum;
      IF v_cnt <> 0 THEN
        RAISE EXCEPTION 'RECON-METADATA-PARITY-001: %.% carries % security label(s)', m.tbl, m.col, v_cnt;
      END IF;
    END LOOP;

    ----------------------------------------------------------------
    -- (A2) projects.updated_at proactive dependency inventory (S1 only;
    -- the restrictive DROP COLUMN is only a backstop). The approved
    -- update_projects_updated_at trigger is handled explicitly and excluded.
    ----------------------------------------------------------------
    IF v_state = 'S1' THEN
      SELECT a.attnum INTO v_att FROM pg_attribute a
       WHERE a.attrelid='public.projects'::regclass AND a.attname='updated_at';

      -- exact matching update trigger present and enabled
      SELECT pg_get_triggerdef(tg.oid), tg.tgenabled INTO v_txt, v_k FROM pg_trigger tg
       WHERE tg.tgrelid='public.projects'::regclass AND tg.tgname=v_trg_proj AND NOT tg.tgisinternal;
      IF v_txt IS DISTINCT FROM v_trg_proj_def OR v_k IS DISTINCT FROM 'O' THEN
        RAISE EXCEPTION 'RECON-METADATA-PARITY-001: update_projects_updated_at trigger missing/altered/disabled (def=%, enabled=%)', COALESCE(v_txt,'<absent>'), COALESCE(v_k,'<absent>');
      END IF;

      -- catalog dependencies beyond the column's own default
      SELECT count(*) INTO v_cnt FROM pg_depend d
       WHERE d.refclassid='pg_class'::regclass AND d.refobjid='public.projects'::regclass
         AND d.refobjsubid=v_att
         AND NOT (d.classid='pg_attrdef'::regclass);
      IF v_cnt <> 0 THEN RAISE EXCEPTION 'RECON-METADATA-PARITY-001: projects.updated_at has % catalog dependency(ies) beyond its own default', v_cnt; END IF;

      -- non-not-null constraints referencing the column (its own NOT NULL is fine)
      SELECT count(*) INTO v_cnt FROM pg_constraint c
       WHERE c.conrelid='public.projects'::regclass AND c.contype <> 'n' AND v_att = ANY(c.conkey);
      IF v_cnt <> 0 THEN RAISE EXCEPTION 'RECON-METADATA-PARITY-001: projects.updated_at appears in % non-not-null constraint(s)', v_cnt; END IF;

      -- indexes (key, expression or predicate)
      SELECT count(*) INTO v_cnt FROM pg_index i
       WHERE i.indrelid='public.projects'::regclass
         AND (v_att = ANY(string_to_array(i.indkey::text,' ')::int2[])
              OR pg_get_expr(i.indexprs,i.indrelid) ~* '\yupdated_at\y'
              OR pg_get_expr(i.indpred,i.indrelid)  ~* '\yupdated_at\y');
      IF v_cnt <> 0 THEN RAISE EXCEPTION 'RECON-METADATA-PARITY-001: projects.updated_at appears in % index(es)', v_cnt; END IF;

      -- extended statistics
      SELECT count(*) INTO v_cnt FROM pg_statistic_ext s
       WHERE s.stxrelid='public.projects'::regclass AND v_att = ANY(string_to_array(s.stxkeys::text,' ')::int2[]);
      IF v_cnt <> 0 THEN RAISE EXCEPTION 'RECON-METADATA-PARITY-001: projects.updated_at appears in % extended statistics object(s)', v_cnt; END IF;

      -- views / matviews / rules mentioning projects + updated_at
      SELECT count(*) INTO v_cnt FROM pg_rewrite w
       JOIN pg_class c ON c.oid=w.ev_class JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname NOT IN ('pg_catalog','information_schema')
         AND pg_get_ruledef(w.oid) ~* '\yprojects\y' AND pg_get_ruledef(w.oid) ~* '\yupdated_at\y';
      IF v_cnt <> 0 THEN RAISE EXCEPTION 'RECON-METADATA-PARITY-001: % view/rule definition(s) reference projects.updated_at', v_cnt; END IF;

      -- RLS policies on projects referencing updated_at
      SELECT count(*) INTO v_cnt FROM pg_policy p
       WHERE p.polrelid='public.projects'::regclass
         AND (pg_get_expr(p.polqual,p.polrelid) ~* '\yupdated_at\y'
              OR pg_get_expr(p.polwithcheck,p.polrelid) ~* '\yupdated_at\y');
      IF v_cnt <> 0 THEN RAISE EXCEPTION 'RECON-METADATA-PARITY-001: % RLS policy(ies) reference projects.updated_at', v_cnt; END IF;

      -- other-column defaults / generation expressions on projects mentioning updated_at
      SELECT count(*) INTO v_cnt FROM pg_attrdef ad
       WHERE ad.adrelid='public.projects'::regclass AND ad.adnum <> v_att
         AND pg_get_expr(ad.adbin,ad.adrelid) ~* '\yupdated_at\y';
      IF v_cnt <> 0 THEN RAISE EXCEPTION 'RECON-METADATA-PARITY-001: % other projects default/generation expression(s) reference updated_at', v_cnt; END IF;

      -- functions/procedures that reference the projects table AND updated_at, use a
      -- projects whole-row idiom, or return the projects row type. (The generic
      -- set_updated_at / update_updated_at_column trigger functions reference
      -- updated_at but NOT the projects table, so they are correctly excluded.)
      -- Precise: a qualified projects.updated_at reference, or updated_at used in
      -- a statement targeting the projects table (FROM/JOIN/UPDATE/INTO projects —
      -- the '\y' boundary excludes paper_projects), or a projects whole-row idiom /
      -- row-type result/argument. (merge_exact_duplicates references the WORD
      -- "projects" in a comment and sets papers.updated_at via paper_projects, so
      -- it is correctly not matched.)
      SELECT count(*) INTO v_cnt FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname NOT IN ('pg_catalog','information_schema')
         AND ( p.prosrc ~* 'projects\.updated_at'
               OR (p.prosrc ~* '\yupdated_at\y' AND p.prosrc ~* '(from|join|update|into)[[:space:]]+(public\.)?projects\y')
               OR p.prosrc ~* '(public\.)?projects[[:space:]]*%[[:space:]]*rowtype'
               OR p.prosrc ~* 'select[[:space:]]+\*[[:space:]]+from[[:space:]]+(public\.)?projects\y'
               OR p.prorettype = (SELECT c.reltype FROM pg_class c WHERE c.oid='public.projects'::regclass)
               OR pg_get_function_result(p.oid) ~* '\yprojects\y'
               OR pg_get_function_arguments(p.oid) ~* '\yprojects\y' );
      IF v_cnt <> 0 THEN RAISE EXCEPTION 'RECON-METADATA-PARITY-001: % routine(s) consume projects.updated_at or the projects whole row', v_cnt; END IF;

      -- composite row-type consumers of projects
      SELECT count(*) INTO v_cnt FROM pg_depend d
       WHERE d.refclassid='pg_type'::regclass
         AND d.refobjid=(SELECT c.reltype FROM pg_class c WHERE c.oid='public.projects'::regclass)
         AND d.deptype='n';
      IF v_cnt <> 0 THEN RAISE EXCEPTION 'RECON-METADATA-PARITY-001: % object(s) depend on the projects composite row type', v_cnt; END IF;

      -- publication column list pinning the column, or whole-table membership / FOR ALL TABLES
      SELECT count(*) INTO v_cnt FROM pg_publication_rel pr
       WHERE pr.prrelid='public.projects'::regclass AND pr.prattrs IS NOT NULL
         AND v_att = ANY(string_to_array(pr.prattrs::text,' ')::int2[]);
      IF v_cnt <> 0 THEN RAISE EXCEPTION 'RECON-METADATA-PARITY-001: projects.updated_at is pinned in a publication column list'; END IF;
      SELECT count(*) INTO v_cnt FROM pg_publication_rel pr WHERE pr.prrelid='public.projects'::regclass;
      IF v_cnt <> 0 THEN RAISE EXCEPTION 'RECON-METADATA-PARITY-001: public.projects is a member of % publication(s)', v_cnt; END IF;
      SELECT count(*) INTO v_cnt FROM pg_publication WHERE puballtables;
      IF v_cnt <> 0 THEN RAISE EXCEPTION 'RECON-METADATA-PARITY-001: % FOR ALL TABLES publication(s) exist', v_cnt; END IF;
    ELSE
      PERFORM 1 FROM pg_trigger tg WHERE tg.tgrelid='public.projects'::regclass AND tg.tgname=v_trg_proj AND NOT tg.tgisinternal;
      IF FOUND THEN RAISE EXCEPTION 'RECON-METADATA-PARITY-001: S2 but update_projects_updated_at present'; END IF;
    END IF;
    -- projects must never carry any OTHER updated_at-maintaining trigger
    SELECT count(*) INTO v_cnt FROM pg_trigger tg JOIN pg_proc p ON p.oid=tg.tgfoid
     WHERE tg.tgrelid='public.projects'::regclass AND NOT tg.tgisinternal
       AND p.proname IN ('set_updated_at','update_updated_at_column') AND tg.tgname <> v_trg_proj;
    IF v_cnt <> 0 THEN RAISE EXCEPTION 'RECON-METADATA-PARITY-001: unexpected extra updated_at trigger on projects (%)', v_cnt; END IF;

    ----------------------------------------------------------------
    -- (A3) papers updated_at triggers — canonical always present + enabled;
    -- duplicate present iff S1; no third updated_at trigger.
    ----------------------------------------------------------------
    SELECT pg_get_triggerdef(tg.oid), tg.tgenabled INTO v_txt, v_k FROM pg_trigger tg
     WHERE tg.tgrelid='public.papers'::regclass AND tg.tgname=v_trg_keep AND NOT tg.tgisinternal;
    IF v_txt IS DISTINCT FROM v_trg_keep_def OR v_k IS DISTINCT FROM 'O' THEN
      RAISE EXCEPTION 'RECON-METADATA-PARITY-001: canonical papers trigger % missing/altered/disabled (def=%, enabled=%)', v_trg_keep, COALESCE(v_txt,'<absent>'), COALESCE(v_k,'<absent>');
    END IF;
    SELECT pg_get_triggerdef(tg.oid), tg.tgenabled INTO v_txt, v_k FROM pg_trigger tg
     WHERE tg.tgrelid='public.papers'::regclass AND tg.tgname=v_trg_pap_dup AND NOT tg.tgisinternal;
    IF v_state = 'S1' THEN
      IF v_txt IS DISTINCT FROM v_trg_pap_def OR v_k IS DISTINCT FROM 'O' THEN
        RAISE EXCEPTION 'RECON-METADATA-PARITY-001: S1 but duplicate papers trigger missing/altered/disabled (def=%, enabled=%)', COALESCE(v_txt,'<absent>'), COALESCE(v_k,'<absent>');
      END IF;
    ELSE
      IF v_txt IS NOT NULL THEN RAISE EXCEPTION 'RECON-METADATA-PARITY-001: S2 but duplicate papers trigger present'; END IF;
    END IF;
    SELECT count(*) INTO v_cnt FROM pg_trigger tg JOIN pg_proc p ON p.oid=tg.tgfoid
     WHERE tg.tgrelid='public.papers'::regclass AND NOT tg.tgisinternal
       AND p.proname IN ('set_updated_at','update_updated_at_column') AND tg.tgname NOT IN (v_trg_keep, v_trg_pap_dup);
    IF v_cnt <> 0 THEN RAISE EXCEPTION 'RECON-METADATA-PARITY-001: unexpected extra updated_at trigger on papers (%)', v_cnt; END IF;

    ----------------------------------------------------------------
    -- (A4) study_type_pool.created_at ZERO-NULL gate (rechecked under lock).
    ----------------------------------------------------------------
    SELECT count(*) INTO v_cnt FROM public.study_type_pool WHERE created_at IS NULL;
    IF v_cnt <> 0 THEN
      RAISE EXCEPTION 'RECON-METADATA-PARITY-001: study_type_pool.created_at has % NULL row(s); refusing NOT NULL', v_cnt;
    END IF;

    ----------------------------------------------------------------
    -- (A5) seven redundant indexes — present with EXACT def (non-unique,
    -- not constraint-backed) in S1; absent in S2.
    ----------------------------------------------------------------
    FOR m IN SELECT key AS idxname FROM jsonb_object_keys(v_idx7) AS key LOOP
      SELECT pg_get_indexdef(i.indexrelid) INTO v_txt
        FROM pg_class ic JOIN pg_index i ON i.indexrelid=ic.oid
       WHERE ic.relnamespace='public'::regnamespace AND ic.relname=m.idxname;
      IF v_state = 'S1' THEN
        IF v_txt IS DISTINCT FROM (v_idx7 ->> m.idxname) THEN
          RAISE EXCEPTION 'RECON-METADATA-PARITY-001: index % missing or has unexpected definition (%)', m.idxname, COALESCE(v_txt,'<absent>');
        END IF;
        SELECT i.indisunique OR i.indisprimary INTO v_bool
          FROM pg_class ic JOIN pg_index i ON i.indexrelid=ic.oid
         WHERE ic.relnamespace='public'::regnamespace AND ic.relname=m.idxname;
        IF v_bool THEN RAISE EXCEPTION 'RECON-METADATA-PARITY-001: index % is unique/primary; refusing to drop', m.idxname; END IF;
        SELECT count(*) INTO v_cnt FROM pg_constraint c JOIN pg_class ic ON ic.oid=c.conindid
         WHERE ic.relname=m.idxname AND ic.relnamespace='public'::regnamespace;
        IF v_cnt <> 0 THEN RAISE EXCEPTION 'RECON-METADATA-PARITY-001: index % backs a constraint; refusing to drop', m.idxname; END IF;
      ELSE
        IF v_txt IS NOT NULL THEN RAISE EXCEPTION 'RECON-METADATA-PARITY-001: S2 but index % is present', m.idxname; END IF;
      END IF;
    END LOOP;

    ----------------------------------------------------------------
    -- (A6) Exact approved routine inventory gate (every state, every pass;
    -- pass 2 is under lock — as late as possible before Phase B).
    ----------------------------------------------------------------
    SELECT count(*),
           md5(string_agg(
             n.nspname||'|'||p.proname||'|'||pg_get_function_identity_arguments(p.oid)||'|'||
             pg_get_function_result(p.oid)||'|'||p.prokind::text||'|'||l.lanname||'|'||
             p.prosecdef::text||'|'||p.provolatile::text||'|'||p.proisstrict::text||'|'||
             p.proleakproof::text||'|'||p.proparallel::text||'|'||
             COALESCE(array_to_string(p.proconfig,','),'-')||'|'||md5(p.prosrc),
             chr(10) ORDER BY p.proname, pg_get_function_identity_arguments(p.oid))),
           md5(string_agg(
             n.nspname||'|'||p.proname||'|'||pg_get_function_identity_arguments(p.oid)||'|'||
             pg_get_function_result(p.oid)||'|'||p.prokind::text||'|'||l.lanname||'|'||
             p.prosecdef::text||'|'||p.provolatile::text||'|'||p.proisstrict::text||'|'||
             p.proleakproof::text||'|'||p.proparallel::text||'|'||
             COALESCE(array_to_string(p.proconfig,','),'-')||'|'||
             pg_get_userbyid(p.proowner)||'|'||COALESCE(p.proacl::text,'-')||'|'||md5(p.prosrc),
             chr(10) ORDER BY p.proname, pg_get_function_identity_arguments(p.oid)))
      INTO v_rt_count, v_rt_beh, v_rt_full
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang
     WHERE n.nspname='public';
    IF v_rt_count <> v_routines_count THEN
      RAISE EXCEPTION 'RECON-METADATA-PARITY-001: public routine count is % (expected %)', v_rt_count, v_routines_count;
    END IF;
    IF v_rt_beh <> v_routines_beh THEN
      RAISE EXCEPTION 'RECON-METADATA-PARITY-001: public routine behavioral inventory drift (a routine was added, removed, or its signature/behavior/body changed)';
    END IF;
    IF v_rt_full <> v_routines_full_s1 AND v_rt_full <> v_routines_full_s2 THEN
      RAISE EXCEPTION 'RECON-METADATA-PARITY-001: public routine owner/ACL inventory matches neither audited baseline (a routine owner, ACL, volatility, security-definer or config changed)';
    END IF;

    ----------------------------------------------------------------
    -- Preservation capture (pass 2 under lock = authoritative pre-DDL image).
    ----------------------------------------------------------------
    v_prov_pre := jsonb_build_object('_state', v_state, '_routines', v_rt_beh||'/'||v_rt_full||'/'||v_rt_count::text);
    v_rows_pre := '{}'::jsonb;
    v_data_pre := '{}'::jsonb;
    FOREACH t IN ARRAY v_all_tables LOOP
      SELECT jsonb_build_object(
        'kind_owner_acl_rls', (SELECT c.relkind::text||'/'||pg_get_userbyid(c.relowner)||'/'||COALESCE(c.relacl::text,'-')||'/'||
                               c.relrowsecurity::text||'/'||c.relforcerowsecurity::text||'/'||COALESCE(c.relreplident::text,'-')
                                 FROM pg_class c WHERE c.oid=('public.'||t)::regclass),
        'pol', (SELECT COALESCE(md5(string_agg(pol.polname||':'||pol.polcmd::text||':'||pol.polpermissive::text||':'||
                       COALESCE(array_to_string(ARRAY(SELECT pg_get_userbyid(ur) FROM unnest(pol.polroles) ur ORDER BY 1),','),'-')||':'||
                       COALESCE(pg_get_expr(pol.polqual,pol.polrelid),'-')||':'||
                       COALESCE(pg_get_expr(pol.polwithcheck,pol.polrelid),'-'),'|' ORDER BY pol.polname)),'none')
                  FROM pg_policy pol WHERE pol.polrelid=('public.'||t)::regclass),
        'con', (SELECT COALESCE(md5(string_agg(c.conname||':'||pg_get_constraintdef(c.oid),'|' ORDER BY c.conname)),'none')
                  FROM pg_constraint c WHERE c.conrelid=('public.'||t)::regclass AND c.contype <> 'n'),
        'idx', (SELECT COALESCE(md5(string_agg(ic.relname||':'||pg_get_indexdef(ic.oid)||':'||
                       i.indisunique::text||i.indisvalid::text||i.indisready::text||i.indisclustered::text||i.indisreplident::text,'|' ORDER BY ic.relname)),'none')
                  FROM pg_class ic JOIN pg_index i ON i.indexrelid=ic.oid
                 WHERE i.indrelid=('public.'||t)::regclass AND NOT (v_idx7 ? ic.relname)),
        'trg', (SELECT COALESCE(md5(string_agg(tg.tgname||':'||pg_get_triggerdef(tg.oid)||':'||tg.tgenabled::text||':'||tg.tgdeferrable::text||':'||tg.tginitdeferred::text,'|' ORDER BY tg.tgname)),'none')
                  FROM pg_trigger tg WHERE tg.tgrelid=('public.'||t)::regclass AND NOT tg.tgisinternal
                    AND tg.tgname NOT IN (v_trg_pap_dup, v_trg_proj)),
        'xstat', (SELECT COALESCE(md5(string_agg(s.stxname||':'||pg_get_statisticsobjdef(s.oid),'|' ORDER BY s.stxname)),'none')
                  FROM pg_statistic_ext s WHERE s.stxrelid=('public.'||t)::regclass),
        'pub', (SELECT COALESCE(md5(string_agg(z.pubname||':'||z.attrs,'|' ORDER BY z.pubname,z.attrs)),'none') FROM (
                  SELECT pub.pubname AS pubname, COALESCE(pr.prattrs::text,'ALL') AS attrs
                    FROM pg_publication_rel pr JOIN pg_publication pub ON pub.oid=pr.prpubid
                   WHERE pr.prrelid=('public.'||t)::regclass
                  UNION ALL SELECT pub.pubname,'FOR_ALL_TABLES' FROM pg_publication pub WHERE pub.puballtables) z),
        'seclab', (SELECT COALESCE(md5(string_agg(sl.provider||':'||sl.objsubid::text||':'||sl.label,'|' ORDER BY sl.provider,sl.objsubid)),'none')
                  FROM pg_seclabel sl WHERE sl.classoid='pg_class'::regclass AND sl.objoid=('public.'||t)::regclass),
        'comment', (SELECT COALESCE(obj_description(('public.'||t)::regclass,'pg_class'),'-')),
        'seq', (SELECT COALESCE(md5(string_agg(dc.relname||':'||d.deptype::text,'|' ORDER BY dc.relname)),'none')
                  FROM pg_depend d JOIN pg_class dc ON dc.oid=d.objid AND dc.relkind='S'
                 WHERE d.refobjid=('public.'||t)::regclass AND d.refclassid='pg_class'::regclass),
        'cols', (SELECT md5(string_agg(a.attname||':'||a.atttypid::text||':'||format_type(a.atttypid,a.atttypmod)||':'||
                        -- mask the intentionally-changed attributes; keep all others
                        (CASE WHEN t='study_type_pool' AND a.attname='created_at' THEN '<nn>' ELSE a.attnotnull::text END)||':'||
                        (CASE WHEN a.attname='created_at' OR (t='tags' AND a.attname='color') THEN '<def>' ELSE COALESCE(pg_get_expr(ad.adbin,ad.adrelid),'-') END)||':'||
                        a.attgenerated::text||':'||a.attidentity::text||':'||a.attcollation::text||':'||a.attstorage::text||':'||
                        COALESCE(a.attcompression::text,'')||':'||COALESCE(a.attstattarget::text,'-')||':'||COALESCE(a.attacl::text,'-')||':'||
                        COALESCE(col_description(a.attrelid,a.attnum),'-')||':'||
                        (SELECT COALESCE(md5(string_agg(sl.provider||'='||sl.label,',' ORDER BY sl.provider)),'-')
                           FROM pg_seclabel sl WHERE sl.classoid='pg_class'::regclass AND sl.objoid=a.attrelid AND sl.objsubid=a.attnum),
                        '|' ORDER BY a.attname))
                   FROM pg_attribute a LEFT JOIN pg_attrdef ad ON ad.adrelid=a.attrelid AND ad.adnum=a.attnum
                  WHERE a.attrelid=('public.'||t)::regclass AND a.attnum>0 AND NOT a.attisdropped
                    AND NOT (t='projects' AND a.attname='updated_at'))
      ) INTO v_prov_post;
      v_prov_pre := v_prov_pre || jsonb_build_object(t, v_prov_post);

      EXECUTE format('SELECT count(*) FROM public.%I', t) INTO v_cnt;
      v_rows_pre := v_rows_pre || jsonb_build_object(t, v_cnt);
      IF t = 'projects' THEN
        SELECT COALESCE(md5(string_agg(rh,'|' ORDER BY rh)),'empty')
          INTO v_txt FROM (SELECT md5((to_jsonb(p.*) - 'updated_at')::text) AS rh FROM public.projects p) q;
      ELSE
        EXECUTE format('SELECT COALESCE(md5(string_agg(rh,''|'' ORDER BY rh)),''empty'') FROM (SELECT md5(to_jsonb(x.*)::text) AS rh FROM public.%I x) q', t) INTO v_txt;
      END IF;
      v_data_pre := v_data_pre || jsonb_build_object(t, v_txt);
    END LOOP;

    IF v_pass = 1 THEN
      FOREACH t IN ARRAY v_all_tables LOOP
        EXECUTE format('LOCK TABLE public.%I IN ACCESS EXCLUSIVE MODE', t);
      END LOOP;
    END IF;
  END LOOP;

  ------------------------------------------------------------------
  -- Phase B — bounded convergence DDL.
  ------------------------------------------------------------------
  IF v_state = 'S1' THEN
    EXECUTE format('DROP TRIGGER %I ON public.projects', v_trg_proj);
    ALTER TABLE public.projects DROP COLUMN updated_at;
    EXECUTE format('DROP TRIGGER %I ON public.papers', v_trg_pap_dup);
    EXECUTE format('ALTER TABLE public.tags ALTER COLUMN color SET DEFAULT %s', v_color_canon);
    ALTER TABLE public.study_type_pool ALTER COLUMN created_at SET NOT NULL;
    FOR m IN SELECT key AS idxname FROM jsonb_object_keys(v_idx7) AS key LOOP
      EXECUTE format('DROP INDEX public.%I', m.idxname);
    END LOOP;
    RAISE NOTICE 'RECON-METADATA-PARITY-001: Phase B (S1) — dropped projects.updated_at (+trigger), papers duplicate trigger, 7 indexes; tags.color -> canonical; study_type_pool.created_at -> NOT NULL';
  END IF;

  FOREACH t IN ARRAY v_ca_tables LOOP
    SELECT COALESCE(pg_get_expr(ad.adbin,ad.adrelid),'-') INTO v_k
      FROM pg_attribute a LEFT JOIN pg_attrdef ad ON ad.adrelid=a.attrelid AND ad.adnum=a.attnum
     WHERE a.attrelid=('public.'||t)::regclass AND a.attname='created_at';
    IF v_k = v_utc THEN
      EXECUTE format('ALTER TABLE public.%I ALTER COLUMN created_at SET DEFAULT now()', t);
    ELSIF v_k <> v_now THEN
      RAISE EXCEPTION 'RECON-METADATA-PARITY-001: Phase B — public.%.created_at default drifted to % mid-migration', t, v_k;
    END IF;
  END LOOP;
  IF v_state = 'S2' THEN
    RAISE NOTICE 'RECON-METADATA-PARITY-001: Phase B (S2) — converged 8 created_at defaults to now() (all other items already canonical)';
  END IF;

  ------------------------------------------------------------------
  -- Phase C — exact canonical postconditions + preservation re-proof.
  ------------------------------------------------------------------
  -- Canonical column end state (re-drive the manifest at the canonical target).
  FOR m IN SELECT * FROM jsonb_to_recordset(v_manifest)
           AS x(tbl text, col text, s1_att int, s2_att int, typoid oid, typmod int,
                rtype text, coll oid, storage "char", s1_nn boolean, s2_nn boolean,
                s1_def text, s2_def text) LOOP
    IF m.tbl='projects' AND m.col='updated_at' THEN
      PERFORM 1 FROM pg_attribute a WHERE a.attrelid='public.projects'::regclass AND a.attname='updated_at' AND a.attnum>0 AND NOT a.attisdropped;
      IF FOUND THEN RAISE EXCEPTION 'RECON-METADATA-PARITY-001: Phase C — projects.updated_at still present'; END IF;
      CONTINUE;
    END IF;
    SELECT a.attnotnull, COALESCE(pg_get_expr(ad.adbin,ad.adrelid),'-') INTO v_bool, v_k
      FROM pg_attribute a LEFT JOIN pg_attrdef ad ON ad.adrelid=a.attrelid AND ad.adnum=a.attnum
     WHERE a.attrelid=('public.'||m.tbl)::regclass AND a.attname=m.col;
    IF m.col='created_at' AND v_k <> v_now THEN RAISE EXCEPTION 'RECON-METADATA-PARITY-001: Phase C — %.created_at default is % (expected now())', m.tbl, v_k; END IF;
    IF m.tbl='tags' AND m.col='color' AND v_k <> v_color_canon THEN RAISE EXCEPTION 'RECON-METADATA-PARITY-001: Phase C — tags.color default is % (expected %)', v_k, v_color_canon; END IF;
    IF m.tbl='study_type_pool' AND m.col='created_at' AND NOT v_bool THEN RAISE EXCEPTION 'RECON-METADATA-PARITY-001: Phase C — study_type_pool.created_at is not NOT NULL'; END IF;
  END LOOP;

  PERFORM 1 FROM pg_trigger tg WHERE tg.tgrelid='public.projects'::regclass AND tg.tgname=v_trg_proj AND NOT tg.tgisinternal;
  IF FOUND THEN RAISE EXCEPTION 'RECON-METADATA-PARITY-001: Phase C — update_projects_updated_at still present'; END IF;
  SELECT pg_get_triggerdef(tg.oid), tg.tgenabled INTO v_txt, v_k FROM pg_trigger tg
   WHERE tg.tgrelid='public.papers'::regclass AND tg.tgname=v_trg_keep AND NOT tg.tgisinternal;
  IF v_txt IS DISTINCT FROM v_trg_keep_def OR v_k IS DISTINCT FROM 'O' THEN
    RAISE EXCEPTION 'RECON-METADATA-PARITY-001: Phase C — canonical papers trigger missing/altered/disabled';
  END IF;
  PERFORM 1 FROM pg_trigger tg WHERE tg.tgrelid='public.papers'::regclass AND tg.tgname=v_trg_pap_dup AND NOT tg.tgisinternal;
  IF FOUND THEN RAISE EXCEPTION 'RECON-METADATA-PARITY-001: Phase C — duplicate papers trigger still present'; END IF;

  FOR m IN SELECT key AS idxname FROM jsonb_object_keys(v_idx7) AS key LOOP
    PERFORM 1 FROM pg_class ic WHERE ic.relnamespace='public'::regnamespace AND ic.relname=m.idxname AND ic.relkind='i';
    IF FOUND THEN RAISE EXCEPTION 'RECON-METADATA-PARITY-001: Phase C — index % still present', m.idxname; END IF;
  END LOOP;

  -- Routine inventory unchanged (re-proved).
  SELECT count(*),
         md5(string_agg(
           n.nspname||'|'||p.proname||'|'||pg_get_function_identity_arguments(p.oid)||'|'||
           pg_get_function_result(p.oid)||'|'||p.prokind::text||'|'||l.lanname||'|'||
           p.prosecdef::text||'|'||p.provolatile::text||'|'||p.proisstrict::text||'|'||
           p.proleakproof::text||'|'||p.proparallel::text||'|'||
           COALESCE(array_to_string(p.proconfig,','),'-')||'|'||md5(p.prosrc),
           chr(10) ORDER BY p.proname, pg_get_function_identity_arguments(p.oid))),
         md5(string_agg(
           n.nspname||'|'||p.proname||'|'||pg_get_function_identity_arguments(p.oid)||'|'||
           pg_get_function_result(p.oid)||'|'||p.prokind::text||'|'||l.lanname||'|'||
           p.prosecdef::text||'|'||p.provolatile::text||'|'||p.proisstrict::text||'|'||
           p.proleakproof::text||'|'||p.proparallel::text||'|'||
           COALESCE(array_to_string(p.proconfig,','),'-')||'|'||
           pg_get_userbyid(p.proowner)||'|'||COALESCE(p.proacl::text,'-')||'|'||md5(p.prosrc),
           chr(10) ORDER BY p.proname, pg_get_function_identity_arguments(p.oid)))
    INTO v_rt_count, v_rt_beh, v_rt_full
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang
   WHERE n.nspname='public';
  IF (v_rt_beh||'/'||v_rt_full||'/'||v_rt_count::text) IS DISTINCT FROM (v_prov_pre ->> '_routines') THEN
    RAISE EXCEPTION 'RECON-METADATA-PARITY-001: Phase C — public routine inventory changed';
  END IF;

  -- Preserved inventory + row counts + remaining-data fingerprints byte-identical.
  FOREACH t IN ARRAY v_all_tables LOOP
    SELECT jsonb_build_object(
      'kind_owner_acl_rls', (SELECT c.relkind::text||'/'||pg_get_userbyid(c.relowner)||'/'||COALESCE(c.relacl::text,'-')||'/'||
                             c.relrowsecurity::text||'/'||c.relforcerowsecurity::text||'/'||COALESCE(c.relreplident::text,'-')
                               FROM pg_class c WHERE c.oid=('public.'||t)::regclass),
      'pol', (SELECT COALESCE(md5(string_agg(pol.polname||':'||pol.polcmd::text||':'||pol.polpermissive::text||':'||
                     COALESCE(array_to_string(ARRAY(SELECT pg_get_userbyid(ur) FROM unnest(pol.polroles) ur ORDER BY 1),','),'-')||':'||
                     COALESCE(pg_get_expr(pol.polqual,pol.polrelid),'-')||':'||
                     COALESCE(pg_get_expr(pol.polwithcheck,pol.polrelid),'-'),'|' ORDER BY pol.polname)),'none')
                FROM pg_policy pol WHERE pol.polrelid=('public.'||t)::regclass),
      'con', (SELECT COALESCE(md5(string_agg(c.conname||':'||pg_get_constraintdef(c.oid),'|' ORDER BY c.conname)),'none')
                FROM pg_constraint c WHERE c.conrelid=('public.'||t)::regclass AND c.contype <> 'n'),
      'idx', (SELECT COALESCE(md5(string_agg(ic.relname||':'||pg_get_indexdef(ic.oid)||':'||
                     i.indisunique::text||i.indisvalid::text||i.indisready::text||i.indisclustered::text||i.indisreplident::text,'|' ORDER BY ic.relname)),'none')
                FROM pg_class ic JOIN pg_index i ON i.indexrelid=ic.oid
               WHERE i.indrelid=('public.'||t)::regclass AND NOT (v_idx7 ? ic.relname)),
      'trg', (SELECT COALESCE(md5(string_agg(tg.tgname||':'||pg_get_triggerdef(tg.oid)||':'||tg.tgenabled::text||':'||tg.tgdeferrable::text||':'||tg.tginitdeferred::text,'|' ORDER BY tg.tgname)),'none')
                FROM pg_trigger tg WHERE tg.tgrelid=('public.'||t)::regclass AND NOT tg.tgisinternal
                  AND tg.tgname NOT IN (v_trg_pap_dup, v_trg_proj)),
      'xstat', (SELECT COALESCE(md5(string_agg(s.stxname||':'||pg_get_statisticsobjdef(s.oid),'|' ORDER BY s.stxname)),'none')
                FROM pg_statistic_ext s WHERE s.stxrelid=('public.'||t)::regclass),
      'pub', (SELECT COALESCE(md5(string_agg(z.pubname||':'||z.attrs,'|' ORDER BY z.pubname,z.attrs)),'none') FROM (
                SELECT pub.pubname AS pubname, COALESCE(pr.prattrs::text,'ALL') AS attrs
                  FROM pg_publication_rel pr JOIN pg_publication pub ON pub.oid=pr.prpubid
                 WHERE pr.prrelid=('public.'||t)::regclass
                UNION ALL SELECT pub.pubname,'FOR_ALL_TABLES' FROM pg_publication pub WHERE pub.puballtables) z),
      'seclab', (SELECT COALESCE(md5(string_agg(sl.provider||':'||sl.objsubid::text||':'||sl.label,'|' ORDER BY sl.provider,sl.objsubid)),'none')
                FROM pg_seclabel sl WHERE sl.classoid='pg_class'::regclass AND sl.objoid=('public.'||t)::regclass),
      'comment', (SELECT COALESCE(obj_description(('public.'||t)::regclass,'pg_class'),'-')),
      'seq', (SELECT COALESCE(md5(string_agg(dc.relname||':'||d.deptype::text,'|' ORDER BY dc.relname)),'none')
                FROM pg_depend d JOIN pg_class dc ON dc.oid=d.objid AND dc.relkind='S'
               WHERE d.refobjid=('public.'||t)::regclass AND d.refclassid='pg_class'::regclass),
      'cols', (SELECT md5(string_agg(a.attname||':'||a.atttypid::text||':'||format_type(a.atttypid,a.atttypmod)||':'||
                      (CASE WHEN t='study_type_pool' AND a.attname='created_at' THEN '<nn>' ELSE a.attnotnull::text END)||':'||
                      (CASE WHEN a.attname='created_at' OR (t='tags' AND a.attname='color') THEN '<def>' ELSE COALESCE(pg_get_expr(ad.adbin,ad.adrelid),'-') END)||':'||
                      a.attgenerated::text||':'||a.attidentity::text||':'||a.attcollation::text||':'||a.attstorage::text||':'||
                      COALESCE(a.attcompression::text,'')||':'||COALESCE(a.attstattarget::text,'-')||':'||COALESCE(a.attacl::text,'-')||':'||
                      COALESCE(col_description(a.attrelid,a.attnum),'-')||':'||
                      (SELECT COALESCE(md5(string_agg(sl.provider||'='||sl.label,',' ORDER BY sl.provider)),'-')
                         FROM pg_seclabel sl WHERE sl.classoid='pg_class'::regclass AND sl.objoid=a.attrelid AND sl.objsubid=a.attnum),
                      '|' ORDER BY a.attname))
                 FROM pg_attribute a LEFT JOIN pg_attrdef ad ON ad.adrelid=a.attrelid AND ad.adnum=a.attnum
                WHERE a.attrelid=('public.'||t)::regclass AND a.attnum>0 AND NOT a.attisdropped
                  AND NOT (t='projects' AND a.attname='updated_at'))
    ) INTO v_prov_post;
    IF v_prov_post IS DISTINCT FROM v_prov_pre -> t THEN
      RAISE EXCEPTION 'RECON-METADATA-PARITY-001: Phase C — preserved inventory of public.% changed: % vs %', t, v_prov_pre -> t, v_prov_post;
    END IF;

    EXECUTE format('SELECT count(*) FROM public.%I', t) INTO v_cnt;
    IF v_cnt <> (v_rows_pre ->> t)::bigint THEN
      RAISE EXCEPTION 'RECON-METADATA-PARITY-001: Phase C — public.% row count changed (% -> %)', t, v_rows_pre ->> t, v_cnt;
    END IF;
    IF t = 'projects' THEN
      SELECT COALESCE(md5(string_agg(rh,'|' ORDER BY rh)),'empty')
        INTO v_txt FROM (SELECT md5(to_jsonb(p.*)::text) AS rh FROM public.projects p) q;
    ELSE
      EXECUTE format('SELECT COALESCE(md5(string_agg(rh,''|'' ORDER BY rh)),''empty'') FROM (SELECT md5(to_jsonb(x.*)::text) AS rh FROM public.%I x) q', t) INTO v_txt;
    END IF;
    IF v_txt IS DISTINCT FROM (v_data_pre ->> t) THEN
      RAISE EXCEPTION 'RECON-METADATA-PARITY-001: Phase C — remaining-data fingerprint of public.% changed', t;
    END IF;
  END LOOP;

  RAISE NOTICE 'RECON-METADATA-PARITY-001: Phase C passed — canonical end state verified (started as %)', v_state;
END;
$recon$;
