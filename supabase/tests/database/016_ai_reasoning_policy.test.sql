-- AI-MULTI-PROVIDER-001C suite 016: model-aware reasoning policy (C41).
--
-- Owns the database half of migration 20260912120000:
--
--   * the four reasoning capability columns on `ai_model_catalog`, their
--     integrity constraints, and the exact Automatic matrix seeded onto the four
--     Gemini rows — with `reasoning_selectable = false` on every one;
--   * `user_ai_preferences.preferred_reasoning_level`, where NULL is Automatic;
--   * `set_current_user_ai_model` resetting an incompatible manual level in the
--     SAME transaction as the model change, and reporting it;
--   * `set_current_user_ai_reasoning` — its business rules exercised in the
--     database-owner context, and its STAGED privilege posture: granted to NO
--     role, `authenticated` included;
--   * `clear_current_user_ai_reasoning` — granted, entitlement-free, idempotent,
--     and model-preserving.
--
-- Why the reasoning setter is exercised as the owner. The migration withholds
-- EXECUTE from `authenticated` on purpose, so an ordinary client call is
-- refused with 42501 — and that refusal is itself asserted below. The business
-- logic still has to be proven now, before the later user-enablement migration
-- grants it, so those calls run as the function owner with the caller's JWT
-- claims set: `auth.uid()` reads the claims, not the role, which is exactly the
-- identity the function will see once it is granted.
--
-- Deterministic UUIDs; explicit fixtures; no TODO/SKIP; no remote calls; no
-- Production data; no real credentials; no provider request of any kind. pgTAP
-- is created inside the transaction and rolled back with it.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path TO extensions, public, pg_temp;

-- ── Helpers ─────────────────────────────────────────────────────────────────
-- Same shape as 011/012/003: run a statement as a given role with a given JWT
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

-- The saved (model, level) pair for one user, as one comparable string.
CREATE FUNCTION pg_temp.pair(p_uid uuid) RETURNS text LANGUAGE sql STABLE AS $hlp$
  SELECT COALESCE(
    (SELECT preferred_model_id || ':' || COALESCE(preferred_reasoning_level, 'AUTOMATIC')
       FROM public.user_ai_preferences WHERE user_id = p_uid),
    'NO_ROW');
$hlp$;

SELECT plan(95);

-- ════════════════════════════════════════════════════════════════════════════
-- 1. Catalog reasoning metadata — shape
-- ════════════════════════════════════════════════════════════════════════════

SELECT has_column('public', 'ai_model_catalog', 'reasoning_levels',
  'ai_model_catalog.reasoning_levels exists');
SELECT has_column('public', 'ai_model_catalog', 'auto_analyze_reasoning_level',
  'ai_model_catalog.auto_analyze_reasoning_level exists');
SELECT has_column('public', 'ai_model_catalog', 'auto_suggest_reasoning_level',
  'ai_model_catalog.auto_suggest_reasoning_level exists');
SELECT has_column('public', 'ai_model_catalog', 'reasoning_selectable',
  'ai_model_catalog.reasoning_selectable exists');
SELECT col_type_is('public', 'ai_model_catalog', 'reasoning_levels', 'text[]',
  'reasoning_levels is text[]');
SELECT col_not_null('public', 'ai_model_catalog', 'reasoning_levels',
  'reasoning_levels is NOT NULL');
SELECT col_not_null('public', 'ai_model_catalog', 'reasoning_selectable',
  'reasoning_selectable is NOT NULL');
SELECT col_default_is('public', 'ai_model_catalog', 'reasoning_selectable', 'false',
  'reasoning_selectable defaults to false');
-- Nullable on purpose: NULL means "PaperLume states no Automatic policy for
-- this model", which the runtime answers with its bounded fail-open path.
SELECT col_is_null('public', 'ai_model_catalog', 'auto_analyze_reasoning_level',
  'auto_analyze_reasoning_level is nullable');
SELECT col_is_null('public', 'ai_model_catalog', 'auto_suggest_reasoning_level',
  'auto_suggest_reasoning_level is nullable');

