-- AI-MODEL-SELECTION-001A suite 011: entitlement, model catalog and per-user
-- AI-model preference foundation.
--
-- Owns the database half of the model-selection foundation added by migration
-- 20260902120000. The claim that migration makes is an AUTHORIZATION claim, so
-- it is asserted here rather than assumed:
--
--   * the catalog is an allowlist — the two rows 001A approved are present with
--     the exact provider-qualified internal ids and provider model strings, both
--     enabled and selectable, 3.5 ordered before 3.6, readable by a signed-in
--     caller and mutable by none;
--   * the capability is the explicit `ai_model_selection_enabled` flag combined
--     with an active/trialing status — NOT the plan name. A row whose plan text
--     says 'pro' but whose flag is false is denied, in the access projection and
--     in the setter, because a client-side plan-name shortcut is exactly the
--     enforcement mistake this design exists to prevent;
--   * every failure direction fails CLOSED: missing entitlement, inactive
--     entitlement, unknown model, disabled model, unselectable model;
--   * the setter and the reset RPC take no user id at all, so writing another
--     user's preference is unexpressible rather than merely guarded — asserted
--     both on the catalog signature and behaviourally;
--   * preference rows are readable only by their owner;
--   * clearing does NOT require the entitlement, so a downgraded user can still
--     drop a dormant preference;
--   * every pre-existing get_current_user_access field keeps its meaning.
--
-- Runtime routing is deliberately NOT covered: this migration changes nothing
-- about which model an AI operation invokes, and there is no code path from
-- these tables to a provider request. That is AI-MODEL-SELECTION-001B.
--
-- Scope note (AI-MODEL-SELECTION-001D). Every database suite runs against the
-- FINAL migration state, not against the state each migration left behind, and
-- migration 20260903120000 later added Gemini 3.7 Flash and Gemini 3.8 Flash
-- (C35). This suite therefore asserts what 001A durably claims — that ITS two
-- rows are present exactly as approved, with the posture and constraints it
-- established — and deliberately no longer claims the catalog is exhausted by
-- them. The exhaustive "exactly these four rows, in this order" assertions live
-- in suite 012, which owns the expanded catalog. Nothing here was weakened to
-- accommodate that: the authorization claims (who may read, who may not write,
-- what the setter accepts and refuses) are unchanged and still exact.
--
-- Deterministic UUIDs; explicit fixtures; no TODO/SKIP; no remote calls; no
-- Production data; no real credentials. pgTAP is created inside the transaction
-- and rolled back with it.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path TO extensions, public, pg_temp;

-- ── Helpers ─────────────────────────────────────────────────────────────────
-- Same shape as 003_rpc_caller_scope_and_grants.test.sql: run a statement as a
-- given role with a given JWT claim set, and report only the SQLSTATE.
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

-- A signed-in claim set for a given user id.
CREATE FUNCTION pg_temp.claims(p_uid text) RETURNS text LANGUAGE sql IMMUTABLE AS $hlp$
  SELECT '{"sub":"' || p_uid || '","role":"authenticated"}';
$hlp$;

-- ── Fixtures ────────────────────────────────────────────────────────────────
-- handle_new_user seeds a default Free entitlement (plan 'free', plan_status
-- 'active', ai_model_selection_enabled false by column default) for each row.
INSERT INTO auth.users (id, email) VALUES
  ('d1000000-0000-0000-0000-000000000001','aims-entitled-A@paperlume.test'),
  ('d1000000-0000-0000-0000-000000000002','aims-entitled-B@paperlume.test'),
  ('d1000000-0000-0000-0000-000000000003','aims-free@paperlume.test'),
  ('d1000000-0000-0000-0000-000000000004','aims-trialing@paperlume.test'),
  ('d1000000-0000-0000-0000-000000000005','aims-canceled@paperlume.test'),
  ('d1000000-0000-0000-0000-000000000006','aims-missing@paperlume.test'),
  ('d1000000-0000-0000-0000-000000000007','aims-pro-flag-off@paperlume.test'),
  ('d1000000-0000-0000-0000-000000000008','aims-downgraded@paperlume.test');

