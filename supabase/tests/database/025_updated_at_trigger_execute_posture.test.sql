-- Suite 025: the updated_at triggers fire for callers that hold no EXECUTE on
-- their trigger function (DB-DEFAULT-FUNCTION-EXECUTE-HARDENING-001A, C56).
--
-- C56 (20260928133918_harden_default_function_execute.sql) made
-- public.set_updated_at() and public.update_updated_at_column() owner-only. That
-- is safe only because PostgreSQL checks EXECUTE on a trigger function when
-- CREATE TRIGGER runs, never when the trigger fires. This suite owns that runtime
-- fact for all twelve triggers the two functions serve. The catalog side — both
-- ACLs, no PUBLIC EXECUTE anywhere in `public`, the default privileges — is
-- owned by 015, and set_updated_at()'s search_path and body by 007. Nothing
-- else covers the eleven update_updated_at_column() triggers at runtime.
--
-- Asserted here, each so a failure names what broke:
--   * coverage: the live set of triggers bound to either function is exactly
--     the twelve fixture rows below (BEFORE UPDATE FOR EACH ROW, enabled, no
--     WHEN clause), and each fixture predicate selects exactly one row;
--   * the premise: none of the DML roles used here holds EXECUTE on either
--     function;
--   * a dedicated role holding no EXECUTE (only SELECT/UPDATE, and BYPASSRLS so
--     one role reaches every table) advances updated_at on all twelve tables —
--     the stored value itself, not merely an UPDATE that returned;
--   * a sensitivity control: the same statements with the twelve triggers
--     disabled leave every updated_at at its backdated value, so the check
--     above cannot pass vacuously;
--   * the real writers: `authenticated` under its own RLS claims (papers,
--     profiles, filter_presets, author_identities.preferred_name). The six
--     server-written tables are written by postgres-owned SECURITY DEFINER
--     functions and operator SQL, both covered by the no-EXECUTE role above;
--     `service_role` wrote them directly until C57 and is now refused;
--   * an ownership/RLS negative control: another user's UPDATE touches no row
--     and fires no trigger;
--   * a direct call of either function is refused with 42501 for every role
--     above, while the owner's direct call reaches the function and fails with
--     0A000 — a trigger function is not callable as a function by anyone;
--   * a contrast: the same no-EXECUTE role IS stopped (42501) by an owner-only
--     function in a column DEFAULT, while an owner-only trigger on that same
--     table still fires — so this suite would notice if PostgreSQL started
--     checking EXECUTE at trigger time, or if the privilege assumption above
--     were wrong.
--
-- Deterministic UUIDs; explicit fixtures; no TODO/SKIP; no remote calls; no
-- Production data; no real credentials. Everything, the probe role included,
-- is created inside the transaction and rolled back with it.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path TO extensions, public, pg_temp;

-- ── The twelve trigger-bearing rows ─────────────────────────────────────────
CREATE TEMP TABLE t025_rows (tbl text PRIMARY KEY, pred text NOT NULL, trg text NOT NULL, fn text NOT NULL);
INSERT INTO t025_rows VALUES
  ('ai_model_catalog',     $p$id = (SELECT min(id) FROM public.ai_model_catalog)$p$,       'update_ai_model_catalog_updated_at',     'update_updated_at_column()'),
  ('author_identities',    $p$id = '02500000-0000-0000-0000-0000000000b1'$p$,              'update_author_identities_updated_at',    'update_updated_at_column()'),
  ('filter_presets',       $p$id = '02500000-0000-0000-0000-0000000000f1'$p$,              'update_filter_presets_updated_at',       'update_updated_at_column()'),
  ('internal_user_access', $p$user_id = '02500000-0000-0000-0000-000000000001'$p$,         'update_internal_user_access_updated_at', 'update_updated_at_column()'),
  ('papers',               $p$id = '02500000-0000-0000-0000-0000000000a1'$p$,              'trg_papers_updated_at',                  'set_updated_at()'),
  ('profiles',             $p$user_id = '02500000-0000-0000-0000-000000000001'$p$,         'update_profiles_updated_at',             'update_updated_at_column()'),
  ('subscriptions',        $p$id = '02500000-0000-0000-0000-0000000000c1'$p$,              'update_subscriptions_updated_at',        'update_updated_at_column()'),
  ('usage_counters',       $p$user_id = '02500000-0000-0000-0000-000000000001'$p$,         'update_usage_counters_updated_at',       'update_updated_at_column()'),
  ('usage_credits',        $p$id = '02500000-0000-0000-0000-0000000000d1'$p$,              'update_usage_credits_updated_at',        'update_updated_at_column()'),
  ('user_ai_preferences',  $p$user_id = '02500000-0000-0000-0000-000000000001'$p$,         'update_user_ai_preferences_updated_at',  'update_updated_at_column()'),
  ('user_entitlements',    $p$user_id = '02500000-0000-0000-0000-000000000001'$p$,         'update_user_entitlements_updated_at',    'update_updated_at_column()'),
  ('user_storage_usage',   $p$user_id = '02500000-0000-0000-0000-000000000001'$p$,         'update_user_storage_usage_updated_at',   'update_updated_at_column()');

