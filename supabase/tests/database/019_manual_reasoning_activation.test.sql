-- AI-MANUAL-REASONING-001 suite 019: manual reasoning, activated for users.
--
-- Owns the database half of migration 20260919075655, which set
-- `reasoning_selectable = true` on exactly the six catalog rows and granted
-- EXECUTE on `set_current_user_ai_reasoning(text)` to `authenticated`.
--
-- ## Where the boundary is
--
--   * 016 owns the MECHANISM that 001C built: the vocabulary constraints, the
--     setter's business rules, the model setter's reset-on-switch, the row
--     locks and write truthfulness, and the clear RPC.
--   * 018 owns what the two paid rows ARE and that they are user-selectable.
--   * 019 — this suite — owns the ACTIVATION: which rows are open, who may call
--     the setter and nobody else, and that the real client path works end to end
--     for every level of every model and refuses everything else.
--
-- Every database suite runs against the FINAL migration state, so the staging
-- claims 016, 018 and 003 used to make ("granted to no role", "no row offers
-- manual reasoning") were inverted or moved here rather than deleted. The staged
-- history is not lost: 20260912120000, 20260917201856 and 20260918210017 each
-- carry a fail-closed verify block proving manual reasoning was still off when
-- they ran, and those blocks replay on every reset.
--
-- ## Why every setter call here runs as `authenticated`
--
-- Before activation, 016 had to exercise the setter as its OWNER because
-- `authenticated` could not call it. That proved the business logic but not the
-- path a browser takes. Here every call goes through `SET ROLE authenticated`
-- with the caller's JWT claims — the exact privilege context of a signed-in
-- supabase-js client — so an accepted level is proof the grant, the catalog flag
-- and the business rules all agree.
--
-- Deterministic UUIDs; explicit fixtures; no TODO/SKIP; no remote calls; no
-- Production data; no real credentials; no provider request of any kind. pgTAP
-- is created inside the transaction and rolled back with it.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path TO extensions, public, pg_temp;

-- ── Helpers ─────────────────────────────────────────────────────────────────
-- Same shape as 011/012/016/018: run a statement as a given role with a given
-- JWT claim set, and report only the SQLSTATE or a single scalar.
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

-- The saved (model, level) pair for one user, as one comparable string.
CREATE FUNCTION pg_temp.pair(p_uid uuid) RETURNS text LANGUAGE sql STABLE AS $hlp$
  SELECT COALESCE(
    (SELECT preferred_model_id || ':' || COALESCE(preferred_reasoning_level, 'AUTOMATIC')
       FROM public.user_ai_preferences WHERE user_id = p_uid),
    'NO_ROW');
$hlp$;

-- The reasoning setter, as a signed-in client calls it.
CREATE FUNCTION pg_temp.set_level(p_uid text, p_level text) RETURNS text
LANGUAGE sql AS $hlp$
  SELECT pg_temp.scalar_as('authenticated', pg_temp.claims(p_uid),
    format('SELECT reason FROM public.set_current_user_ai_reasoning(%L)', p_level));
$hlp$;

-- The model setter, as a signed-in client calls it: `reason:reasoning_reset`.
CREATE FUNCTION pg_temp.set_model(p_uid text, p_model text) RETURNS text
LANGUAGE sql AS $hlp$
  SELECT pg_temp.scalar_as('authenticated', pg_temp.claims(p_uid),
    format('SELECT reason || '':'' || reasoning_reset::text FROM public.set_current_user_ai_model(%L)', p_model));
$hlp$;

-- A write and then the pair it left behind: `result>model:level`.
--
-- Two STATEMENTS, not one expression. `pair` is STABLE, so inside the same
-- query as the write it would read the snapshot from before the write and
-- report the previous pair — and relying on argument evaluation order would be
-- no better. A second statement takes a fresh snapshot that sees the write.
CREATE FUNCTION pg_temp.step_level(p_uid text, p_level text) RETURNS text
LANGUAGE plpgsql AS $hlp$
DECLARE v_result text;
BEGIN
  v_result := pg_temp.set_level(p_uid, p_level);
  RETURN v_result || '>' || pg_temp.pair(p_uid::uuid);
END;
$hlp$;

CREATE FUNCTION pg_temp.step_model(p_uid text, p_model text) RETURNS text
LANGUAGE plpgsql AS $hlp$
DECLARE v_result text;
BEGIN
  v_result := pg_temp.set_model(p_uid, p_model);
  RETURN v_result || '>' || pg_temp.pair(p_uid::uuid);
END;
$hlp$;

-- Call the reasoning setter once per level, in order, and report each call as
-- `level=reason>pair-after-the-call`. The expected strings below are written
-- out by hand from the provider vocabularies — never derived from the catalog,
-- which is the thing under test.
CREATE FUNCTION pg_temp.sweep(p_uid text, p_levels text[]) RETURNS text
LANGUAGE plpgsql AS $hlp$
DECLARE
  v_level text;
  v_out   text[] := ARRAY[]::text[];
BEGIN
  FOREACH v_level IN ARRAY p_levels LOOP
    v_out := v_out || (v_level || '=' || pg_temp.step_level(p_uid, v_level));
  END LOOP;
  RETURN array_to_string(v_out, ',');
END;
$hlp$;

-- What `sweep` must print when every level is ACCEPTED: each call answers ok
-- and leaves the model pinned with exactly that level.
CREATE FUNCTION pg_temp.all_ok(p_model text, p_levels text[]) RETURNS text
LANGUAGE sql IMMUTABLE AS $hlp$
  SELECT string_agg(l || '=ok>' || p_model || ':' || l, ',' ORDER BY o)
  FROM unnest(p_levels) WITH ORDINALITY AS t(l, o);
$hlp$;

-- What `sweep` must print when every level is REFUSED as unsupported: each call
-- is refused and the saved pair never moves from `p_model:p_kept`.
CREATE FUNCTION pg_temp.all_refused(p_model text, p_kept text, p_levels text[]) RETURNS text
LANGUAGE sql IMMUTABLE AS $hlp$
  SELECT string_agg(l || '=reasoning_level_not_supported>' || p_model || ':' || p_kept, ',' ORDER BY o)
  FROM unnest(p_levels) WITH ORDINALITY AS t(l, o);
$hlp$;

SELECT plan(79);

-- ════════════════════════════════════════════════════════════════════════════
-- 1. The activated catalog — asserted before any fixture exists
-- ════════════════════════════════════════════════════════════════════════════

-- Exactly the six approved rows are open, and no other.
SELECT set_eq(
  $$SELECT id FROM public.ai_model_catalog WHERE reasoning_selectable$$,
  ARRAY['google/gemini-3.5-flash','google/gemini-3.6-flash',
        'google/gemini-3.7-flash','google/gemini-3.8-flash',
        'anthropic/claude-sonnet-5','openai/gpt-5.6-terra'],
  'exactly the six approved models offer manual reasoning');
SELECT is((SELECT count(*)::int FROM public.ai_model_catalog WHERE NOT reasoning_selectable),
  0, 'no catalog row is left closed to manual reasoning');

-- Whole-row identity: `reasoning_selectable` is the only field activation moved.
-- The vocabulary (order included) and the Automatic matrix are exactly what
-- 001C and 001E staged.
SELECT is(
  (SELECT count(*)::int FROM public.ai_model_catalog
    WHERE (id, provider, provider_model, display_name, enabled, selectable, sort_order,
           reasoning_levels, auto_analyze_reasoning_level, auto_suggest_reasoning_level,
           reasoning_selectable) IN (
      ('google/gemini-3.5-flash','google','gemini-3.5-flash','Gemini 3.5 Flash',true,true,10,
       ARRAY['minimal','low','medium','high'],'minimal','medium',true),
      ('google/gemini-3.6-flash','google','gemini-3.6-flash','Gemini 3.6 Flash',true,true,20,
       ARRAY['minimal','low','medium','high'],'minimal','medium',true),
      ('google/gemini-3.7-flash','google','gemini-3.7-flash','Gemini 3.7 Flash',true,true,30,
       ARRAY['low','medium','high'],'low','medium',true),
      ('google/gemini-3.8-flash','google','gemini-3.8-flash','Gemini 3.8 Flash',true,true,40,
       ARRAY['low','medium','high'],'low','medium',true),
      ('anthropic/claude-sonnet-5','anthropic','claude-sonnet-5','Claude Sonnet 5',true,true,50,
       ARRAY['off','low','medium','high','xhigh','max'],'off','medium',true),
      ('openai/gpt-5.6-terra','openai','gpt-5.6-terra','GPT-5.6 Terra',true,true,60,
       ARRAY['none','low','medium','high','xhigh','max'],'none','medium',true))),
  6, 'all six rows match their approved metadata as whole rows, now reasoning_selectable');

-- A FUTURE row still starts closed: activation opened six rows, not the column.
SELECT col_default_is('public', 'ai_model_catalog', 'reasoning_selectable', 'false',
  'reasoning_selectable still defaults to false for any future model');

-- Activation chose nothing for anyone.
SELECT is((SELECT count(*)::int FROM public.user_ai_preferences), 0,
  'migration replay created no preference row');
SELECT is((SELECT count(*)::int FROM public.user_ai_preferences
            WHERE preferred_reasoning_level IS NOT NULL),
  0, 'migration replay backfilled no manual reasoning level');

-- ════════════════════════════════════════════════════════════════════════════
-- 2. The grant: authenticated, and nobody else
-- ════════════════════════════════════════════════════════════════════════════

SELECT ok(has_function_privilege('authenticated',
    'public.set_current_user_ai_reasoning(text)', 'EXECUTE'),
  'authenticated holds EXECUTE on set_current_user_ai_reasoning');
SELECT ok(NOT has_function_privilege('anon',
    'public.set_current_user_ai_reasoning(text)', 'EXECUTE'),
  'anon cannot execute set_current_user_ai_reasoning');
SELECT ok(NOT has_function_privilege('service_role',
    'public.set_current_user_ai_reasoning(text)', 'EXECUTE'),
  'service_role cannot execute set_current_user_ai_reasoning');
SELECT ok(NOT EXISTS (
    SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
     WHERE p.oid = 'public.set_current_user_ai_reasoning(text)'::regprocedure
       AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'),
  'set_current_user_ai_reasoning carries no PUBLIC EXECUTE');
-- The allowlist, judging EVERY grantee: the checks above are a deny-list and
-- would pass a function some unexpected role could still execute.
SELECT set_eq(
  $$SELECT a.grantee FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
     WHERE p.oid = 'public.set_current_user_ai_reasoning(text)'::regprocedure
       AND a.privilege_type = 'EXECUTE'$$,
  $$SELECT p.proowner FROM pg_proc p WHERE p.oid = 'public.set_current_user_ai_reasoning(text)'::regprocedure
    UNION ALL SELECT to_regrole('authenticated')::oid$$,
  'EXACTLY its owner and authenticated can execute set_current_user_ai_reasoning');
SELECT ok(NOT EXISTS (
    SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
     WHERE p.oid = 'public.set_current_user_ai_reasoning(text)'::regprocedure
       AND a.grantee = to_regrole('authenticated')::oid AND a.is_grantable),
  'authenticated cannot pass the privilege on (no GRANT OPTION)');
-- The way back out is unchanged, and so is the model-selection family.
SELECT is(
  (SELECT count(*)::int FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
    WHERE p.oid IN ('public.clear_current_user_ai_reasoning()'::regprocedure,
                    'public.set_current_user_ai_model(text)'::regprocedure,
                    'public.clear_current_user_ai_model()'::regprocedure)
      AND a.privilege_type = 'EXECUTE'
      AND a.grantee NOT IN (p.proowner, to_regrole('authenticated')::oid)),
  0, 'the clear RPC and both model RPCs are still owner + authenticated only');
SELECT ok(has_function_privilege('authenticated',
    'public.clear_current_user_ai_reasoning()', 'EXECUTE'),
  'authenticated still holds EXECUTE on clear_current_user_ai_reasoning');

-- Granting did not replace the reviewed body, and identity still comes from the
-- session: a granted call without claims is refused before anything is read.
SELECT is((SELECT md5(p.prosrc) FROM pg_proc p
            WHERE p.oid = 'public.set_current_user_ai_reasoning(text)'::regprocedure),
  '2f3db6644683273bb8e3bcea2b3f3811',
  'the granted setter is byte-for-byte the reviewed 001C body');
SELECT is(pg_temp.errcode_as('authenticated', '',
  $q$SELECT * FROM public.set_current_user_ai_reasoning('high')$q$),
  'P0001', 'a granted call with no authenticated user is refused');

-- ── No second entitlement ────────────────────────────────────────────────────
-- Manual reasoning rides on the SAME capability as model selection. There is
-- nowhere to put a separate reasoning entitlement, and the setter reads the one
-- that exists.
SELECT is((SELECT count(*)::int FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'user_entitlements'
              AND column_name ~* 'reason'),
  0, 'user_entitlements has no reasoning-specific entitlement column');
SELECT ok((SELECT pg_get_functiondef(
             'public.set_current_user_ai_reasoning(text)'::regprocedure)
             ~ 'v_entitlement\.ai_model_selection_enabled'),
  'the setter gates on ai_model_selection_enabled, the model-selection capability');

-- ── Fixtures ────────────────────────────────────────────────────────────────
-- handle_new_user seeds a Free entitlement (flag false) for each row.
INSERT INTO auth.users (id, email) VALUES
  ('e9000000-0000-0000-0000-000000000001','r019-entitled@paperlume.test'),
  ('e9000000-0000-0000-0000-000000000002','r019-free@paperlume.test'),
  ('e9000000-0000-0000-0000-000000000003','r019-default@paperlume.test'),
  ('e9000000-0000-0000-0000-000000000004','r019-downgraded@paperlume.test'),
  ('e9000000-0000-0000-0000-000000000005','r019-inactive@paperlume.test'),
  ('e9000000-0000-0000-0000-000000000006','r019-switcher@paperlume.test'),
  ('e9000000-0000-0000-0000-000000000007','r019-bystander@paperlume.test');

UPDATE public.user_entitlements
   SET plan = 'pro', plan_status = 'active', ai_model_selection_enabled = true
 WHERE user_id IN ('e9000000-0000-0000-0000-000000000001',
                   'e9000000-0000-0000-0000-000000000003',
                   'e9000000-0000-0000-0000-000000000006',
                   'e9000000-0000-0000-0000-000000000007');
UPDATE public.user_entitlements
   SET plan = 'pro', plan_status = 'canceled', ai_model_selection_enabled = true
 WHERE user_id = 'e9000000-0000-0000-0000-000000000005';

-- The downgraded account: it chose a model and a level while entitled, and has
-- since lost the capability. Written directly because that history predates
-- this suite; its row is DORMANT, not deleted, exactly as C33 requires.
INSERT INTO public.user_ai_preferences (user_id, preferred_model_id, preferred_reasoning_level)
VALUES ('e9000000-0000-0000-0000-000000000004', 'anthropic/claude-sonnet-5', 'high');

-- A bystander on a pinned model with Automatic reasoning, to prove nothing in
-- this suite — or in activation — writes anyone else's row.
INSERT INTO public.user_ai_preferences (user_id, preferred_model_id)
VALUES ('e9000000-0000-0000-0000-000000000007', 'google/gemini-3.7-flash');

-- ════════════════════════════════════════════════════════════════════════════
-- 3. An entitled, pinned caller: every supported level, per model
-- ════════════════════════════════════════════════════════════════════════════
--
-- For each model: pin it, sweep EVERY level it supports (each must save and
-- leave the model pinned), then sweep every canonical level it does NOT support
-- (each must be refused and move nothing). Together the two sweeps cover all
-- eight canonical literals for all six models: 48 setter calls through the real
-- client privilege context.

-- ── Gemini 3.5 Flash: minimal | low | medium | high ─────────────────────────
SELECT is(pg_temp.set_model('e9000000-0000-0000-0000-000000000001', 'google/gemini-3.5-flash'),
  'ok:false', 'the entitled caller pins Gemini 3.5 Flash');
SELECT is(pg_temp.sweep('e9000000-0000-0000-0000-000000000001', ARRAY['minimal','low','medium','high']),
  pg_temp.all_ok('google/gemini-3.5-flash', ARRAY['minimal','low','medium','high']),
  'Gemini 3.5 Flash accepts minimal, low, medium and high');
SELECT is(pg_temp.sweep('e9000000-0000-0000-0000-000000000001', ARRAY['off','none','xhigh','max']),
  pg_temp.all_refused('google/gemini-3.5-flash', 'high', ARRAY['off','none','xhigh','max']),
  'Gemini 3.5 Flash refuses off, none, xhigh and max, and keeps high');

-- ── Gemini 3.6 Flash: minimal | low | medium | high ─────────────────────────
SELECT is(pg_temp.set_model('e9000000-0000-0000-0000-000000000001', 'google/gemini-3.6-flash'),
  'ok:false', 'switching 3.5 -> 3.6 keeps the shared level high (no reset)');
SELECT is(pg_temp.sweep('e9000000-0000-0000-0000-000000000001', ARRAY['minimal','low','medium','high']),
  pg_temp.all_ok('google/gemini-3.6-flash', ARRAY['minimal','low','medium','high']),
  'Gemini 3.6 Flash accepts minimal, low, medium and high');
SELECT is(pg_temp.sweep('e9000000-0000-0000-0000-000000000001', ARRAY['off','none','xhigh','max']),
  pg_temp.all_refused('google/gemini-3.6-flash', 'high', ARRAY['off','none','xhigh','max']),
  'Gemini 3.6 Flash refuses off, none, xhigh and max, and keeps high');

-- ── Gemini 3.7 Flash: low | medium | high — and NOT minimal ─────────────────
SELECT is(pg_temp.set_model('e9000000-0000-0000-0000-000000000001', 'google/gemini-3.7-flash'),
  'ok:false', 'switching 3.6 -> 3.7 keeps high');
SELECT is(pg_temp.sweep('e9000000-0000-0000-0000-000000000001', ARRAY['low','medium','high']),
  pg_temp.all_ok('google/gemini-3.7-flash', ARRAY['low','medium','high']),
  'Gemini 3.7 Flash accepts low, medium and high');
SELECT is(pg_temp.sweep('e9000000-0000-0000-0000-000000000001', ARRAY['minimal','off','none','xhigh','max']),
  pg_temp.all_refused('google/gemini-3.7-flash', 'high', ARRAY['minimal','off','none','xhigh','max']),
  'Gemini 3.7 Flash REFUSES minimal (and off, none, xhigh, max), and keeps high');

-- ── Gemini 3.8 Flash: low | medium | high — and NOT minimal ─────────────────
SELECT is(pg_temp.set_model('e9000000-0000-0000-0000-000000000001', 'google/gemini-3.8-flash'),
  'ok:false', 'switching 3.7 -> 3.8 keeps high');
SELECT is(pg_temp.sweep('e9000000-0000-0000-0000-000000000001', ARRAY['low','medium','high']),
  pg_temp.all_ok('google/gemini-3.8-flash', ARRAY['low','medium','high']),
  'Gemini 3.8 Flash accepts low, medium and high');
SELECT is(pg_temp.sweep('e9000000-0000-0000-0000-000000000001', ARRAY['minimal','off','none','xhigh','max']),
  pg_temp.all_refused('google/gemini-3.8-flash', 'high', ARRAY['minimal','off','none','xhigh','max']),
  'Gemini 3.8 Flash REFUSES minimal (and off, none, xhigh, max), and keeps high');

-- ── Claude Sonnet 5: off | low | medium | high | xhigh | max ────────────────
SELECT is(pg_temp.set_model('e9000000-0000-0000-0000-000000000001', 'anthropic/claude-sonnet-5'),
  'ok:false', 'switching Gemini 3.8 -> Claude keeps high, which both list');
SELECT is(pg_temp.sweep('e9000000-0000-0000-0000-000000000001', ARRAY['off','low','medium','high','xhigh','max']),
  pg_temp.all_ok('anthropic/claude-sonnet-5', ARRAY['off','low','medium','high','xhigh','max']),
  'Claude Sonnet 5 accepts off, low, medium, high, xhigh and max');
SELECT is(pg_temp.sweep('e9000000-0000-0000-0000-000000000001', ARRAY['none','minimal']),
  pg_temp.all_refused('anthropic/claude-sonnet-5', 'max', ARRAY['none','minimal']),
  'Claude Sonnet 5 refuses OpenAI''s none and Google''s minimal, and keeps max');

-- ── GPT-5.6 Terra: none | low | medium | high | xhigh | max ─────────────────
SELECT is(pg_temp.set_model('e9000000-0000-0000-0000-000000000001', 'openai/gpt-5.6-terra'),
  'ok:false', 'switching Claude -> Terra keeps max, which both list');
SELECT is(pg_temp.sweep('e9000000-0000-0000-0000-000000000001', ARRAY['none','low','medium','high','xhigh','max']),
  pg_temp.all_ok('openai/gpt-5.6-terra', ARRAY['none','low','medium','high','xhigh','max']),
  'GPT-5.6 Terra accepts none, low, medium, high, xhigh and max');
SELECT is(pg_temp.sweep('e9000000-0000-0000-0000-000000000001', ARRAY['off','minimal']),
  pg_temp.all_refused('openai/gpt-5.6-terra', 'max', ARRAY['off','minimal']),
  'GPT-5.6 Terra refuses Anthropic''s off and Google''s minimal, and keeps max');

-- ── The shape of a successful save ───────────────────────────────────────────
SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('e9000000-0000-0000-0000-000000000001'),
  $q$SELECT saved::text || ':' || reason || ':' || preferred_model_id || ':' || preferred_reasoning_level
       FROM public.set_current_user_ai_reasoning('low')$q$),
  'true:ok:openai/gpt-5.6-terra:low',
  'a save reports saved = true with the model it was validated against and the stored level');