-- ════════════════════════════════════════════════════════════════════════════
-- 2. The approved Automatic matrix, as whole rows
-- ════════════════════════════════════════════════════════════════════════════

SELECT is((SELECT count(*)::int FROM public.ai_model_catalog
            WHERE id = 'google/gemini-3.5-flash'
              AND reasoning_levels = ARRAY['minimal','low','medium','high']
              AND auto_analyze_reasoning_level = 'minimal'
              AND auto_suggest_reasoning_level = 'medium'
              AND reasoning_selectable = false),
  1, 'Gemini 3.5 Flash: minimal/low/medium/high, analyze=minimal, suggest=medium, not selectable');
SELECT is((SELECT count(*)::int FROM public.ai_model_catalog
            WHERE id = 'google/gemini-3.6-flash'
              AND reasoning_levels = ARRAY['minimal','low','medium','high']
              AND auto_analyze_reasoning_level = 'minimal'
              AND auto_suggest_reasoning_level = 'medium'
              AND reasoning_selectable = false),
  1, 'Gemini 3.6 Flash: minimal/low/medium/high, analyze=minimal, suggest=medium, not selectable');
SELECT is((SELECT count(*)::int FROM public.ai_model_catalog
            WHERE id = 'google/gemini-3.7-flash'
              AND reasoning_levels = ARRAY['low','medium','high']
              AND auto_analyze_reasoning_level = 'low'
              AND auto_suggest_reasoning_level = 'medium'
              AND reasoning_selectable = false),
  1, 'Gemini 3.7 Flash: low/medium/high, analyze=low, suggest=medium, not selectable');
SELECT is((SELECT count(*)::int FROM public.ai_model_catalog
            WHERE id = 'google/gemini-3.8-flash'
              AND reasoning_levels = ARRAY['low','medium','high']
              AND auto_analyze_reasoning_level = 'low'
              AND auto_suggest_reasoning_level = 'medium'
              AND reasoning_selectable = false),
  1, 'Gemini 3.8 Flash: low/medium/high, analyze=low, suggest=medium, not selectable');

-- The staging lock, stated on its own.
SELECT is((SELECT count(*)::int FROM public.ai_model_catalog WHERE reasoning_selectable),
  0, 'no catalog row offers manual reasoning selection — 001C activates nothing');

-- Metadata, never a model: no Sonnet, no Terra, nothing non-Google.
SELECT is((SELECT count(*)::int FROM public.ai_model_catalog WHERE provider <> 'google'),
  0, 'the catalog holds no non-Google row');
SELECT is((SELECT count(*)::int FROM public.ai_model_catalog
            WHERE id ~ '^(anthropic|openai)/'
               OR provider_model ~* '(claude|gpt|terra|sonnet)'),
  0, 'neither claude-sonnet-5 nor gpt-5.6-terra was seeded');

-- The per-model fact Google publishes: 3.7 and 3.8 reject `minimal`.
SELECT is((SELECT count(*)::int FROM public.ai_model_catalog
            WHERE id IN ('google/gemini-3.7-flash','google/gemini-3.8-flash')
              AND 'minimal' = ANY (reasoning_levels)),
  0, 'neither Gemini 3.7 nor 3.8 offers minimal');

-- ════════════════════════════════════════════════════════════════════════════
-- 3. Catalog integrity constraints bite
-- ════════════════════════════════════════════════════════════════════════════

SELECT is(pg_temp.errcode_as('postgres','',
  $q$INSERT INTO public.ai_model_catalog (id,provider,provider_model,display_name,reasoning_levels)
     VALUES ('google/c1','google','c1','C1',ARRAY['ultra'])$q$),
  '23514', 'a non-canonical reasoning level is rejected');
SELECT is(pg_temp.errcode_as('postgres','',
  $q$INSERT INTO public.ai_model_catalog (id,provider,provider_model,display_name,reasoning_levels)
     VALUES ('google/c2','google','c2','C2',ARRAY['low',NULL])$q$),
  '23514', 'a NULL element in the level list is rejected');
