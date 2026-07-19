-- RECON-METADATA-PARITY-001 — reconcile the remaining public-schema metadata
-- drift between a clean local replay and the linked production project, under
-- docs/schema-reconciliation.md §5 item 5 and the canonical rules in the task
-- spec (§7). This is the fifth and final schema-reconciliation migration.
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
-- Canonical end state (both states converge here):
--   * projects.updated_at column absent; update_projects_updated_at absent
--   * papers keeps exactly one updated_at trigger: trg_papers_updated_at
--     (BEFORE UPDATE … EXECUTE FUNCTION set_updated_at()); update_papers_updated_at absent
--   * created_at default = now() on the eight drifted tables
--   * study_type_pool.created_at NOT NULL (default now())
--   * tags.color default = '#e2e8f0'
--   * the seven redundant single-column indexes absent (production's covering
--     composite/unique indexes are the active query contract and are preserved)
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
-- validation runs twice — pre-lock and again under ACCESS EXCLUSIVE — and any
-- failure rolls back the whole migration transaction.

DO $recon$
DECLARE
  -- eight locked tables (deterministic order) = created_at convergence targets
  v_all_tables CONSTANT text[] := ARRAY[
    'keyword_exclusion_pool','keyword_pool','papers','projects',
    'study_type_exclusion_pool','study_type_pool','synonym_pool','tags'];
  v_ca_tables  CONSTANT text[] := ARRAY[
    'keyword_exclusion_pool','keyword_pool','papers','projects',
    'study_type_exclusion_pool','study_type_pool','synonym_pool','tags'];

  -- seven redundant single-column btree indexes (canonical: absent) + exact defs
  v_idx7 CONSTANT jsonb := jsonb_build_object(
    'idx_papers_doi',           'CREATE INDEX idx_papers_doi ON public.papers USING btree (doi)',
    'idx_papers_pmid',          'CREATE INDEX idx_papers_pmid ON public.papers USING btree (pmid)',
    'idx_papers_user_id',       'CREATE INDEX idx_papers_user_id ON public.papers USING btree (user_id)',
    'idx_papers_year',          'CREATE INDEX idx_papers_year ON public.papers USING btree (year)',
    'idx_projects_user_id',     'CREATE INDEX idx_projects_user_id ON public.projects USING btree (user_id)',
    'idx_synonym_pool_user_id', 'CREATE INDEX idx_synonym_pool_user_id ON public.synonym_pool USING btree (user_id)',
    'idx_tags_user_id',         'CREATE INDEX idx_tags_user_id ON public.tags USING btree (user_id)');

  -- canonical / state default expressions (deparsed pg_get_expr form)
  v_now         CONSTANT text := 'now()';
  v_utc         CONSTANT text := 'timezone(''utc''::text, now())';
  v_color_s1    CONSTANT text := '''#8b5cf6''::text';
  v_color_canon CONSTANT text := '''#e2e8f0''::text';

  -- canonical papers trigger (must always survive) and the removable duplicates
  v_trg_keep     CONSTANT text := 'trg_papers_updated_at';
  v_trg_keep_def CONSTANT text := 'CREATE TRIGGER trg_papers_updated_at BEFORE UPDATE ON public.papers FOR EACH ROW EXECUTE FUNCTION set_updated_at()';
  v_trg_pap_dup  CONSTANT text := 'update_papers_updated_at';
  v_trg_pap_def  CONSTANT text := 'CREATE TRIGGER update_papers_updated_at BEFORE UPDATE ON public.papers FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()';
  v_trg_proj     CONSTANT text := 'update_projects_updated_at';
  v_trg_proj_def CONSTANT text := 'CREATE TRIGGER update_projects_updated_at BEFORE UPDATE ON public.projects FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()';

  v_state    text;
  v_pass     int;
  v_cnt      bigint;
  v_txt      text;
  v_k        text;
  v_bool     boolean;
  t          text;
  m          record;

  -- preservation captures (pass 2 / under-lock authoritative), re-proved in Phase C
  v_prov_pre  jsonb := '{}'::jsonb;
  v_prov_post jsonb;
  v_rows_pre  jsonb := '{}'::jsonb;
  v_data_pre  jsonb := '{}'::jsonb;
  v_funcs_pre  text;
  v_funcs_post text;