-- Setting the level it already holds is an ordinary save: same answer, same pair.
SELECT is(pg_temp.step_level('e9000000-0000-0000-0000-000000000001', 'low'),
  'ok>openai/gpt-5.6-terra:low', 'saving the same level again is safe and changes nothing');
SELECT is(pg_temp.set_level('e9000000-0000-0000-0000-000000000001', 'automatic'),
  'invalid_reasoning_level', '"automatic" is still not a level — Automatic is the clear RPC');

-- ── Back to Automatic, keeping the model ─────────────────────────────────────
SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('e9000000-0000-0000-0000-000000000001'),
  $q$SELECT reason FROM public.clear_current_user_ai_reasoning()$q$),
  'ok', 'clear_current_user_ai_reasoning returns the caller to Automatic');
SELECT is(pg_temp.pair('e9000000-0000-0000-0000-000000000001'),
  'openai/gpt-5.6-terra:AUTOMATIC', 'Automatic is NULL, and the saved model survived the clear');
SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('e9000000-0000-0000-0000-000000000001'),
  $q$SELECT reason FROM public.clear_current_user_ai_reasoning()$q$),
  'no_reasoning_preference', 'clearing again is an idempotent no-op');

-- ════════════════════════════════════════════════════════════════════════════
-- 4. Refusals — each one writes nothing
-- ════════════════════════════════════════════════════════════════════════════