-- ── Helpers (called as the owner only) ──────────────────────────────────────
-- Backdate every fixture row to a fixed past value WITHOUT firing any trigger.
-- A SET statement, not set_config(): on Supabase, postgres may set
-- session_replication_role only through the SET command.
CREATE FUNCTION pg_temp.backdate() RETURNS void LANGUAGE plpgsql AS $hlp$
DECLARE r record;
BEGIN
  EXECUTE 'SET LOCAL session_replication_role = replica';
  FOR r IN SELECT * FROM t025_rows LOOP
    EXECUTE format($q$UPDATE public.%I SET updated_at = '2001-01-01 00:00:00+00' WHERE %s$q$, r.tbl, r.pred);
  END LOOP;
  EXECUTE 'SET LOCAL session_replication_role = origin';
END;
$hlp$;

-- 'advanced' when the row's updated_at is this transaction's now() (the
-- trigger fired), 'old' when it still holds the backdated value.
CREATE FUNCTION pg_temp.state(p_tbl text) RETURNS text LANGUAGE plpgsql AS $hlp$
DECLARE v_ts timestamptz;
BEGIN
  EXECUTE format('SELECT updated_at FROM public.%I WHERE %s', p_tbl,
                 (SELECT pred FROM t025_rows WHERE tbl = p_tbl)) INTO v_ts;
  RETURN CASE WHEN v_ts = now() THEN 'advanced'
              WHEN v_ts = '2001-01-01 00:00:00+00' THEN 'old'
              ELSE coalesce(v_ts::text, '<no row>') END;
END;
$hlp$;

CREATE FUNCTION pg_temp.errcode_as(p_role text, p_claims text, p_sql text)
RETURNS text LANGUAGE plpgsql AS $hlp$
DECLARE v_state text;
BEGIN
  PERFORM set_config('request.jwt.claims', COALESCE(p_claims, ''), true);
  EXECUTE 'SET LOCAL ROLE ' || quote_ident(p_role);
  BEGIN
    EXECUTE p_sql;
    v_state := '00000';
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
  END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN v_state;
END;
$hlp$;

CREATE FUNCTION pg_temp.rows_as(p_role text, p_claims text, p_sql text)
RETURNS integer LANGUAGE plpgsql AS $hlp$
DECLARE v_rows integer;
BEGIN
  PERFORM set_config('request.jwt.claims', COALESCE(p_claims, ''), true);
  EXECUTE 'SET LOCAL ROLE ' || quote_ident(p_role);
  EXECUTE p_sql;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN v_rows;
END;
$hlp$;

CREATE FUNCTION pg_temp.claims(p_uid text) RETURNS text LANGUAGE sql IMMUTABLE AS $hlp$
  SELECT '{"sub":"' || p_uid || '","role":"authenticated"}'
$hlp$;

