-- AI-MULTI-PROVIDER-001E suite 018: the two paid-provider catalog rows.
--
-- Owns the database half of BOTH 001E migrations:
--
--   * 20260917201856 staged `anthropic/claude-sonnet-5` and
--     `openai/gpt-5.6-terra` in `public.ai_model_catalog` as ENABLED but NOT
--     SELECTABLE, so Phase 7 could canary them without exposing them;
--   * 20260918210017 (Phase 8) then set `selectable = true` on exactly those
--     two rows, once the Production canaries had passed.
--
-- The filename still says "staging" because that is where these rows came from
-- and renaming a suite loses its history; what it asserts is the CURRENT state.
-- Every database suite runs against the FINAL migration state, so the
-- staging-era claims here were inverted rather than deleted. That is not lost
-- coverage: 20260917201856 carries its own fail-closed verify block proving it
-- inserted the rows non-selectable, and that block is replayed on every reset.
--
-- ## Why a separate suite, and where the boundary is
--
-- Every database suite runs against the FINAL migration state, so the existing
-- catalog suites could not keep claiming "the catalog is exhausted by the four
-- Google models". They were updated rather than softened — 012 still asserts
-- the whole list and now asserts six rows, and 016 still asserts that no row
-- offers manual reasoning. What moved here is everything specific to the two
-- paid rows:
--
--   * 012 owns the catalog as a LIST and the client-facing grant posture;
--   * 016 owns the reasoning VOCABULARY constraints and the ungranted setter;
--   * 018 owns what the two paid rows ARE, what they are now allowed to do,
--     and what activation still does not grant.
--
-- ## The property this suite exists to defend
--
-- The two flags are independent, and after Phase 8 both are true for these
-- rows:
--
--   * `enabled` means the resolver WILL route a saved preference naming one of
--     these models — the property that let Phase 7 canary them, and the same
--     property that now serves a user's own choice;
--   * `selectable` means `set_current_user_ai_model` will accept it and the
--     Settings control will offer it.
--
-- A regression in either direction is still a real incident: losing `enabled`
-- would strand saved preferences on the system default while appearing to work,
-- and losing `selectable` would silently remove two models users can now
-- choose. Both directions are asserted here.
--
-- What activation deliberately did NOT change is who may choose at all. That
-- gate is `can_select_ai_model`, and section 5 proves an unentitled caller is
-- still refused a paid model at the first gate.
--
-- Manual reasoning is NOT activated by either migration and this suite proves it
-- three ways: no row carries `reasoning_selectable`, no preference row carries a
-- reasoning level, and `set_current_user_ai_reasoning` is still ungranted.
--
-- Deterministic UUIDs; explicit fixtures; no TODO/SKIP; no remote calls; no
-- Production data; no real credentials; no provider request of any kind. pgTAP
-- is created inside the transaction and rolled back with it.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path TO extensions, public, pg_temp;

-- ── Helpers ─────────────────────────────────────────────────────────────────
-- Same shape as 011/012/016: run a statement as a given role with a given JWT
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

SELECT plan(49);

-- ════════════════════════════════════════════════════════════════════════════
-- 1. Exactly one row per staged model, and exactly the approved metadata
-- ════════════════════════════════════════════════════════════════════════════
--
-- Asserted BEFORE any fixture row is inserted, so these describe the migrated
-- catalog and nothing this suite manufactured.

SELECT is((SELECT count(*)::int FROM public.ai_model_catalog
            WHERE id = 'anthropic/claude-sonnet-5'), 1,
  'exactly one Claude Sonnet 5 row exists');
SELECT is((SELECT count(*)::int FROM public.ai_model_catalog
            WHERE id = 'openai/gpt-5.6-terra'), 1,
  'exactly one GPT-5.6 Terra row exists');

-- Nothing ELSE arrived under either provider: the catalog is the allowlist, so
-- a stray sibling model would be a route nobody approved.
SELECT is((SELECT count(*)::int FROM public.ai_model_catalog
            WHERE provider = 'anthropic'), 1,
  'the catalog holds exactly one anthropic row');
SELECT is((SELECT count(*)::int FROM public.ai_model_catalog
            WHERE provider = 'openai'), 1,
  'the catalog holds exactly one openai row');