-- Unentitled (Free), with no row: refused at the FIRST gate, before the missing
-- model could be mentioned, and no row is created to hold anything.
SELECT is(pg_temp.set_level('e9000000-0000-0000-0000-000000000002', 'high'),
  'not_entitled', 'an unentitled caller is refused');
SELECT is(pg_temp.pair('e9000000-0000-0000-0000-000000000002'), 'NO_ROW',
  'the refused unentitled caller still has no preference row');

-- Downgraded: holds a dormant pinned model and level, and cannot change the
-- level — but CAN still return to Automatic, because leaving a manual level
-- must never require the capability that entering one does.
SELECT is(pg_temp.set_level('e9000000-0000-0000-0000-000000000004', 'low'),
  'not_entitled', 'a downgraded caller cannot choose a new level for a dormant model');
SELECT is(pg_temp.pair('e9000000-0000-0000-0000-000000000004'),
  'anthropic/claude-sonnet-5:high', 'the refused call moved nothing');
SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('e9000000-0000-0000-0000-000000000004'),
  $q$SELECT reason FROM public.clear_current_user_ai_reasoning()$q$),
  'ok', 'the downgraded caller can still clear the old manual level');
SELECT is(pg_temp.pair('e9000000-0000-0000-0000-000000000004'),
  'anthropic/claude-sonnet-5:AUTOMATIC', 'cleared to Automatic, dormant model kept');