-- ── Fixtures ────────────────────────────────────────────────────────────────
-- handle_new_user() creates each user's profiles, user_entitlements and
-- usage_counters rows.
INSERT INTO auth.users (id, email) VALUES
  ('02500000-0000-0000-0000-000000000001', 'c56-u1@paperlume.test'),
  ('02500000-0000-0000-0000-000000000002', 'c56-u2@paperlume.test');
INSERT INTO public.papers (id, user_id, title) VALUES
  ('02500000-0000-0000-0000-0000000000a1', '02500000-0000-0000-0000-000000000001', 'C56 paper');
INSERT INTO public.filter_presets (id, user_id, name, payload) VALUES
  ('02500000-0000-0000-0000-0000000000f1', '02500000-0000-0000-0000-000000000001', 'C56 preset', '{}'::jsonb);
INSERT INTO public.author_identities (id, user_id, preferred_name) VALUES
  ('02500000-0000-0000-0000-0000000000b1', '02500000-0000-0000-0000-000000000001', 'C56 Author');
INSERT INTO public.internal_user_access (user_id, role) VALUES ('02500000-0000-0000-0000-000000000001', 'manager');
INSERT INTO public.subscriptions (id, user_id, provider, status) VALUES
  ('02500000-0000-0000-0000-0000000000c1', '02500000-0000-0000-0000-000000000001', 'manual', 'active');
INSERT INTO public.usage_credits (id, user_id, source, quantity_granted, quantity_remaining) VALUES
  ('02500000-0000-0000-0000-0000000000d1', '02500000-0000-0000-0000-000000000001', 'promo', 5, 5);
INSERT INTO public.user_ai_preferences (user_id, preferred_model_id)
  SELECT '02500000-0000-0000-0000-000000000001', min(id) FROM public.ai_model_catalog;
INSERT INTO public.user_storage_usage (user_id) VALUES ('02500000-0000-0000-0000-000000000001');

-- The role with no EXECUTE: SELECT/UPDATE on the twelve tables, nothing else.
-- postgres creates it with ADMIN only, so it grants itself SET to switch to it.
CREATE ROLE zz_025_noexec NOLOGIN BYPASSRLS;
GRANT zz_025_noexec TO postgres WITH INHERIT FALSE, SET TRUE;
GRANT USAGE ON SCHEMA public TO zz_025_noexec;
GRANT SELECT, UPDATE ON public.ai_model_catalog, public.author_identities, public.filter_presets,
                        public.internal_user_access, public.papers, public.profiles, public.subscriptions,
                        public.usage_counters, public.usage_credits, public.user_ai_preferences,
                        public.user_entitlements, public.user_storage_usage TO zz_025_noexec;

-- 1 + 1 + 1 (coverage, fixtures, premise) + 12 (no-EXECUTE role) + 2 (disabled
-- control, re-enabled) + 4 (authenticated) + 6 (service_role refused) + 1 (RLS)
-- + 2 (direct calls) + 3 (contrast) = 33
SELECT plan(33);

-- ══ 1. Coverage, fixtures and the premise ═══════════════════════════════════
SELECT is(
  (SELECT string_agg(c.relname || '.' || t.tgname || '=' || t.tgfoid::regprocedure::text || '|' || t.tgtype::text
                     || '|' || t.tgenabled::text || '|' || (t.tgqual IS NULL)::text, ', ' ORDER BY c.relname, t.tgname)
     FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE t.tgfoid IN (to_regprocedure('public.set_updated_at()'), to_regprocedure('public.update_updated_at_column()'))),
  (SELECT string_agg(tbl || '.' || trg || '=' || fn || '|19|O|true', ', ' ORDER BY tbl, trg) FROM t025_rows),
  'coverage: the triggers bound to the two functions are exactly the twelve fixture rows, BEFORE UPDATE FOR EACH ROW, enabled, no WHEN');