-- A and B: entitled Pro. The two of them exist so cross-user isolation can be
-- proven between two callers who are BOTH allowed to use the feature — an
-- isolation bug between two entitled users is the one a naive implementation
-- actually has.
UPDATE public.user_entitlements
   SET plan = 'pro', plan_status = 'active', ai_model_selection_enabled = true
 WHERE user_id IN ('d1000000-0000-0000-0000-000000000001',
                   'd1000000-0000-0000-0000-000000000002');

-- Trialing + entitled: the status set that must also be permitted.
UPDATE public.user_entitlements
   SET plan = 'pro', plan_status = 'trialing', ai_model_selection_enabled = true
 WHERE user_id = 'd1000000-0000-0000-0000-000000000004';

-- Canceled but still flagged: the capability must not survive the status.
UPDATE public.user_entitlements
   SET plan = 'pro', plan_status = 'canceled', ai_model_selection_enabled = true
 WHERE user_id = 'd1000000-0000-0000-0000-000000000005';

-- No entitlement row at all.
DELETE FROM public.user_entitlements
 WHERE user_id = 'd1000000-0000-0000-0000-000000000006';

-- Plan text says 'pro', ACTIVE, flag explicitly false. The whole point of the
-- design: the flag is the gate, not the plan name.
UPDATE public.user_entitlements
   SET plan = 'pro', plan_status = 'active', ai_model_selection_enabled = false
 WHERE user_id = 'd1000000-0000-0000-0000-000000000007';

-- Downgraded-with-a-saved-preference: entitled now, made inactive later in the
-- suite so the dormant-preference and clear-after-downgrade rules can be shown.
UPDATE public.user_entitlements
   SET plan = 'pro', plan_status = 'active', ai_model_selection_enabled = true
 WHERE user_id = 'd1000000-0000-0000-0000-000000000008';

SELECT plan(96);

-- ════════════════════════════════════════════════════════════════════════════
-- 1. Catalog: the two models 001A approved, before any fixture row is added
-- ════════════════════════════════════════════════════════════════════════════

-- The 001A pair, asserted as a whole row each: ids, provider model strings,
-- labels, flags and sort positions together. Their exact values are the durable
-- part of this migration's claim, and 001D must not have disturbed any of them.
SELECT is(
  (SELECT count(*)::int FROM public.ai_model_catalog
    WHERE (id, provider, provider_model, display_name, enabled, selectable, sort_order) IN (
      ('google/gemini-3.5-flash','google','gemini-3.5-flash','Gemini 3.5 Flash',true,true,10),
      ('google/gemini-3.6-flash','google','gemini-3.6-flash','Gemini 3.6 Flash',true,true,20))),
  2, 'the two models 001A approved are present exactly as it seeded them');

SELECT is(
  (SELECT array_agg(id ORDER BY sort_order) FROM public.ai_model_catalog
    WHERE id IN ('google/gemini-3.5-flash','google/gemini-3.6-flash')),
  ARRAY['google/gemini-3.5-flash','google/gemini-3.6-flash'],
  'the 001A ids are provider-qualified and still ordered 3.5 before 3.6');

SELECT is(
  (SELECT array_agg(provider_model ORDER BY sort_order) FROM public.ai_model_catalog
    WHERE id IN ('google/gemini-3.5-flash','google/gemini-3.6-flash')),
  ARRAY['gemini-3.5-flash','gemini-3.6-flash'],
  'the 001A provider model strings are exactly the two approved Gemini models');

SELECT is(
  (SELECT array_agg(display_name ORDER BY sort_order) FROM public.ai_model_catalog
    WHERE id IN ('google/gemini-3.5-flash','google/gemini-3.6-flash')),
  ARRAY['Gemini 3.5 Flash','Gemini 3.6 Flash'],
  'the 001A display names are exactly the two approved labels');

SELECT is(
  (SELECT count(*)::int FROM public.ai_model_catalog
    WHERE provider = 'google'
      AND id IN ('google/gemini-3.5-flash','google/gemini-3.6-flash')),
  2, 'both 001A models declare provider google');

SELECT ok(
  (SELECT bool_and(enabled AND selectable) FROM public.ai_model_catalog
    WHERE id IN ('google/gemini-3.5-flash','google/gemini-3.6-flash')),
  'both 001A models are still enabled AND selectable');