-- Capability flag set, plan no longer active.
SELECT is(pg_temp.set_level('e9000000-0000-0000-0000-000000000005', 'high'),
  'inactive_entitlement', 'a canceled plan is refused even with the capability flag set');

-- PaperLume default: entitled, but no model pinned. Refused with the existing
-- model-required semantic, and no row is created merely to hold a level.
SELECT is(pg_temp.set_level('e9000000-0000-0000-0000-000000000003', 'medium'),
  'model_required', 'manual reasoning is refused on PaperLume default');
SELECT is(pg_temp.pair('e9000000-0000-0000-0000-000000000003'), 'NO_ROW',
  'no preference row was created for the default-model caller');

-- A retired saved model. Test setup: the owner disables one row for the
-- duration of one call, then restores it; the suite rolls back regardless.
SELECT is(pg_temp.set_model('e9000000-0000-0000-0000-000000000003', 'google/gemini-3.6-flash'),
  'ok:false', 'the default-model caller now pins Gemini 3.6 Flash');
UPDATE public.ai_model_catalog SET enabled = false WHERE id = 'google/gemini-3.6-flash';
SELECT is(pg_temp.set_level('e9000000-0000-0000-0000-000000000003', 'low'),
  'model_disabled', 'a disabled saved model accepts no manual level');