SELECT is(
  (SELECT coalesce(string_agg(r.tbl, ', ' ORDER BY r.tbl), '')
     FROM t025_rows r
    WHERE (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM public.%I WHERE %s', r.tbl, r.pred), false, true, '')))[1]::text::int <> 1),
  '',
  'fixtures: every predicate selects exactly one row');

SELECT is(
  (SELECT coalesce(string_agg(r || ' -> ' || f, ', ' ORDER BY r, f), '')
     FROM unnest(ARRAY['zz_025_noexec','anon','authenticated','service_role']) r,
          unnest(ARRAY['public.set_updated_at()','public.update_updated_at_column()']) f
    WHERE has_function_privilege(to_regrole(r)::oid, to_regprocedure(f), 'EXECUTE')),
  '',
  'premise: no role used below holds EXECUTE on either trigger function');

-- ══ 2. A role with no EXECUTE fires all twelve ══════════════════════════════
SELECT pg_temp.backdate();
SET LOCAL ROLE zz_025_noexec;
UPDATE public.ai_model_catalog     SET updated_at = updated_at WHERE id = (SELECT min(id) FROM public.ai_model_catalog);
UPDATE public.author_identities    SET updated_at = updated_at WHERE id = '02500000-0000-0000-0000-0000000000b1';
UPDATE public.filter_presets       SET updated_at = updated_at WHERE id = '02500000-0000-0000-0000-0000000000f1';
UPDATE public.internal_user_access SET updated_at = updated_at WHERE user_id = '02500000-0000-0000-0000-000000000001';
UPDATE public.papers               SET updated_at = updated_at WHERE id = '02500000-0000-0000-0000-0000000000a1';
UPDATE public.profiles             SET updated_at = updated_at WHERE user_id = '02500000-0000-0000-0000-000000000001';
UPDATE public.subscriptions        SET updated_at = updated_at WHERE id = '02500000-0000-0000-0000-0000000000c1';
UPDATE public.usage_counters       SET updated_at = updated_at WHERE user_id = '02500000-0000-0000-0000-000000000001';
UPDATE public.usage_credits        SET updated_at = updated_at WHERE id = '02500000-0000-0000-0000-0000000000d1';
UPDATE public.user_ai_preferences  SET updated_at = updated_at WHERE user_id = '02500000-0000-0000-0000-000000000001';
UPDATE public.user_entitlements    SET updated_at = updated_at WHERE user_id = '02500000-0000-0000-0000-000000000001';
UPDATE public.user_storage_usage   SET updated_at = updated_at WHERE user_id = '02500000-0000-0000-0000-000000000001';
RESET ROLE;

SELECT is(pg_temp.state(r.tbl), 'advanced',
          'no-EXECUTE role: ' || r.tbl || '.' || r.trg || ' fired and advanced updated_at')
  FROM t025_rows r ORDER BY r.tbl;

-- ══ 3. Sensitivity control: the same statements, triggers disabled ══════════
DO $ctl$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM t025_rows LOOP
    EXECUTE format('ALTER TABLE public.%I DISABLE TRIGGER %I', r.tbl, r.trg);
  END LOOP;
END
$ctl$;
SELECT pg_temp.backdate();
SET LOCAL ROLE zz_025_noexec;
UPDATE public.ai_model_catalog     SET updated_at = updated_at WHERE id = (SELECT min(id) FROM public.ai_model_catalog);
UPDATE public.author_identities    SET updated_at = updated_at WHERE id = '02500000-0000-0000-0000-0000000000b1';
UPDATE public.filter_presets       SET updated_at = updated_at WHERE id = '02500000-0000-0000-0000-0000000000f1';
UPDATE public.internal_user_access SET updated_at = updated_at WHERE user_id = '02500000-0000-0000-0000-000000000001';
UPDATE public.papers               SET updated_at = updated_at WHERE id = '02500000-0000-0000-0000-0000000000a1';
UPDATE public.profiles             SET updated_at = updated_at WHERE user_id = '02500000-0000-0000-0000-000000000001';
UPDATE public.subscriptions        SET updated_at = updated_at WHERE id = '02500000-0000-0000-0000-0000000000c1';
UPDATE public.usage_counters       SET updated_at = updated_at WHERE user_id = '02500000-0000-0000-0000-000000000001';
UPDATE public.usage_credits        SET updated_at = updated_at WHERE id = '02500000-0000-0000-0000-0000000000d1';
UPDATE public.user_ai_preferences  SET updated_at = updated_at WHERE user_id = '02500000-0000-0000-0000-000000000001';
UPDATE public.user_entitlements    SET updated_at = updated_at WHERE user_id = '02500000-0000-0000-0000-000000000001';
UPDATE public.user_storage_usage   SET updated_at = updated_at WHERE user_id = '02500000-0000-0000-0000-000000000001';
RESET ROLE;

SELECT is(
  (SELECT string_agg(r.tbl || '=' || pg_temp.state(r.tbl), ', ' ORDER BY r.tbl) FROM t025_rows r),
  (SELECT string_agg(r.tbl || '=old', ', ' ORDER BY r.tbl) FROM t025_rows r),
  'control: with the twelve triggers disabled, the same UPDATEs leave every updated_at at its backdated value');

DO $ctl$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM t025_rows LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE TRIGGER %I', r.tbl, r.trg);
  END LOOP;
END
$ctl$;

SELECT is(
  (SELECT count(*)::int FROM pg_trigger t
    WHERE t.tgfoid IN (to_regprocedure('public.set_updated_at()'), to_regprocedure('public.update_updated_at_column()'))
      AND t.tgenabled = 'O'),
  12,
  'control: all twelve triggers are enabled again');

-- ══ 4. The real writers ═════════════════════════════════════════════════════
-- authenticated, under its own claims and RLS, on the four tables it may write.
SELECT pg_temp.backdate();
SELECT set_config('request.jwt.claims', pg_temp.claims('02500000-0000-0000-0000-000000000001'), true);
SET LOCAL ROLE authenticated;
UPDATE public.papers            SET title = 'C56 paper (edited)'           WHERE id = '02500000-0000-0000-0000-0000000000a1';
UPDATE public.profiles          SET display_name = 'C56 display'           WHERE user_id = '02500000-0000-0000-0000-000000000001';
UPDATE public.filter_presets    SET name = 'C56 preset (edited)'           WHERE id = '02500000-0000-0000-0000-0000000000f1';
UPDATE public.author_identities SET preferred_name = 'C56 Author (edited)' WHERE id = '02500000-0000-0000-0000-0000000000b1';
RESET ROLE;
SELECT set_config('request.jwt.claims', '', true);

SELECT is(pg_temp.state(t.tbl), 'advanced', 'authenticated: its own ' || t.tbl || ' UPDATE fired the trigger')
  FROM unnest(ARRAY['author_identities','filter_presets','papers','profiles']) AS t(tbl) ORDER BY t.tbl;

-- service_role wrote the six server-written tables directly until C57
-- (SERVICE-ROLE-LEAST-PRIVILEGE-HARDENING-001) removed a privilege no server
-- path used. Their writers are postgres-owned SECURITY DEFINER functions and
-- operator SQL, which section 2's no-EXECUTE role already stands in for. Each
-- service_role UPDATE is now refused at the ACL, so no row changes and no
-- trigger fires.
SELECT is(
  pg_temp.errcode_as('service_role', NULL,
                     format('UPDATE public.%I SET updated_at = updated_at WHERE %s', t.tbl,
                            (SELECT pred FROM t025_rows WHERE tbl = t.tbl)))
  || ' ' || pg_temp.state(t.tbl),
  '42501 old',
  'service_role: its ' || t.tbl || ' UPDATE is refused (42501) and fires no trigger (C57)')
  FROM unnest(ARRAY['internal_user_access','subscriptions','usage_counters','usage_credits','user_entitlements','user_storage_usage']) AS t(tbl)
 ORDER BY t.tbl;

-- Ownership/RLS negative control: user 2 cannot reach user 1's rows, so no
-- row changes and no trigger fires.
SELECT pg_temp.backdate();
SELECT is(
  pg_temp.rows_as('authenticated', pg_temp.claims('02500000-0000-0000-0000-000000000002'),
                  $q$UPDATE public.papers SET title = 'hijack' WHERE id = '02500000-0000-0000-0000-0000000000a1'$q$)::text
  || '/' || pg_temp.state('papers') || ' '
  || pg_temp.rows_as('authenticated', pg_temp.claims('02500000-0000-0000-0000-000000000002'),
                     $q$UPDATE public.profiles SET display_name = 'hijack' WHERE user_id = '02500000-0000-0000-0000-000000000001'$q$)::text
  || '/' || pg_temp.state('profiles') || ' '
  || pg_temp.rows_as('authenticated', pg_temp.claims('02500000-0000-0000-0000-000000000002'),
                     $q$UPDATE public.filter_presets SET name = 'hijack' WHERE id = '02500000-0000-0000-0000-0000000000f1'$q$)::text
  || '/' || pg_temp.state('filter_presets'),
  '0/old 0/old 0/old',
  'RLS: another user''s UPDATE of papers, profiles and filter_presets touches no row and fires no trigger');

-- ══ 5. Direct calls ═════════════════════════════════════════════════════════
SELECT is(
  (SELECT string_agg(r || ' ' || f || '=' || pg_temp.errcode_as(r, NULL, 'SELECT ' || f), ', ' ORDER BY r, f)
     FROM unnest(ARRAY['anon','authenticated','service_role','zz_025_noexec']) r,
          unnest(ARRAY['public.set_updated_at()','public.update_updated_at_column()']) f),
  (SELECT string_agg(r || ' ' || f || '=42501', ', ' ORDER BY r, f)
     FROM unnest(ARRAY['anon','authenticated','service_role','zz_025_noexec']) r,
          unnest(ARRAY['public.set_updated_at()','public.update_updated_at_column()']) f),
  'direct call: every non-owner role is refused EXECUTE (42501) on both trigger functions');

SELECT is(
  pg_temp.errcode_as('postgres', NULL, 'SELECT public.set_updated_at()') || ' '
  || pg_temp.errcode_as('postgres', NULL, 'SELECT public.update_updated_at_column()'),
  '0A000 0A000',
  'direct call: even the owner only reaches "trigger functions can only be called as triggers" (0A000)');

-- ══ 6. Contrast: expressions DO check EXECUTE at run time ═══════════════════
-- Two owner-only functions, explicitly revoked (independent of any default):
-- one in a column DEFAULT, one as a BEFORE INSERT trigger on the same table.
CREATE FUNCTION public.zz_025_default_fn() RETURNS text LANGUAGE sql AS $f$ SELECT 'from-default' $f$;
REVOKE ALL ON FUNCTION public.zz_025_default_fn() FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.zz_025_trg_fn() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN
  NEW.note := 'set-by-owner-only-trigger';
  RETURN NEW;
END;
$f$;
REVOKE ALL ON FUNCTION public.zz_025_trg_fn() FROM PUBLIC, anon, authenticated, service_role;
CREATE TABLE public.zz_025_contrast (id integer PRIMARY KEY, note text, d text DEFAULT public.zz_025_default_fn());
CREATE TRIGGER zz_025_contrast_trg BEFORE INSERT ON public.zz_025_contrast
  FOR EACH ROW EXECUTE FUNCTION public.zz_025_trg_fn();
GRANT INSERT, SELECT ON public.zz_025_contrast TO zz_025_noexec;

SELECT is(
  pg_temp.errcode_as('zz_025_noexec', NULL, 'INSERT INTO public.zz_025_contrast (id) VALUES (1)'),
  '42501',
  'contrast: a DEFAULT expression calling an owner-only function IS refused for the no-EXECUTE role');

SELECT is(
  pg_temp.errcode_as('zz_025_noexec', NULL, $q$INSERT INTO public.zz_025_contrast (id, d) VALUES (2, 'explicit')$q$),
  '00000',
  'contrast: the same role inserts once the DEFAULT is not evaluated');

SELECT is(
  (SELECT id::text || '|' || coalesce(note, '<null>') || '|' || d FROM public.zz_025_contrast WHERE id = 2),
  '2|set-by-owner-only-trigger|explicit',
  'contrast: the owner-only BEFORE INSERT trigger fired for that same no-EXECUTE role');

SELECT * FROM finish();
ROLLBACK;