-- Every model still arrives by explicit product acceptance. Gemini 3.7 and 3.8
-- cleared that bar under C35 and are asserted exhaustively in suite 012; a
-- Claude / GPT / o-series / preview model or the floating `gemini-flash-latest`
-- alias has not, and none may appear by a seed nobody reviewed. A floating alias
-- stays excluded on its own terms: it is not a stable thing to have chosen.
SELECT is(
  (SELECT count(*)::int FROM public.ai_model_catalog
    WHERE provider_model ~* '(claude|gpt|o[0-9]|preview|latest)'),
  0, 'no Claude / GPT / o-series / preview / -latest model reached the catalog');

-- The catalog is product metadata. Its column set is pinned so a future change
-- cannot quietly add a place to put an API key, secret name or credential.
SELECT set_eq(
  $$SELECT column_name::text FROM information_schema.columns
     WHERE table_schema='public' AND table_name='ai_model_catalog'$$,
  ARRAY['id','provider','provider_model','display_name','enabled','selectable',
        'sort_order','created_at','updated_at'],
  'catalog columns are exactly the intended non-sensitive metadata set');

SELECT is(
  (SELECT count(*)::int FROM information_schema.columns
    WHERE table_schema='public' AND table_name IN ('ai_model_catalog','user_ai_preferences')
      AND column_name ~* '(key|secret|token|credential|password)'),
  0, 'neither new table has a column that could hold credential material');

-- ── Catalog integrity constraints ───────────────────────────────────────────
SELECT is(pg_temp.errcode_as('postgres','',
  $q$INSERT INTO public.ai_model_catalog (id,provider,provider_model,display_name)
     VALUES ('  ','google','x','X')$q$),
  '23514', 'catalog rejects a blank id');
SELECT is(pg_temp.errcode_as('postgres','',
  $q$INSERT INTO public.ai_model_catalog (id,provider,provider_model,display_name)
     VALUES ('x','google',' gemini-3.5-flash ','X')$q$),
  '23514', 'catalog rejects an untrimmed provider_model');
SELECT is(pg_temp.errcode_as('postgres','',
  $q$INSERT INTO public.ai_model_catalog (id,provider,provider_model,display_name)
     VALUES ('google/dup','google','gemini-3.5-flash','Dup')$q$),
  '23505', 'catalog rejects a second row for the same (provider, provider_model)');

-- ── Catalog read/write posture ──────────────────────────────────────────────
-- Compared against the catalog's own size rather than a literal: the claim is
-- "the WHOLE catalog is readable", which must keep holding as reviewed rows are
-- added, and pinning a number here would only restate suite 012's job.
SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('d1000000-0000-0000-0000-000000000003'),
  $q$SELECT count(*)::text FROM public.ai_model_catalog$q$),
  (SELECT count(*)::text FROM public.ai_model_catalog),
  'an ordinary signed-in user can read the whole catalog');

SELECT is(pg_temp.errcode_as('anon','',
  $q$SELECT count(*) FROM public.ai_model_catalog$q$),
  '42501', 'anon cannot reach the catalog at all');

SELECT is(pg_temp.errcode_as('authenticated', pg_temp.claims('d1000000-0000-0000-0000-000000000001'),
  $q$INSERT INTO public.ai_model_catalog (id,provider,provider_model,display_name)
     VALUES ('evil/model','evil','evil-1','Evil')$q$),
  '42501', 'an entitled user cannot INSERT a catalog row');
SELECT is(pg_temp.errcode_as('authenticated', pg_temp.claims('d1000000-0000-0000-0000-000000000001'),
  $q$UPDATE public.ai_model_catalog SET provider_model = 'anything'$q$),
  '42501', 'an entitled user cannot UPDATE a catalog row');
SELECT is(pg_temp.errcode_as('authenticated', pg_temp.claims('d1000000-0000-0000-0000-000000000001'),
  $q$DELETE FROM public.ai_model_catalog$q$),
  '42501', 'an entitled user cannot DELETE a catalog row');

SELECT ok(NOT has_table_privilege('service_role','public.ai_model_catalog','SELECT, INSERT, UPDATE, DELETE'),
  'service_role holds no privilege on the catalog (administration is a migration)');