UPDATE public.ai_model_catalog SET enabled = true WHERE id = 'google/gemini-3.6-flash';

-- A MISSING saved model is structurally impossible rather than merely refused:
-- the preference row's foreign key forbids deleting a catalog row still in use,
-- so the setter's `model_missing` branch is defence in depth.
SELECT is(pg_temp.errcode_as('postgres', '',
  $q$DELETE FROM public.ai_model_catalog WHERE id = 'google/gemini-3.6-flash'$q$),
  '23503', 'a catalog row a preference names cannot be deleted out from under it');

-- A model closed to NEW manual choices — the long-term meaning of the flag, and
-- the state every future row starts in. Test setup again, restored at once.
UPDATE public.ai_model_catalog SET reasoning_selectable = false WHERE id = 'google/gemini-3.6-flash';
SELECT is(pg_temp.set_level('e9000000-0000-0000-0000-000000000003', 'low'),
  'reasoning_not_selectable', 'a model closed to new reasoning choices refuses one');
UPDATE public.ai_model_catalog SET reasoning_selectable = true WHERE id = 'google/gemini-3.6-flash';
SELECT is(pg_temp.pair('e9000000-0000-0000-0000-000000000003'),
  'google/gemini-3.6-flash:AUTOMATIC', 'none of those refusals wrote a level');