SELECT is(pg_temp.errcode_as('postgres','',
  $q$INSERT INTO public.ai_model_catalog (id,provider,provider_model,display_name,reasoning_levels)
     VALUES ('google/c3','google','c3','C3',ARRAY['low','low'])$q$),
  '23514', 'a duplicated level is rejected');
SELECT is(pg_temp.errcode_as('postgres','',
  $q$INSERT INTO public.ai_model_catalog (id,provider,provider_model,display_name,reasoning_levels)
     VALUES ('google/c4','google','c4','C4',ARRAY['automatic'])$q$),
  '23514', '"automatic" is not a storable reasoning level');
SELECT is(pg_temp.errcode_as('postgres','',
  $q$UPDATE public.ai_model_catalog SET auto_analyze_reasoning_level = 'ultra'
      WHERE id = 'google/gemini-3.5-flash'$q$),
  '23514', 'a non-canonical Automatic level is rejected');
SELECT is(pg_temp.errcode_as('postgres','',
  $q$UPDATE public.ai_model_catalog SET auto_analyze_reasoning_level = 'minimal'
      WHERE id = 'google/gemini-3.8-flash'$q$),
  '23514', 'an Automatic level the model itself does not support is rejected');
SELECT is(pg_temp.errcode_as('postgres','',
  $q$UPDATE public.ai_model_catalog SET reasoning_levels = ARRAY['high']
      WHERE id = 'google/gemini-3.5-flash'$q$),
  '23514', 'narrowing a model''s levels out from under its Automatic policy is rejected');
SELECT is(pg_temp.errcode_as('postgres','',
  $q$UPDATE public.ai_model_catalog
        SET reasoning_selectable = true, auto_suggest_reasoning_level = NULL
      WHERE id = 'google/gemini-3.5-flash'$q$),
  '23514', 'a selectable reasoning control requires both Automatic levels');
SELECT is(pg_temp.errcode_as('postgres','',
  $q$INSERT INTO public.ai_model_catalog
       (id,provider,provider_model,display_name,reasoning_selectable)
     VALUES ('google/c5','google','c5','C5',true)$q$),
  '23514', 'a selectable reasoning control requires a non-empty level list');
-- Positive control: the future Sonnet-shaped metadata IS representable. The
-- provider column stays open; only the reasoning vocabulary is closed.
SELECT is(pg_temp.errcode_as('postgres','',
  $q$INSERT INTO public.ai_model_catalog
       (id,provider,provider_model,display_name,reasoning_levels,
        auto_analyze_reasoning_level,auto_suggest_reasoning_level,reasoning_selectable)
     VALUES ('anthropic/suite-016-fixture','anthropic','suite-016-fixture-model','Fixture',
             ARRAY['off','low','medium','high','xhigh','max'],'off','medium',false)$q$),
  '00000', 'a well-formed future-provider row is accepted (fixture, deleted next)');
DELETE FROM public.ai_model_catalog WHERE id = 'anthropic/suite-016-fixture';
SELECT is((SELECT count(*)::int FROM public.ai_model_catalog), 4,
  'the positive-control fixture left nothing behind');

-- ════════════════════════════════════════════════════════════════════════════
-- 4. The preference column
-- ════════════════════════════════════════════════════════════════════════════

SELECT has_column('public', 'user_ai_preferences', 'preferred_reasoning_level',
  'user_ai_preferences.preferred_reasoning_level exists');
SELECT col_is_null('public', 'user_ai_preferences', 'preferred_reasoning_level',
  'preferred_reasoning_level is nullable — NULL means Automatic');
SELECT is((SELECT count(*)::int FROM public.user_ai_preferences
            WHERE preferred_reasoning_level IS NOT NULL),
  0, 'migration replay gave no preference row a manual level');