-- The provider/provider_model pair is what the adapter actually sends, so it is
-- asserted exactly rather than by pattern.
SELECT is((SELECT provider FROM public.ai_model_catalog WHERE id = 'anthropic/claude-sonnet-5'),
  'anthropic', 'Sonnet row names provider anthropic');
SELECT is((SELECT provider_model FROM public.ai_model_catalog WHERE id = 'anthropic/claude-sonnet-5'),
  'claude-sonnet-5', 'Sonnet row sends provider model claude-sonnet-5');
SELECT is((SELECT provider FROM public.ai_model_catalog WHERE id = 'openai/gpt-5.6-terra'),
  'openai', 'Terra row names provider openai');
SELECT is((SELECT provider_model FROM public.ai_model_catalog WHERE id = 'openai/gpt-5.6-terra'),
  'gpt-5.6-terra', 'Terra row sends provider model gpt-5.6-terra');

SELECT is((SELECT display_name FROM public.ai_model_catalog WHERE id = 'anthropic/claude-sonnet-5'),
  'Claude Sonnet 5', 'Sonnet row carries its approved label');
SELECT is((SELECT display_name FROM public.ai_model_catalog WHERE id = 'openai/gpt-5.6-terra'),
  'GPT-5.6 Terra', 'Terra row carries its approved label');

-- ── enabled AND selectable — the activated combination ─────────────────────
-- Phase 8 (20260918210017) flipped `selectable` and nothing else. `enabled` is
-- asserted separately from `selectable` because they still mean different
-- things: `enabled` is what makes a saved preference ROUTABLE, `selectable` is
-- what lets a user acquire that preference in the first place.
SELECT ok((SELECT bool_and(enabled) FROM public.ai_model_catalog
            WHERE provider IN ('anthropic','openai')),
  'both paid models are enabled, so a saved preference for one is routable');
SELECT ok((SELECT bool_and(selectable) FROM public.ai_model_catalog
            WHERE provider IN ('anthropic','openai')),
  'both paid models are selectable, so an entitled user can choose one');
SELECT ok((SELECT NOT bool_or(reasoning_selectable) FROM public.ai_model_catalog
            WHERE provider IN ('anthropic','openai')),
  'neither paid model offers manual reasoning selection');

-- ════════════════════════════════════════════════════════════════════════════
-- 2. The C41 reasoning metadata, exactly and in order
-- ════════════════════════════════════════════════════════════════════════════
--
-- `reasoning_levels` is an ARRAY, and the comparison is array equality rather
-- than set containment, so the ORDER is pinned too: it is the order a future
-- manual-reasoning control would render, and the two providers' vocabularies
-- differ at exactly the first element (`off` vs `none`).

SELECT is((SELECT reasoning_levels FROM public.ai_model_catalog
            WHERE id = 'anthropic/claude-sonnet-5'),
  ARRAY['off','low','medium','high','xhigh','max'],
  'Sonnet reasoning levels are off/low/medium/high/xhigh/max, in order');
SELECT is((SELECT reasoning_levels FROM public.ai_model_catalog
            WHERE id = 'openai/gpt-5.6-terra'),
  ARRAY['none','low','medium','high','xhigh','max'],
  'Terra reasoning levels are none/low/medium/high/xhigh/max, in order');

-- The spellings are NOT interchangeable: Anthropic has no `none` and OpenAI no
-- `off`, and collapsing them would let an adapter be handed the other's word.
SELECT ok((SELECT NOT ('none' = ANY (reasoning_levels)) FROM public.ai_model_catalog
            WHERE id = 'anthropic/claude-sonnet-5'),
  'Sonnet does not offer OpenAI''s spelling `none`');
SELECT ok((SELECT NOT ('off' = ANY (reasoning_levels)) FROM public.ai_model_catalog
            WHERE id = 'openai/gpt-5.6-terra'),
  'Terra does not offer Anthropic''s spelling `off`');
-- Neither provider publishes Google's `minimal`.
SELECT is((SELECT count(*)::int FROM public.ai_model_catalog
            WHERE provider IN ('anthropic','openai')
              AND 'minimal' = ANY (reasoning_levels)),
  0, 'neither paid model offers Google''s `minimal`');

-- ── Automatic: the per-operation levels PaperLume chose ────────────────────
SELECT is((SELECT auto_analyze_reasoning_level FROM public.ai_model_catalog
            WHERE id = 'anthropic/claude-sonnet-5'),
  'off', 'Sonnet Automatic Analyze is off');