-- A future, unreviewed model: inserted with the column default and pinned. It
-- is enabled and selectable, and still refuses a manual level — activation
-- opened six rows, not every row that will ever exist.
INSERT INTO public.ai_model_catalog
  (id, provider, provider_model, display_name, enabled, selectable, sort_order,
   reasoning_levels, auto_analyze_reasoning_level, auto_suggest_reasoning_level)
VALUES ('google/suite-019-future', 'google', 'suite-019-future-model', 'Future fixture',
        true, true, 9019, ARRAY['low','medium','high'], 'low', 'medium');
SELECT is((SELECT reasoning_selectable::text FROM public.ai_model_catalog
            WHERE id = 'google/suite-019-future'),
  'false', 'a newly inserted model starts closed to manual reasoning');
SELECT is(pg_temp.set_model('e9000000-0000-0000-0000-000000000003', 'google/suite-019-future'),
  'ok:false', 'the future model can be pinned (it is selectable)');
SELECT is(pg_temp.set_level('e9000000-0000-0000-0000-000000000003', 'high'),
  'reasoning_not_selectable', 'but it refuses a manual level until a reviewed migration opens it');
SELECT is(pg_temp.set_model('e9000000-0000-0000-0000-000000000003', 'google/gemini-3.6-flash'),
  'ok:false', 'the caller moves back off the fixture model');