-- ── Fixtures ────────────────────────────────────────────────────────────────
-- handle_new_user seeds a Free entitlement (flag false) for each row.
INSERT INTO auth.users (id, email) VALUES
  ('e3000000-0000-0000-0000-000000000001','r016-a@paperlume.test'),
  ('e3000000-0000-0000-0000-000000000002','r016-free@paperlume.test'),
  ('e3000000-0000-0000-0000-000000000003','r016-c@paperlume.test'),
  ('e3000000-0000-0000-0000-000000000004','r016-inactive@paperlume.test'),
  ('e3000000-0000-0000-0000-000000000005','r016-noentitlement@paperlume.test'),
  ('e3000000-0000-0000-0000-000000000006','r016-nomodel@paperlume.test');

UPDATE public.user_entitlements
   SET plan = 'pro', plan_status = 'active', ai_model_selection_enabled = true
 WHERE user_id IN ('e3000000-0000-0000-0000-000000000001',
                   'e3000000-0000-0000-0000-000000000003',
                   'e3000000-0000-0000-0000-000000000006');
UPDATE public.user_entitlements
   SET plan = 'pro', plan_status = 'canceled', ai_model_selection_enabled = true
 WHERE user_id = 'e3000000-0000-0000-0000-000000000004';
DELETE FROM public.user_entitlements
 WHERE user_id = 'e3000000-0000-0000-0000-000000000005';

SELECT is(pg_temp.errcode_as('postgres','',
  $q$INSERT INTO public.user_ai_preferences (user_id, preferred_model_id, preferred_reasoning_level)
     VALUES ('e3000000-0000-0000-0000-000000000002','google/gemini-3.5-flash','ultra')$q$),
  '23514', 'a non-canonical saved reasoning level is rejected');
SELECT is(pg_temp.errcode_as('postgres','',
  $q$INSERT INTO public.user_ai_preferences (user_id, preferred_model_id, preferred_reasoning_level)
     VALUES ('e3000000-0000-0000-0000-000000000002','google/gemini-3.5-flash','automatic')$q$),
  '23514', '"automatic" cannot be saved — Automatic is NULL');

-- ════════════════════════════════════════════════════════════════════════════
-- 5. set_current_user_ai_model — model and reasoning move together
-- ════════════════════════════════════════════════════════════════════════════

SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('e3000000-0000-0000-0000-000000000001'),
  $q$SELECT reason || ':' || reasoning_reset::text FROM public.set_current_user_ai_model('google/gemini-3.5-flash')$q$),
  'ok:false', 'a first model save reports no reasoning reset');

-- Test setup: open the reasoning control on three rows so the OWNER can create
-- manual levels. Production has this false everywhere; it rolls back with the
-- suite.
UPDATE public.ai_model_catalog SET reasoning_selectable = true
 WHERE id IN ('google/gemini-3.5-flash','google/gemini-3.6-flash','google/gemini-3.8-flash');

SELECT is(pg_temp.scalar_as('postgres', pg_temp.claims('e3000000-0000-0000-0000-000000000001'),
  $q$SELECT reason FROM public.set_current_user_ai_reasoning('minimal')$q$),
  'ok', 'owner context: a supported manual level is saved');
SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('e3000000-0000-0000-0000-000000000001'),
  $q$SELECT reason || ':' || reasoning_reset::text FROM public.set_current_user_ai_model('google/gemini-3.6-flash')$q$),
  'ok:false', 'switching to a model that supports the saved level resets nothing');
SELECT is(pg_temp.pair('e3000000-0000-0000-0000-000000000001'),
  'google/gemini-3.6-flash:minimal', 'the compatible level was preserved across the switch');
SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('e3000000-0000-0000-0000-000000000001'),
  $q$SELECT reason || ':' || reasoning_reset::text FROM public.set_current_user_ai_model('google/gemini-3.8-flash')$q$),
  'ok:true', 'switching to a model that rejects the saved level reports a reset');
SELECT is(pg_temp.pair('e3000000-0000-0000-0000-000000000001'),
  'google/gemini-3.8-flash:AUTOMATIC',
  'the incompatible level was reset to NULL in the same transaction as the model change');
SELECT is(pg_temp.scalar_as('postgres', pg_temp.claims('e3000000-0000-0000-0000-000000000001'),
  $q$SELECT reason FROM public.set_current_user_ai_reasoning('high')$q$),
  'ok', 'owner context: high is saved on 3.8');
SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('e3000000-0000-0000-0000-000000000001'),
  $q$SELECT reason || ':' || reasoning_reset::text FROM public.set_current_user_ai_model('google/gemini-3.5-flash')$q$),
  'ok:false', 'high is supported by 3.5, so the switch back resets nothing');
SELECT is(pg_temp.pair('e3000000-0000-0000-0000-000000000001'),
  'google/gemini-3.5-flash:high', 'high survived the switch to 3.5');

-- Every pre-existing rejection is intact, writes nothing, and reports no reset.
SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('e3000000-0000-0000-0000-000000000002'),
  $q$SELECT reason || ':' || reasoning_reset::text FROM public.set_current_user_ai_model('google/gemini-3.5-flash')$q$),
  'not_entitled:false', 'a Free user is still refused, before the catalog is consulted');
SELECT is(pg_temp.pair('e3000000-0000-0000-0000-000000000002'), 'NO_ROW',
  'the refused Free user wrote nothing');
SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('e3000000-0000-0000-0000-000000000001'),
  $q$SELECT reason || ':' || reasoning_reset::text FROM public.set_current_user_ai_model('anthropic/claude-sonnet-5')$q$),
  'unknown_model:false', 'an unseeded future model is refused as unknown');
SELECT is(pg_temp.pair('e3000000-0000-0000-0000-000000000001'),
  'google/gemini-3.5-flash:high', 'a refused model switch left the saved pair untouched');
SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('e3000000-0000-0000-0000-000000000003'),
  $q$SELECT reason || ':' || reasoning_reset::text FROM public.set_current_user_ai_model('google/gemini-3.6-flash')$q$),
  'ok:false', 'a user with no prior row gets no reset report');

-- ════════════════════════════════════════════════════════════════════════════
-- 6. set_current_user_ai_reasoning — business rules (owner context)
-- ════════════════════════════════════════════════════════════════════════════

SELECT is(pg_temp.scalar_as('postgres', pg_temp.claims('e3000000-0000-0000-0000-000000000001'),
  $q$SELECT reason FROM public.set_current_user_ai_reasoning('ultra')$q$),
  'invalid_reasoning_level', 'a non-canonical level is refused first');
SELECT is(pg_temp.scalar_as('postgres', pg_temp.claims('e3000000-0000-0000-0000-000000000001'),
  $q$SELECT reason FROM public.set_current_user_ai_reasoning('automatic')$q$),
  'invalid_reasoning_level', '"automatic" is not a level — returning to it is the clear RPC');
SELECT is(pg_temp.scalar_as('postgres', pg_temp.claims('e3000000-0000-0000-0000-000000000001'),
  $q$SELECT reason FROM public.set_current_user_ai_reasoning(NULL)$q$),
  'invalid_reasoning_level', 'a NULL level is refused');
-- Entitlement before model: the Free user has no saved model either, and still
-- hears about entitlement, so the shape of the failure discloses nothing else.
SELECT is(pg_temp.scalar_as('postgres', pg_temp.claims('e3000000-0000-0000-0000-000000000002'),
  $q$SELECT reason FROM public.set_current_user_ai_reasoning('high')$q$),
  'not_entitled', 'entitlement is checked before any model-specific rejection');
SELECT is(pg_temp.scalar_as('postgres', pg_temp.claims('e3000000-0000-0000-0000-000000000004'),
  $q$SELECT reason FROM public.set_current_user_ai_reasoning('high')$q$),
  'inactive_entitlement', 'a canceled plan is refused even with the capability flag set');
SELECT is(pg_temp.scalar_as('postgres', pg_temp.claims('e3000000-0000-0000-0000-000000000005'),
  $q$SELECT reason FROM public.set_current_user_ai_reasoning('high')$q$),
  'missing_entitlement', 'no entitlement row fails closed');
SELECT is(pg_temp.scalar_as('postgres', pg_temp.claims('e3000000-0000-0000-0000-000000000006'),
  $q$SELECT reason FROM public.set_current_user_ai_reasoning('high')$q$),
  'model_required', 'manual reasoning requires a saved named model');