SELECT ok(NOT has_table_privilege('service_role','public.user_ai_preferences','SELECT, INSERT, UPDATE, DELETE'),
  'service_role holds no privilege on user_ai_preferences');

-- ════════════════════════════════════════════════════════════════════════════
-- 2. The entitlement column itself
-- ════════════════════════════════════════════════════════════════════════════

SELECT col_not_null('public','user_entitlements','ai_model_selection_enabled',
  'ai_model_selection_enabled is NOT NULL');
SELECT col_has_default('public','user_entitlements','ai_model_selection_enabled',
  'ai_model_selection_enabled has a default');
SELECT col_default_is('public','user_entitlements','ai_model_selection_enabled','false',
  'ai_model_selection_enabled defaults to false (a new user cannot select)');

-- A brand-new signup gets the capability OFF, through the real trigger path.
INSERT INTO auth.users (id, email)
VALUES ('d1000000-0000-0000-0000-00000000000f','aims-newsignup@paperlume.test');
SELECT is(
  (SELECT ai_model_selection_enabled FROM public.user_entitlements
    WHERE user_id = 'd1000000-0000-0000-0000-00000000000f'),
  false, 'a newly provisioned entitlement cannot select a model');

-- The client may read its own flag but never write it: user_entitlements holds a
-- SELECT-own policy and a SELECT-only grant, so this stays server-controlled.
SELECT is(pg_temp.errcode_as('authenticated', pg_temp.claims('d1000000-0000-0000-0000-000000000003'),
  $q$UPDATE public.user_entitlements SET ai_model_selection_enabled = true
      WHERE user_id = 'd1000000-0000-0000-0000-000000000003'$q$),
  '42501', 'a user cannot grant themselves the capability by writing the flag');

-- ════════════════════════════════════════════════════════════════════════════
-- 3. get_current_user_access().can_select_ai_model — fail-closed semantics
-- ════════════════════════════════════════════════════════════════════════════

SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims(uid),
    $q$SELECT can_select_ai_model::text FROM public.get_current_user_access()$q$),
    expected, descr)
FROM (VALUES
  ('d1000000-0000-0000-0000-000000000001','true',
     'active Pro with the flag enabled may select a model'),
  ('d1000000-0000-0000-0000-000000000004','true',
     'trialing entitled user may select a model'),
  ('d1000000-0000-0000-0000-000000000003','false',
     'ordinary Free user may not select a model'),
  ('d1000000-0000-0000-0000-000000000005','false',
     'canceled entitlement may not select a model even with the flag set'),
  ('d1000000-0000-0000-0000-000000000006','false',
     'missing entitlement fails closed'),
  ('d1000000-0000-0000-0000-000000000007','false',
     'plan text ''pro'' with the flag false is denied — the flag is the gate')
) v(uid, expected, descr);

-- Null auth and anon are refused exactly as before this migration.
SELECT is(pg_temp.errcode_as('authenticated','',
  $q$SELECT * FROM public.get_current_user_access()$q$),
  'P0001', 'get_current_user_access still rejects null auth');
SELECT is(pg_temp.errcode_as('anon','',
  $q$SELECT * FROM public.get_current_user_access()$q$),
  '42501', 'anon still cannot execute get_current_user_access');

-- ── Every pre-existing field survives unchanged ─────────────────────────────
INSERT INTO public.internal_user_access (user_id, role, ai_quota_exempt) VALUES
  ('d1000000-0000-0000-0000-000000000002','owner', true),
  ('d1000000-0000-0000-0000-000000000003','manager', false);
UPDATE public.user_entitlements
   SET premium_taxonomy_enabled = true, labs_team_enabled = true
 WHERE user_id = 'd1000000-0000-0000-0000-000000000002';

SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims(uid), sql), expected, descr)
FROM (VALUES
  ('d1000000-0000-0000-0000-000000000002', $q$SELECT role FROM public.get_current_user_access()$q$,
     'owner', 'owner role still resolves'),
  ('d1000000-0000-0000-0000-000000000002', $q$SELECT is_internal::text FROM public.get_current_user_access()$q$,
     'true', 'owner is_internal unchanged'),
  ('d1000000-0000-0000-0000-000000000002', $q$SELECT can_view_provider_quota::text FROM public.get_current_user_access()$q$,
     'true', 'owner can_view_provider_quota unchanged'),
  ('d1000000-0000-0000-0000-000000000002', $q$SELECT ai_quota_exempt::text FROM public.get_current_user_access()$q$,
     'true', 'owner ai_quota_exempt unchanged'),
  ('d1000000-0000-0000-0000-000000000002', $q$SELECT premium_taxonomy_enabled::text FROM public.get_current_user_access()$q$,
     'true', 'premium_taxonomy_enabled unchanged'),
  ('d1000000-0000-0000-0000-000000000002', $q$SELECT labs_team_enabled::text FROM public.get_current_user_access()$q$,
     'true', 'labs_team_enabled unchanged'),
  ('d1000000-0000-0000-0000-000000000002', $q$SELECT plan FROM public.get_current_user_access()$q$,
     'pro', 'plan unchanged'),
  ('d1000000-0000-0000-0000-000000000002', $q$SELECT plan_status FROM public.get_current_user_access()$q$,
     'active', 'plan_status unchanged'),
  ('d1000000-0000-0000-0000-000000000003', $q$SELECT role FROM public.get_current_user_access()$q$,
     'manager', 'manager role still resolves'),
  ('d1000000-0000-0000-0000-000000000003', $q$SELECT ai_quota_exempt::text FROM public.get_current_user_access()$q$,
     'false', 'manager is still not auto-exempt'),
  -- An internal role is NOT a shortcut to the commercial capability: the manager
  -- above is Free, so being internal must not grant model selection.
  ('d1000000-0000-0000-0000-000000000003', $q$SELECT can_select_ai_model::text FROM public.get_current_user_access()$q$,
     'false', 'an internal manager on Free still may not select a model')
) v(uid, sql, expected, descr);

-- The projection is exactly nine columns: additive, in order, nothing dropped.
SELECT is(
  (SELECT array_agg(u.nm ORDER BY u.ord)
     FROM pg_proc p
     CROSS JOIN LATERAL unnest(p.proargnames, p.proargmodes)
       WITH ORDINALITY AS u(nm, md, ord)
    WHERE p.oid = 'public.get_current_user_access()'::regprocedure
      AND u.md = 't'),
  ARRAY['role','is_internal','can_view_provider_quota','ai_quota_exempt','plan',
        'plan_status','premium_taxonomy_enabled','labs_team_enabled','can_select_ai_model'],
  'get_current_user_access returns the pre-existing columns plus can_select_ai_model, in order');

-- ════════════════════════════════════════════════════════════════════════════
-- 4. set_current_user_ai_model — the only write path
-- ════════════════════════════════════════════════════════════════════════════

-- Additional catalog fixtures for the two "exists but is not offered" cases.
INSERT INTO public.ai_model_catalog
    (id, provider, provider_model, display_name, enabled, selectable, sort_order)
VALUES
  ('google/aims-disabled',   'google', 'aims-disabled-model',   'AIMS Disabled',   false, true,  900),
  ('google/aims-unselectable','google','aims-unselectable-model','AIMS Unselectable', true, false, 901);

-- ── Caller identity ─────────────────────────────────────────────────────────
SELECT is(pg_temp.errcode_as('authenticated','',
  $q$SELECT * FROM public.set_current_user_ai_model('google/gemini-3.5-flash')$q$),
  'P0001', 'setter rejects an unauthenticated (null auth.uid) caller');
SELECT is(pg_temp.errcode_as('anon','',
  $q$SELECT * FROM public.set_current_user_ai_model('google/gemini-3.5-flash')$q$),
  '42501', 'anon cannot execute the setter');
SELECT is(pg_temp.errcode_as('anon','',
  $q$SELECT * FROM public.clear_current_user_ai_model()$q$),
  '42501', 'anon cannot execute the reset RPC');
SELECT is(pg_temp.errcode_as('authenticated','',
  $q$SELECT * FROM public.clear_current_user_ai_model()$q$),
  'P0001', 'reset RPC rejects an unauthenticated caller');

-- S1 by construction: neither RPC has a parameter through which a caller could
-- name a different user. This is the structural half of cross-user isolation —
-- the behavioural half is asserted in section 5.
SELECT is(
  (SELECT pg_get_function_identity_arguments('public.set_current_user_ai_model(text)'::regprocedure)),
  'p_model_id text', 'the setter takes exactly one text model id and no user id');