BEGIN
  ------------------------------------------------------------------
  -- Phase A: pass 1 pre-lock, pass 2 under ACCESS EXCLUSIVE lock.
  ------------------------------------------------------------------
  FOR v_pass IN 1..2 LOOP

    -- All eight tables must exist as ordinary tables.
    FOREACH t IN ARRAY v_all_tables LOOP
      PERFORM 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = t AND c.relkind = 'r';
      IF NOT FOUND THEN
        RAISE EXCEPTION 'RECON-METADATA-PARITY-001: public.% is missing or not an ordinary table', t;
      END IF;
    END LOOP;

    ----------------------------------------------------------------
    -- Global state classification via the projects.updated_at bellwether,
    -- then every other item is cross-validated against that state so a
    -- mixed / third state fails closed before any DDL.
    ----------------------------------------------------------------
    SELECT count(*) INTO v_cnt FROM pg_attribute a
     WHERE a.attrelid = 'public.projects'::regclass
       AND a.attname = 'updated_at' AND a.attnum > 0 AND NOT a.attisdropped;
    IF v_cnt = 1 THEN
      v_state := 'S1';
    ELSIF v_cnt = 0 THEN
      v_state := 'S2';
    ELSE
      RAISE EXCEPTION 'RECON-METADATA-PARITY-001: projects.updated_at classification anomaly (% live)', v_cnt;
    END IF;

    IF v_pass = 2 AND v_state <> (v_prov_pre ->> '_state') THEN
      RAISE EXCEPTION 'RECON-METADATA-PARITY-001: global state changed under lock (% -> %)', v_prov_pre ->> '_state', v_state;
    END IF;

    ----------------------------------------------------------------
    -- (A1) projects.updated_at column + its update trigger
    ----------------------------------------------------------------
    IF v_state = 'S1' THEN
      SELECT format_type(a.atttypid,a.atttypmod)||'/'||a.attnotnull::text||'/'||
             COALESCE(pg_get_expr(ad.adbin,ad.adrelid),'-')||'/'||a.attgenerated::text
        INTO v_txt
        FROM pg_attribute a LEFT JOIN pg_attrdef ad ON ad.adrelid=a.attrelid AND ad.adnum=a.attnum
       WHERE a.attrelid='public.projects'::regclass AND a.attname='updated_at';
      IF v_txt <> 'timestamp with time zone/true/now()/' THEN
        RAISE EXCEPTION 'RECON-METADATA-PARITY-001: projects.updated_at has unexpected shape (%)', v_txt;
      END IF;
      -- no dependency beyond its own default (no index / constraint reference)
      SELECT count(*) INTO v_cnt FROM pg_index i
       WHERE i.indrelid='public.projects'::regclass
         AND (SELECT a.attnum FROM pg_attribute a WHERE a.attrelid='public.projects'::regclass AND a.attname='updated_at')
             = ANY(string_to_array(i.indkey::text,' ')::int2[]);
      IF v_cnt <> 0 THEN RAISE EXCEPTION 'RECON-METADATA-PARITY-001: projects.updated_at is indexed'; END IF;
      SELECT count(*) INTO v_cnt FROM pg_constraint c
       WHERE c.conrelid='public.projects'::regclass
         AND (SELECT a.attnum FROM pg_attribute a WHERE a.attrelid='public.projects'::regclass AND a.attname='updated_at') = ANY(c.conkey);
      IF v_cnt <> 0 THEN RAISE EXCEPTION 'RECON-METADATA-PARITY-001: projects.updated_at appears in a constraint'; END IF;
      -- exact matching update trigger present and enabled
      SELECT pg_get_triggerdef(tg.oid), tg.tgenabled INTO v_txt, v_k FROM pg_trigger tg
       WHERE tg.tgrelid='public.projects'::regclass AND tg.tgname=v_trg_proj AND NOT tg.tgisinternal;
      IF v_txt IS DISTINCT FROM v_trg_proj_def OR v_k IS DISTINCT FROM 'O' THEN
        RAISE EXCEPTION 'RECON-METADATA-PARITY-001: update_projects_updated_at trigger missing/altered/disabled (def=%, enabled=%)', COALESCE(v_txt,'<absent>'), COALESCE(v_k,'<absent>');
      END IF;
    ELSE
      PERFORM 1 FROM pg_trigger tg WHERE tg.tgrelid='public.projects'::regclass AND tg.tgname=v_trg_proj AND NOT tg.tgisinternal;
      IF FOUND THEN RAISE EXCEPTION 'RECON-METADATA-PARITY-001: S2 but update_projects_updated_at present'; END IF;
    END IF;
    -- projects must never carry any OTHER updated_at-maintaining trigger
    SELECT count(*) INTO v_cnt FROM pg_trigger tg JOIN pg_proc p ON p.oid=tg.tgfoid
     WHERE tg.tgrelid='public.projects'::regclass AND NOT tg.tgisinternal
       AND p.proname IN ('set_updated_at','update_updated_at_column')
       AND tg.tgname <> v_trg_proj;
    IF v_cnt <> 0 THEN RAISE EXCEPTION 'RECON-METADATA-PARITY-001: unexpected extra updated_at trigger on projects (%)', v_cnt; END IF;

    ----------------------------------------------------------------
    -- (A2) papers updated_at triggers — canonical trigger must always
    -- exist; the duplicate is present iff S1.
    ----------------------------------------------------------------
    SELECT pg_get_triggerdef(tg.oid), tg.tgenabled INTO v_txt, v_k FROM pg_trigger tg
     WHERE tg.tgrelid='public.papers'::regclass AND tg.tgname=v_trg_keep AND NOT tg.tgisinternal;
    IF v_txt IS DISTINCT FROM v_trg_keep_def THEN
      RAISE EXCEPTION 'RECON-METADATA-PARITY-001: canonical papers trigger % missing or altered (%)', v_trg_keep, COALESCE(v_txt,'<absent>');
    END IF;
    IF v_k IS DISTINCT FROM 'O' THEN
      RAISE EXCEPTION 'RECON-METADATA-PARITY-001: canonical papers trigger % is not enabled (tgenabled=%)', v_trg_keep, COALESCE(v_k,'<absent>');
    END IF;
    SELECT pg_get_triggerdef(tg.oid), tg.tgenabled INTO v_txt, v_k FROM pg_trigger tg
     WHERE tg.tgrelid='public.papers'::regclass AND tg.tgname=v_trg_pap_dup AND NOT tg.tgisinternal;
    IF v_state = 'S1' THEN
      IF v_txt IS DISTINCT FROM v_trg_pap_def OR v_k IS DISTINCT FROM 'O' THEN
        RAISE EXCEPTION 'RECON-METADATA-PARITY-001: S1 but duplicate papers trigger missing/altered/disabled (def=%, enabled=%)', COALESCE(v_txt,'<absent>'), COALESCE(v_k,'<absent>');
      END IF;
    ELSE
      IF v_txt IS NOT NULL THEN
        RAISE EXCEPTION 'RECON-METADATA-PARITY-001: S2 but duplicate papers trigger present';
      END IF;
    END IF;
    -- no THIRD updated_at trigger on papers beyond the two known names
    SELECT count(*) INTO v_cnt FROM pg_trigger tg JOIN pg_proc p ON p.oid=tg.tgfoid
     WHERE tg.tgrelid='public.papers'::regclass AND NOT tg.tgisinternal
       AND p.proname IN ('set_updated_at','update_updated_at_column')
       AND tg.tgname NOT IN (v_trg_keep, v_trg_pap_dup);
    IF v_cnt <> 0 THEN RAISE EXCEPTION 'RECON-METADATA-PARITY-001: unexpected extra updated_at trigger on papers (%)', v_cnt; END IF;

    ----------------------------------------------------------------
    -- (A3) created_at defaults on the eight tables — each must be exactly
    -- now() (S1) or timezone('utc', now()) (S2); column must be timestamptz.
    ----------------------------------------------------------------
    FOREACH t IN ARRAY v_ca_tables LOOP
      SELECT format_type(a.atttypid,a.atttypmod), COALESCE(pg_get_expr(ad.adbin,ad.adrelid),'-')
        INTO v_txt, v_k
        FROM pg_attribute a LEFT JOIN pg_attrdef ad ON ad.adrelid=a.attrelid AND ad.adnum=a.attnum
       WHERE a.attrelid=('public.'||t)::regclass AND a.attname='created_at' AND a.attnum>0 AND NOT a.attisdropped;
      IF NOT FOUND THEN RAISE EXCEPTION 'RECON-METADATA-PARITY-001: public.%.created_at missing', t; END IF;
      IF v_txt <> 'timestamp with time zone' THEN
        RAISE EXCEPTION 'RECON-METADATA-PARITY-001: public.%.created_at is % (expected timestamptz)', t, v_txt;
      END IF;
      IF v_state = 'S1' AND v_k <> v_now THEN
        RAISE EXCEPTION 'RECON-METADATA-PARITY-001: S1 but public.%.created_at default is % (expected now())', t, v_k;
      ELSIF v_state = 'S2' AND v_k <> v_utc THEN
        RAISE EXCEPTION 'RECON-METADATA-PARITY-001: S2 but public.%.created_at default is % (expected timezone utc)', t, v_k;
      END IF;
    END LOOP;

    ----------------------------------------------------------------
    -- (A4) study_type_pool.created_at nullability — NULLABLE (S1) / NOT
    -- NULL (S2); ZERO NULLs required either way (rechecked under lock).
    ----------------------------------------------------------------
    SELECT a.attnotnull INTO v_bool FROM pg_attribute a
     WHERE a.attrelid='public.study_type_pool'::regclass AND a.attname='created_at';
    IF v_state = 'S1' AND v_bool THEN
      RAISE EXCEPTION 'RECON-METADATA-PARITY-001: S1 but study_type_pool.created_at already NOT NULL';
    ELSIF v_state = 'S2' AND NOT v_bool THEN
      RAISE EXCEPTION 'RECON-METADATA-PARITY-001: S2 but study_type_pool.created_at is nullable';
    END IF;
    SELECT count(*) INTO v_cnt FROM public.study_type_pool WHERE created_at IS NULL;
    IF v_cnt <> 0 THEN
      RAISE EXCEPTION 'RECON-METADATA-PARITY-001: study_type_pool.created_at has % NULL row(s); refusing NOT NULL', v_cnt;
    END IF;

    ----------------------------------------------------------------
    -- (A5) tags.color default — '#8b5cf6' (S1) / '#e2e8f0' (S2); text, nullable.
    ----------------------------------------------------------------
    SELECT format_type(a.atttypid,a.atttypmod)||'/'||a.attnotnull::text,
           COALESCE(pg_get_expr(ad.adbin,ad.adrelid),'-')
      INTO v_txt, v_k
      FROM pg_attribute a LEFT JOIN pg_attrdef ad ON ad.adrelid=a.attrelid AND ad.adnum=a.attnum
     WHERE a.attrelid='public.tags'::regclass AND a.attname='color';
    IF v_txt <> 'text/false' THEN
      RAISE EXCEPTION 'RECON-METADATA-PARITY-001: tags.color has unexpected type/nullability (%)', v_txt;
    END IF;
    IF v_state = 'S1' AND v_k <> v_color_s1 THEN
      RAISE EXCEPTION 'RECON-METADATA-PARITY-001: S1 but tags.color default is % (expected %)', v_k, v_color_s1;
    ELSIF v_state = 'S2' AND v_k <> v_color_canon THEN
      RAISE EXCEPTION 'RECON-METADATA-PARITY-001: S2 but tags.color default is % (expected %)', v_k, v_color_canon;
    END IF;

    ----------------------------------------------------------------
    -- (A6) seven redundant indexes — present with EXACT expected def
    -- (non-unique, not constraint-backed) in S1; absent in S2. A same-name
    -- but wrong-definition index fails.
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
        SELECT count(*) INTO v_cnt FROM pg_constraint c
         JOIN pg_class ic ON ic.oid=c.conindid
         WHERE ic.relname=m.idxname AND ic.relnamespace='public'::regnamespace;
        IF v_cnt <> 0 THEN RAISE EXCEPTION 'RECON-METADATA-PARITY-001: index % backs a constraint; refusing to drop', m.idxname; END IF;
      ELSE
        IF v_txt IS NOT NULL THEN
          RAISE EXCEPTION 'RECON-METADATA-PARITY-001: S2 but index % is present', m.idxname;
        END IF;
      END IF;
    END LOOP;

    ----------------------------------------------------------------
    -- Preservation captures + function inventory + row counts + data
    -- fingerprints. Pass 2 (under lock) is the authoritative pre-DDL image.
    ----------------------------------------------------------------
    v_prov_pre := jsonb_build_object('_state', v_state);
    v_rows_pre := '{}'::jsonb;
    v_data_pre := '{}'::jsonb;
    FOREACH t IN ARRAY v_all_tables LOOP
      -- Preserved inventory: RLS/owner/ACL, policies, NON-not-null constraints,
      -- indexes MINUS the seven intended drops, triggers MINUS the two intended
      -- drops, and columns MINUS the intentionally changed ones. Everything here
      -- must be byte-identical in Phase C.
      SELECT jsonb_build_object(
        'rls', (SELECT c.relrowsecurity::text||'/'||c.relforcerowsecurity::text||'/'||
                       pg_get_userbyid(c.relowner)||'/'||COALESCE(c.relacl::text,'-')
                  FROM pg_class c WHERE c.oid=('public.'||t)::regclass),
        'pol', (SELECT COALESCE(md5(string_agg(pol.polname||':'||pol.polcmd::text||':'||
                       COALESCE(pg_get_expr(pol.polqual,pol.polrelid),'-')||':'||
                       COALESCE(pg_get_expr(pol.polwithcheck,pol.polrelid),'-'),'|' ORDER BY pol.polname)),'none')
                  FROM pg_policy pol WHERE pol.polrelid=('public.'||t)::regclass),
        'con', (SELECT COALESCE(md5(string_agg(c.conname||':'||pg_get_constraintdef(c.oid),'|' ORDER BY c.conname)),'none')
                  FROM pg_constraint c WHERE c.conrelid=('public.'||t)::regclass AND c.contype <> 'n'),
        'idx', (SELECT COALESCE(md5(string_agg(ic.relname||':'||pg_get_indexdef(ic.oid),'|' ORDER BY ic.relname)),'none')
                  FROM pg_class ic JOIN pg_index i ON i.indexrelid=ic.oid
                 WHERE i.indrelid=('public.'||t)::regclass AND NOT (v_idx7 ? ic.relname)),
        'trg', (SELECT COALESCE(md5(string_agg(tg.tgname||':'||pg_get_triggerdef(tg.oid),'|' ORDER BY tg.tgname)),'none')
                  FROM pg_trigger tg WHERE tg.tgrelid=('public.'||t)::regclass AND NOT tg.tgisinternal
                    AND tg.tgname NOT IN (v_trg_pap_dup, v_trg_proj)),
        'cols', (SELECT md5(string_agg(a.attname||':'||a.atttypid::text||':'||format_type(a.atttypid,a.atttypmod)||':'||
                        a.attnotnull::text||':'||COALESCE(pg_get_expr(ad.adbin,ad.adrelid),'-')||':'||
                        a.attgenerated::text||':'||a.attidentity::text||':'||a.attcollation::text||':'||
                        a.attstorage::text||':'||COALESCE(a.attcompression::text,'')||':'||
                        COALESCE(a.attstattarget::text,'-')||':'||COALESCE(a.attacl::text,'-')||':'||
                        COALESCE(col_description(a.attrelid,a.attnum),'-'),'|' ORDER BY a.attname))
                   FROM pg_attribute a LEFT JOIN pg_attrdef ad ON ad.adrelid=a.attrelid AND ad.adnum=a.attnum
                  WHERE a.attrelid=('public.'||t)::regclass AND a.attnum>0 AND NOT a.attisdropped
                    AND NOT (t='projects' AND a.attname='updated_at')
                    AND NOT (a.attname='created_at')
                    AND NOT (t='tags' AND a.attname='color'))
      ) INTO v_prov_post;
      v_prov_pre := v_prov_pre || jsonb_build_object(t, v_prov_post);

      EXECUTE format('SELECT count(*) FROM public.%I', t) INTO v_cnt;
      v_rows_pre := v_rows_pre || jsonb_build_object(t, v_cnt);
      IF t = 'projects' THEN
        SELECT COALESCE(md5(string_agg(rh,'|' ORDER BY rh)),'empty')
          INTO v_txt FROM (SELECT md5((to_jsonb(p.*) - 'updated_at')::text) AS rh FROM public.projects p) q;
      ELSE
        EXECUTE format(
          'SELECT COALESCE(md5(string_agg(rh,''|'' ORDER BY rh)),''empty'') FROM (SELECT md5(to_jsonb(x.*)::text) AS rh FROM public.%I x) q', t)
          INTO v_txt;
      END IF;
      v_data_pre := v_data_pre || jsonb_build_object(t, v_txt);
    END LOOP;

    SELECT md5(string_agg(p.proname||':'||pg_get_function_identity_arguments(p.oid)||':'||md5(p.prosrc),
                          '|' ORDER BY p.proname, pg_get_function_identity_arguments(p.oid)))
      INTO v_funcs_pre
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public';

    ----------------------------------------------------------------
    -- End of pass 1: take deterministic ACCESS EXCLUSIVE locks (the mode
    -- the DDL needs anyway) and rerun all checks under lock.
    ----------------------------------------------------------------
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

  -- created_at defaults -> now() wherever still timezone('utc', now()) (S2 path).
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
  -- Phase C — exact canonical postconditions + preservation.
  ------------------------------------------------------------------
  PERFORM 1 FROM pg_attribute a WHERE a.attrelid='public.projects'::regclass
     AND a.attname='updated_at' AND a.attnum>0 AND NOT a.attisdropped;
  IF FOUND THEN RAISE EXCEPTION 'RECON-METADATA-PARITY-001: Phase C — projects.updated_at still present'; END IF;
  PERFORM 1 FROM pg_trigger tg WHERE tg.tgrelid='public.projects'::regclass AND tg.tgname=v_trg_proj AND NOT tg.tgisinternal;
  IF FOUND THEN RAISE EXCEPTION 'RECON-METADATA-PARITY-001: Phase C — update_projects_updated_at still present'; END IF;

  SELECT pg_get_triggerdef(tg.oid), tg.tgenabled INTO v_txt, v_k FROM pg_trigger tg
   WHERE tg.tgrelid='public.papers'::regclass AND tg.tgname=v_trg_keep AND NOT tg.tgisinternal;
  IF v_txt IS DISTINCT FROM v_trg_keep_def OR v_k IS DISTINCT FROM 'O' THEN
    RAISE EXCEPTION 'RECON-METADATA-PARITY-001: Phase C — canonical papers trigger missing/altered/disabled';
  END IF;
  PERFORM 1 FROM pg_trigger tg WHERE tg.tgrelid='public.papers'::regclass AND tg.tgname=v_trg_pap_dup AND NOT tg.tgisinternal;
  IF FOUND THEN RAISE EXCEPTION 'RECON-METADATA-PARITY-001: Phase C — duplicate papers trigger still present'; END IF;

  FOREACH t IN ARRAY v_ca_tables LOOP
    SELECT COALESCE(pg_get_expr(ad.adbin,ad.adrelid),'-') INTO v_k
      FROM pg_attribute a LEFT JOIN pg_attrdef ad ON ad.adrelid=a.attrelid AND ad.adnum=a.attnum
     WHERE a.attrelid=('public.'||t)::regclass AND a.attname='created_at';
    IF v_k <> v_now THEN RAISE EXCEPTION 'RECON-METADATA-PARITY-001: Phase C — public.%.created_at default is % (expected now())', t, v_k; END IF;
  END LOOP;

  SELECT a.attnotnull INTO v_bool FROM pg_attribute a
   WHERE a.attrelid='public.study_type_pool'::regclass AND a.attname='created_at';
  IF NOT v_bool THEN RAISE EXCEPTION 'RECON-METADATA-PARITY-001: Phase C — study_type_pool.created_at is not NOT NULL'; END IF;

  SELECT COALESCE(pg_get_expr(ad.adbin,ad.adrelid),'-') INTO v_k
    FROM pg_attribute a LEFT JOIN pg_attrdef ad ON ad.adrelid=a.attrelid AND ad.adnum=a.attnum
   WHERE a.attrelid='public.tags'::regclass AND a.attname='color';
  IF v_k <> v_color_canon THEN RAISE EXCEPTION 'RECON-METADATA-PARITY-001: Phase C — tags.color default is % (expected %)', v_k, v_color_canon; END IF;

  FOR m IN SELECT key AS idxname FROM jsonb_object_keys(v_idx7) AS key LOOP
    PERFORM 1 FROM pg_class ic WHERE ic.relnamespace='public'::regnamespace AND ic.relname=m.idxname AND ic.relkind='i';
    IF FOUND THEN RAISE EXCEPTION 'RECON-METADATA-PARITY-001: Phase C — index % still present', m.idxname; END IF;
  END LOOP;

  -- Preservation: everything else byte-identical; row counts and remaining
  -- stored values unchanged; function inventory unchanged.
  FOREACH t IN ARRAY v_all_tables LOOP
    SELECT jsonb_build_object(
      'rls', (SELECT c.relrowsecurity::text||'/'||c.relforcerowsecurity::text||'/'||
                     pg_get_userbyid(c.relowner)||'/'||COALESCE(c.relacl::text,'-')
                FROM pg_class c WHERE c.oid=('public.'||t)::regclass),
      'pol', (SELECT COALESCE(md5(string_agg(pol.polname||':'||pol.polcmd::text||':'||
                     COALESCE(pg_get_expr(pol.polqual,pol.polrelid),'-')||':'||
                     COALESCE(pg_get_expr(pol.polwithcheck,pol.polrelid),'-'),'|' ORDER BY pol.polname)),'none')
                FROM pg_policy pol WHERE pol.polrelid=('public.'||t)::regclass),
      'con', (SELECT COALESCE(md5(string_agg(c.conname||':'||pg_get_constraintdef(c.oid),'|' ORDER BY c.conname)),'none')
                FROM pg_constraint c WHERE c.conrelid=('public.'||t)::regclass AND c.contype <> 'n'),
      'idx', (SELECT COALESCE(md5(string_agg(ic.relname||':'||pg_get_indexdef(ic.oid),'|' ORDER BY ic.relname)),'none')
                FROM pg_class ic JOIN pg_index i ON i.indexrelid=ic.oid
               WHERE i.indrelid=('public.'||t)::regclass AND NOT (v_idx7 ? ic.relname)),
      'trg', (SELECT COALESCE(md5(string_agg(tg.tgname||':'||pg_get_triggerdef(tg.oid),'|' ORDER BY tg.tgname)),'none')
                FROM pg_trigger tg WHERE tg.tgrelid=('public.'||t)::regclass AND NOT tg.tgisinternal
                  AND tg.tgname NOT IN (v_trg_pap_dup, v_trg_proj)),
      'cols', (SELECT md5(string_agg(a.attname||':'||a.atttypid::text||':'||format_type(a.atttypid,a.atttypmod)||':'||
                      a.attnotnull::text||':'||COALESCE(pg_get_expr(ad.adbin,ad.adrelid),'-')||':'||
                      a.attgenerated::text||':'||a.attidentity::text||':'||a.attcollation::text||':'||
                      a.attstorage::text||':'||COALESCE(a.attcompression::text,'')||':'||
                      COALESCE(a.attstattarget::text,'-')||':'||COALESCE(a.attacl::text,'-')||':'||
                      COALESCE(col_description(a.attrelid,a.attnum),'-'),'|' ORDER BY a.attname))
                 FROM pg_attribute a LEFT JOIN pg_attrdef ad ON ad.adrelid=a.attrelid AND ad.adnum=a.attnum
                WHERE a.attrelid=('public.'||t)::regclass AND a.attnum>0 AND NOT a.attisdropped
                  AND NOT (t='projects' AND a.attname='updated_at')
                  AND NOT (a.attname='created_at')
                  AND NOT (t='tags' AND a.attname='color'))
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
      EXECUTE format(
        'SELECT COALESCE(md5(string_agg(rh,''|'' ORDER BY rh)),''empty'') FROM (SELECT md5(to_jsonb(x.*)::text) AS rh FROM public.%I x) q', t)
        INTO v_txt;
    END IF;
    IF v_txt IS DISTINCT FROM (v_data_pre ->> t) THEN
      RAISE EXCEPTION 'RECON-METADATA-PARITY-001: Phase C — remaining-data fingerprint of public.% changed', t;
    END IF;
  END LOOP;

  SELECT md5(string_agg(p.proname||':'||pg_get_function_identity_arguments(p.oid)||':'||md5(p.prosrc),
                        '|' ORDER BY p.proname, pg_get_function_identity_arguments(p.oid)))
    INTO v_funcs_post
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public';
  IF v_funcs_post IS DISTINCT FROM v_funcs_pre THEN
    RAISE EXCEPTION 'RECON-METADATA-PARITY-001: Phase C — public function inventory changed';
  END IF;

  RAISE NOTICE 'RECON-METADATA-PARITY-001: Phase C passed — canonical end state verified (started as %)', v_state;
END;
$recon$;