SELECT is((SELECT auto_suggest_reasoning_level FROM public.ai_model_catalog
            WHERE id = 'anthropic/claude-sonnet-5'),
  'medium', 'Sonnet Automatic Suggest is medium');
SELECT is((SELECT auto_analyze_reasoning_level FROM public.ai_model_catalog
            WHERE id = 'openai/gpt-5.6-terra'),
  'none', 'Terra Automatic Analyze is none');
SELECT is((SELECT auto_suggest_reasoning_level FROM public.ai_model_catalog
            WHERE id = 'openai/gpt-5.6-terra'),
  'medium', 'Terra Automatic Suggest is medium');

-- Whole-row identity, so a column cannot drift onto the wrong model while every
-- individual assertion above still lines up.
SELECT is(
  (SELECT count(*)::int FROM public.ai_model_catalog
    WHERE (id, provider, provider_model, display_name, enabled, selectable, sort_order,
           reasoning_levels, auto_analyze_reasoning_level, auto_suggest_reasoning_level,
           reasoning_selectable) IN (
      ('anthropic/claude-sonnet-5','anthropic','claude-sonnet-5','Claude Sonnet 5',
       true,true,50,ARRAY['off','low','medium','high','xhigh','max'],'off','medium',false),
      ('openai/gpt-5.6-terra','openai','gpt-5.6-terra','GPT-5.6 Terra',
       true,true,60,ARRAY['none','low','medium','high','xhigh','max'],'none','medium',false))),
  2, 'each paid row matches its approved metadata as a whole row');

-- ════════════════════════════════════════════════════════════════════════════
-- 3. The four Google rows are exactly as they were
-- ════════════════════════════════════════════════════════════════════════════
--
-- The invariant a careless edit of the 001E migration would break. Asserted
-- positively, as whole rows, rather than by counting what changed.

SELECT is(
  (SELECT count(*)::int FROM public.ai_model_catalog
    WHERE (id, provider, provider_model, display_name, enabled, selectable, sort_order,
           reasoning_levels, auto_analyze_reasoning_level, auto_suggest_reasoning_level,
           reasoning_selectable) IN (
      ('google/gemini-3.5-flash','google','gemini-3.5-flash','Gemini 3.5 Flash',true,true,10,
       ARRAY['minimal','low','medium','high'],'minimal','medium',false),
      ('google/gemini-3.6-flash','google','gemini-3.6-flash','Gemini 3.6 Flash',true,true,20,
       ARRAY['minimal','low','medium','high'],'minimal','medium',false),
      ('google/gemini-3.7-flash','google','gemini-3.7-flash','Gemini 3.7 Flash',true,true,30,
       ARRAY['low','medium','high'],'low','medium',false),
      ('google/gemini-3.8-flash','google','gemini-3.8-flash','Gemini 3.8 Flash',true,true,40,
       ARRAY['low','medium','high'],'low','medium',false))),
  4, 'all four Google rows are unchanged, as whole rows');

-- The paid rows appended; they did not renumber anyone.
SELECT is((SELECT array_agg(sort_order ORDER BY sort_order)
             FROM public.ai_model_catalog WHERE provider = 'google'),
  ARRAY[10,20,30,40], 'the Google rows kept their original sort positions');
SELECT ok((SELECT min(sort_order) FROM public.ai_model_catalog WHERE provider <> 'google')
          > (SELECT max(sort_order) FROM public.ai_model_catalog WHERE provider = 'google'),
  'both paid models sort after every Google model');

-- ════════════════════════════════════════════════════════════════════════════
-- 4. No user preference was created or rewritten
-- ════════════════════════════════════════════════════════════════════════════

SELECT is((SELECT count(*)::int FROM public.user_ai_preferences), 0,
  'the migration created no user preference row');
SELECT is((SELECT count(*)::int FROM public.user_ai_preferences
            WHERE preferred_model_id IN ('anthropic/claude-sonnet-5','openai/gpt-5.6-terra')),
  0, 'nobody was migrated onto a paid model');
SELECT is((SELECT count(*)::int FROM public.user_ai_preferences
            WHERE preferred_reasoning_level IS NOT NULL),
  0, 'no manual reasoning preference exists');