SELECT is(
  (SELECT pg_get_function_identity_arguments('public.clear_current_user_ai_model()'::regprocedure)),
  '', 'the reset RPC takes no argument at all');

-- ── Rejection matrix (nothing is written on any of these) ───────────────────
SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims(uid),
    'SELECT reason FROM public.set_current_user_ai_model(' || quote_literal(model) || ')'),
    expected, descr)
FROM (VALUES
  ('d1000000-0000-0000-0000-000000000001','google/gemini-3.9-flash','unknown_model',
     'an id absent from the catalog is refused'),
  ('d1000000-0000-0000-0000-000000000001','gemini-3.5-flash','unknown_model',
     'the bare provider model string is not an accepted id'),
  ('d1000000-0000-0000-0000-000000000001','google/aims-disabled','model_disabled',
     'a disabled catalog model is refused'),
  ('d1000000-0000-0000-0000-000000000001','google/aims-unselectable','model_not_selectable',
     'an enabled but unselectable model is refused'),
  ('d1000000-0000-0000-0000-000000000001','','invalid_model_id',
     'an empty model id is refused'),
  ('d1000000-0000-0000-0000-000000000003','google/gemini-3.5-flash','not_entitled',
     'a Free user is refused'),
  ('d1000000-0000-0000-0000-000000000007','google/gemini-3.5-flash','not_entitled',
     'plan text ''pro'' with the flag false is refused — not a plan-name check'),
  ('d1000000-0000-0000-0000-000000000005','google/gemini-3.5-flash','inactive_entitlement',
     'a canceled entitlement is refused even with the flag set'),
  ('d1000000-0000-0000-0000-000000000006','google/gemini-3.5-flash','missing_entitlement',
     'a caller with no entitlement row is refused'),
  ('d1000000-0000-0000-0000-000000000004','google/gemini-3.5-flash','ok',
     'a trialing entitled caller may save')
) v(uid, model, expected, descr);

-- Only the trialing caller above wrote anything.
SELECT is((SELECT count(*)::int FROM public.user_ai_preferences), 1,
  'every rejected attempt wrote nothing');
SELECT is((SELECT preferred_model_id FROM public.user_ai_preferences
            WHERE user_id = 'd1000000-0000-0000-0000-000000000004'),
  'google/gemini-3.5-flash', 'the trialing caller''s saved model is the one requested');

-- ── Happy path, and upsert stays one row per user ───────────────────────────
SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('d1000000-0000-0000-0000-000000000001'),
  $q$SELECT reason FROM public.set_current_user_ai_model('google/gemini-3.5-flash')$q$),
  'ok', 'an entitled caller can save Gemini 3.5 Flash');
SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('d1000000-0000-0000-0000-000000000001'),
  $q$SELECT preferred_model_id FROM public.set_current_user_ai_model('google/gemini-3.6-flash')$q$),
  'google/gemini-3.6-flash', 'the same caller can change to Gemini 3.6 Flash');
SELECT is((SELECT count(*)::int FROM public.user_ai_preferences
            WHERE user_id = 'd1000000-0000-0000-0000-000000000001'),
  1, 'changing the choice upserts — still exactly one row for that user');
SELECT is((SELECT preferred_model_id FROM public.user_ai_preferences
            WHERE user_id = 'd1000000-0000-0000-0000-000000000001'),
  'google/gemini-3.6-flash', 'the stored row holds the latest choice');

-- The confirmation shape is useful and carries nothing sensitive.
SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('d1000000-0000-0000-0000-000000000001'),
  $q$SELECT display_name FROM public.set_current_user_ai_model('google/gemini-3.6-flash')$q$),
  'Gemini 3.6 Flash', 'the setter confirms the display name for a later client');
SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('d1000000-0000-0000-0000-000000000001'),
  $q$SELECT provider FROM public.set_current_user_ai_model('google/gemini-3.6-flash')$q$),
  'google', 'the setter confirms the provider');
SELECT set_eq(
  $$SELECT unnest(p.proargnames) FROM pg_proc p
     WHERE p.oid = 'public.set_current_user_ai_model(text)'::regprocedure$$,
  ARRAY['p_model_id','saved','reason','preferred_model_id','provider','display_name','updated_at'],
  'the setter''s result carries no credential, key or provider-secret field');