DELETE FROM public.ai_model_catalog WHERE id = 'google/suite-019-future';

-- ════════════════════════════════════════════════════════════════════════════
-- 5. Model changes: a compatible level stays, an incompatible one resets
-- ════════════════════════════════════════════════════════════════════════════
--
-- The rule is 001C's and lives entirely in `set_current_user_ai_model`: under a
-- row lock, a saved level the NEW model lists is kept; one it does not list is
-- reset to NULL (Automatic) in the same statement, and `reasoning_reset`
-- reports it. Before activation it could only be exercised with owner-created
-- levels; here every level is chosen through the real client path.

SELECT is(pg_temp.step_model('e9000000-0000-0000-0000-000000000006', 'google/gemini-3.5-flash'),
  'ok:false>google/gemini-3.5-flash:AUTOMATIC', 'setup: pin Gemini 3.5 Flash');
SELECT is(pg_temp.step_level('e9000000-0000-0000-0000-000000000006', 'minimal'),
  'ok>google/gemini-3.5-flash:minimal', 'setup: choose manual minimal on Gemini 3.5 Flash');
SELECT is(pg_temp.step_model('e9000000-0000-0000-0000-000000000006', 'google/gemini-3.6-flash'),
  'ok:false>google/gemini-3.6-flash:minimal',
  '3.5 minimal -> 3.6: minimal is kept, because 3.6 lists it');