-- ════════════════════════════════════════════════════════════════════════════
-- 5. The setter now ACCEPTS both paid models — for an ENTITLED caller only
-- ════════════════════════════════════════════════════════════════════════════
--
-- The load-bearing test of the activation. Before Phase 8 this section proved
-- the mirror image: the same entitled caller was refused with
-- `model_not_selectable`. That refusal is exactly what the activation removes,
-- so the assertion is inverted rather than deleted — and the deleted half is
-- not lost coverage, because 20260917201856's own verify block still proves the
-- rows were inserted non-selectable, and it is replayed on every reset.
--
-- It must run as a caller who is entitled, or it proves nothing about
-- `selectable`: an acceptance for an unentitled user would be impossible for a
-- different reason. `set_current_user_ai_model` checks entitlement, then plan
-- status, then existence, then `enabled`, then `selectable` — so a successful
-- save positively proves the row passed every one of those gates, including the
-- flag this migration set.

INSERT INTO auth.users (id, email) VALUES
  ('e8000000-0000-0000-0000-000000000001','suite018-entitled@paperlume.test');

UPDATE public.user_entitlements
   SET plan = 'pro', plan_status = 'active', ai_model_selection_enabled = true
 WHERE user_id = 'e8000000-0000-0000-0000-000000000001';

-- Positive control FIRST: this caller really can save a model. Without it, the
-- acceptances below would be consistent with a fixture that accepts anything.
SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('e8000000-0000-0000-0000-000000000001'),
  $q$SELECT reason FROM public.set_current_user_ai_model('google/gemini-3.8-flash')$q$),
  'ok', 'control: the entitled caller can save a selectable Google model');
SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('e8000000-0000-0000-0000-000000000001'),
  $q$SELECT saved::text FROM public.set_current_user_ai_model('google/gemini-3.8-flash')$q$),
  'true', 'control: that save reported success');

SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('e8000000-0000-0000-0000-000000000001'),
  $q$SELECT reason FROM public.set_current_user_ai_model('anthropic/claude-sonnet-5')$q$),
  'ok', 'the setter accepts Claude Sonnet 5 for an entitled caller');
SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('e8000000-0000-0000-0000-000000000001'),
  $q$SELECT saved::text FROM public.set_current_user_ai_model('anthropic/claude-sonnet-5')$q$),
  'true', 'that Claude selection reported success');
SELECT is((SELECT preferred_model_id FROM public.user_ai_preferences
            WHERE user_id = 'e8000000-0000-0000-0000-000000000001'),
  'anthropic/claude-sonnet-5', 'the caller''s saved model is now Claude Sonnet 5');

SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('e8000000-0000-0000-0000-000000000001'),
  $q$SELECT reason FROM public.set_current_user_ai_model('openai/gpt-5.6-terra')$q$),
  'ok', 'the setter accepts GPT-5.6 Terra for an entitled caller');
SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('e8000000-0000-0000-0000-000000000001'),
  $q$SELECT saved::text FROM public.set_current_user_ai_model('openai/gpt-5.6-terra')$q$),
  'true', 'that Terra selection reported success');
SELECT is((SELECT preferred_model_id FROM public.user_ai_preferences
            WHERE user_id = 'e8000000-0000-0000-0000-000000000001'),
  'openai/gpt-5.6-terra', 'the caller''s saved model is now GPT-5.6 Terra');

-- ── Entitlement is untouched by activation ────────────────────────────────
-- The corollary that matters most: making a model choosable did not make
-- anyone able to choose. An unentitled caller is refused at the FIRST gate,
-- before `selectable` is ever consulted, so a paid model is no more reachable
-- for them than a Google one ever was.
INSERT INTO auth.users (id, email) VALUES
  ('e8000000-0000-0000-0000-000000000002','suite018-unentitled@paperlume.test');

SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('e8000000-0000-0000-0000-000000000002'),
  $q$SELECT reason FROM public.set_current_user_ai_model('anthropic/claude-sonnet-5')$q$),
  'not_entitled', 'an unentitled caller is refused Claude Sonnet 5 as not entitled');
SELECT is(pg_temp.scalar_as('authenticated', pg_temp.claims('e8000000-0000-0000-0000-000000000002'),
  $q$SELECT saved::text FROM public.set_current_user_ai_model('openai/gpt-5.6-terra')$q$),
  'false', 'an unentitled caller cannot save GPT-5.6 Terra either');
SELECT is((SELECT count(*)::int FROM public.user_ai_preferences
            WHERE user_id = 'e8000000-0000-0000-0000-000000000002'),
  0, 'the refused unentitled caller has no saved preference at all');