-- The preference table never duplicates the provider model string, so a catalog
-- correction cannot leave a stale copy behind on a user's row.
SELECT hasnt_column('public','user_ai_preferences','provider_model',
  'user_ai_preferences does not duplicate provider_model');

-- ── Direct table mutation is not the authorization path ─────────────────────
SELECT is(pg_temp.errcode_as('authenticated', pg_temp.claims('d1000000-0000-0000-0000-000000000003'),
  $q$INSERT INTO public.user_ai_preferences (user_id, preferred_model_id)
     VALUES ('d1000000-0000-0000-0000-000000000003','google/gemini-3.6-flash')$q$),
  '42501', 'a Free user cannot INSERT a preference row directly, bypassing the entitlement check');
SELECT is(pg_temp.errcode_as('authenticated', pg_temp.claims('d1000000-0000-0000-0000-000000000001'),
  $q$INSERT INTO public.user_ai_preferences (user_id, preferred_model_id)
     VALUES ('d1000000-0000-0000-0000-000000000001','google/gemini-3.5-flash')$q$),
  '42501', 'even an entitled user cannot INSERT a preference row directly');
SELECT is(pg_temp.errcode_as('authenticated', pg_temp.claims('d1000000-0000-0000-0000-000000000001'),
  $q$UPDATE public.user_ai_preferences SET preferred_model_id = 'google/gemini-3.5-flash'$q$),
  '42501', 'a user cannot UPDATE a preference row directly');
SELECT is(pg_temp.errcode_as('authenticated', pg_temp.claims('d1000000-0000-0000-0000-000000000001'),
  $q$DELETE FROM public.user_ai_preferences$q$),
  '42501', 'a user cannot DELETE a preference row directly');

-- ════════════════════════════════════════════════════════════════════════════
-- 5. Cross-user isolation — read and write
-- ════════════════════════════════════════════════════════════════════════════

-- B (also entitled) saves its own choice.
SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('d1000000-0000-0000-0000-000000000002'),
  $q$SELECT reason FROM public.set_current_user_ai_model('google/gemini-3.5-flash')$q$),
  'ok', 'the second entitled user can save their own preference');

-- Each sees exactly one row: their own.
SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('d1000000-0000-0000-0000-000000000001'),
  $q$SELECT count(*)::text FROM public.user_ai_preferences$q$),
  '1', 'user A sees exactly one preference row');
SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('d1000000-0000-0000-0000-000000000001'),
  $q$SELECT preferred_model_id FROM public.user_ai_preferences$q$),
  'google/gemini-3.6-flash', 'the row user A sees is user A''s own');
SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('d1000000-0000-0000-0000-000000000002'),
  $q$SELECT count(*)::text FROM public.user_ai_preferences
      WHERE user_id = 'd1000000-0000-0000-0000-000000000001'$q$),
  '0', 'user B cannot read user A''s preference row');
SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('d1000000-0000-0000-0000-000000000003'),
  $q$SELECT count(*)::text FROM public.user_ai_preferences$q$),
  '0', 'an unrelated user sees no preference row at all');

-- A's row is untouched by everything B did.
SELECT is((SELECT preferred_model_id FROM public.user_ai_preferences
            WHERE user_id = 'd1000000-0000-0000-0000-000000000001'),
  'google/gemini-3.6-flash', 'user A''s saved model is unaffected by user B''s calls');
SELECT is((SELECT preferred_model_id FROM public.user_ai_preferences
            WHERE user_id = 'd1000000-0000-0000-0000-000000000002'),
  'google/gemini-3.5-flash', 'user B''s saved model is its own');
SELECT is((SELECT count(*)::int FROM public.user_ai_preferences), 3,
  'exactly three preference rows exist (A, B and the trialing user) — no row was created for anyone else');

-- ════════════════════════════════════════════════════════════════════════════
-- 6. clear_current_user_ai_model — reset to the system default
-- ════════════════════════════════════════════════════════════════════════════

SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('d1000000-0000-0000-0000-000000000002'),
  $q$SELECT reason FROM public.clear_current_user_ai_model()$q$),
  'ok', 'a caller can clear their own preference');