UPDATE public.ai_model_catalog SET reasoning_selectable = false WHERE id = 'google/gemini-3.6-flash';
SELECT is(pg_temp.scalar_as('postgres', pg_temp.claims('e3000000-0000-0000-0000-000000000003'),
  $q$SELECT reason FROM public.set_current_user_ai_reasoning('high')$q$),
  'reasoning_not_selectable', 'a model closed to new reasoning choices refuses one');
UPDATE public.ai_model_catalog SET reasoning_selectable = true WHERE id = 'google/gemini-3.6-flash';

SELECT is(pg_temp.scalar_as('postgres', pg_temp.claims('e3000000-0000-0000-0000-000000000003'),
  $q$SELECT reason FROM public.set_current_user_ai_reasoning('xhigh')$q$),
  'reasoning_level_not_supported', 'a canonical level the model does not list is refused');
SELECT is(pg_temp.scalar_as('postgres', pg_temp.claims('e3000000-0000-0000-0000-000000000003'),
  $q$SELECT reason FROM public.set_current_user_ai_reasoning('off')$q$),
  'reasoning_level_not_supported', 'another provider''s level is refused for a Gemini model');

UPDATE public.ai_model_catalog SET enabled = false WHERE id = 'google/gemini-3.6-flash';
SELECT is(pg_temp.scalar_as('postgres', pg_temp.claims('e3000000-0000-0000-0000-000000000003'),
  $q$SELECT reason FROM public.set_current_user_ai_reasoning('low')$q$),
  'model_disabled', 'a retired saved model accepts no reasoning choice');
UPDATE public.ai_model_catalog SET enabled = true WHERE id = 'google/gemini-3.6-flash';

SELECT is(pg_temp.scalar_as('postgres', pg_temp.claims('e3000000-0000-0000-0000-000000000003'),
  $q$SELECT reason || ':' || preferred_model_id || ':' || preferred_reasoning_level
       FROM public.set_current_user_ai_reasoning('low')$q$),
  'ok:google/gemini-3.6-flash:low', 'a valid level is saved and confirmed with its model');
SELECT is(pg_temp.pair('e3000000-0000-0000-0000-000000000003'),
  'google/gemini-3.6-flash:low', 'only the reasoning column moved — the saved model did not');
SELECT is(pg_temp.pair('e3000000-0000-0000-0000-000000000001'),
  'google/gemini-3.5-flash:high', 'another user''s row was untouched by that write');

-- ── STAGED privileges: nobody can call it yet ────────────────────────────────
SELECT ok(NOT has_function_privilege('authenticated',
    'public.set_current_user_ai_reasoning(text)', 'EXECUTE'),
  'STAGED: authenticated does NOT hold EXECUTE on set_current_user_ai_reasoning');
SELECT is(pg_temp.errcode_as('authenticated', pg_temp.claims('e3000000-0000-0000-0000-000000000003'),
  $q$SELECT * FROM public.set_current_user_ai_reasoning('medium')$q$),
  '42501', 'STAGED: an authenticated client call is refused by the database');
SELECT ok(NOT has_function_privilege('anon',
    'public.set_current_user_ai_reasoning(text)', 'EXECUTE'),
  'anon cannot execute set_current_user_ai_reasoning');
SELECT ok(NOT has_function_privilege('service_role',
    'public.set_current_user_ai_reasoning(text)', 'EXECUTE'),
  'service_role is not widened onto set_current_user_ai_reasoning');
