-- AI-MODEL-SELECTION-001D suite 012: the expanded four-model catalog.
--
-- Owns the database half of migration 20260903120000, which adds Gemini 3.7
-- Flash and Gemini 3.8 Flash to `public.ai_model_catalog` (decision C35).
--
-- Why this is a separate suite rather than more assertions in 011. Every
-- database suite runs against the FINAL migration state, so 011 could not both
-- keep claiming "the catalog is exhausted by the 001A pair" and stay true. The
-- split is deliberate and the boundary is meaningful:
--
--   * 011 owns the 001A foundation — the entitlement gate, the RLS/grant
--     posture, the setter's authorization matrix, cross-user isolation, and the
--     fact that ITS two rows are present exactly as it approved them. None of
--     those claims was weakened; the exhaustive catalog-contents assertions
--     simply moved here rather than being softened there.
--   * 012 owns the catalog as a LIST: exactly four rows, exactly these ids,
--     provider models, labels, flags and sort positions, in exactly this order.
--
-- What this suite is really testing is that adding a model needed **nothing but
-- a reviewed row**. So it asserts, in the same breath as the new contents, that
-- the security posture the catalog carried before is byte-for-byte the posture
-- it carries now: still read-only to clients, still unreachable by `anon`, still
-- revoked from `service_role`, still free of any column that could hold a
-- credential — and that no database function learned either new model's name.
--
-- The system default is NOT a database concept and is not asserted here: it
-- lives in the `GEMINI_MODEL` environment configuration (C34), and 001D does not
-- change it. A catalog row makes a model *selectable*, never *default*.
--
-- Deterministic UUIDs; explicit fixtures; no TODO/SKIP; no remote calls; no
-- Production data; no real credentials; no provider request of any kind. pgTAP
-- is created inside the transaction and rolled back with it.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path TO extensions, public, pg_temp;

-- ── Helpers ─────────────────────────────────────────────────────────────────
-- Same shape as 011 and 003: run a statement as a given role with a given JWT
-- claim set, and report only the SQLSTATE or a single scalar.
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

CREATE FUNCTION pg_temp.scalar_as(p_role text, p_claims text, p_sql text)
RETURNS text LANGUAGE plpgsql AS $hlp$
DECLARE v_result text;
BEGIN
  PERFORM set_config('request.jwt.claims', COALESCE(p_claims, ''), true);
  EXECUTE 'SET LOCAL ROLE ' || quote_ident(p_role);
  EXECUTE p_sql INTO v_result;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN v_result;
END;
$hlp$;

CREATE FUNCTION pg_temp.claims(p_uid text) RETURNS text LANGUAGE sql IMMUTABLE AS $hlp$
  SELECT '{"sub":"' || p_uid || '","role":"authenticated"}';
$hlp$;

SELECT plan(50);

-- ════════════════════════════════════════════════════════════════════════════
-- 1. The catalog is exactly the four approved models
-- ════════════════════════════════════════════════════════════════════════════
--
-- Asserted BEFORE any fixture row is inserted, so these counts describe the
-- migrated catalog and nothing this suite manufactured.

SELECT is((SELECT count(*)::int FROM public.ai_model_catalog), 4,
  'the catalog holds exactly the four approved models');

-- Ordered by the two keys the Settings control itself orders by (`sort_order`
-- then `id`), so this is the order a user actually sees in the dropdown.
SELECT is(
  (SELECT array_agg(id ORDER BY sort_order, id) FROM public.ai_model_catalog),
  ARRAY['google/gemini-3.5-flash','google/gemini-3.6-flash',
        'google/gemini-3.7-flash','google/gemini-3.8-flash'],
  'catalog ids are provider-qualified and ordered 3.5, 3.6, 3.7, 3.8');

SELECT is(
  (SELECT array_agg(provider_model ORDER BY sort_order, id) FROM public.ai_model_catalog),
  ARRAY['gemini-3.5-flash','gemini-3.6-flash','gemini-3.7-flash','gemini-3.8-flash'],
  'provider model strings are exactly the four approved Gemini models');

SELECT is(
  (SELECT array_agg(display_name ORDER BY sort_order, id) FROM public.ai_model_catalog),
  ARRAY['Gemini 3.5 Flash','Gemini 3.6 Flash','Gemini 3.7 Flash','Gemini 3.8 Flash'],
  'display names are exactly the four approved labels');

SELECT is(
  (SELECT array_agg(provider ORDER BY sort_order, id) FROM public.ai_model_catalog),
  ARRAY['google','google','google','google'],
  'all four models are served by the one implemented provider adapter');