SELECT is((SELECT count(*)::int FROM public.user_ai_preferences
            WHERE user_id = 'd1000000-0000-0000-0000-000000000002'),
  0, 'the cleared user has no preference row — back to the system default');
SELECT is((SELECT count(*)::int FROM public.user_ai_preferences
            WHERE user_id = 'd1000000-0000-0000-0000-000000000001'),
  1, 'clearing one user''s preference leaves the other user''s row intact');

SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('d1000000-0000-0000-0000-000000000002'),
  $q$SELECT reason FROM public.clear_current_user_ai_model()$q$),
  'no_preference', 'clearing again is idempotent, not an error');

-- Nothing else on the account was disturbed.
SELECT is((SELECT plan || '/' || plan_status || '/' || ai_model_selection_enabled::text
             FROM public.user_entitlements WHERE user_id = 'd1000000-0000-0000-0000-000000000002'),
  'pro/active/true', 'clearing a preference changes no entitlement state');

-- ── Downgrade: the saved preference goes dormant, it is not destroyed ────────
SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('d1000000-0000-0000-0000-000000000008'),
  $q$SELECT reason FROM public.set_current_user_ai_model('google/gemini-3.6-flash')$q$),
  'ok', 'the soon-to-be-downgraded user saves a preference while entitled');

UPDATE public.user_entitlements
   SET plan_status = 'canceled'
 WHERE user_id = 'd1000000-0000-0000-0000-000000000008';

SELECT is((SELECT preferred_model_id FROM public.user_ai_preferences
            WHERE user_id = 'd1000000-0000-0000-0000-000000000008'),
  'google/gemini-3.6-flash',
  'a downgrade does NOT delete the saved preference — it stays dormant');
SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('d1000000-0000-0000-0000-000000000008'),
  $q$SELECT can_select_ai_model::text FROM public.get_current_user_access()$q$),
  'false', 'the dormant preference does not keep the capability alive');
SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('d1000000-0000-0000-0000-000000000008'),
  $q$SELECT reason FROM public.set_current_user_ai_model('google/gemini-3.5-flash')$q$),
  'inactive_entitlement', 'the downgraded user can no longer CHANGE the dormant preference');
SELECT is((SELECT preferred_model_id FROM public.user_ai_preferences
            WHERE user_id = 'd1000000-0000-0000-0000-000000000008'),
  'google/gemini-3.6-flash', 'the refused change left the dormant preference exactly as it was');

-- Clearing must NOT require the entitlement: a downgraded user has to be able to
-- drop a stale preference, or the check protects nothing and only takes control
-- away from the person it belongs to.
SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('d1000000-0000-0000-0000-000000000008'),
  $q$SELECT reason FROM public.clear_current_user_ai_model()$q$),
  'ok', 'clearing works even after the entitlement has become inactive');
SELECT is((SELECT count(*)::int FROM public.user_ai_preferences
            WHERE user_id = 'd1000000-0000-0000-0000-000000000008'),
  0, 'the downgraded user''s dormant preference is gone once they clear it');

-- ── Catalog retirement preserves history ────────────────────────────────────
-- A model a user has chosen cannot be deleted out from under them; retiring it
-- is `enabled = false`, which the setter already refuses to select.
SELECT is(pg_temp.errcode_as('postgres','',
  $q$DELETE FROM public.ai_model_catalog WHERE id = 'google/gemini-3.6-flash'$q$),
  '23503', 'a catalog row a user has selected cannot be deleted (FK preserves history)');

-- ════════════════════════════════════════════════════════════════════════════
-- 7. Runtime routing is untouched by this foundation
-- ════════════════════════════════════════════════════════════════════════════
-- No database object added here is reachable from the AI quota path, and no
-- pre-existing function learned about the new tables. If a later change wires
-- model selection into the runtime without its own review, this fails.
SELECT is(
  (SELECT count(*)::int FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('consume_ai_quota','refund_ai_quota','get_ai_quota_status')
      AND pg_get_functiondef(p.oid) ~* '(ai_model_catalog|user_ai_preferences|ai_model_selection_enabled)'),
  0, 'no AI-quota RPC consults the model catalog, preference or capability flag');

SELECT * FROM finish();
ROLLBACK;