SELECT ok(NOT EXISTS (
    SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
     WHERE p.oid = 'public.set_current_user_ai_reasoning(text)'::regprocedure
       AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'),
  'set_current_user_ai_reasoning carries no PUBLIC EXECUTE');
-- Allowlists, judging EVERY grantee: the per-role checks above are a deny-list
-- and would pass a function some other role could still execute.
SELECT is(
  (SELECT count(*)::int FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
    WHERE p.oid = 'public.set_current_user_ai_reasoning(text)'::regprocedure
      AND a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner),
  0, 'STAGED: no role but its owner can execute set_current_user_ai_reasoning (every grantee judged)');
SELECT is(
  (SELECT count(*)::int FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
    WHERE p.oid = 'public.clear_current_user_ai_reasoning()'::regprocedure
      AND a.privilege_type = 'EXECUTE'
      AND a.grantee NOT IN (p.proowner, to_regrole('authenticated')::oid)),
  0, 'clear_current_user_ai_reasoning is executable by its owner and authenticated only');
SELECT set_eq(
  $$SELECT unnest(p.proargnames) FROM pg_proc p
     WHERE p.oid = 'public.set_current_user_ai_reasoning(text)'::regprocedure$$,
  ARRAY['p_reasoning_level','saved','reason','preferred_model_id','preferred_reasoning_level','updated_at'],
  'the reasoning setter takes a level and no user id, and returns no secret');
SELECT ok((SELECT p.prosecdef AND p.proconfig @> ARRAY['search_path=public']
             FROM pg_proc p WHERE p.oid = 'public.set_current_user_ai_reasoning(text)'::regprocedure),
  'set_current_user_ai_reasoning is SECURITY DEFINER with a pinned search_path');

-- ════════════════════════════════════════════════════════════════════════════
-- 7. clear_current_user_ai_reasoning — granted, entitlement-free, idempotent
-- ════════════════════════════════════════════════════════════════════════════

SELECT is(pg_temp.errcode_as('authenticated', '',
  $q$SELECT * FROM public.clear_current_user_ai_reasoning()$q$),
  'P0001', 'clearing reasoning requires an authenticated caller');
SELECT ok(has_function_privilege('authenticated',
    'public.clear_current_user_ai_reasoning()', 'EXECUTE'),
  'authenticated holds EXECUTE on clear_current_user_ai_reasoning');
SELECT ok(NOT has_function_privilege('anon',
    'public.clear_current_user_ai_reasoning()', 'EXECUTE'),
  'anon cannot execute clear_current_user_ai_reasoning');
SELECT ok(NOT has_function_privilege('service_role',
    'public.clear_current_user_ai_reasoning()', 'EXECUTE'),
  'service_role is not widened onto clear_current_user_ai_reasoning');
SELECT is((SELECT p.pronargs::int FROM pg_proc p
            WHERE p.oid = 'public.clear_current_user_ai_reasoning()'::regprocedure),
  0, 'the clear RPC takes no argument at all — cross-user clearing is unexpressible');

SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('e3000000-0000-0000-0000-000000000003'),
  $q$SELECT reason FROM public.clear_current_user_ai_reasoning()$q$),
  'ok', 'a caller with a manual level clears it');
SELECT is(pg_temp.pair('e3000000-0000-0000-0000-000000000003'),
  'google/gemini-3.6-flash:AUTOMATIC', 'the level is NULL and the saved model survives');
SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('e3000000-0000-0000-0000-000000000003'),
  $q$SELECT reason FROM public.clear_current_user_ai_reasoning()$q$),
  'no_reasoning_preference', 'clearing again is an idempotent no-op');
SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('e3000000-0000-0000-0000-000000000002'),
  $q$SELECT reason FROM public.clear_current_user_ai_reasoning()$q$),
  'no_reasoning_preference', 'a caller with no row at all gets the same idempotent answer');

-- A downgraded account holding a manual level must be able to leave it.
INSERT INTO public.user_ai_preferences (user_id, preferred_model_id, preferred_reasoning_level)
VALUES ('e3000000-0000-0000-0000-000000000004', 'google/gemini-3.5-flash', 'low');
SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('e3000000-0000-0000-0000-000000000004'),
  $q$SELECT reason FROM public.clear_current_user_ai_reasoning()$q$),
  'ok', 'no entitlement is required to return to Automatic');
SELECT is(pg_temp.pair('e3000000-0000-0000-0000-000000000004'),
  'google/gemini-3.5-flash:AUTOMATIC', 'the downgraded account is now on Automatic, model kept');
SELECT is(pg_temp.pair('e3000000-0000-0000-0000-000000000001'),
  'google/gemini-3.5-flash:high', 'nobody else''s level was cleared');