-- ════════════════════════════════════════════════════════════════════════════
-- 6. A saved paid preference is ROUTABLE
-- ════════════════════════════════════════════════════════════════════════════
--
-- The other half of `enabled = true`. Before Phase 8 this was the mechanism the
-- canaries used: the setter would not create such a preference, but one written
-- directly by an operator had to resolve, or a canary would silently run on the
-- system default while appearing to test a paid provider. After Phase 8 an
-- entitled user's own choice lands in the same row, and it must resolve the
-- same way.
--
-- This is the DATABASE-side fact: the row is enabled, and the catalog join a
-- resolver performs still returns it. The runtime's own handling of that row is
-- pinned by the Vitest suites for `_shared/aiModelSelection.ts`.

INSERT INTO public.user_ai_preferences (user_id, preferred_model_id)
VALUES ('e8000000-0000-0000-0000-000000000001', 'anthropic/claude-sonnet-5')
ON CONFLICT (user_id) DO UPDATE SET preferred_model_id = 'anthropic/claude-sonnet-5';

SELECT is(
  (SELECT c.provider_model
     FROM public.user_ai_preferences p
     JOIN public.ai_model_catalog c ON c.id = p.preferred_model_id
    WHERE p.user_id = 'e8000000-0000-0000-0000-000000000001'
      AND c.enabled),
  'claude-sonnet-5',
  'an operator-written Sonnet preference still resolves to a routable provider model');

-- And it is now selectable as well as routable: after activation the two flags
-- agree for these rows, which is exactly what Phase 8 changed.
SELECT ok(
  (SELECT c.enabled AND c.selectable
     FROM public.user_ai_preferences p
     JOIN public.ai_model_catalog c ON c.id = p.preferred_model_id
    WHERE p.user_id = 'e8000000-0000-0000-0000-000000000001'),
  'that routable preference names a model that is now user-selectable too');

DELETE FROM public.user_ai_preferences WHERE user_id = 'e8000000-0000-0000-0000-000000000001';

-- ════════════════════════════════════════════════════════════════════════════
-- 7. Manual reasoning is still inactive, catalog-wide
-- ════════════════════════════════════════════════════════════════════════════

SELECT is((SELECT count(*)::int FROM public.ai_model_catalog WHERE reasoning_selectable),
  0, 'no catalog row offers manual reasoning — 001E activates nothing');

-- The grant is the other half of manual reasoning. 001E must not have added it.
SELECT ok(NOT has_function_privilege('authenticated',
            'public.set_current_user_ai_reasoning(text)'::regprocedure, 'EXECUTE'),
  'authenticated still cannot execute set_current_user_ai_reasoning');
SELECT ok(NOT has_function_privilege('anon',
            'public.set_current_user_ai_reasoning(text)'::regprocedure, 'EXECUTE'),
  'anon still cannot execute set_current_user_ai_reasoning');

-- ════════════════════════════════════════════════════════════════════════════
-- 8. The catalog is still credential-free and still read-only to clients
-- ════════════════════════════════════════════════════════════════════════════
--
-- Two PAID providers now have rows, so "there is nowhere here to put an API
-- key" stops being hypothetical: a credential column would be a credential in
-- a table every signed-in user can SELECT.

SELECT is(
  (SELECT count(*)::int FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'ai_model_catalog'
      AND column_name ~* '(key|secret|token|credential|password)'),
  0, 'the catalog has no column that could hold credential material');

SELECT is(
  (SELECT count(*)::int FROM public.ai_model_catalog
    WHERE (id || provider || provider_model || display_name)
          ~* '(api[_-]?key|secret|token|credential|password|sk-|sk_)'),
  0, 'no catalog row names a secret or credential in its metadata');

SELECT is(pg_temp.errcode_as('anon','',
  $q$SELECT count(*) FROM public.ai_model_catalog$q$),
  '42501', 'anon still cannot read the catalog');

SELECT is(pg_temp.errcode_as('authenticated', pg_temp.claims('e8000000-0000-0000-0000-000000000001'),
  $q$UPDATE public.ai_model_catalog SET selectable = true WHERE id = 'anthropic/claude-sonnet-5'$q$),
  '42501',
  'an entitled user cannot make a paid model selectable by writing the catalog');

SELECT * FROM finish();
ROLLBACK;