SELECT is(pg_temp.step_model('e9000000-0000-0000-0000-000000000006', 'google/gemini-3.8-flash'),
  'ok:true>google/gemini-3.8-flash:AUTOMATIC',
  '3.6 minimal -> 3.8: reset to Automatic in the same statement, and reported');

SELECT is(pg_temp.step_model('e9000000-0000-0000-0000-000000000006', 'anthropic/claude-sonnet-5'),
  'ok:false>anthropic/claude-sonnet-5:AUTOMATIC', 'setup: pin Claude Sonnet 5');
SELECT is(pg_temp.step_level('e9000000-0000-0000-0000-000000000006', 'off'),
  'ok>anthropic/claude-sonnet-5:off', 'setup: choose manual off on Claude');
SELECT is(pg_temp.step_model('e9000000-0000-0000-0000-000000000006', 'openai/gpt-5.6-terra'),
  'ok:true>openai/gpt-5.6-terra:AUTOMATIC',
  'Claude off -> Terra: reset, because Terra spells it none, not off');

SELECT is(pg_temp.step_level('e9000000-0000-0000-0000-000000000006', 'none'),
  'ok>openai/gpt-5.6-terra:none', 'setup: choose manual none on Terra');
SELECT is(pg_temp.step_model('e9000000-0000-0000-0000-000000000006', 'anthropic/claude-sonnet-5'),
  'ok:true>anthropic/claude-sonnet-5:AUTOMATIC',
  'Terra none -> Claude: reset, because Claude spells it off, not none');

SELECT is(pg_temp.step_level('e9000000-0000-0000-0000-000000000006', 'xhigh'),
  'ok>anthropic/claude-sonnet-5:xhigh', 'setup: choose manual xhigh on Claude');
SELECT is(pg_temp.step_model('e9000000-0000-0000-0000-000000000006', 'openai/gpt-5.6-terra'),
  'ok:false>openai/gpt-5.6-terra:xhigh',
  'Claude xhigh -> Terra: kept, because both paid models list xhigh');
SELECT is(pg_temp.step_model('e9000000-0000-0000-0000-000000000006', 'google/gemini-3.7-flash'),
  'ok:true>google/gemini-3.7-flash:AUTOMATIC',
  'Terra xhigh -> Gemini 3.7: reset, because no Gemini model lists xhigh');

SELECT is(pg_temp.step_level('e9000000-0000-0000-0000-000000000006', 'low'),
  'ok>google/gemini-3.7-flash:low', 'setup: choose manual low on Gemini 3.7');
SELECT is(pg_temp.step_model('e9000000-0000-0000-0000-000000000006', 'openai/gpt-5.6-terra'),
  'ok:false>openai/gpt-5.6-terra:low',
  'Gemini 3.7 low -> Terra: kept across providers, because both list low');

-- Returning to PaperLume default drops the model AND the level together.
SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('e9000000-0000-0000-0000-000000000006'),
  $q$SELECT reason FROM public.clear_current_user_ai_model()$q$),
  'ok', 'choosing PaperLume default succeeds');
SELECT is(pg_temp.pair('e9000000-0000-0000-0000-000000000006'), 'NO_ROW',
  'the model and its manual level were cleared together, by deleting one row');

-- ════════════════════════════════════════════════════════════════════════════
-- 6. The only way in is the RPC, and nobody else's row moved
-- ════════════════════════════════════════════════════════════════════════════

SELECT is(pg_temp.errcode_as('authenticated', pg_temp.claims('e9000000-0000-0000-0000-000000000001'),
  $q$UPDATE public.user_ai_preferences SET preferred_reasoning_level = 'max'
      WHERE user_id = 'e9000000-0000-0000-0000-000000000001'$q$),
  '42501', 'an entitled client still cannot write its reasoning level directly');
SELECT is(pg_temp.errcode_as('authenticated', pg_temp.claims('e9000000-0000-0000-0000-000000000001'),
  $q$UPDATE public.ai_model_catalog SET reasoning_selectable = false
      WHERE id = 'google/gemini-3.5-flash'$q$),
  '42501', 'a client cannot open or close a model''s reasoning control itself');
SELECT is(pg_temp.pair('e9000000-0000-0000-0000-000000000007'),
  'google/gemini-3.7-flash:AUTOMATIC',
  'the bystander''s pinned model and Automatic reasoning were never touched');

SELECT * FROM finish();
ROLLBACK;