-- ════════════════════════════════════════════════════════════════════════════
-- 8. Clearing the MODEL also returns reasoning to Automatic
-- ════════════════════════════════════════════════════════════════════════════

SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('e3000000-0000-0000-0000-000000000001'),
  $q$SELECT reason FROM public.clear_current_user_ai_model()$q$),
  'ok', 'returning to PaperLume default succeeds');
SELECT is(pg_temp.pair('e3000000-0000-0000-0000-000000000001'), 'NO_ROW',
  'the row that held the manual level is gone — default model AND Automatic reasoning');

-- ════════════════════════════════════════════════════════════════════════════
-- 9. The Data API posture is exactly what 001A left it
-- ════════════════════════════════════════════════════════════════════════════

SELECT is(pg_temp.errcode_as('authenticated', pg_temp.claims('e3000000-0000-0000-0000-000000000003'),
  $q$UPDATE public.user_ai_preferences SET preferred_reasoning_level = 'high'
      WHERE user_id = 'e3000000-0000-0000-0000-000000000003'$q$),
  '42501', 'a client cannot write its own reasoning level directly, bypassing the RPC');
SELECT is(pg_temp.errcode_as('authenticated', pg_temp.claims('e3000000-0000-0000-0000-000000000006'),
  $q$INSERT INTO public.user_ai_preferences (user_id, preferred_model_id, preferred_reasoning_level)
     VALUES ('e3000000-0000-0000-0000-000000000006','google/gemini-3.5-flash','max')$q$),
  '42501', 'a client cannot insert a preference row carrying a reasoning level');
SELECT is(pg_temp.errcode_as('authenticated', pg_temp.claims('e3000000-0000-0000-0000-000000000003'),
  $q$DELETE FROM public.user_ai_preferences
      WHERE user_id = 'e3000000-0000-0000-0000-000000000003'$q$),
  '42501', 'a client cannot delete its preference row directly');
SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('e3000000-0000-0000-0000-000000000003'),
  $q$SELECT COALESCE(preferred_reasoning_level, 'AUTOMATIC') FROM public.user_ai_preferences
      WHERE user_id = 'e3000000-0000-0000-0000-000000000003'$q$),
  'AUTOMATIC', 'a caller can still read its own row, reasoning column included');
SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('e3000000-0000-0000-0000-000000000003'),
  $q$SELECT count(*)::text FROM public.user_ai_preferences
      WHERE user_id = 'e3000000-0000-0000-0000-000000000004'$q$),
  '0', 'a caller cannot read another user''s reasoning preference');
SELECT is(pg_temp.errcode_as('anon', '',
  $q$SELECT preferred_reasoning_level FROM public.user_ai_preferences$q$),
  '42501', 'anon cannot read the preference table');
SELECT ok(NOT has_table_privilege('service_role', 'public.user_ai_preferences',
                                  'SELECT, INSERT, UPDATE, DELETE'),
  'service_role is not widened onto user_ai_preferences');
SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('e3000000-0000-0000-0000-000000000002'),
  $q$SELECT array_to_string(reasoning_levels, ',') || '|' || auto_analyze_reasoning_level
            || '|' || auto_suggest_reasoning_level || '|' || reasoning_selectable::text
       FROM public.ai_model_catalog WHERE id = 'google/gemini-3.7-flash'$q$),
  'low,medium,high|low|medium|false', 'any signed-in user can read a model''s reasoning metadata');
SELECT is(pg_temp.errcode_as('authenticated', pg_temp.claims('e3000000-0000-0000-0000-000000000003'),
  $q$UPDATE public.ai_model_catalog SET reasoning_selectable = true
      WHERE id = 'google/gemini-3.5-flash'$q$),
  '42501', 'a client cannot open a model''s reasoning control itself');
SELECT is(pg_temp.errcode_as('anon', '',
  $q$SELECT reasoning_levels FROM public.ai_model_catalog$q$),
  '42501', 'anon cannot read the catalog');

SELECT * FROM finish();
ROLLBACK;