-- Sparse and unchanged: 001D appended 30 and 40 rather than renumbering 3.5 or
-- 3.6, so a preference someone already saved keeps its position in the list.
SELECT is(
  (SELECT array_agg(sort_order ORDER BY sort_order, id) FROM public.ai_model_catalog),
  ARRAY[10,20,30,40],
  'sort order is exactly 10 / 20 / 30 / 40');

SELECT ok((SELECT bool_and(enabled) FROM public.ai_model_catalog),
  'all four models are enabled');
SELECT ok((SELECT bool_and(selectable) FROM public.ai_model_catalog),
  'all four models are selectable');

-- Whole-row identity, so a column cannot drift onto the wrong model while every
-- individual array above still lines up.
SELECT is(
  (SELECT count(*)::int FROM public.ai_model_catalog
    WHERE (id, provider, provider_model, display_name, enabled, selectable, sort_order) IN (
      ('google/gemini-3.5-flash','google','gemini-3.5-flash','Gemini 3.5 Flash',true,true,10),
      ('google/gemini-3.6-flash','google','gemini-3.6-flash','Gemini 3.6 Flash',true,true,20),
      ('google/gemini-3.7-flash','google','gemini-3.7-flash','Gemini 3.7 Flash',true,true,30),
      ('google/gemini-3.8-flash','google','gemini-3.8-flash','Gemini 3.8 Flash',true,true,40))),
  4, 'each of the four rows matches its approved metadata as a whole row');

-- The 001A pair specifically: 001D is additive, so neither pre-existing row may
-- have been rewritten on the way past.
SELECT is(
  (SELECT count(*)::int FROM public.ai_model_catalog
    WHERE id IN ('google/gemini-3.5-flash','google/gemini-3.6-flash')
      AND enabled AND selectable),
  2, 'the two 001A models are still present, enabled and selectable');

-- Nothing was migrated ONTO a new model. A preference for 3.7 or 3.8 can only
-- come from a user choosing one, which is what section 3 then exercises.
SELECT is((SELECT count(*)::int FROM public.user_ai_preferences), 0,
  'migration replay created no user preference row');

-- ── The catalog is still credential-free product metadata ──────────────────
SELECT set_eq(
  $$SELECT column_name::text FROM information_schema.columns
     WHERE table_schema='public' AND table_name='ai_model_catalog'$$,
  ARRAY['id','provider','provider_model','display_name','enabled','selectable',
        'sort_order','created_at','updated_at'],
  'the catalog column set is unchanged — adding models added no column');

SELECT is(
  (SELECT count(*)::int FROM information_schema.columns
    WHERE table_schema='public' AND table_name='ai_model_catalog'
      AND column_name ~* '(key|secret|token|credential|password)'),
  0, 'no credential-bearing column was introduced');

-- All four are served by the same existing GEMINI_API_KEY, so no row may name a
-- secret in any of its text columns either.
SELECT is(
  (SELECT count(*)::int FROM public.ai_model_catalog
    WHERE (id || provider || provider_model || display_name) ~* '(api[_-]?key|secret|token|credential|password)'),
  0, 'no catalog row names a secret or credential in its metadata');

-- ── The integrity constraints still bite on the new rows ───────────────────
SELECT is(pg_temp.errcode_as('postgres','',
  $q$INSERT INTO public.ai_model_catalog (id,provider,provider_model,display_name)
     VALUES ('google/dup-37','google','gemini-3.7-flash','Dup 3.7')$q$),
  '23505', 'a second row for provider model gemini-3.7-flash is rejected');
SELECT is(pg_temp.errcode_as('postgres','',
  $q$INSERT INTO public.ai_model_catalog (id,provider,provider_model,display_name)
     VALUES ('google/gemini-3.8-flash','google','other-model','Dup id')$q$),
  '23505', 'a second row for the id google/gemini-3.8-flash is rejected');
SELECT is(pg_temp.errcode_as('postgres','',
  $q$INSERT INTO public.ai_model_catalog (id,provider,provider_model,display_name)
     VALUES ('google/untrimmed','google',' gemini-3.8-flash ','Untrimmed')$q$),
  '23514', 'an untrimmed provider_model is still rejected');

-- ── No database object learned either model's name ─────────────────────────
-- 001D is data. If a function, policy or default ever hard-codes 3.7 or 3.8, a
-- second allowlist has appeared in the database to disagree with the catalog.
SELECT is(
  (SELECT count(*)::int FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prokind = 'f'
      AND pg_get_functiondef(p.oid) ~* 'gemini-3\.[78]'),
  0, 'no database function hard-codes Gemini 3.7 or 3.8');

-- ════════════════════════════════════════════════════════════════════════════
-- 2. The security posture is exactly what it was before the expansion
-- ════════════════════════════════════════════════════════════════════════════

SELECT ok(
  (SELECT relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname='public' AND c.relname='ai_model_catalog'),
  'RLS is still enabled on the catalog');
SELECT ok(
  (SELECT relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname='public' AND c.relname='ai_model_catalog'),
  'RLS is still FORCED on the catalog');

-- Exactly one policy, and it is a read policy. A write policy appearing
-- alongside the new rows would be the quiet way this table stopped being
-- server-controlled.
SELECT is(
  (SELECT array_agg(cmd::text ORDER BY policyname) FROM pg_policies
    WHERE schemaname='public' AND tablename='ai_model_catalog'),
  ARRAY['SELECT'],
  'the catalog still carries exactly one policy, and it is SELECT-only');

-- ── Fixtures for the authorization half ────────────────────────────────────
-- handle_new_user seeds a Free entitlement (flag false) for each row.
INSERT INTO auth.users (id, email) VALUES
  ('d2000000-0000-0000-0000-000000000001','aimd-entitled@paperlume.test'),
  ('d2000000-0000-0000-0000-000000000002','aimd-free@paperlume.test');

UPDATE public.user_entitlements
   SET plan = 'pro', plan_status = 'active', ai_model_selection_enabled = true
 WHERE user_id = 'd2000000-0000-0000-0000-000000000001';

SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('d2000000-0000-0000-0000-000000000002'),
  $q$SELECT count(*)::text FROM public.ai_model_catalog$q$),
  '4', 'an ordinary signed-in user can read all four catalog rows');

SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('d2000000-0000-0000-0000-000000000001'),
  $q$SELECT string_agg(id, ',' ORDER BY sort_order, id) FROM public.ai_model_catalog$q$),
  'google/gemini-3.5-flash,google/gemini-3.6-flash,google/gemini-3.7-flash,google/gemini-3.8-flash',
  'an entitled user reads the expanded catalog in the rendered order');

SELECT is(pg_temp.errcode_as('anon','',
  $q$SELECT count(*) FROM public.ai_model_catalog$q$),
  '42501', 'anon still cannot reach the expanded catalog at all');

SELECT is(pg_temp.errcode_as('authenticated', pg_temp.claims('d2000000-0000-0000-0000-000000000001'),
  $q$INSERT INTO public.ai_model_catalog (id,provider,provider_model,display_name)
     VALUES ('google/self-added','google','gemini-self-added','Self Added')$q$),
  '42501', 'an entitled user still cannot INSERT a catalog row');
SELECT is(pg_temp.errcode_as('authenticated', pg_temp.claims('d2000000-0000-0000-0000-000000000001'),
  $q$UPDATE public.ai_model_catalog SET provider_model = 'anything'
      WHERE id = 'google/gemini-3.8-flash'$q$),
  '42501', 'an entitled user still cannot UPDATE a catalog row');
SELECT is(pg_temp.errcode_as('authenticated', pg_temp.claims('d2000000-0000-0000-0000-000000000001'),
  $q$DELETE FROM public.ai_model_catalog WHERE id = 'google/gemini-3.7-flash'$q$),
  '42501', 'an entitled user still cannot DELETE a catalog row');

SELECT ok(NOT has_table_privilege('service_role','public.ai_model_catalog','SELECT, INSERT, UPDATE, DELETE'),
  'service_role still holds no privilege on the catalog');
SELECT ok(NOT has_table_privilege('service_role','public.user_ai_preferences','SELECT, INSERT, UPDATE, DELETE'),
  'service_role still holds no privilege on user_ai_preferences');
SELECT ok(has_table_privilege('authenticated','public.ai_model_catalog','SELECT'),
  'authenticated still holds SELECT on the catalog');
SELECT ok(NOT has_table_privilege('authenticated','public.ai_model_catalog','INSERT, UPDATE, DELETE'),
  'authenticated still holds no write privilege on the catalog');

-- ════════════════════════════════════════════════════════════════════════════
-- 3. The setter accepts the new models, and everything else is unchanged
-- ════════════════════════════════════════════════════════════════════════════
--
-- The setter requires `enabled AND selectable` (011 covers both refusals), so
-- these cases prove the new rows really are offerable — not merely present.

SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('d2000000-0000-0000-0000-000000000001'),
  $q$SELECT reason FROM public.set_current_user_ai_model('google/gemini-3.7-flash')$q$),
  'ok', 'an entitled caller can save Gemini 3.7 Flash');
SELECT is((SELECT preferred_model_id FROM public.user_ai_preferences
            WHERE user_id = 'd2000000-0000-0000-0000-000000000001'),
  'google/gemini-3.7-flash', 'the stored row holds the 3.7 catalog id, not the provider model string');
SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('d2000000-0000-0000-0000-000000000001'),
  $q$SELECT display_name FROM public.set_current_user_ai_model('google/gemini-3.7-flash')$q$),
  'Gemini 3.7 Flash', 'the setter confirms the 3.7 display name');

SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('d2000000-0000-0000-0000-000000000001'),
  $q$SELECT reason FROM public.set_current_user_ai_model('google/gemini-3.8-flash')$q$),
  'ok', 'the same caller can switch to Gemini 3.8 Flash');
SELECT is((SELECT preferred_model_id FROM public.user_ai_preferences
            WHERE user_id = 'd2000000-0000-0000-0000-000000000001'),
  'google/gemini-3.8-flash', 'the stored row holds the 3.8 catalog id');
SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('d2000000-0000-0000-0000-000000000001'),
  $q$SELECT display_name FROM public.set_current_user_ai_model('google/gemini-3.8-flash')$q$),
  'Gemini 3.8 Flash', 'the setter confirms the 3.8 display name');
SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('d2000000-0000-0000-0000-000000000001'),
  $q$SELECT provider FROM public.set_current_user_ai_model('google/gemini-3.8-flash')$q$),
  'google', 'the setter confirms 3.8 belongs to the google adapter');

-- Four models, still one row per user.
SELECT is((SELECT count(*)::int FROM public.user_ai_preferences
            WHERE user_id = 'd2000000-0000-0000-0000-000000000001'),
  1, 'switching between four models still upserts a single row');

-- The 001A models keep behaving exactly as they did.
SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('d2000000-0000-0000-0000-000000000001'),
  $q$SELECT reason FROM public.set_current_user_ai_model('google/gemini-3.5-flash')$q$),
  'ok', 'Gemini 3.5 Flash is still selectable after the expansion');
SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('d2000000-0000-0000-0000-000000000001'),
  $q$SELECT preferred_model_id FROM public.set_current_user_ai_model('google/gemini-3.6-flash')$q$),
  'google/gemini-3.6-flash', 'Gemini 3.6 Flash is still selectable after the expansion');

-- An explicitly saved 3.6 — the state Production is actually in — survives a
-- catalog that has grown past it. This is the invariant 001D most has to keep.
SELECT is((SELECT preferred_model_id FROM public.user_ai_preferences
            WHERE user_id = 'd2000000-0000-0000-0000-000000000001'),
  'google/gemini-3.6-flash', 'a saved 3.6 preference is not moved onto a newer model');

-- ── Unknown models are still refused, however plausible ────────────────────
SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('d2000000-0000-0000-0000-000000000001'),
    'SELECT reason FROM public.set_current_user_ai_model(' || quote_literal(model) || ')'),
    'unknown_model', descr)
FROM (VALUES
  ('google/gemini-3.9-flash', 'a model beyond the approved four is still refused'),
  ('gemini-3.8-flash',        'the bare 3.8 provider model string is not an accepted id'),
  ('google/gemini-3.8-pro',   'a sibling model nobody approved is refused'),
  ('google/gemini-flash-latest', 'the floating -latest alias is not a selectable model')
) v(model, descr);

-- ── The gate is still the entitlement, not the catalog ─────────────────────
SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('d2000000-0000-0000-0000-000000000002'),
  $q$SELECT reason FROM public.set_current_user_ai_model('google/gemini-3.8-flash')$q$),
  'not_entitled', 'a Free user cannot select a newly added model either');
SELECT is((SELECT count(*)::int FROM public.user_ai_preferences
            WHERE user_id = 'd2000000-0000-0000-0000-000000000002'),
  0, 'the refused Free user wrote nothing');

-- ── Clearing still returns the account to the system default ───────────────
SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('d2000000-0000-0000-0000-000000000001'),
  $q$SELECT reason FROM public.clear_current_user_ai_model()$q$),
  'ok', 'a caller can still clear back to Paperlume''s default');
SELECT is((SELECT count(*)::int FROM public.user_ai_preferences), 0,
  'no preference row survives the reset');

SELECT * FROM finish();
ROLLBACK;
